// 配布版の更新機能。起動時に新しい版を確かめ、利用者の操作で、アプリ部分（必要ならNode.jsも）を取得・照合して
// app/versions/へ置き、app/current.jsonを切り替えて終了コード75で終わる（起動役が読み直して起動し直す）。
// 起動役から起動されたとき（NIJIMAKU_LAUNCHER=1）だけ使う。起動役との約束はnote/design.mdの「配布版の起動役」。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { bsdtarPath } from "./bsdtar.ts";
// launch-state.tsは起動役と一緒にapp/にだけ置かれ、版のフォルダには入らない。型だけを使い、読み書きはここで持つ
import type { CurrentState, Target } from "./launch-state.ts";

const REPO = "koguma-inc/nijimaku";
const DEFAULT_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const RELEASE_PREFIX = `https://github.com/${REPO}/releases/`;

const CHECK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const RELEASE_LIMIT = 1024 * 1024;
const SUMS_LIMIT = 64 * 1024;
const ZIP_LIMIT = 200 * 1024 * 1024;
const NODE_LIMIT = 200 * 1024 * 1024;

const VERSION = /^\d+\.\d+\.\d+$/;
const TAG = /^v(\d+\.\d+\.\d+)$/;
const NODE_VERSION = /^v\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
// 起動役（launch-state.ts）と同じ形だけを受け付ける
const RUNTIME = /^app\/runtimes\/(v\d+\.\d+\.\d+)\/node\.exe$/;
const APP_ROOTS = new Set(["src", "public", "node_modules", "package.json", "runtime.json"]);
// runtime.jsonの項目ごとの、nodejs.orgでのnode.exeの場所
const NODE_DIST: Record<string, string> = { "win32-x64": "win-x64/node.exe" };

const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 100;

export type UpdateState = "idle" | "checking" | "available" | "downloading" | "restarting" | "error";

export type UpdateStatus = {
  state: UpdateState;
  // 新しい版と、変更点（Release）のURL
  version: string | null;
  url: string | null;
  message: string;
  // 起動に失敗したため起動役が戻した版
  failed: string | null;
};

export type Release = { version: string; url: string; zipName: string; zipUrl: string; sumsUrl: string };

export type UpdaterOptions = {
  // インストール先（NIJIMAKU_DATA_DIR）。触るのはこの下のapp/だけ
  installDir: string;
  version: string;
  // 起動役のプロトコルの版（NIJIMAKU_LAUNCHER）
  launcher: number;
  // テスト用の取得先（NIJIMAKU_UPDATE_API）
  apiUrl?: string;
  fetch?: typeof fetch;
  tar?: string;
  // runtime.jsonの項目名（`${process.platform}-${process.arch}`）
  platform?: string;
  nodeVersion?: string;
  remove?: (target: string) => Promise<void>;
  onStatus: (status: UpdateStatus) => void;
  onRestart: () => void;
  warn: (message: string) => void;
};

const execFileAsync = promisify(execFile);

export class Updater {
  #status: UpdateStatus = { state: "idle", version: null, url: null, message: "", failed: null };
  #release: Release | null = null;
  readonly #installDir: string;
  readonly #appDir: string;
  readonly #currentFile: string;
  readonly #version: string;
  readonly #launcher: number;
  readonly #apiUrl: string;
  readonly #prefixes: { download: string; release: string };
  readonly #fetch: typeof fetch;
  readonly #tar: string;
  readonly #platform: string;
  readonly #nodeVersion: string;
  readonly #remove: (target: string) => Promise<void>;
  readonly #onStatus: (status: UpdateStatus) => void;
  readonly #onRestart: () => void;
  readonly #warn: (message: string) => void;

