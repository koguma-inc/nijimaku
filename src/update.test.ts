import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test, type TestContext } from "node:test";
import timers from "node:timers/promises";
import { crc32 } from "node:zlib";
import { makeZip } from "../scripts/dist.ts";
import { parseCurrent } from "./launch-state.ts";
import { findBadEntry, parseRelease, parseSums, Updater, writeCurrent, type UpdaterOptions, type UpdateStatus } from "./update.ts";

const API = "https://api.github.com/repos/koguma-inc/nijimaku/releases/latest";
const DOWNLOAD = "https://github.com/koguma-inc/nijimaku/releases/download";
const PREFIXES = { download: `${DOWNLOAD}/`, release: "https://github.com/koguma-inc/nijimaku/releases/" };
const NODE_EXE = Buffer.from("fake node.exe v24.20.0");
const NODE_URL = "https://nodejs.org/dist/v24.20.0/win-x64/node.exe";
const NODE_RUNTIME = "app/runtimes/v24.20.0/node.exe";

type Route = string | Buffer | (() => Response | Promise<Response>);
type Routes = Record<string, Route>;

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

function releaseJson(version: string): Record<string, unknown> {
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/koguma-inc/nijimaku/releases/tag/v${version}`,
    assets: [
      { name: `nijimaku-${version}-app.zip`, browser_download_url: `${DOWNLOAD}/v${version}/nijimaku-${version}-app.zip` },
      { name: "SHA256SUMS.txt", browser_download_url: `${DOWNLOAD}/v${version}/SHA256SUMS.txt` },
    ],
  };
}

describe("parseRelease", () => {
  test("今より新しい版なら、版・変更点のURL・添付のURLを返す", () => {
    assert.deepEqual(parseRelease(releaseJson("0.3.0"), "0.2.0", PREFIXES), {
      release: {
        version: "0.3.0",
        url: "https://github.com/koguma-inc/nijimaku/releases/tag/v0.3.0",
        zipName: "nijimaku-0.3.0-app.zip",
        zipUrl: `${DOWNLOAD}/v0.3.0/nijimaku-0.3.0-app.zip`,
        sumsUrl: `${DOWNLOAD}/v0.3.0/SHA256SUMS.txt`,
      },
      warning: null,
    });
  });

  test("今と同じか古い版は、警告なしで通知しない", () => {
    for (const version of ["0.2.0", "0.1.9"]) assert.deepEqual(parseRelease(releaseJson(version), "0.2.0", PREFIXES), { release: null, warning: null });
  });

  test("版は数値として比べる", () => {
    for (const [latest, current] of [["0.10.0", "0.9.0"], ["1.0.0", "0.99.99"]]) {
      assert.equal(parseRelease(releaseJson(latest), current, PREFIXES).release?.version, latest);
    }
  });

  test("タグの形が違えば、警告を出して通知しない", () => {
    for (const tag of ["v0.3.0-rc.1", "0.3.0", "v0.3"]) {
      const result = parseRelease({ ...releaseJson("0.3.0"), tag_name: tag }, "0.2.0", PREFIXES);
      assert.equal(result.release, null);
      assert.match(String(result.warning), /タグの形/);
    }
  });

  test("添付が無い・URLが想定外なら、警告を出して通知しない", () => {
    const base = releaseJson("0.3.0");
    const assets = base.assets as { name: string; browser_download_url: string }[];
    const cases = [
      { ...base, assets: [assets[0]] },
      { ...base, assets: [assets[0], { ...assets[1], browser_download_url: "https://github.com/other/repo/releases/download/v0.3.0/SHA256SUMS.txt" }] },
      { ...base, html_url: "https://example.com/koguma-inc/nijimaku/releases/tag/v0.3.0" },
    ];
    for (const data of cases) {
      const result = parseRelease(data, "0.2.0", PREFIXES);
      assert.equal(result.release, null);
      assert.ok(result.warning);
    }
  });
});

describe("findBadEntry・parseSums", () => {
  test("アプリ部分のルートにあるものだけを通す", () => {
    assert.equal(findBadEntry(["src/", "src/server.ts", "public/capture.html", "node_modules/ws/index.js", "package.json", "runtime.json"]), null);
    for (const entry of ["../evil", "/etc/evil", "C:/evil", "src\\evil", "evil.txt"]) {
      assert.equal(findBadEntry(["src/server.ts", entry]), entry, entry);
    }
  });

  test("sha256sumの形式を読む", () => {
    const hex = "a".repeat(64);
    const sums = parseSums(`${hex}  nijimaku-0.3.0-app.zip\r\n${"B".repeat(64)} *nijimaku-0.3.0-win-x64.zip\nbroken line\n`);
    assert.equal(sums.get("nijimaku-0.3.0-app.zip"), hex);
    assert.equal(sums.get("nijimaku-0.3.0-win-x64.zip"), "b".repeat(64));
    assert.equal(sums.size, 2);
  });
});

// --- Updater ---

type Install = { dir: string; currentFile: string };

// インストール先を作る。versionsとruntimesは、置いておく版のフォルダとNode.jsの版
function install(t: TestContext, current: unknown, versions: string[] = ["0.2.0"], runtimes: string[] = []): Install {
  const dir = mkdtempSync(path.join(tmpdir(), "nijimaku-update-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const version of versions) put(dir, `app/versions/${version}/src/server.ts`, "\n");
  for (const version of runtimes) put(dir, `app/runtimes/${version}/node.exe`, version === "v24.20.0" ? NODE_EXE : "other");
  const currentFile = path.join(dir, "app", "current.json");
  put(dir, "app/current.json", JSON.stringify(current));
  return { dir, currentFile };
}

function put(dir: string, file: string, data: string | Buffer): void {
  const to = path.join(dir, ...file.split("/"));
  mkdirSync(path.dirname(to), { recursive: true });
  writeFileSync(to, data);
}

type AppZip = { version?: string; launcher?: number; runtime?: unknown; server?: boolean; files?: Record<string, string> };

// アプリ部分のZIPを作り、その中身とSHA256を返す
function appZip(t: TestContext, options: AppZip = {}): { zip: Buffer; sha: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "nijimaku-appzip-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stage = path.join(dir, "stage");
  const version = options.version ?? "0.3.0";
  put(stage, "package.json", JSON.stringify({ name: "nijimaku", version, private: true, type: "module", nijimaku: { launcher: options.launcher ?? 1 } }));
  put(stage, "runtime.json", JSON.stringify(options.runtime ?? { "win32-x64": { version: "v24.21.0", sha256: "0".repeat(64) } }));
  if (options.server !== false) put(stage, "src/server.ts", "// 0.3.0\n");
  put(stage, "public/capture.html", "<!doctype html>\n");
  put(stage, "node_modules/ws/index.js", "\n");
  for (const [file, data] of Object.entries(options.files ?? {})) put(stage, file, data);
  const file = path.join(dir, "app.zip");
  makeZip(stage, file);
  const zip = readFileSync(file);
  return { zip, sha: sha256(zip) };
}

// 無圧縮のZIPを組み立てる。Windowsのtar.exeは-sに対応しておらず、tarでは不正な名前のエントリーを作れない
function storedZip(entries: [name: string, data: string][]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [entry, text] of entries) {
    const name = Buffer.from(entry);
    const data = Buffer.from(text);
    // ローカルヘッダーとセントラルディレクトリで共通の部分（必要な版から名前の長さまで）
    const fields = Buffer.alloc(26);
    fields.writeUInt16LE(20, 0);
    fields.writeUInt16LE(0x21, 8); // 1980-01-01
    fields.writeUInt32LE(crc32(data), 10);
    fields.writeUInt32LE(data.length, 14);
    fields.writeUInt32LE(data.length, 18);
    fields.writeUInt16LE(name.length, 22);
    const local = Buffer.concat([Buffer.from("PK\x03\x04"), fields, name, data]);
    const tail = Buffer.alloc(14);
    tail.writeUInt32LE(offset, 10);
    locals.push(local);
    centrals.push(Buffer.concat([Buffer.from("PK\x01\x02\x14\x00"), fields, tail, name]));
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.write("PK\x05\x06");
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

// 偽のReleaseの取得先。取得されたときだけZIPを作る
function releaseRoutes(t: TestContext, zip?: { zip: Buffer; sha: string }, version = "0.3.0"): Routes {
  const name = `nijimaku-${version}-app.zip`;
  const getZip = () => zip ??= appZip(t);
  return {
    [API]: JSON.stringify(releaseJson(version)),
    [`${DOWNLOAD}/v${version}/SHA256SUMS.txt`]: () => new Response(`${getZip().sha}  ${name}\n${"f".repeat(64)}  nijimaku-${version}-win-x64.zip\n`),
    [`${DOWNLOAD}/v${version}/${name}`]: () => new Response(new Uint8Array(getZip().zip)),
  };
}

function fakeFetch(routes: Routes, requests: { url: string; headers: Headers }[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    const route = routes[url];
    if (route === undefined) return new Response("Not Found", { status: 404 });
    if (typeof route === "function") return route();
    return new Response(typeof route === "string" ? route : new Uint8Array(route));
  }) as typeof fetch;
}

function createUpdater(dir: string, routes: Routes, options: Partial<UpdaterOptions> = {}) {
  const statuses: UpdateStatus[] = [];
  const warnings: string[] = [];
  const requests: { url: string; headers: Headers }[] = [];
  let restarts = 0;
  const updater = new Updater({
    installDir: dir,
    version: "0.2.0",
    launcher: 1,
    fetch: fakeFetch(routes, requests),
    platform: "win32-x64",
    nodeVersion: "v24.21.0",
    onStatus: (status) => statuses.push(status),
    onRestart: () => restarts++,
    warn: (message) => warnings.push(message),
    ...options,
  });
  return { updater, statuses, warnings, requests, restarts: () => restarts };
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function ls(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

test("current.jsonの置き換えは一時的なEPERMから復帰し、EBUSYが続けば旧版を保つ", async (t) => {
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const { currentFile } = install(t, { app: "0.2.0" });
  const originalRename = fs.renameSync;
  let mode: "once" | "always" = "once";
  let attempts = 0;
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
    attempts++;
    if (mode === "always" || attempts === 1) {
      const code = mode === "once" ? "EPERM" : "EBUSY";
      throw Object.assign(new Error(code), { code });
    }
    originalRename(...args);
  });
  const wait = t.mock.method(timers, "setTimeout", <T = void>(_ms?: number, value?: T) => Promise.resolve(value as T));
  syncBuiltinESMExports();

  await writeCurrent(currentFile, { app: "0.3.0" });
  assert.deepEqual(readJson(currentFile), { app: "0.3.0" });
  assert.equal(attempts, 2);
  assert.equal(wait.mock.callCount(), 1);

  mode = "always";
  attempts = 0;
  await assert.rejects(writeCurrent(currentFile, { app: "0.4.0" }), { code: "EBUSY" });
  assert.equal(attempts, 6);
  assert.deepEqual(readJson(currentFile), { app: "0.3.0" });
});

describe("確認", () => {
  test("初期化の後に確認し、新しい版があればavailableを知らせる。GitHubのAPIの約束どおりのヘッダーを付ける", async (t) => {
    const { dir } = install(t, { app: "0.2.0" });
    const { updater, statuses, requests } = createUpdater(dir, releaseRoutes(t));
    await updater.start();
    assert.deepEqual(statuses.map((s) => s.state), ["checking", "available"]);
    assert.deepEqual(updater.status, { state: "available", version: "0.3.0", url: "https://github.com/koguma-inc/nijimaku/releases/tag/v0.3.0", message: "", failed: null });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, API);
    assert.equal(requests[0]!.headers.get("user-agent"), "nijimaku/0.2.0");
    assert.equal(requests[0]!.headers.get("accept"), "application/vnd.github+json");
    assert.equal(requests[0]!.headers.get("x-github-api-version"), "2022-11-28");
  });

  test("GitHubに接続できない・拒否されたときは、警告を残して「確認できませんでした」と出す", async (t) => {
    const { dir } = install(t, { app: "0.2.0" });
    const failures: Route[] = [
      () => Promise.reject(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.github.com") })),
      () => new Response("rate limited", { status: 403 }),
    ];
    for (const failure of failures) {
      const { updater, warnings } = createUpdater(dir, { [API]: failure });
      await updater.start();
      assert.equal(updater.status.state, "error");
      assert.equal(updater.status.message, "新しい版を確認できませんでした");
      assert.equal(updater.status.version, null);
      assert.match(warnings.join("\n"), /確認できませんでした/);
      assert.equal(updater.apply(), null);
    }
  });

  test("添付が無ければ警告してidleのまま適用を受け付けない", async (t) => {
    const { dir } = install(t, { app: "0.2.0" });
    const noAssets = { ...releaseJson("0.3.0"), assets: [] };
    const { updater, warnings } = createUpdater(dir, { [API]: JSON.stringify(noAssets) });
    await updater.start();
    assert.equal(updater.status.state, "idle");
    assert.ok(warnings.length > 0);
    assert.equal(updater.apply(), null);
  });

  test("取得先を差し替えたときは、添付とReleaseのURLをそのoriginで確かめる", async (t) => {
    const { dir } = install(t, { app: "0.2.0" });
    const apiUrl = "http://127.0.0.1:8080/repos/koguma-inc/nijimaku/releases/latest";
    const local = (version: string, origin: string) => ({
      tag_name: `v${version}`,
      html_url: `${origin}/releases/tag/v${version}`,
      assets: [
        { name: `nijimaku-${version}-app.zip`, browser_download_url: `${origin}/download/app.zip` },
        { name: "SHA256SUMS.txt", browser_download_url: `${origin}/download/SHA256SUMS.txt` },
      ],
    });
    const ok = createUpdater(dir, { [apiUrl]: JSON.stringify(local("0.3.0", "http://127.0.0.1:8080")) }, { apiUrl });
    await ok.updater.start();
    assert.equal(ok.updater.status.state, "available");
    const other = createUpdater(dir, { [apiUrl]: JSON.stringify(local("0.3.0", "http://127.0.0.1:9090")) }, { apiUrl });
    await other.updater.start();
    assert.equal(other.updater.status.state, "idle");
    const badAsset = local("0.3.0", "http://127.0.0.1:8080");
    badAsset.assets[0]!.browser_download_url = "http://127.0.0.1:9090/download/app.zip";
    const asset = createUpdater(dir, { [apiUrl]: JSON.stringify(badAsset) }, { apiUrl });
    await asset.updater.start();
    assert.equal(asset.updater.status.state, "idle");
  });
});

describe("適用", () => {
  async function ready(t: TestContext, current: unknown, routes: Routes, options: Partial<UpdaterOptions> = {}, runtimes: string[] = []) {
    const inst = install(t, current, ["0.2.0"], runtimes);
    const created = createUpdater(inst.dir, routes, options);
    await created.updater.start();
    assert.equal(created.updater.status.state, "available");
    return { ...inst, ...created };
  }

  test("取得・照合・展開して版のフォルダへ置き、current.jsonを切り替えてから再起動する", async (t) => {
    const { dir, currentFile, updater, statuses, restarts } = await ready(t, { app: "0.2.0", failed: { app: "0.1.9", at: "2026-10-06T00:00:00.000Z" } }, releaseRoutes(t));
    await updater.apply();
    assert.deepEqual(statuses.slice(-2).map((s) => s.state), ["downloading", "restarting"]);
    assert.equal(restarts(), 1);
    assert.equal(readFileSync(path.join(dir, "app", "versions", "0.3.0", "src", "server.ts"), "utf8"), "// 0.3.0\n");
    assert.deepEqual(ls(path.join(dir, "app", "versions")), ["0.2.0", "0.3.0"]);
    // 起動役が読める形で書く（failedは消す。Node.jsは同じ版なので起動役自身のもののまま）
    const expected = { app: "0.3.0", pending: true, previous: { app: "0.2.0" } };
    assert.deepEqual(readJson(currentFile), expected);
    assert.deepEqual(parseCurrent(readFileSync(currentFile, "utf8")), expected);
  });

  test("Node.jsの版が違えば、nodejs.orgから取得して照合し、app/runtimes/へ置いて新しい版と組で切り替える", async (t) => {
    const zip = appZip(t, { runtime: { "win32-x64": { version: "v24.20.0", sha256: sha256(NODE_EXE) } } });
    const routes = { ...releaseRoutes(t, zip), [NODE_URL]: NODE_EXE };
    const { dir, currentFile, updater, requests } = await ready(t, { app: "0.2.0", runtime: "app/runtimes/v24.19.0/node.exe" }, routes, {}, ["v24.19.0"]);
    await updater.apply();
    assert.equal(updater.status.state, "restarting");
    assert.ok(requests.some((r) => r.url === NODE_URL));
    assert.deepEqual(readFileSync(path.join(dir, ...NODE_RUNTIME.split("/"))), NODE_EXE);
    assert.deepEqual(readJson(currentFile), { app: "0.3.0", runtime: NODE_RUNTIME, pending: true, previous: { app: "0.2.0", runtime: "app/runtimes/v24.19.0/node.exe" } });
  });

  test("同じNode.jsが照合済みで置いてあれば（前の版が使っている等）取得しない", async (t) => {
    const zip = appZip(t, { runtime: { "win32-x64": { version: "v24.20.0", sha256: sha256(NODE_EXE) } } });
    const current = { app: "0.2.0", previous: { app: "0.1.0", runtime: NODE_RUNTIME } };
    const { currentFile, updater, requests } = await ready(t, current, releaseRoutes(t, zip), {}, ["v24.20.0"]);
    await updater.apply();
    assert.equal(updater.status.state, "restarting");
    assert.ok(!requests.some((r) => r.url === NODE_URL));
    assert.equal((readJson(currentFile) as { runtime: string }).runtime, NODE_RUNTIME);
  });

  // 失敗したら、app/tmp/を消し、current.jsonと版のフォルダは変えず、理由を出す
  async function assertFailed(t: TestContext, routes: Routes, message: RegExp, options: Partial<UpdaterOptions> = {}) {
    const current = { app: "0.2.0", pending: false };
    const { dir, currentFile, updater, warnings, restarts } = await ready(t, current, routes, options);
    await updater.apply();
    assert.equal(updater.status.state, "error");
    assert.equal(updater.status.version, "0.3.0");
    assert.match(updater.status.message, /^更新できませんでした: /);
    assert.match(updater.status.message, message);
    assert.match(warnings.join("\n"), message);
    assert.equal(restarts(), 0);
    assert.deepEqual(readJson(currentFile), current);
    assert.ok(!existsSync(path.join(dir, "app", "tmp")));
    assert.deepEqual(ls(path.join(dir, "app", "versions")), ["0.2.0"]);
    assert.deepEqual(ls(path.join(dir, "app", "runtimes")), []);
    return updater;
  }

  test("アプリ部分のZIPのSHA256が一致しなければ中止する", async (t) => {
    const routes = releaseRoutes(t);
    routes[`${DOWNLOAD}/v0.3.0/SHA256SUMS.txt`] = `${"0".repeat(64)}  nijimaku-0.3.0-app.zip\n`;
    await assertFailed(t, routes, /SHA256が一致しません/);
  });

  test("SHA256SUMS.txtにアプリ部分のZIPの行が無ければ中止する", async (t) => {
    const routes = releaseRoutes(t);
    routes[`${DOWNLOAD}/v0.3.0/SHA256SUMS.txt`] = `${"0".repeat(64)}  nijimaku-0.3.0-win-x64.zip\n`;
    await assertFailed(t, routes, /SHA256SUMS\.txtにnijimaku-0\.3\.0-app\.zipの行がありません/);
  });

  test("取得が途中で切れる・上限を超える・時間切れなら中止する", async (t) => {
    const zipUrl = `${DOWNLOAD}/v0.3.0/nijimaku-0.3.0-app.zip`;
    const sumsUrl = `${DOWNLOAD}/v0.3.0/SHA256SUMS.txt`;
    const cut = () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024));
        controller.error(new Error("socket hang up"));
      },
    }));
    const cases: [string, Route, RegExp][] = [
      [zipUrl, cut, /socket hang up/],
      [zipUrl, () => new Response("x", { headers: { "content-length": String(300 * 1024 * 1024) } }), /を超えています/],
      // Content-Lengthが無くても、受け取った量で上限を確かめる（SHA256SUMS.txtは64KBまで）
      [sumsUrl, () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(65 * 1024));
          controller.close();
        },
      })), /64KBを超えています/],
      [zipUrl, () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")), /時間内に取得できませんでした/],
      [zipUrl, () => new Response("gone", { status: 410 }), /HTTP 410/],
    ];
    for (const [url, route, message] of cases) {
      await t.test(String(message), async (t) => {
        await assertFailed(t, { ...releaseRoutes(t), [url]: route }, message);
      });
    }
  });

  test("ZIPに..・絶対パスがあれば展開せずに中止する", async (t) => {
    const cases: [string, string][] = [
      ["dotdot", "../evil"],
      ["absolute", "/tmp/nijimaku-evil"],
    ];
    for (const [name, entry] of cases) {
      await t.test(name, async (t) => {
        const zip = storedZip([
          ["src/server.ts", "\n"],
          ["package.json", JSON.stringify({ version: "0.3.0", nijimaku: { launcher: 1 } })],
          [entry, "evil\n"],
        ]);
        await assertFailed(t, releaseRoutes(t, { zip, sha: sha256(zip) }), new RegExp(`想定外の項目があります: ${entry.replaceAll(".", "\\.")}$`));
      });
    }
    assert.ok(!existsSync("/tmp/nijimaku-evil"));
  });

  test("ZIPの版がタグと違う・src/server.tsが無ければ中止する", async (t) => {
    await assertFailed(t, releaseRoutes(t, appZip(t, { version: "0.3.1" })), /版（0\.3\.1）がタグ（v0\.3\.0）と一致しません/);
    await assertFailed(t, releaseRoutes(t, appZip(t, { server: false })), /src\/server\.tsがありません/);
  });

  test("新しい起動役が要る版なら中止し、全部入りZIPの上書き展開を案内する", async (t) => {
    const updater = await assertFailed(t, releaseRoutes(t, appZip(t, { launcher: 2 })), /全部入りZIPを.*上書き展開してください/);
    assert.equal(updater.status.url, "https://github.com/koguma-inc/nijimaku/releases/tag/v0.3.0");
  });

  test("Node.jsのSHA256が一致しなければ中止する", async (t) => {
    const zip = appZip(t, { runtime: { "win32-x64": { version: "v24.20.0", sha256: sha256("another") } } });
    await assertFailed(t, { ...releaseRoutes(t, zip), [NODE_URL]: NODE_EXE }, /Node\.js（v24\.20\.0）のSHA256が一致しません/);
  });

  test("失敗の後は、もう一度押せば適用できる", async (t) => {
    const routes = releaseRoutes(t);
    const sumsUrl = `${DOWNLOAD}/v0.3.0/SHA256SUMS.txt`;
    const good = routes[sumsUrl]!;
    routes[sumsUrl] = `${"0".repeat(64)}  nijimaku-0.3.0-app.zip\n`;
    const { currentFile, updater, restarts } = await ready(t, { app: "0.2.0" }, routes);
    await updater.apply();
    assert.equal(updater.status.state, "error");
    routes[sumsUrl] = good;
    await updater.apply();
    assert.equal(updater.status.state, "restarting");
    assert.equal(restarts(), 1);
    assert.equal((readJson(currentFile) as { app: string }).app, "0.3.0");
  });

  test("連打や2つの画面からの同時の適用は1つだけ実行し、他は受け付けない", async (t) => {
    const { updater, statuses, restarts } = await ready(t, { app: "0.2.0" }, releaseRoutes(t));
    const first = updater.apply();
    assert.ok(first);
    assert.equal(updater.apply(), null);
    assert.equal(updater.status.state, "downloading");
    await first;
    assert.equal(updater.apply(), null);
    assert.equal(restarts(), 1);
    assert.equal(statuses.filter((s) => s.state === "downloading").length, 1);
  });
});

describe("起動時の初期化", () => {
  test("自分がpendingの版なら解除し、current.jsonが指さない版とNode.jsとapp/tmp/を消す", async (t) => {
    const current = { app: "0.2.0", runtime: "app/runtimes/v24.20.0/node.exe", pending: true, previous: { app: "0.1.0", runtime: "app/runtimes/v24.19.0/node.exe" } };
    const { dir, currentFile } = install(t, current, ["0.0.9", "0.1.0", "0.2.0", "0.3.0"], ["v24.18.0", "v24.19.0", "v24.20.0", "v24.21.0"]);
    put(dir, "app/tmp/stage/src/server.ts", "\n");
    const { updater } = createUpdater(dir, releaseRoutes(t));
    await updater.start();
    const { pending: _, ...rest } = current;
    assert.deepEqual(readJson(currentFile), rest);
    assert.deepEqual(ls(path.join(dir, "app", "versions")), ["0.1.0", "0.2.0"]);
    // v24.21.0は、current.jsonに無くても自分が動いているNode.jsなので残す
    assert.deepEqual(ls(path.join(dir, "app", "runtimes")), ["v24.19.0", "v24.20.0", "v24.21.0"]);
    assert.ok(!existsSync(path.join(dir, "app", "tmp")));
  });

  test("pendingが別の版なら書き換えない", async (t) => {
    const current = { app: "0.3.0", pending: true, previous: { app: "0.2.0" } };
    const { dir, currentFile } = install(t, current, ["0.2.0", "0.3.0"]);
    const { updater } = createUpdater(dir, releaseRoutes(t));
    await updater.start();
    assert.deepEqual(readJson(currentFile), current);
    assert.deepEqual(ls(path.join(dir, "app", "versions")), ["0.2.0", "0.3.0"]);
  });

  test("起動に失敗して戻した版を知らせる", async (t) => {
    const { dir } = install(t, { app: "0.2.0", failed: { app: "0.3.0", at: "2026-10-07T12:00:00.000Z" } }, ["0.2.0", "0.3.0"]);
    const { updater } = createUpdater(dir, releaseRoutes(t));
    await updater.start();
    assert.equal(updater.status.failed, "0.3.0");
    assert.equal(updater.status.state, "available");
  });

  test("消せなかったものは警告して次回に回し、確認へ進む", async (t) => {
    const { dir } = install(t, { app: "0.2.0" }, ["0.1.0", "0.2.0"]);
    const { updater, warnings } = createUpdater(dir, releaseRoutes(t), {
      remove: async (target) => {
        if (path.basename(target) === "0.1.0") throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
        rmSync(target, { recursive: true, force: true });
      },
    });
    await updater.start();
    assert.match(warnings.join("\n"), /消せませんでした（次の起動で消します）: .*0\.1\.0: EBUSY/);
    assert.equal(updater.status.state, "available");
    assert.deepEqual(ls(path.join(dir, "app", "versions")), ["0.1.0", "0.2.0"]);
  });

  test("current.jsonを読めなくても、警告して確認へ進む", async (t) => {
    const { dir } = install(t, "{", ["0.2.0"]);
    writeFileSync(path.join(dir, "app", "current.json"), "{");
    const { updater, warnings } = createUpdater(dir, releaseRoutes(t));
    await updater.start();
    assert.match(warnings.join("\n"), /current\.jsonを読めません/);
    assert.equal(updater.status.state, "available");
  });

  test("後片付けの最中に届いた適用はファイルもcurrent.jsonも変えない", async (t) => {
    const current = { app: "0.2.0", pending: true, previous: { app: "0.1.0" } };
    const { dir, currentFile } = install(t, current, ["0.0.9", "0.1.0", "0.2.0"]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const { updater, requests } = createUpdater(dir, releaseRoutes(t), {
      remove: async (target) => {
        entered();
        await gate;
        rmSync(target, { recursive: true, force: true });
      },
    });
    const started = updater.start();
    await waiting;
    const pendingRemoved = readJson(currentFile);
    assert.equal(updater.apply(), null);
    assert.equal(updater.status.state, "idle");
    assert.equal(requests.length, 0);
    assert.deepEqual(readJson(currentFile), pendingRemoved);
    assert.deepEqual(ls(path.join(dir, "app", "versions")), ["0.0.9", "0.1.0", "0.2.0"]);
    release();
    await started;
    assert.equal(updater.status.state, "available");
  });
});
