import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Corrector, type LunaMode } from "./corrector.ts";
import type { Logger } from "./log.ts";

function stream(t: TestContext, chunks: string[]) {
  const events = chunks.map((delta) => ({ type: "response.output_text.delta", delta }));
  t.mock.method(globalThis, "fetch", async () => new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  ));
}

function setup(mode: LunaMode, timeoutMs = 1000) {
  const fixed: { id: string; ja: string; en?: string }[] = [];
  const logs: { kind: string; fields: Record<string, unknown> }[] = [];
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const logger: Logger = {
    path: null,
    log(kind, fields = {}) {
      logs.push({ kind, fields });
      if (kind === "luna.error") finish();
    },
    close: async () => {},
  };
  const corrector = new Corrector(
    { apiKey: "sk-test-key", timeoutMs, mode, serviceTier: "fast" },
    (id, ja, en) => {
      fixed.push({ id, ja, en });
      if (en !== undefined) finish();
    },
    logger,
  );
  return { corrector, fixed, logs, done };
}

test("translateで認識した日本語を保ち、英訳を確定する", async (t) => {
  stream(t, ['{"en":"Hello."}\n']);
  const { corrector, fixed, done } = setup("translate");
  corrector.correct("item", "こんにちは。", []);
  await done;
  assert.deepEqual(fixed, [
    { id: "item", ja: "こんにちは。", en: undefined },
    { id: "item", ja: "こんにちは。", en: "Hello." },
  ]);
});

test("combinedで英訳が先に来ても空の日本語を採らず、有効な日本語の後に英訳を出す", async (t) => {
  stream(t, ['{"en":"Hello."}\n', '{"ja":"   "}\n', '{"ja":"こんにちは。"}\n']);
  const { corrector, fixed, done } = setup("combined");
  corrector.correct("item", "こんにちわ。", []);
  await done;
  assert.deepEqual(fixed, [
    { id: "item", ja: "こんにちは。", en: undefined },
    { id: "item", ja: "こんにちは。", en: "Hello." },
  ]);
});

test("combinedのタイムアウト後は認識結果を保持する", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }));
  const { corrector, fixed, logs, done } = setup("combined", 1000);
  corrector.correct("item", "認識結果", []);
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1000);
  await done;
  assert.deepEqual(fixed, [{ id: "item", ja: "認識結果", en: undefined }]);
  assert.equal(logs.find((log) => log.kind === "luna.error")?.fields.reason, "timeout");
});

for (const mode of ["translate", "combined"] satisfies LunaMode[]) {
  test(`${mode}: 解析できない応答を失敗ログに残し、APIキーを伏せる`, { timeout: 3000 }, async (t) => {
    const apiKey = "sk-test-response-secret";
    const output = `説明です\n{\n  "translation": "${apiKey}"\n}`;
    const events = [
      { type: "response.output_text.delta", delta: output.slice(0, 30) },
      { type: "response.output_text.delta", delta: output.slice(30) },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 16 } } },
    ];
    t.mock.method(globalThis, "fetch", async () => new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    ));
    const logs: { kind: string; fields: Record<string, unknown> }[] = [];
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const logger: Logger = {
      path: null,
      log(kind, fields = {}) {
        logs.push({ kind, fields });
        if (kind === "luna.error") finish();
      },
      close: async () => {},
    };
    const fixed: { id: string; ja: string; en?: string }[] = [];
    const corrector = new Corrector(
      { apiKey, timeoutMs: 1000, mode, serviceTier: "fast" },
      (id, ja, en) => fixed.push({ id, ja, en }),
      logger,
    );
    corrector.correct("item-test", "こんにちは。", []);
    await done;

    assert.deepEqual(logs.find((log) => log.kind === "luna.error")?.fields, {
      item_id: "item-test",
      call: mode,
      reason: mode === "translate" ? "no_en" : "no_ja",
      message: mode === "translate" ? "enの行がありません" : "空でないjaの行がありません",
      output: output.replaceAll(apiKey, "[APIキー]"),
    });
    assert.ok(!JSON.stringify(logs).includes(apiKey));
    assert.deepEqual(fixed, [{ id: "item-test", ja: "こんにちは。", en: undefined }]);
  });
}
