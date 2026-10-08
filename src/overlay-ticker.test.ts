import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error public/は型宣言の無い素のJSで、tsconfigはallowJsを使わない
import { tickerUpdates } from "../public/overlay.js";

test("伸びた分だけ足し、切断後に同じ文を受け直しても足さない", () => {
  const shown = new Map<string, string>();
  assert.deepEqual(tickerUpdates(shown, [{ id: "a", state: "partial", text: "きょうは" }]), [
    { id: "a", state: "partial", text: "きょうは" },
  ]);
  assert.deepEqual(
    tickerUpdates(shown, [
      { id: "a", state: "final", text: "きょうはいい天気" },
      { id: "b", state: "partial", text: "そして" },
    ]),
    [
      { id: "a", state: "final", text: "いい天気" },
      { id: "b", state: "partial", text: "そして" },
    ],
  );
  // 切断中の空のスナップショットの後、再接続で表示済みの文が送り直される
  tickerUpdates(shown, []);
  assert.deepEqual(tickerUpdates(shown, [{ id: "a", state: "fixed", text: "きょうはいい天気" }]), [
    { id: "a", state: "fixed", text: "" },
  ]);
});

test("確定や修正で文字が変わっても、流れている文字を置き換えない", () => {
  const shown = new Map<string, string>();
  tickerUpdates(shown, [{ id: "a", state: "partial", text: "きょうわ" }]);
  assert.deepEqual(tickerUpdates(shown, [{ id: "a", state: "fixed", text: "今日は" }]), [
    { id: "a", state: "fixed", text: "" },
  ]);
});
