import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, type TestContext } from "node:test";
import type WebSocket from "ws";
import { RealtimeSession } from "./realtime.ts";
import type { RealtimeHandlers, TranscriptionConfig } from "./realtime.ts";

const transcription: TranscriptionConfig = { delay: "low", languages: ["ja"], prompt: "", keywords: [] };

class Socket extends EventEmitter {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  closed = false;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from("closed"));
  }
  terminate() { this.close(); }
  disconnect() {
    this.readyState = 3;
    this.emit("close", 1006, Buffer.from("disconnected"));
  }
  message(event: Record<string, unknown>) { this.emit("message", Buffer.from(JSON.stringify(event))); }
}

function setup(t: TestContext, apiKey = "", rotateMin = 50) {
  const sockets: Socket[] = [];
  const keys: string[] = [];
  const partials: string[] = [];
  const committed: [number, string][] = [];
  const dropped: string[][] = [];
  const rejected: [string, string][] = [];
  const logs: unknown[] = [];
  const handlers: RealtimeHandlers = {
    onPartial: (_id, text) => partials.push(text),
    onFinal() {},
    onCommitted: (seq, id) => committed.push([seq, id]),
    onDropped: (ids) => dropped.push(ids),
    onStatus() {},
    onUpdateRejected: (eventId, message) => rejected.push([eventId, message]),
  };
  const session = new RealtimeSession(
    { apiKey, transcription: { ...transcription }, rotateMin }, handlers,
    { path: "", log: (kind, fields) => logs.push({ kind, ...fields }), close: async () => {} },
    (key) => {
      keys.push(key);
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  );
  t.after(() => session.stop());
  return { session, sockets, keys, partials, committed, dropped, rejected, logs };
}

function ready(socket: Socket) {
  socket.emit("open");
  socket.message({ type: "session.updated" });
}

test("キー未設定では接続せず、設定変更や音声入力があってもAPIへ送らない", (t) => {
  const { session, sockets } = setup(t);
  session.start();
  assert.equal(session.status.state, "unconfigured");
  session.updateTranscription({ ...transcription, delay: "high" });
  session.append(Buffer.alloc(480));
  assert.equal(sockets.length, 0);
  assert.equal(session.commit(1), null);
});

test("キーの保存で接続し、置き換え時は保留音声と旧接続のイベントを捨てて新しいキーを使う", (t) => {
  const { session, sockets, keys, partials, logs } = setup(t);
  session.start();
  session.setApiKey("sk-test-first");
  assert.equal(session.status.state, "connecting");
  session.append(Buffer.alloc(480));
  const old = sockets[0];
  old.emit("open");
  session.setApiKey("sk-test-second");
  assert.ok(old.closed);
  old.message({ type: "session.updated" });
  old.message({ type: "conversation.item.input_audio_transcription.delta", item_id: "old", delta: "old" });
  assert.deepEqual(partials, []);
  assert.equal(session.status.state, "connecting");
  const next = sockets[1];
  next.emit("open");
  next.message({ type: "session.updated" });
  assert.equal(session.status.state, "ready");
  assert.equal(next.sent.length, 1);
  assert.equal(next.sent[0].type, "session.update");
  assert.deepEqual(keys, ["sk-test-first", "sk-test-second"]);
  assert.ok(!JSON.stringify(logs).includes("sk-test"));
});

test("キーの削除で接続を閉じ、再設定すると新しい接続で復帰する", (t) => {
  const { session, sockets } = setup(t, "sk-test-first");
  session.start();
  session.setApiKey("");
  assert.ok(sockets[0].closed);
  assert.equal(session.status.state, "unconfigured");
  session.setApiKey("sk-test-second");
  assert.equal(sockets.length, 2);
  assert.equal(session.status.state, "connecting");
});

test("認証拒否はキーを含まないエラーで止まり、キーの変更で復帰できる", (t) => {
  const { session, sockets, logs } = setup(t, "sk-test-first");
  session.start();
  sockets[0].emit("unexpected-response", null, { statusCode: 401, resume() {} });
  assert.equal(session.status.state, "failed");
  assert.ok(sockets[0].closed);
  assert.ok(!JSON.stringify({ status: session.status, logs }).includes("sk-test"));
  session.setApiKey("sk-test-second");
  assert.equal(session.status.state, "connecting");
  assert.equal(sockets.length, 2);
  sockets[1].emit("unexpected-response", null, { statusCode: 403, resume() {} });
  assert.equal(session.status.state, "failed");
  session.setApiKey("sk-test-second");
  assert.equal(session.status.state, "connecting");
  assert.equal(sockets.length, 3);
});

test("ローテーション後も旧接続のcompletedを待ち、完了後に閉じる", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { session, sockets, committed } = setup(t, "sk-test-key", 1);
  session.start();
  ready(sockets[0]);
  t.mock.timers.tick(60_000);
  assert.equal(session.status.state, "rotating");
  ready(sockets[1]);
  assert.equal(session.commit(1), 1);
  assert.equal(session.status.state, "ready");
  assert.equal(sockets[0].closed, false);
  session.append(Buffer.alloc(4_800));
  assert.equal(session.commit(2), 2);
  assert.equal(sockets[1].sent.at(-1)?.type, "input_audio_buffer.commit");
  sockets[0].message({ type: "input_audio_buffer.committed", item_id: "old-item" });
  assert.deepEqual(committed, [[1, "old-item"]]);
  assert.equal(sockets[0].closed, false);
  sockets[0].message({ type: "conversation.item.input_audio_transcription.completed", item_id: "old-item", transcript: "完了" });
  assert.equal(sockets[0].closed, true);
});

