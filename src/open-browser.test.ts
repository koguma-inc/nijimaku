import assert from "node:assert/strict";
import { test } from "node:test";
import { findChromeOnWindows } from "./open-browser.ts";

const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" };
const chromeIn = (base: string) => `${base}\\Google\\Chrome\\Application\\chrome.exe`;

test("全ユーザー向けとユーザー単位のChromeを見つける", () => {
  for (const base of [env.ProgramFiles, env.LOCALAPPDATA]) {
    const installed = chromeIn(base);
    assert.equal(findChromeOnWindows(env, (file) => file === installed), installed);
  }
});

test("Chromeが無ければnullを返し、未定義の環境変数は飛ばす", () => {
  assert.equal(findChromeOnWindows(env, () => false), null);
  assert.equal(findChromeOnWindows({}, () => true), null);
});
