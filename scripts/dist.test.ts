import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { inspectAppZip, inspectFullZip, makeZip } from "./dist.ts";

let dir: string;
let stage: string;
let zip: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nijimaku-dist-"));
  stage = path.join(dir, "stage");
  zip = path.join(dir, "out.zip");
  put("start.cmd", "@echo off\r\nnode\\node.exe app\\launcher.ts\r\n");
  put("LICENSE", "MIT\n");
  put("node/node.exe", "");
  put("app/package.json", "{}\n");
  put("app/launcher.ts", "\n");
  put("app/current.json", JSON.stringify({ app: "1.2.3" }));
  put("app/versions/1.2.3/src/server.ts", "\n");
  put("app/versions/1.2.3/public/index.html", "\n");
  put("app/versions/1.2.3/node_modules/ws/index.js", "\n");
  put("app/versions/1.2.3/package.json", "{}\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function put(file: string, data: string): void {
  const to = path.join(stage, ...file.split("/"));
  mkdirSync(path.dirname(to), { recursive: true });
  writeFileSync(to, data);
}

describe("inspectFullZip", () => {
  test("ステージングどおりなら通る", () => {
    makeZip(stage, zip);
    inspectFullZip(zip, stage);
  });

  for (const file of ["credentials.json", ".env", "settings.json", "app/.env", "app/versions/1.2.3/credentials.json", "app/versions/1.2.3/src/server.test.ts", "README.md"]) {
    test(`禁止ファイル ${file} があれば失敗する`, () => {
      put(file, "dummy\n");
      makeZip(stage, zip);
      assert.throws(() => inspectFullZip(zip, stage), /入れてはいけないファイル/);
    });
  }

  test("依存パッケージ内の同名ファイルは禁止しない", () => {
    put("app/versions/1.2.3/node_modules/ws/credentials.json", "{}\n");
    makeZip(stage, zip);
    inspectFullZip(zip, stage);
  });

  test("ZIPに無いファイルがステージングにあれば失敗する", () => {
    makeZip(stage, zip);
    put("app/versions/1.2.3/src/added.ts", "\n");
    assert.throws(() => inspectFullZip(zip, stage), /不足: app\/versions\/1\.2\.3\/src\/added\.ts/);
  });

  test("start.cmdがLFだけなら失敗する", () => {
    put("start.cmd", "@echo off\nnode\\node.exe app\\launcher.ts\n");
    makeZip(stage, zip);
    assert.throws(() => inspectFullZip(zip, stage), /CRLFのASCII/);
  });

  test("current.jsonの版と版のフォルダが違えば失敗する", () => {
    put("app/current.json", JSON.stringify({ app: "9.9.9" }));
    makeZip(stage, zip);
    assert.throws(() => inspectFullZip(zip, stage), /一致しません/);
  });

  test("版のフォルダが2つあれば失敗する", () => {
    put("app/versions/1.2.4/package.json", "{}\n");
    makeZip(stage, zip);
    assert.throws(() => inspectFullZip(zip, stage), /一致しません/);
  });

  // 1つの名前が長すぎないよう、途中にディレクトリを挟む
  const longPath = (length: number): string => {
    const head = `app/versions/1.2.3/node_modules/ws/${"a".repeat(50)}/${"b".repeat(50)}/`;
    return head + "c".repeat(length - head.length);
  };

  test("150文字ちょうどのパスは通る", () => {
    put(longPath(150), "\n");
    makeZip(stage, zip);
    inspectFullZip(zip, stage);
  });

  test("150文字を超えるパスがあれば、最長のパスと長さを出して失敗する", () => {
    put(longPath(151), "\n");
    put(longPath(152), "\n");
    makeZip(stage, zip);
    assert.throws(() => inspectFullZip(zip, stage), new RegExp(`${longPath(152)} \\(152文字\\)`));
  });
});

describe("inspectAppZip", () => {
  test("禁止ファイルがあれば失敗する", () => {
    const appStage = path.join(stage, "app", "versions", "1.2.3");
    put("app/versions/1.2.3/settings.json", "{}\n");
    makeZip(appStage, zip);
    assert.throws(() => inspectAppZip(zip, appStage), /入れてはいけないファイル/);
  });
});
