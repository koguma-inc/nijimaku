// 起動役（launcher.ts）が使う、app/current.jsonの読み書きと、子の終了から次の動作を決める判定。
// 起動役と一緒にapp/へ置かれ更新では差し替えないため、node:の標準モジュールだけを使い、相対importをしない。
// 起動役が出すメッセージはcmd.exeのコンソールで文字化けしないよう英語にする。
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// アプリの版と、それを動かすNode.jsの組。runtimeはインストール先からの相対パスで、省略時は起動役自身のNode.js
export type Target = { app: string; runtime?: string };

export type CurrentState = Target & {
  // 切り替えた後、まだ一度もreadyに達していない
  pending?: boolean;
  // 起動の失敗で戻す先
  previous?: Target;
  // 直前に起動に失敗して戻した版（画面の通知用）
  failed?: { app: string; at: string };
};

// codeがnullならシグナルでの終了
export type ChildExit = { code: number | null; ready: boolean };

export type NextAction =
  | { type: "restart" }
  | { type: "rollback"; state: CurrentState }
  | { type: "exit"; code: number };

// 子の終了コード（プロトコル1）
const EXIT_OK = 0;
const EXIT_RESTART = 75;
const EXIT_NOT_VERSION_FAULT = 78;

// パスの組み立てに使うので、この形に合うものだけ受け付ける
const VERSION = /^\d+\.\d+\.\d+$/;
const RUNTIME = /^app\/runtimes\/v\d+\.\d+\.\d+\/node\.exe$/;

const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 100;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseVersion(value: unknown, name: string): string {
  if (typeof value !== "string" || !VERSION.test(value)) throw new Error(`${name} must be a version like "1.2.3"`);
  return value;
}

function parseTarget(data: Record<string, unknown>, prefix: string): Target {
  const target: Target = { app: parseVersion(data.app, `${prefix}app`) };
  if (data.runtime !== undefined) {
    if (typeof data.runtime !== "string" || !RUNTIME.test(data.runtime)) {
      throw new Error(`${prefix}runtime must be a path like "app/runtimes/v24.0.0/node.exe"`);
    }
    target.runtime = data.runtime;
  }
  return target;
}

// 不正なら理由を英語で投げる。
// 起動役は更新で差し替えないので、新しい版が足した項目は拒まずに無視する（起動役が戻しで書くときには消える）
export function parseCurrent(text: string): CurrentState {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON (${(err as Error).message})`);
  }
  if (!isObject(data)) throw new Error("not a JSON object");
  const state: CurrentState = parseTarget(data, "");
  if (data.pending !== undefined) {
    if (typeof data.pending !== "boolean") throw new Error("pending must be true or false");
    state.pending = data.pending;
  }
  if (data.previous !== undefined) {
    if (!isObject(data.previous)) throw new Error("previous must be an object");
    state.previous = parseTarget(data.previous, "previous.");
  }
  if (data.failed !== undefined) {
    if (!isObject(data.failed)) throw new Error("failed must be an object");
    if (typeof data.failed.at !== "string") throw new Error("failed.at must be a string");
    state.failed = { app: parseVersion(data.failed.app, "failed.app"), at: data.failed.at };
  }
  return state;
}

export function readCurrent(file: string): CurrentState {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error((err as NodeJS.ErrnoException).code === "ENOENT" ? "file not found" : (err as Error).message);
  }
  return parseCurrent(text);
}

export type WriteOptions = {
  rename?: (from: string, to: string) => void;
  wait?: (ms: number) => Promise<unknown>;
};

// 書き込み途中で落ちても壊れたファイルを残さないよう、一時ファイルにfsyncまで済ませてからrenameで置き換える。
// 一時ファイルは固定名にして、前回の残骸は上書きする
export async function writeCurrent(file: string, state: CurrentState, options: WriteOptions = {}): Promise<void> {
  const rename = options.rename ?? renameSync;
  const wait = options.wait ?? delay;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { flush: true });
  for (let retry = 0; ; retry++) {
    try {
      rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Windowsではウイルス対策ソフトがファイルを一時的に掴み、renameがEPERM/EBUSYになることがある
      if ((code !== "EPERM" && code !== "EBUSY") || retry >= RENAME_RETRIES) throw err;
      await wait(RENAME_RETRY_MS);
    }
  }
}

// stateはparseCurrentで検証したもの（外部の文字列をそのままパスにしない）
export function resolveLaunch(installDir: string, state: Target, execPath: string): { runtime: string; server: string } {
  return {
    runtime: state.runtime === undefined ? execPath : path.join(installDir, state.runtime),
    server: path.join(installDir, "app", "versions", state.app, "src", "server.ts"),
  };
}

export type LaunchContext = {
  state: CurrentState;
  // この起動役の実行で既に戻したか（戻すのは1回まで）
  rolledBack: boolean;
  // SIGINTを受けたか
  interrupted: boolean;
  now: Date;
};

// シグナルでの終了（null）と、spawnの失敗での負のコードは1にする
export function toExitCode(code: number | null): number {
  return code === null || code < 0 ? 1 : code;
}

export function nextAction(exit: ChildExit, context: LaunchContext): NextAction {
  const code = toExitCode(exit.code);
  // Ctrl+Cは子にも届いているので、再起動も戻しもしない
  if (context.interrupted) return { type: "exit", code };
  if (exit.code === EXIT_RESTART) return { type: "restart" };
  const { state } = context;
  const failedToStart = !exit.ready && exit.code !== EXIT_OK && exit.code !== EXIT_NOT_VERSION_FAULT;
  if (failedToStart && state.pending === true && state.previous && !context.rolledBack) {
    const rollback: CurrentState = { app: state.previous.app };
    if (state.previous.runtime !== undefined) rollback.runtime = state.previous.runtime;
    rollback.failed = { app: state.app, at: context.now.toISOString() };
    return { type: "rollback", state: rollback };
  }
  return { type: "exit", code };
}
