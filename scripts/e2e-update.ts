// 配布版の更新（取得・照合・切り替え・再起動・起動の失敗での戻し）を、全部入りZIPから作ったインストール先で端から端まで確かめる。
// Windows固有の動作（実行中のファイル、tar.exe、Node.jsの切り替え）を確かめるため、release.ymlでWindowsのランナーで流す。
// 実行: nr distの後に node scripts/e2e-update.ts
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import WebSocket from "ws";
import { bsdtarPath } from "../src/bsdtar.ts";
import { makeZip } from "./dist.ts";

const ROOT = path.join(import.meta.dirname, "..");
const IS_WINDOWS = process.platform === "win32";
const SHARED_ORIGIN = "https://shared.example";
const API_PATH = "/repos/koguma-inc/nijimaku/releases/latest";
// 更新で切り替えるNode.js。runtime.jsonとは別の実在する版で、sha256は
// https://nodejs.org/dist/v24.20.0/SHASUMS256.txt の win-x64/node.exe の値
const OTHER_NODE = { version: "v24.20.0", sha256: "5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5" };
const FAIL_MESSAGE = "e2e: this version fails before ready";
const STEP_TIMEOUT = 60_000;
// node.exe（約90MB）をnodejs.orgから取る
const DOWNLOAD_TIMEOUT = 180_000;
// ワークフローのtimeout-minutes（15分）で打ち切られる前に、何を待っていたかと起動役の出力を出して終わる
const TOTAL_TIMEOUT = 12 * 60_000;
const POLL_MS = 100;
const RECONNECT_MS = 500;
// 拒否したupdate.applyの後に状態が変わらないことを見届ける時間
const SETTLE_MS = 1500;
// 失敗時に出す、受けたメッセージの種類
const REPORTED_TYPES = new Set(["app", "app.info", "update.status", "update.error"]);

type Message = Record<string, unknown>;
type Match = (message: Message) => boolean;
type Release = { version: string; zip: string; sha256: string };
type Current = { app?: unknown; runtime?: unknown; pending?: unknown; previous?: { app?: unknown }; failed?: { app?: unknown } };
type FakeGitHub = { server: Server; origin: string; requests: string[]; latest: string; brokenSums: boolean };
type Launcher = { child: ChildProcess; output: string; exit: string | null; closed: Promise<void> };

// 想定どおりに進まなかったもの。スタックトレースは出さない
class Failure extends Error {}

const deadline = Date.now() + TOTAL_TIMEOUT;
const conns: Conn[] = [];
let work: string | undefined;
let install: string | undefined;
let fake: FakeGitHub | undefined;
let launcher: Launcher | undefined;

class Conn {
  readonly name: string;
  readonly ws: WebSocket;
  readonly messages: Message[] = [];
  closed = false;
  #cursor = 0;

  constructor(name: string, url: string, origin?: string) {
    this.name = name;
    this.ws = new WebSocket(url, { headers: origin ? { Origin: origin } : {}, handshakeTimeout: 5000 });
    conns.push(this);
    this.ws.on("message", (data) => {
      try {
        const message: unknown = JSON.parse(data.toString());
        if (typeof message === "object" && message !== null && !Array.isArray(message)) this.messages.push(message as Message);
      } catch {}
    });
    this.ws.on("close", () => {
      this.closed = true;
    });
    this.ws.on("error", () => {});
  }

