import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { CredentialsStore } from "./credentials.ts";

function tempFile(t: TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "nijimaku-credentials-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "credentials.json");
}

test("保存したキーは環境変数より優先し、削除後は環境変数へ戻る。画面へ返す状態にはキーを含めない", (t) => {
  const file = tempFile(t);
  const store = new CredentialsStore(file, "sk-test-env");
  assert.equal(store.load(), undefined);
  assert.equal(store.apiKey, "sk-test-env");
  assert.deepEqual(store.status, { configured: true, saved: false });
  assert.equal(store.set("  sk-test-saved  "), undefined);
  assert.equal(store.apiKey, "sk-test-saved");
  assert.deepEqual(store.status, { configured: true, saved: true });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { openaiApiKey: "sk-test-saved" });
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);

  const reloaded = new CredentialsStore(file, "sk-test-env");
  assert.equal(reloaded.load(), undefined);
  assert.equal(reloaded.apiKey, "sk-test-saved");
  assert.equal(reloaded.set("sk-test-replaced"), undefined);
  assert.equal(reloaded.apiKey, "sk-test-replaced");
  assert.equal(reloaded.reset(), undefined);
  assert.equal(reloaded.apiKey, "sk-test-env");
  assert.equal(existsSync(file), false);

  const withoutFallback = new CredentialsStore(file);
  assert.equal(withoutFallback.set("sk-test-saved"), undefined);
  assert.equal(withoutFallback.reset(), undefined);
  assert.equal(withoutFallback.apiKey, "");
  assert.deepEqual(withoutFallback.status, { configured: false, saved: false });
});

test("空・改行・過大なキーを拒否し、使用中のキーやファイルを変更しない", (t) => {
  const file = tempFile(t);
  const store = new CredentialsStore(file);
  assert.equal(store.set("sk-test-original"), undefined);
  for (const value of ["", " ", "sk-test\nsecret", "sk-test secret", "x".repeat(1025), null, 123]) {
    assert.ok(store.set(value));
    assert.equal(store.apiKey, "sk-test-original");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).openaiApiKey, "sk-test-original");
  }
});

test("保存ファイルが壊れていても、警告にキーを含めず環境変数で動く", (t) => {
  const file = tempFile(t);
  for (const text of ['{"openaiApiKey":"sk-test-secret', JSON.stringify({ openaiApiKey: "sk-test secret" })]) {
    writeFileSync(file, text);
    const store = new CredentialsStore(file, "sk-test-env");
    const warning = store.load();
    assert.ok(warning);
    assert.ok(!warning.includes("sk-test"));
    assert.equal(store.apiKey, "sk-test-env");
  }
});

test("保存できない場合は使用中のキーを維持し、エラーに入力したキーを含めない", (t) => {
  const file = tempFile(t);
  const store = new CredentialsStore(path.join(file, "credentials.json"), "sk-test-env");
  const error = store.set("sk-test-secret");
  assert.ok(error);
  assert.ok(!error.includes("sk-test-secret"));
  assert.equal(store.apiKey, "sk-test-env");
  assert.deepEqual(store.status, { configured: true, saved: false });
});

test("置き換えが失敗しても使用中のキーを維持し、一時ファイルを残さない", (t) => {
  const file = tempFile(t);
  const dir = path.dirname(file);
  const store = new CredentialsStore(file);
  assert.equal(store.set("sk-test-original"), undefined);
  rmSync(file);
  mkdirSync(file);

  const error = store.set("sk-test-secret");
  assert.ok(error);
  assert.ok(!error.includes("sk-test-secret"));
  assert.equal(store.apiKey, "sk-test-original");
  assert.deepEqual(store.status, { configured: true, saved: true });
  assert.deepEqual(readdirSync(dir), ["credentials.json"]);
});
