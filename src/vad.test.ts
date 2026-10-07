import assert from "node:assert/strict";
import { test } from "node:test";
import { FRAME_MS, FRAME_SAMPLES, Vad, rmsDbfs } from "./vad.ts";
import type { VadEvent, VadOptions } from "./vad.ts";

// 約 -10 dBFS と無音
const LOUD = new Int16Array(FRAME_SAMPLES).fill(10000);
const QUIET = new Int16Array(FRAME_SAMPLES);

const OPTS: VadOptions = { thresholdDb: -45, minSpeechMs: 200, silenceMs: 500, maxSegmentMs: 60000 };

type Fed = { events: VadEvent[]; at: { i: number; event: VadEvent }[]; nextT: number };

// フレームを連続して渡し、イベントと発生したフレーム番号を返す
function feed(vad: Vad, frames: Int16Array[], startT: number): Fed {
  const events: VadEvent[] = [];
  const at: { i: number; event: VadEvent }[] = [];
  frames.forEach((frame, i) => {
    for (const event of vad.push(frame, startT + i * FRAME_MS)) {
      events.push(event);
      at.push({ i, event });
    }
  });
  return { events, at, nextT: startT + frames.length * FRAME_MS };
}

function repeat(frame: Int16Array, n: number): Int16Array[] {
  return Array.from({ length: n }, () => frame);
}

function commits(events: VadEvent[]): VadEvent[] {
  return events.filter((e) => e.type === "commit");
}

test("rmsDbfs: 全ゼロは -Infinity、定数振幅は振幅どおり", () => {
  assert.equal(rmsDbfs(QUIET), -Infinity);
  assert.ok(Math.abs(rmsDbfs(new Int16Array(FRAME_SAMPLES).fill(16384)) - 20 * Math.log10(0.5)) < 1e-9);
});

test("発話開始と終了: start の t は連続区間の最初、end の t は最後の発話フレーム", () => {
  const vad = new Vad(OPTS);
  const start = feed(vad, repeat(LOUD, 15), 1000);
  assert.deepEqual(start.at, [{ i: 9, event: { type: "speech_start", t: 1000 } }]);
  assert.equal(vad.hasSpeech(), true);

  const end = feed(vad, repeat(QUIET, 25), start.nextT);
  assert.deepEqual(end.at, [
    { i: 24, event: { type: "speech_end", t: 1000 + 14 * FRAME_MS } },
    { i: 24, event: { type: "commit", reason: "silence" } },
  ]);
  // 発話終了後も reset まで発話ありのまま
  assert.equal(vad.hasSpeech(), true);
});

test("発話中の短い無音では終了せず、続く発話で最後の発話フレームが進む", () => {
  const vad = new Vad(OPTS);
  const frames = [...repeat(LOUD, 10), ...repeat(QUIET, 24), LOUD, ...repeat(QUIET, 25)];
  const { at } = feed(vad, frames, 0);
  assert.deepEqual(at, [
    { i: 9, event: { type: "speech_start", t: 0 } },
    { i: 59, event: { type: "speech_end", t: 34 * FRAME_MS } },
    { i: 59, event: { type: "commit", reason: "silence" } },
  ]);
});

test("minSpeechMs 未満のノイズでは発話にならない", () => {
  const vad = new Vad(OPTS);
  const noise = [...repeat(LOUD, 9), QUIET, ...repeat(LOUD, 9), ...repeat(QUIET, 100)];
  const alternating = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? LOUD : QUIET));
  assert.deepEqual(feed(vad, [...noise, ...alternating], 0).events, []);
  assert.equal(vad.hasSpeech(), false);
});

test("発話が無ければ commit しない", () => {
  const vad = new Vad({ ...OPTS, maxSegmentMs: 1000 });
  assert.deepEqual(feed(vad, repeat(QUIET, 2000), 0).events, []);
  assert.equal(vad.hasSpeech(), false);
});

