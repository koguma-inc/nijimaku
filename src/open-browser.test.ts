import assert from "node:assert/strict";
import { test } from "node:test";
import { findChromeOnWindows } from "./open-browser.ts";

const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" };
const chromeIn = (base: string) => `${base}\\Google\\Chrome\\Application\\chrome.exe`;

test("Chromeは全ユーザー向けのインストール先を優先し、無ければユーザー単位も探す", () => {
  const all = new Set(Object.values(env).map(chromeIn));
  assert.equal(findChromeOnWindows(env, (file) => all.has(file)), chromeIn(env.ProgramFiles));
  const perUser = chromeIn(env.LOCALAPPDATA);
  assert.equal(findChromeOnWindows(env, (file) => file === perUser), perUser);
});

test("Chromeが無ければnullを返し、未定義の環境変数は飛ばす", () => {
  assert.equal(findChromeOnWindows(env, () => false), null);
  assert.equal(findChromeOnWindows({}, () => true), null);
});
