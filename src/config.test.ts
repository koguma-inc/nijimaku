import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.ts";

test("ログは既定で保存せず、SAVE_LOGS=1のときだけ保存する", () => {
  assert.equal(loadConfig({}).saveLogs, false);
  assert.equal(loadConfig({ SAVE_LOGS: "0" }).saveLogs, false);
  assert.equal(loadConfig({ SAVE_LOGS: "1" }).saveLogs, true);
  assert.throws(() => loadConfig({ SAVE_LOGS: "true" }), /SAVE_LOGS/);
});

test("数値でないPORTを拒否する", () => {
  assert.throws(() => loadConfig({ PORT: "abc" }), /PORT/);
});
