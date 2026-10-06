import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error public/は型宣言の無い素のJSで、tsconfigはallowJsを使わない
import { createVersionWatch } from "../public/overlay.js";

test("最初に受けた版は基準になり、読み直さない", () => {
  const isNewVersion = createVersionWatch();
  assert.equal(isNewVersion("0.2.0"), false);
});

test("同じ版のサーバーへ再接続しても読み直さない", () => {
  const isNewVersion = createVersionWatch();
  isNewVersion("0.2.0");
  assert.equal(isNewVersion("0.2.0"), false);
});

test("違う版を受けたら読み直す", () => {
  const isNewVersion = createVersionWatch();
  isNewVersion("0.2.0");
  assert.equal(isNewVersion("0.3.0"), true);
});

test("更新が起動に失敗して元の版に戻っても読み直さない", () => {
  const isNewVersion = createVersionWatch();
  isNewVersion("0.2.0");
  assert.equal(isNewVersion("0.2.0"), false);
});

test("読み直した後のページは新しい版を基準にする", () => {
  const isNewVersion = createVersionWatch();
  assert.equal(isNewVersion("0.3.0"), false);
  assert.equal(isNewVersion("0.3.0"), false);
});

test("文字列でない版は無視し、基準にもしない", () => {
  const isNewVersion = createVersionWatch();
  for (const v of [undefined, null, 2, {}, ["0.2.0"]]) assert.equal(isNewVersion(v), false);
  assert.equal(isNewVersion("0.2.0"), false);
  assert.equal(isNewVersion(3), false);
  assert.equal(isNewVersion("0.3.0"), true);
});
