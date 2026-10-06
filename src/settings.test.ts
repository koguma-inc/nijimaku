import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FIELDS, SettingsStore, validate } from "./settings.ts";
import type { Values } from "./settings.ts";

const DEFAULTS: Values = {
  vadThresholdDb: -45,
  vadSilenceMs: 800,
  glossary: [],
  transcribeLanguages: ["ja"],
  styleJaSize: null,
  styleJaColor: null,
};

function field(key: string) {
  const f = FIELDS.find((x) => x.key === key);
  assert.ok(f, key);
  return f;
}

function tempFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "nijimaku-settings-")), "settings.json");
}

test("保存した値は既定値より優先され、resetで既定値に戻り、ファイルには変えた項目だけ残る", () => {
  const file = tempFile();
  const store = new SettingsStore(DEFAULTS, file);
  assert.deepEqual(store.load(), []);

  assert.equal(store.set("vadSilenceMs", 600), undefined);
  assert.equal(store.values.vadSilenceMs, 600);
  assert.equal(store.values.vadThresholdDb, -45);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { vadSilenceMs: 600 });

  const reloaded = new SettingsStore(DEFAULTS, file);
  assert.deepEqual(reloaded.load(), []);
  assert.equal(reloaded.values.vadSilenceMs, 600);

  reloaded.reset("vadSilenceMs");
  assert.equal(reloaded.values.vadSilenceMs, 800);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});
});

test("不正な値はsetで拒否し、保存済みファイルの不正な値と不明な項目は読み込み時に捨てる", () => {
  const file = tempFile();
  writeFileSync(file, JSON.stringify({ vadSilenceMs: 99999, vadThresholdDb: -50, unknownKey: 1 }));
  const store = new SettingsStore(DEFAULTS, file);
  const warnings = store.load();
  assert.equal(warnings.length, 2);
  assert.equal(store.values.vadSilenceMs, 800);
  assert.equal(store.values.vadThresholdDb, -50);

  assert.match(store.set("vadSilenceMs", "600") ?? "", /数値/);
  assert.match(store.set("nope", 1) ?? "", /不明/);
  assert.equal(store.values.vadSilenceMs, 800);
});

test("壊れたファイルは警告を返し、既定値で動く", () => {
  const file = tempFile();
  writeFileSync(file, "{broken");
  const store = new SettingsStore(DEFAULTS, file);
  assert.equal(store.load().length, 1);
  assert.equal(store.values.vadSilenceMs, 800);
});

test("用語集: 前後の空白を除き、空行を捨て、英語の無い行はjaだけにする。重複・日本語の無い行・<、>は拒否する", () => {
  const f = field("glossary");
  assert.deepEqual(
    validate(f, [
      { ja: " 紫薇令あもる ", en: " Shibirei Amoru " },
      { ja: "ニジマク" },
      { ja: "", en: " " },
    ]),
    { ok: true, value: [{ ja: "紫薇令あもる", en: "Shibirei Amoru" }, { ja: "ニジマク" }] },
  );
  assert.equal(validate(f, [{ ja: "ニジマク" }, { ja: "ニジマク", en: "dup" }]).ok, false);
  assert.equal(validate(f, [{ ja: "", en: "x" }]).ok, false);
  assert.equal(validate(f, [{ ja: "<tag>" }]).ok, false);
  assert.equal(validate(f, "ニジマク").ok, false);
});

test("言語: 小文字の言語コードだけを受け付け、空なら空の一覧", () => {
  const f = field("transcribeLanguages");
  assert.deepEqual(validate(f, ["ja", " en ", "", "ja"]), { ok: true, value: ["ja", "en"] });
  assert.deepEqual(validate(f, []), { ok: true, value: [] });
  assert.equal(validate(f, ["Japanese"]).ok, false);
});

test("色: CSSの宣言を作れる文字（;や{}）は拒否する", () => {
  const f = field("styleJaColor");
  assert.equal(validate(f, "rgba(255, 255, 255, 0.6)").ok, true);
  assert.equal(validate(f, "#fff").ok, true);
  assert.equal(validate(f, "red; display: none").ok, false);
  assert.equal(validate(f, "}").ok, false);
});

test("styleVarsは画面で変えたCSS変数だけを返す", () => {
  const store = new SettingsStore(DEFAULTS, tempFile());
  assert.deepEqual(store.styleVars(), {});
  store.set("styleJaSize", 56);
  store.set("styleJaColor", "#ffeeaa");
  store.set("stylePartialOpacity", 40);
  assert.deepEqual(store.styleVars(), {
    "--nm-ja-size": "56px",
    "--nm-ja-color": "#ffeeaa",
    "--nm-partial-opacity": "0.4",
  });
});