  opened(): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.OPEN) resolve(true);
      else if (this.ws.readyState !== WebSocket.CONNECTING) resolve(false);
      this.ws.once("open", () => resolve(true));
      this.ws.once("close", () => resolve(false));
    });
  }

  send(message: Message): void {
    this.ws.send(JSON.stringify(message));
  }

  // 以降のfind・nextは、これより後に受けたメッセージから探す
  mark(): void {
    this.#cursor = this.messages.length;
  }

  find(match: Match): Message | undefined {
    return this.messages.slice(this.#cursor).find(match);
  }

  // 合うメッセージを待ち、その次から探すように進める
  next(label: string, timeoutMs: number, match: Match): Promise<Message> {
    return until(label, timeoutMs, () => {
      const index = this.messages.findIndex((message, i) => i >= this.#cursor && match(message));
      if (index !== -1) {
        this.#cursor = index + 1;
        return this.messages[index];
      }
      if (this.closed) throw new Failure(`${label}を待つ間に${this.name}の接続が切れました`);
      return undefined;
    });
  }
}

// 切れたらつなぎ直す接続（ページのクライアントと同じ動き）。current()はuntilの確認の中で呼ぶ
class Reconnecting {
  readonly #name: string;
  readonly #url: string;
  readonly #origin: string | undefined;
  #last: Conn | undefined;
  #connecting = false;
  #attemptedAt = 0;

  constructor(name: string, url: string, origin?: string) {
    this.#name = name;
    this.#url = url;
    this.#origin = origin;
  }

  current(): Conn | undefined {
    const last = this.#last;
    if (last && !last.closed) return last;
    if (!this.#connecting && Date.now() - this.#attemptedAt >= RECONNECT_MS) {
      this.#connecting = true;
      this.#attemptedAt = Date.now();
      const conn = new Conn(this.#name, this.#url, this.#origin);
      void conn.opened().then((ok) => {
        if (ok) this.#last = conn;
        this.#connecting = false;
      });
    }
    return undefined;
  }
}

const isType = (type: string): Match => (message) => message.type === type;
const isStatus = (...states: string[]): Match => (message) => message.type === "update.status" && states.includes(String(message.state));

let failed = false;
try {
  await main();
  console.log("更新のE2E: すべての手順が通りました");
} catch (err) {
  failed = true;
  report(err);
} finally {
  await cleanup();
}
process.exitCode = failed ? 1 : 0;
// ハンドルが残っても終わるようにする。process.exit()はパイプへの書き出しを打ち切ることがあるので、すぐには呼ばない
setTimeout(() => process.exit(), 5000).unref();

async function main(): Promise<void> {
  // --- 0. 前提 ---
  const base = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;
  const v1 = bump(base, 1);
  const v2 = bump(base, 2);
  const fullZip = path.join(ROOT, "dist", `nijimaku-${base}-win-x64.zip`);
  const appZip = path.join(ROOT, "dist", appZipName(base));
  for (const zip of [fullZip, appZip]) {
    if (!existsSync(zip)) throw new Failure(`${path.relative(ROOT, zip)}がありません。先にnr distを実行してください`);
  }
  const runtimes = JSON.parse(readFileSync(path.join(ROOT, "runtime.json"), "utf8")) as Record<string, { version: string } | undefined>;
  const bundledNode = runtimes["win32-x64"]?.version;
  check(bundledNode !== OTHER_NODE.version, `runtime.jsonのNode.js（${bundledNode}）と、更新で切り替えるNode.js（OTHER_NODE）が同じです。OTHER_NODEを別の版にしてください`);
  work = mkdtempSync(path.join(process.env.RUNNER_TEMP || tmpdir(), "nijimaku-e2e-"));
  console.log(`作業ディレクトリ: ${work}`);

  // --- 1. インストール先 ---
  install = path.join(work, "install");
  mkdirSync(install);
  tar("-x", "-f", fullZip, "-C", install);
  const currentFile = path.join(install, "app", "current.json");
  const tmpDir = path.join(install, "app", "tmp");
  const readCurrent = (): Current => JSON.parse(readFileSync(currentFile, "utf8")) as Current;
  expect("展開したapp/current.jsonのapp", readCurrent().app, base);
  step(1, `全部入りZIPを展開した（v${base}）`);

  // --- 2. 偽のRelease ---
  // 確認は起動時の1回だけなので、起動役より先に用意する。v2はv1の後に適用するので、同じNode.jsにして取得し直さない
  const releases = [buildRelease(work, appZip, v1, false), buildRelease(work, appZip, v2, true)];
  fake = await startFakeGitHub(releases, v1);
  const port = await freePort();
  launcher = startLauncher(install, port, `${fake.origin}${API_PATH}`);
  step(2, `偽のRelease（v${v1}・v${v2}）を${fake.origin}で返し、起動役を起動した（PORT=${port}）`);

  // --- 3. 新しい版の通知 ---
  const localOrigin = `http://localhost:${port}`;
  const settingsUrl = `ws://127.0.0.1:${port}/ws/settings`;
  const settings = new Reconnecting("/ws/settings（localhost）", settingsUrl, localOrigin);
  let local = await until("/ws/settingsへの接続とapp.info", STEP_TIMEOUT, () => {
    const conn = settings.current();
    return conn?.find(isType("app.info")) ? conn : undefined;
  });
  const baseInfo = local.find(isType("app.info"))!;
  expect("app.infoのversion", baseInfo.version, base);
  expect("app.infoのupdater", baseInfo.updater, true);
  expect("localhostの接続のapp.infoのcanApply", baseInfo.canApply, true);
  const baseNode = baseInfo.nodeVersion;
  expect("app.infoのnodeVersion", baseNode, IS_WINDOWS ? bundledNode : process.version);
  const available = await local.next(`v${v1}のavailable`, STEP_TIMEOUT, isStatus("available", "error"));
  check(available.state === "available", `新しい版の確認に失敗しました: ${String(available.message)}`);
  expect("update.statusのversion", available.version, v1);
  expect("update.statusのurl", available.url, `${fake.origin}/releases/tag/v${v1}`);
  const initialCurrent = readFileSync(currentFile, "utf8");
  step(3, `v${base}（Node.js ${String(baseNode)}）で起動し、v${v1}をavailableで通知した`);

  // --- 4. 共有URLからの適用の拒否 ---
  const shared = new Conn("/ws/settings（共有URL）", settingsUrl, SHARED_ORIGIN);
  check(await shared.opened(), `${SHARED_ORIGIN}のOriginで/ws/settingsへ接続できません`);
  const sharedInfo = await shared.next("共有URLの接続のapp.info", STEP_TIMEOUT, isType("app.info"));
  expect("共有URLの接続のapp.infoのcanApply", sharedInfo.canApply, false);
  local.mark();
  let requested = fake.requests.length;
  shared.send({ type: "update.apply" });
  const rejected = await shared.next("共有URLからのupdate.applyへのupdate.error", STEP_TIMEOUT, isType("update.error"));
  await delay(SETTLE_MS);
  const changed = local.find((message) => message.type === "update.status" && message.state !== "available");
  check(!changed, `共有URLからのupdate.applyで状態が変わりました: ${JSON.stringify(changed)}`);
  check(!fake.requests.slice(requested).some((request) => request.includes("/releases/download/")), "共有URLからのupdate.applyで取得が始まりました");
  check(readFileSync(currentFile, "utf8") === initialCurrent, "共有URLからのupdate.applyでapp/current.jsonが変わりました");
  check(!existsSync(tmpDir), "共有URLからのupdate.applyでapp/tmp/ができました");
  shared.ws.close();
  step(4, `共有URLからのupdate.applyを拒否した（${String(rejected.message)}）`);

  // --- 5. SHA256の不一致 ---
  fake.brokenSums = true;
  local.mark();
  requested = fake.requests.length;
  local.send({ type: "update.apply" });
  const broken = await local.next("SHA256の不一致でのerror", STEP_TIMEOUT, isStatus("error", "restarting"));
  check(broken.state === "error", "SHA256SUMS.txtと一致しないZIPを適用しました");
  expect("errorのupdate.statusのversion", broken.version, v1);
  const zipPath = `/releases/download/v${v1}/${appZipName(v1)}`;
  check(fake.requests.slice(requested).includes(`GET ${zipPath} -> 302`), `${zipPath}を取得していません`);
  check(fake.requests.slice(requested).includes(`GET /assets/v${v1}/${appZipName(v1)} -> 200`), `${zipPath}のリダイレクト先を取得していません`);
  check(readFileSync(currentFile, "utf8") === initialCurrent, "SHA256の不一致でapp/current.jsonが変わりました");
  await until("SHA256の不一致の後にapp/tmp/が消える", STEP_TIMEOUT, () => !existsSync(tmpDir) || undefined);
  fake.brokenSums = false;
  step(5, `SHA256の不一致で中止し、元のままだった（${String(broken.message)}）`);

  // --- 6. 更新 ---
  const overlayUrl = `ws://127.0.0.1:${port}/ws/overlay`;
  const overlay = new Reconnecting("/ws/overlay", overlayUrl);
  const overlayFirst = await until("/ws/overlayへの接続と最初のメッセージ", STEP_TIMEOUT, () => {
    const conn = overlay.current();
    return conn && conn.messages.length > 0 ? conn : undefined;
  });
  expect("/ws/overlayの最初のメッセージ", pick(overlayFirst.messages[0], "type", "version"), { type: "app", version: base });
  local.mark();
  local.send({ type: "update.apply" });
  await expectState(local, `v${v1}の適用でのdownloading`, "downloading", STEP_TIMEOUT);
  await expectState(local, `v${v1}の適用でのrestarting`, "restarting", DOWNLOAD_TIMEOUT);
  // 再起動したv1は起動時に1回だけ確認するので、それより前に切り替える
  fake.latest = v2;
  await until("再起動で/ws/settingsが切れる", STEP_TIMEOUT, () => local.closed || undefined);
  local = await until(`再起動後の/ws/settingsのapp.info（v${v1}）`, STEP_TIMEOUT, () => {
    const conn = settings.current();
    return conn?.find((message) => message.type === "app.info" && message.version === v1) ? conn : undefined;
  });
  const v1Node = local.find(isType("app.info"))!.nodeVersion;
  if (IS_WINDOWS) {
    expect("更新後のapp.infoのnodeVersion", v1Node, OTHER_NODE.version);
  } else {
    expect("更新後のapp.infoのnodeVersion", v1Node, baseNode);
    console.log(`    Windows以外ではruntime.jsonに${process.platform}-${process.arch}の項目が無いため、Node.jsの切り替えの確認を飛ばした`);
  }
  const updated = readCurrent();
  expect("更新後のapp/current.jsonのapp", updated.app, v1);
  expect("更新後のapp/current.jsonのprevious.app", updated.previous?.app, base);
  const runtime = IS_WINDOWS ? `app/runtimes/${OTHER_NODE.version}/node.exe` : undefined;
  expect("更新後のapp/current.jsonのruntime", updated.runtime, runtime);
  if (runtime) check(existsSync(path.join(install, runtime)), `${runtime}がありません`);
  await until(`/ws/overlayの再接続とv${v1}のapp`, STEP_TIMEOUT, () => {
    const conn = overlay.current();
    const first = conn?.messages[0];
    return conn !== overlayFirst && first?.type === "app" && first.version === v1 ? conn : undefined;
  });
  step(6, `v${v1}（Node.js ${String(v1Node)}）で起動し直し、/ws/overlayも再接続してv${v1}を受けた`);

  // --- 7. 起動の失敗での戻し ---
  const available2 = await local.next(`v${v2}のavailable`, STEP_TIMEOUT, isStatus("available", "error"));
  check(available2.state === "available", `v${v2}の確認に失敗しました: ${String(available2.message)}`);
  expect("update.statusのversion", available2.version, v2);
  // 確認は起動時の初期化の後なので、pendingはもう外れている
  expect("v1の初期化の後のapp/current.jsonのpending", readCurrent().pending, undefined);
  local.mark();
  local.send({ type: "update.apply" });
  await expectState(local, `v${v2}の適用でのrestarting`, "restarting", DOWNLOAD_TIMEOUT);
  await until("再起動で/ws/settingsが切れる", STEP_TIMEOUT, () => local.closed || undefined);
  // 再起動前と同じv1なので、app.infoの版ではなくfailedで戻した後のサーバーと見分ける
  local = await until(`v${v2}から戻した後の/ws/settings（app.infoがv${v1}、failedがv${v2}）`, STEP_TIMEOUT, () => {
    const conn = settings.current();
    const ok = conn?.find((message) => message.type === "app.info" && message.version === v1) && conn.find((message) => message.type === "update.status" && message.failed === v2);
    return ok ? conn : undefined;
  });
  check(launcher.output.includes(FAIL_MESSAGE), `v${v2}を起動していません（起動役の出力に「${FAIL_MESSAGE}」がありません）`);
  check(launcher.output.includes(`Nijimaku ${v2} failed to start. Rolling back to ${v1}.`), "起動役が戻したことを出力していません");
  const rolledBack = readCurrent();
  expect("戻した後のapp/current.jsonのapp", rolledBack.app, v1);
  expect("戻した後のapp/current.jsonのfailed.app", rolledBack.failed?.app, v2);
  expect("戻した後のapp/current.jsonのruntime", rolledBack.runtime, runtime);
  const rolledBackNode = local.find(isType("app.info"))!.nodeVersion;
  expect("戻した後のapp.infoのnodeVersion", rolledBackNode, v1Node);
  step(7, `v${v2}がready前に落ち、起動役がv${v1}（Node.js ${String(rolledBackNode)}）へ戻してfailedを通知した`);
}

function step(n: number, message: string): void {
  console.log(`[${n}] ${message}`);
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new Failure(message);
}

function expect(label: string, actual: unknown, expected: unknown): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Failure(`${label}: ${JSON.stringify(expected)}のはずが${JSON.stringify(actual)}でした`);
}

function pick(message: Message | undefined, ...keys: string[]): Message | undefined {
  return message && Object.fromEntries(keys.map((key) => [key, message[key]]));
}

// 適用の途中の状態を待つ。errorになったら理由を出してすぐ終わる
async function expectState(conn: Conn, label: string, state: string, timeoutMs: number): Promise<void> {
  const status = await conn.next(label, timeoutMs, isStatus(state, "error"));
  check(status.state === state, `${label}を待つ間に適用に失敗しました: ${String(status.message)}`);
}

// probeがundefined以外を返すまで待つ。起動役が終わったら、その時点で失敗にする
async function until<T>(label: string, timeoutMs: number, probe: () => T | undefined): Promise<T> {
  const end = Math.min(Date.now() + timeoutMs, deadline);
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (launcher?.exit) throw new Failure(`${label}を待つ間に起動役が終了しました（${launcher.exit}）`);
    if (Date.now() >= end) {
      throw new Failure(end === deadline ? `全体の上限（${TOTAL_TIMEOUT / 60_000}分）に達しました。${label}を待っていました` : `${label}を${timeoutMs / 1000}秒待ちましたが、そうなりませんでした`);
    }
    await delay(POLL_MS);
  }
}