  constructor(options: UpdaterOptions) {
    this.#installDir = options.installDir;
    this.#appDir = path.join(options.installDir, "app");
    this.#currentFile = path.join(this.#appDir, "current.json");
    this.#version = options.version;
    this.#launcher = options.launcher;
    this.#apiUrl = options.apiUrl ?? DEFAULT_API;
    // 取得先を差し替えたときは、添付とReleaseのURLもその取得先にあるものだけを受け付ける
    if (options.apiUrl === undefined) {
      this.#prefixes = { download: DOWNLOAD_PREFIX, release: RELEASE_PREFIX };
    } else {
      const origin = `${new URL(options.apiUrl).origin}/`;
      this.#prefixes = { download: origin, release: origin };
    }
    this.#fetch = options.fetch ?? fetch;
    this.#tar = options.tar ?? bsdtarPath();
    this.#platform = options.platform ?? `${process.platform}-${process.arch}`;
    this.#nodeVersion = options.nodeVersion ?? process.version;
    this.#remove = options.remove ?? ((target) => rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
    this.#onStatus = options.onStatus;
    this.#onRestart = options.onRestart;
    this.#warn = options.warn;
  }

  get status(): UpdateStatus {
    return this.#status;
  }

  // readyの後に1回だけ呼ぶ。初期化（pendingの解除・後片付け・failedの通知）を終えてから確認を始める。
  // 適用は確認の結果を待つので、後片付けと適用は重ならない
  async start(): Promise<void> {
    await this.#init();
    await this.#check();
  }