test("未完了の旧接続は10秒で退役し、未完了itemを通知する", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { session, sockets, dropped } = setup(t, "sk-test-key", 1);
  session.start();
  ready(sockets[0]);
  session.commit(1);
  sockets[0].message({ type: "input_audio_buffer.committed", item_id: "old-item" });
  t.mock.timers.tick(60_000);
  ready(sockets[1]);
  session.commit(2);
  t.mock.timers.tick(9_999);
  assert.equal(sockets[0].closed, false);
  t.mock.timers.tick(1);
  assert.equal(sockets[0].closed, true);
  assert.deepEqual(dropped, [["old-item"]]);
});

test("現行接続が先に切れたら準備中の次接続へ移り、そのreadyで保留音声を送る", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { session, sockets } = setup(t, "sk-test-key", 1);
  session.start();
  ready(sockets[0]);
  t.mock.timers.tick(60_000);
  sockets[0].disconnect();
  assert.equal(session.status.state, "connecting");
  session.append(Buffer.alloc(4_800));
  ready(sockets[1]);
  assert.equal(session.status.state, "ready");
  assert.equal(sockets[1].sent.at(-1)?.type, "input_audio_buffer.append");
  assert.equal(sockets.length, 2);
});

test("committedは送信したcommitの順でseqに対応する", (t) => {
  const { session, sockets, committed } = setup(t, "sk-test-key");
  session.start();
  ready(sockets[0]);
  session.commit(3);
  session.commit(4);
  sockets[0].message({ type: "input_audio_buffer.committed", item_id: "first" });
  sockets[0].message({ type: "input_audio_buffer.committed", item_id: "second" });
  assert.deepEqual(committed, [[3, "first"], [4, "second"]]);
});

test("settings拒否は通知し、失敗したcommitをFIFOから除いて次のitemを対応づける", (t) => {
  const { session, sockets, committed, rejected } = setup(t, "sk-test-key");
  session.start();
  ready(sockets[0]);
  const [eventId] = session.updateTranscription({ ...transcription, prompt: "変更" });
  sockets[0].message({ type: "error", error: { event_id: eventId, message: "拒否" } });
  assert.deepEqual(rejected, [[eventId, "拒否"]]);
  assert.equal(session.status.state, "ready");
  session.commit(1);
  session.commit(2);
  sockets[0].message({ type: "error", error: { event_id: "commit_1", message: "短すぎる" } });
  sockets[0].message({ type: "input_audio_buffer.committed", item_id: "kept" });
  assert.deepEqual(committed, [[2, "kept"]]);
});

test("ready前のsession.update拒否は設定エラーとして止まり、変更後に復帰する", (t) => {
  const { session, sockets } = setup(t, "sk-test-key");
  session.start();
  sockets[0].emit("open");
  sockets[0].message({ type: "error", error: { event_id: "session_update", message: "設定エラー" } });
  assert.equal(session.status.state, "failed");
  assert.equal(sockets[0].closed, true);
  session.updateTranscription({ ...transcription, prompt: "修正" });
  assert.equal(sockets.length, 2);
  ready(sockets[1]);
  assert.equal(session.status.state, "ready");
});

test("切断時にpartialとcommitted済みitemの消失を通知する", (t) => {
  const { session, sockets, dropped } = setup(t, "sk-test-key");
  session.start();
  ready(sockets[0]);
  session.commit(1);
  sockets[0].message({ type: "input_audio_buffer.committed", item_id: "committed" });
  sockets[0].message({ type: "conversation.item.input_audio_transcription.delta", item_id: "partial", delta: "途中" });
  sockets[0].disconnect();
  assert.deepEqual(dropped, [["partial", "committed"]]);
});

test("再接続は指数バックオフし、readyで次回の待ち時間を戻す", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { session, sockets } = setup(t, "sk-test-key");
  session.start();
  ready(sockets[0]);
  sockets[0].disconnect();
  assert.equal(session.status.state, "reconnecting");
  t.mock.timers.tick(999);
  assert.equal(sockets.length, 1);
  t.mock.timers.tick(1);
  assert.equal(sockets.length, 2);
  sockets[1].disconnect();
  t.mock.timers.tick(1_999);
  assert.equal(sockets.length, 2);
  t.mock.timers.tick(1);
  assert.equal(sockets.length, 3);
  ready(sockets[2]);
  sockets[2].disconnect();
  t.mock.timers.tick(1_000);
  assert.equal(sockets.length, 4);
});