function bump(version: string, patch: number): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Failure(`package.jsonのversionの形が違います: ${version}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + patch}`;
}

function appZipName(version: string): string {
  return `nijimaku-${version}-app.zip`;
}

function tar(...args: string[]): void {
  execFileSync(bsdtarPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

// ビルドしたアプリ部分のZIPから、versionの版のZIPを作り直す
function buildRelease(work: string, appZip: string, version: string, failBeforeReady: boolean): Release {
  const stage = path.join(work, "build", version);
  mkdirSync(stage, { recursive: true });
  tar("-x", "-f", appZip, "-C", stage);
  const manifestFile = path.join(stage, "package.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
  writeFileSync(manifestFile, JSON.stringify({ ...manifest, version }, null, 2) + "\n");
  writeFileSync(path.join(stage, "runtime.json"), JSON.stringify({ "win32-x64": OTHER_NODE }, null, 2) + "\n");
  if (failBeforeReady) {
    const server = path.join(stage, "src", "server.ts");
    writeFileSync(server, `throw new Error(${JSON.stringify(FAIL_MESSAGE)});\n${readFileSync(server, "utf8")}`);
  }
  const zip = path.join(work, "release", appZipName(version));
  mkdirSync(path.dirname(zip), { recursive: true });
  makeZip(stage, zip);
  return { version, zip, sha256: sha256(readFileSync(zip)) };
}

// GitHubのReleaseの代わり。latestとbrokenSumsは途中で切り替える
async function startFakeGitHub(releases: Release[], latest: string): Promise<FakeGitHub> {
  const byVersion = new Map(releases.map((release) => [release.version, release]));
  const fake: FakeGitHub = { server: createServer(), origin: "", requests: [], latest, brokenSums: false };
  const asset = (version: string, name: string): Buffer | string | undefined => {
    const release = byVersion.get(version);
    if (!release) return undefined;
    if (name === appZipName(version)) return readFileSync(release.zip);
    if (name !== "SHA256SUMS.txt") return undefined;
    const hash = fake.brokenSums ? sha256(release.sha256) : release.sha256;
    // 本物と同じく全部入りZIPの行も置く（その値は使われない）
    return `${"0".repeat(64)}  nijimaku-${version}-win-x64.zip\n${hash}  ${appZipName(version)}\n`;
  };
  fake.server.on("request", (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const reply = (status: number, headers: Record<string, string | number> = {}, body?: Buffer | string): void => {
      fake.requests.push(`${req.method} ${pathname} -> ${status}`);
      res.writeHead(status, headers).end(body);
    };
    if (req.method !== "GET") return reply(405);
    if (pathname === API_PATH) return reply(200, { "Content-Type": "application/json" }, JSON.stringify(releaseJson(fake.origin, fake.latest)));
    // GitHubと同じく、添付は別の場所へ302で転送する
    const download = /^\/releases\/download\/v([^/]+)\/([^/]+)$/.exec(pathname);
    if (download && byVersion.has(download[1]!) && (download[2] === appZipName(download[1]!) || download[2] === "SHA256SUMS.txt")) {
      return reply(302, { Location: `${fake.origin}/assets/v${download[1]}/${download[2]}` });
    }
    const assetPath = /^\/assets\/v([^/]+)\/([^/]+)$/.exec(pathname);
    const body = assetPath ? asset(assetPath[1]!, assetPath[2]!) : undefined;
    if (body !== undefined) return reply(200, { "Content-Type": "application/octet-stream", "Content-Length": Buffer.byteLength(body) }, body);
    reply(404);
  });
  fake.server.listen(0, "127.0.0.1");
  await once(fake.server, "listening");
  fake.origin = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  return fake;
}

function releaseJson(origin: string, version: string): unknown {
  const names = [`nijimaku-${version}-win-x64.zip`, appZipName(version), "SHA256SUMS.txt"];
  return {
    tag_name: `v${version}`,
    html_url: `${origin}/releases/tag/v${version}`,
    assets: names.map((name) => ({ name, browser_download_url: `${origin}/releases/download/v${version}/${name}` })),
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

function startLauncher(installDir: string, port: number, updateApi: string): Launcher {
  const child = spawn(IS_WINDOWS ? path.join(installDir, "node", "node.exe") : process.execPath, [path.join("app", "launcher.ts")], {
    cwd: installDir,
    env: { ...process.env, PORT: String(port), OPENAI_API_KEY: "", ALLOWED_ORIGINS: SHARED_ORIGIN, NIJIMAKU_UPDATE_API: updateApi },
    stdio: ["ignore", "pipe", "pipe"],
    // 後片付けで、起動役とサーバー（子）をプロセスグループごと止める
    detached: !IS_WINDOWS,
    windowsHide: true,
  });
  const started: Launcher = { child, output: "", exit: null, closed: new Promise((resolve) => child.on("close", () => resolve())) };
  for (const stream of [child.stdout!, child.stderr!]) {
    stream.setEncoding("utf8");
    stream.on("data", (data: string) => {
      started.output += data;
    });
  }
  child.on("error", (err) => {
    started.exit = `起動できません: ${err.message}`;
  });
  child.on("exit", (code, signal) => {
    started.exit = `終了コード ${code ?? signal}`;
  });
  return started;
}

function report(err: unknown): void {
  console.error(`\n失敗: ${err instanceof Failure ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  if (launcher) console.error(`\n--- 起動役の出力 ---\n${launcher.output}`);
  if (fake) console.error(`\n--- 偽のReleaseへのリクエスト ---\n${fake.requests.join("\n")}`);
  for (const conn of conns) {
    const lines = conn.messages.filter((message) => REPORTED_TYPES.has(String(message.type))).map((message) => JSON.stringify(message));
    if (lines.length > 0) console.error(`\n--- ${conn.name}で受けたメッセージ ---\n${lines.join("\n")}`);
  }
  if (!install) return;
  const currentFile = path.join(install, "app", "current.json");
  if (existsSync(currentFile)) console.error(`\n--- app/current.json ---\n${readFileSync(currentFile, "utf8")}`);
  for (const dir of ["versions", "runtimes", "tmp"]) {
    const full = path.join(install, "app", dir);
    console.error(`app/${dir}/: ${existsSync(full) ? readdirSync(full).join(", ") || "（空）" : "（無い）"}`);
  }
}

async function cleanup(): Promise<void> {
  for (const conn of conns) conn.ws.terminate();
  if (launcher) await stopLauncher(launcher);
  if (fake) {
    fake.server.closeAllConnections();
    fake.server.close();
  }
  if (work) {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      console.warn(`作業ディレクトリを消せませんでした: ${work}（${(err as Error).message}）`);
    }
  }
}

async function stopLauncher({ child, closed }: Launcher): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (IS_WINDOWS) {
      execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    // 既に終わっている
  }
  // 子が起動役から受け継いだパイプを閉じるまでcloseは来ないので、closeで子の終了も待てる
  if (await within(closed, 10_000)) return;
  if (!IS_WINDOWS) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  if (!(await within(closed, 5000))) console.warn(`起動役（pid ${pid}）が終わりません`);
}

function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
