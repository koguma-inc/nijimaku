import assert from "node:assert/strict";
import { test } from "node:test";
import { AudioPipeline } from "./audio-pipeline.ts";
import type { Logger } from "./log.ts";
import { FRAME_MS, FRAME_SAMPLES, type VadOptions } from "./vad.ts";

const BYTES_PER_MS = 48;
const LOUD = Buffer.alloc(FRAME_SAMPLES * 2);
for (let i = 0; i < FRAME_SAMPLES; i++) LOUD.writeInt16LE(10000, i * 2);
const QUIET = Buffer.alloc(FRAME_SAMPLES * 2);

const VAD: VadOptions = { thresholdDb: -45, minSpeechMs: 200, silenceMs: 500, maxSegmentMs: 1000 };

const logger: Logger = { path: "", log() {}, close: async () => {} };

// RealtimeSessionの保持とready時の送信順（保持音声のappend→ready通知）を真似る
class FakeRealtime {
  ready = false;
  held = 0;
  appended = 0;
  commits: number[] = [];
  onReady = () => {};

  append(pcm: Buffer): void {
    if (this.ready) this.appended += pcm.length;
    else this.held += pcm.length;
  }

  appendedMsSinceCommit(): number {
    return this.ready ? this.appended / BYTES_PER_MS : 0;
  }

  commit(seq: number): number | null {
    if (!this.ready) return null;
    this.commits.push(seq);
    this.appended = 0;
    return 1;
  }

  setReady(): void {
    this.ready = true;
    this.appended += this.held;
    this.held = 0;
    this.onReady();
  }

  disconnect(): void {
    this.ready = false;
    this.appended = 0;
  }
}

function setup(): { pipeline: AudioPipeline; realtime: FakeRealtime; push: (frame: Buffer, n: number) => void } {
  const realtime = new FakeRealtime();
  const pipeline = new AudioPipeline({ vad: VAD }, realtime, logger);
  realtime.onReady = () => pipeline.retryPendingCommit();
  let t = 0;
  const push = (frame: Buffer, n: number) => {
    for (let i = 0; i < n; i++) pipeline.pushChunk(frame, (t += FRAME_MS));
  };
  return { pipeline, realtime, push };
}

test("ready前に発話が終わったcommitは、ready通知で送られる", () => {
  const { realtime, push } = setup();
  push(LOUD, 15);
  push(QUIET, 25);
  assert.deepEqual(realtime.commits, []);
  realtime.setReady();
  assert.deepEqual(realtime.commits, [1]);
  push(QUIET, 50);
  assert.deepEqual(realtime.commits, [1]);
});

test("ready前にcaptureが切れても、後続フレーム無しでready通知から送られる", () => {
  const { pipeline, realtime, push } = setup();
  push(LOUD, 15);
  assert.equal(pipeline.commit("close"), false);
  pipeline.resetInput();
  realtime.setReady();
  assert.deepEqual(realtime.commits, [1]);
});

test("再接続中に最大長へ達したcommitは、ready通知で送られる", () => {
  const { realtime, push } = setup();
  realtime.setReady();
  push(LOUD, 10);
  realtime.disconnect();
  push(LOUD, 50);
  assert.deepEqual(realtime.commits, []);
  realtime.setReady();
  assert.deepEqual(realtime.commits, [1]);
});

test("ready後にappendが100ms未満で送れなかったcommitは、100msに達したappendで送られる", () => {
  const { pipeline, realtime, push } = setup();
  push(LOUD, 15);
  realtime.held = 0; // 保持音声が無い状態でready
  realtime.setReady();
  assert.deepEqual(realtime.commits, []);
  assert.equal(pipeline.commit("vad"), false);
  push(LOUD, 4);
  assert.deepEqual(realtime.commits, []);
  push(LOUD, 1);
  assert.deepEqual(realtime.commits, [1]);
});

test("発話が無ければ保留せず、ready通知でも送らない", () => {
  const { pipeline, realtime, push } = setup();
  push(QUIET, 40);
  assert.equal(pipeline.commit("vad"), false);
  realtime.setReady();
  push(QUIET, 40);
  assert.deepEqual(realtime.commits, []);
});

test("APIキーの切り替えで捨てた音声の保留commitは、新しい接続のready時に送らない", () => {
  const { pipeline, realtime, push } = setup();
  push(LOUD, 15);
  push(QUIET, 25);
  pipeline.resetSession();
  realtime.held = 0;
  realtime.setReady();
  push(QUIET, 40);
  assert.deepEqual(realtime.commits, []);
  push(LOUD, 15);
  push(QUIET, 25);
  assert.deepEqual(realtime.commits, [1]);
});
