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
  message(event: Record<string, unknown>) { this.emit("message", Buffer.from(JSON.stringify(event))); }
}

function setup(t: TestContext, apiKey = "") {
  const sockets: Socket[] = [];
  const keys: string[] = [];
  const partials: string[] = [];
  const logs: unknown[] = [];
  const handlers: RealtimeHandlers = {
    onPartial: (_id, text) => partials.push(text),
    onFinal() {}, onCommitted() {}, onDropped() {}, onStatus() {}, onUpdateRejected() {},
  };
  const session = new RealtimeSession(
    { apiKey, transcription: { ...transcription }, rotateMin: 50 }, handlers,
    { path: "", log: (kind, fields) => logs.push({ kind, ...fields }), close: async () => {} },
    (key) => {
      keys.push(key);
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  );
  t.after(() => session.stop());
  return { session, sockets, keys, partials, logs };
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
});

test("アクセス権を修正した後は、同じキーを保存し直して接続を再試行できる", (t) => {
  const { session, sockets } = setup(t, "sk-test-key");
  session.start();
  sockets[0].emit("unexpected-response", null, { statusCode: 403, resume() {} });
  assert.equal(session.status.state, "failed");
  session.setApiKey("sk-test-key");
  assert.equal(session.status.state, "connecting");
  assert.equal(sockets.length, 2);
});