  // 受け付けたら完了を待つPromise（失敗も状態で知らせ、rejectしない）を、受け付けなければnullを返す。
  // 受け付けるのは確認で新しい版が分かった後だけで、初期化中・確認中・適用中は今の状態のまま
  apply(): Promise<void> | null {
    const release = this.#release;
    if (!release || (this.#status.state !== "available" && this.#status.state !== "error")) return null;
    this.#set({ state: "downloading", message: "" });
    return this.#apply(release);
  }

  #set(patch: Partial<UpdateStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.#onStatus(this.#status);
  }

  async #init(): Promise<void> {
    let state: CurrentState;
    try {
      state = readCurrent(this.#currentFile);
    } catch (err) {
      this.#warn(`app/current.jsonを読めません: ${errorText(err)}`);
      return;
    }
    if (state.pending === true && state.app === this.#version) {
      const { pending: _, ...rest } = state;
      try {
        await writeCurrent(this.#currentFile, rest);
      } catch (err) {
        this.#warn(`app/current.jsonを書けません: ${errorText(err)}`);
      }
    }
    await this.#cleanup();
    if (state.failed) this.#set({ failed: state.failed.app });
  }

  // current.jsonが指さない版とNode.jsを消す。消せなかったものは次の起動で消す
  async #cleanup(): Promise<void> {
    try {
      const state = readCurrent(this.#currentFile);
      const apps = new Set([this.#version, state.app]);
      if (state.previous) apps.add(state.previous.app);
      // 自分が動いているNode.jsは、current.jsonに無くても消さない
      const runtimes = new Set([this.#nodeVersion]);
      for (const runtime of [state.runtime, state.previous?.runtime]) {
        const version = runtime === undefined ? undefined : RUNTIME.exec(runtime)?.[1];
        if (version) runtimes.add(version);
      }
      for (const [dir, keep] of [["versions", apps], ["runtimes", runtimes]] as const) {
        const full = path.join(this.#appDir, dir);
        if (!existsSync(full)) continue;
        for (const name of readdirSync(full)) {
          if (!keep.has(name)) await this.#tryRemove(path.join(full, name));
        }
      }
    } catch (err) {
      this.#warn(`使っていない版を消せませんでした: ${errorText(err)}`);
    }
    await this.#tryRemove(path.join(this.#appDir, "tmp"));
  }

  async #tryRemove(target: string): Promise<void> {
    try {
      await this.#remove(target);
    } catch (err) {
      this.#warn(`消せませんでした（次の起動で消します）: ${path.relative(this.#installDir, target)}: ${errorText(err)}`);
    }
  }

  async #check(): Promise<void> {
    this.#set({ state: "checking", version: null, url: null, message: "" });
    let data: unknown;
    try {
      const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
      const body = await this.#get(this.#apiUrl, RELEASE_LIMIT, CHECK_TIMEOUT_MS, headers);
      data = JSON.parse(body.toString("utf8"));
    } catch (err) {
      this.#warn(`新しい版を確認できませんでした: ${errorText(err)}`);
      this.#set({ state: "error", message: "新しい版を確認できませんでした" });
      return;
    }
    const { release, warning } = parseRelease(data, this.#version, this.#prefixes);
    if (warning) this.#warn(warning);
    this.#release = release;
    if (release) this.#set({ state: "available", version: release.version, url: release.url });
    else this.#set({ state: "idle" });
  }

  async #apply(release: Release): Promise<void> {
    const tmp = path.join(this.#appDir, "tmp");
    try {
      const current = readCurrent(this.#currentFile);
      if (current.app !== this.#version) throw new Error(`app/current.jsonが今の版（${this.#version}）を指していません`);
      if (release.version === this.#version) throw new Error("今の版と同じ版は適用できません");
      await this.#remove(tmp);
      mkdirSync(tmp, { recursive: true });

      const sums = parseSums((await this.#get(release.sumsUrl, SUMS_LIMIT, DOWNLOAD_TIMEOUT_MS)).toString("utf8"));
      const expected = sums.get(release.zipName);
      if (!expected) throw new Error(`SHA256SUMS.txtに${release.zipName}の行がありません`);
      const zip = path.join(tmp, release.zipName);
      if ((await this.#download(release.zipUrl, zip, ZIP_LIMIT)) !== expected) {
        throw new Error(`${release.zipName}のSHA256が一致しません`);
      }

      const { stdout } = await execFileAsync(this.#tar, ["-t", "-f", zip], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const bad = findBadEntry(stdout.split(/\r?\n/).filter((line) => line !== ""));
      if (bad !== null) throw new Error(`${release.zipName}に想定外の項目があります: ${bad}`);
      const stage = path.join(tmp, "stage");
      mkdirSync(stage);
      await execFileAsync(this.#tar, ["-x", "-f", zip, "-C", stage]);

      const manifest = readManifest(stage);
      if (manifest.version !== release.version) throw new Error(`${release.zipName}の版（${manifest.version}）がタグ（v${release.version}）と一致しません`);
      if (!existsSync(path.join(stage, "src", "server.ts"))) throw new Error(`${release.zipName}にsrc/server.tsがありません`);
      if (manifest.launcher > this.#launcher) {
        throw new Error(`v${release.version}には新しい起動役が要ります。Releaseのページから全部入りZIPをダウンロードし、今のフォルダに上書き展開してください`);
      }

      const runtime = await this.#prepareRuntime(stage, tmp, current);
      const versionsDir = path.join(this.#appDir, "versions");
      const dest = path.join(versionsDir, release.version);
      // 前回の失敗の残りがあれば置き換える
      await this.#remove(dest);
      mkdirSync(versionsDir, { recursive: true });
      await renameWithRetry(stage, dest);

      // ここで初めて切り替わる。failedは消す
      const next: CurrentState = { ...target(release.version, runtime), pending: true, previous: target(this.#version, current.runtime) };
      await writeCurrent(this.#currentFile, next);
    } catch (err) {
      const message = `更新できませんでした: ${errorText(err)}`;
      this.#warn(message);
      await this.#tryRemove(tmp);
      this.#set({ state: "error", message });
      return;
    }
    this.#set({ state: "restarting", message: "" });
    this.#onRestart();
  }

  // 新しい版が使うNode.jsの、インストール先からの相対パスを返す（undefinedは起動役自身のNode.js）
  async #prepareRuntime(stage: string, tmp: string, current: CurrentState): Promise<string | undefined> {
    const entry = readRuntimeEntry(stage, this.#platform);
    // まだ配っていないOS（Mac等）と、同じ版のNode.jsは今のまま
    if (entry === undefined || entry.version === this.#nodeVersion) return current.runtime;
    const runtime = `app/runtimes/${entry.version}/node.exe`;
    const exe = path.join(this.#installDir, ...runtime.split("/"));
    if (existsSync(exe) && (await sha256File(exe)) === entry.sha256) return runtime;
    if (runtime === current.runtime || runtime === current.previous?.runtime) {
      throw new Error(`使用中のNode.js（${entry.version}）のSHA256が一致しません`);
    }
    const dist = NODE_DIST[this.#platform];
    if (!dist) throw new Error(`このOS（${this.#platform}）のNode.jsの取得に対応していません`);
    const downloaded = path.join(tmp, "node.exe");
    if ((await this.#download(`https://nodejs.org/dist/${entry.version}/${dist}`, downloaded, NODE_LIMIT)) !== entry.sha256) {
      throw new Error(`Node.js（${entry.version}）のSHA256が一致しません`);
    }
    await this.#remove(path.dirname(exe));
    mkdirSync(path.dirname(exe), { recursive: true });
    await renameWithRetry(downloaded, exe);
    return runtime;
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    // GitHubのAPIはUser-Agentが無いと拒否する
    return { "User-Agent": `nijimaku/${this.#version}`, ...extra };
  }

  // リダイレクトは追う（Releaseの添付は別のホストの署名付きURLへ転送される）
  async #stream(url: string, limit: number, timeoutMs: number, headers: Record<string, string>, onChunk: (chunk: Uint8Array) => Promise<void> | void): Promise<void> {
    const res = await this.#fetch(url, { headers: this.#headers(headers), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}（${url}）`);
    const tooLarge = () => new Error(`${Math.round(limit / 1024)}KBを超えています（${url}）`);
    if (Number(res.headers.get("content-length")) > limit) throw tooLarge();
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > limit) throw tooLarge();
      await onChunk(chunk);
    }
  }

  async #get(url: string, limit: number, timeoutMs: number, headers: Record<string, string> = {}): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    await this.#stream(url, limit, timeoutMs, headers, (chunk) => {
      chunks.push(chunk);
    });
    return Buffer.concat(chunks);
  }

  // fileへ保存し、SHA256（16進）を返す
  async #download(url: string, file: string, limit: number): Promise<string> {
    const hash = createHash("sha256");
    const handle = await open(file, "w");
    try {
      await this.#stream(url, limit, DOWNLOAD_TIMEOUT_MS, {}, async (chunk) => {
        hash.update(chunk);
        await handle.write(chunk);
      });
    } finally {
      await handle.close();
    }
    return hash.digest("hex");
  }
}

// GitHubのreleases/latestの応答から、今の版より新しい版を取り出す。
// 新しくなければrelease: null。形が想定と違えば通知せず、warningに理由を返す
export function parseRelease(data: unknown, current: string, prefixes: { download: string; release: string }): { release: Release | null; warning: string | null } {
  const none = (warning: string | null = null) => ({ release: null, warning });
  if (!isObject(data) || typeof data.tag_name !== "string") return none("Releaseの応答にtag_nameがありません");
  const version = TAG.exec(data.tag_name)?.[1];
  if (!version) return none(`Releaseのタグの形が違います: ${data.tag_name}`);
  if (compareVersions(version, current) <= 0) return none();
  if (typeof data.html_url !== "string" || !data.html_url.startsWith(prefixes.release)) {
    return none(`ReleaseのURLが想定と違います: ${String(data.html_url)}`);
  }
  const zipName = `nijimaku-${version}-app.zip`;
  const urls = new Map<string, string>();
  for (const asset of Array.isArray(data.assets) ? data.assets : []) {
    if (isObject(asset) && typeof asset.name === "string" && typeof asset.browser_download_url === "string") {
      urls.set(asset.name, asset.browser_download_url);
    }
  }
  const zipUrl = urls.get(zipName);
  const sumsUrl = urls.get("SHA256SUMS.txt");
  if (!zipUrl || !sumsUrl) return none(`v${version}の添付に${zipName}とSHA256SUMS.txtがありません`);
  for (const url of [zipUrl, sumsUrl]) {
    if (!url.startsWith(prefixes.download)) return none(`v${version}の添付のURLが想定と違います: ${url}`);
  }
  return { release: { version, url: data.html_url, zipName, zipUrl, sumsUrl }, warning: null };
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  }
  return 0;
}

// sha256sumの形式（`<hex>  <ファイル名>`。バイナリの印の`*`も許す）
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (m) sums.set(m[2]!, m[1]!.toLowerCase());
  }
  return sums;
}

// アプリ部分のZIPのエントリー（tar -tの出力）で、展開してはいけないものを返す。無ければnull
export function findBadEntry(entries: string[]): string | null {
  for (const entry of entries) {
    const parts = entry.split("/");
    if (entry.startsWith("/") || entry.includes("\\") || /^[A-Za-z]:/.test(entry) || parts.includes("..") || !APP_ROOTS.has(parts[0]!)) {
      return entry;
    }
  }
  return null;
}

function readManifest(stage: string): { version: string; launcher: number } {
  const data: unknown = JSON.parse(readFileSync(path.join(stage, "package.json"), "utf8"));
  if (!isObject(data) || typeof data.version !== "string" || !isObject(data.nijimaku) || !Number.isInteger(data.nijimaku.launcher)) {
    throw new Error("package.jsonにversionとnijimaku.launcherがありません");
  }
  return { version: data.version, launcher: data.nijimaku.launcher as number };
}

function readRuntimeEntry(stage: string, platform: string): { version: string; sha256: string } | undefined {
  const data: unknown = JSON.parse(readFileSync(path.join(stage, "runtime.json"), "utf8"));
  if (!isObject(data)) throw new Error("runtime.jsonの形式が違います");
  const entry = data[platform];
  if (entry === undefined) return undefined;
  if (!isObject(entry) || typeof entry.version !== "string" || !NODE_VERSION.test(entry.version) || typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) {
    throw new Error(`runtime.jsonの${platform}の形式が違います`);
  }
  return { version: entry.version, sha256: entry.sha256 };
}

async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function target(app: string, runtime: string | undefined): Target {
  return runtime === undefined ? { app } : { app, runtime };
}

// 起動役（launch-state.tsのparseCurrent）が受け付ける形だけを読む
export function readCurrent(file: string): CurrentState {
  const data: unknown = JSON.parse(readFileSync(file, "utf8"));
  const state: CurrentState = parseTarget(data, "");
  if (!isObject(data)) throw new Error("JSONのオブジェクトではありません");
  if (data.pending !== undefined) {
    if (typeof data.pending !== "boolean") throw new Error("pendingの形式が違います");
    state.pending = data.pending;
  }
  if (data.previous !== undefined) state.previous = parseTarget(data.previous, "previous.");
  if (data.failed !== undefined) {
    if (!isObject(data.failed) || typeof data.failed.app !== "string" || !VERSION.test(data.failed.app) || typeof data.failed.at !== "string") {
      throw new Error("failedの形式が違います");
    }
    state.failed = { app: data.failed.app, at: data.failed.at };
  }
  return state;
}

function parseTarget(data: unknown, prefix: string): Target {
  if (!isObject(data) || typeof data.app !== "string" || !VERSION.test(data.app)) throw new Error(`${prefix}appの形式が違います`);
  if (data.runtime === undefined) return { app: data.app };
  if (typeof data.runtime !== "string" || !RUNTIME.test(data.runtime)) throw new Error(`${prefix}runtimeの形式が違います`);
  return { app: data.app, runtime: data.runtime };
}

// 起動役と同じく、一時ファイルに書いてからrenameで置き換える（途中で落ちても壊れたファイルを残さない）
export async function writeCurrent(file: string, state: CurrentState): Promise<void> {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { flush: true });
  await renameWithRetry(tmp, file);
}

// Windowsではウイルス対策ソフトが新しいファイルを一時的に掴み、renameがEPERM/EBUSYになることがある
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let retry = 0; ; retry++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EBUSY") || retry >= RENAME_RETRIES) throw err;
      await delay(RENAME_RETRY_MS);
    }
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "時間内に取得できませんでした";
  if (err instanceof Error) {
    // fetchの失敗はTypeError("fetch failed")で、理由はcauseにある
    const cause = err.cause instanceof Error ? `（${err.cause.message}）` : "";
    return `${err.message}${cause}`;
  }
  return String(err);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
