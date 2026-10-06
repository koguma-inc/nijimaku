import assert from "node:assert/strict";
import { test } from "node:test";
import { Corrector, type LunaMode } from "./corrector.ts";
import type { Logger } from "./log.ts";

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