test("maxSegmentMs で強制 commit を1回だけ返す（連続区間の最初のフレームから数える）", () => {
  const vad = new Vad({ ...OPTS, maxSegmentMs: 1000 });
  const { at } = feed(vad, repeat(LOUD, 200), 0);
  assert.deepEqual(at, [
    { i: 9, event: { type: "speech_start", t: 0 } },
    { i: 49, event: { type: "commit", reason: "max" } },
  ]);
});

test("maxSegmentMs は発話終了後の無音中も数える", () => {
  const vad = new Vad({ ...OPTS, silenceMs: 2000, maxSegmentMs: 1000 });
  const { at } = feed(vad, [...repeat(LOUD, 10), ...repeat(QUIET, 200)], 0);
  assert.deepEqual(at, [
    { i: 9, event: { type: "speech_start", t: 0 } },
    { i: 49, event: { type: "commit", reason: "max" } },
    { i: 109, event: { type: "speech_end", t: 9 * FRAME_MS } },
    { i: 109, event: { type: "commit", reason: "silence" } },
  ]);
});

test("無音 commit と最大長が同じフレームで成立したら commit は1つ", () => {
  // 発話10フレーム + 無音25フレーム = 35フレーム = 700ms
  const vad = new Vad({ ...OPTS, maxSegmentMs: 700 });
  const { at } = feed(vad, [...repeat(LOUD, 10), ...repeat(QUIET, 200)], 0);
  assert.deepEqual(at, [
    { i: 9, event: { type: "speech_start", t: 0 } },
    { i: 34, event: { type: "speech_end", t: 9 * FRAME_MS } },
    { i: 34, event: { type: "commit", reason: "silence" } },
  ]);
});

test("reset しなければ再び発話を検出し、最大長は最初の発話開始から数える", () => {
  const vad = new Vad({ ...OPTS, maxSegmentMs: 2000 });
  const frames = [...repeat(LOUD, 10), ...repeat(QUIET, 25), ...repeat(LOUD, 100)];
  const { at } = feed(vad, frames, 0);
  assert.deepEqual(at, [
    { i: 9, event: { type: "speech_start", t: 0 } },
    { i: 34, event: { type: "speech_end", t: 9 * FRAME_MS } },
    { i: 34, event: { type: "commit", reason: "silence" } },
    { i: 44, event: { type: "speech_start", t: 35 * FRAME_MS } },
    { i: 99, event: { type: "commit", reason: "max" } },
  ]);
});

test("reset で初期化される", () => {
  const vad = new Vad({ ...OPTS, maxSegmentMs: 1000 });
  const first = feed(vad, repeat(LOUD, 60), 0);
  assert.equal(commits(first.events).length, 1);
  vad.reset();
  assert.equal(vad.hasSpeech(), false);

  // 発話の途中で reset しても、無音だけなら commit しない
  assert.deepEqual(feed(vad, repeat(QUIET, 100), 5000).events, []);

  // 発話開始には再び minSpeechMs が要り、最大長の commit も再発火する
  const again = feed(vad, repeat(LOUD, 60), 10000);
  assert.deepEqual(again.at, [
    { i: 9, event: { type: "speech_start", t: 10000 } },
    { i: 49, event: { type: "commit", reason: "max" } },
  ]);
});

test("reset で発話途中の連続カウントも消える", () => {
  const vad = new Vad(OPTS);
  feed(vad, repeat(LOUD, 9), 0);
  vad.reset();
  const { at } = feed(vad, repeat(LOUD, 10), 1000);
  assert.deepEqual(at, [{ i: 9, event: { type: "speech_start", t: 1000 } }]);
});

test("setOptions は発話中の状態を保ったまま、次のフレームから新しい無音の長さで区切る", () => {
  const vad = new Vad(OPTS);
  const { nextT } = feed(vad, repeat(LOUD, 15), 0);
  vad.setOptions({ ...OPTS, silenceMs: 100 });
  const { at } = feed(vad, repeat(QUIET, 10), nextT);
  const commit = at.find((x) => x.event.type === "commit");
  assert.ok(commit);
  assert.equal(commit.i, 4);
});
