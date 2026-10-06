// 配布版の起動役。app/current.jsonが指す版のサーバーを子として起動し、子の終了から再起動・前の版への戻し・終了を決める。
// 子との約束はnote/design.mdの「配布版の起動役」。
// 更新では差し替えないため、node:の標準モジュールと./launch-state.tsだけを使う（distがこの2つだけをapp/へ置く）。
// メッセージはcmd.exeのコンソールで文字化けしないよう英語にする。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { nextAction, readCurrent, resolveLaunch, toExitCode, writeCurrent, type ChildExit, type CurrentState } from "./launch-state.ts";

// このファイルはインストール先のapp/に置かれる
const INSTALL_DIR = path.dirname(import.meta.dirname);
const CURRENT_FILE = path.join(INSTALL_DIR, "app", "current.json");
const OPEN = process.argv.slice(2).includes("--open");

let interrupted = false;
// コンソールのCtrl+Cは子にも届くので、自分では終わらずに子の終了を待つ
process.on("SIGINT", () => {
  interrupted = true;
});

// process.exit()はパイプへの書き出しを打ち切ることがあるので、exitCodeを設定して自然に終わる
process.exitCode = await main();

async function main(): Promise<number> {
  let everReady = false;
  let rolledBack = false;
  for (;;) {
    let state: CurrentState;
    try {
      state = readCurrent(CURRENT_FILE);
    } catch (err) {
      console.error(`Cannot read ${CURRENT_FILE}: ${(err as Error).message}`);
      console.error("Extract the full Nijimaku ZIP into this folder again (overwrite existing files), then run start.cmd.");
      return 1;
    }
    // 更新の再起動のたびにブラウザのタブが増えないよう、この実行で子が一度もreadyに達していない間だけ付ける
    const exit = await run(state, OPEN && !everReady);
    everReady ||= exit.ready;
    const action = nextAction(exit, { state, rolledBack, interrupted, now: new Date() });
    if (action.type === "exit") return action.code;
    if (action.type === "rollback") {
      console.error(`Nijimaku ${state.app} failed to start. Rolling back to ${action.state.app}.`);
      try {
        await writeCurrent(CURRENT_FILE, action.state);
      } catch (err) {
        console.error(`Cannot write ${CURRENT_FILE}: ${(err as Error).message}`);
        return 1;
      }
      rolledBack = true;
    }
    // 判定の後（戻しの書き込み中など）にCtrl+Cを受けたら、次の子は起動しない
    if (interrupted) return toExitCode(exit.code);
  }
}

function run(state: CurrentState, open: boolean): Promise<ChildExit> {
  const { runtime, server } = resolveLaunch(INSTALL_DIR, state, process.execPath);
  if (!existsSync(server)) {
    console.error(`Nijimaku ${state.app} is not installed: ${server} not found.`);
    return Promise.resolve({ code: 1, ready: false });
  }
  return new Promise((resolve) => {
    let ready = false;
    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, ready });
    };
    const fail = (err: unknown) => {
      console.error(`Cannot start ${runtime}: ${err instanceof Error ? err.message : String(err)}`);
      settle(1);
    };
    let child: ChildProcess;
    try {
      child = spawn(runtime, [server, ...(open ? ["--open"] : [])], {
        cwd: INSTALL_DIR,
        env: { ...process.env, NIJIMAKU_DATA_DIR: INSTALL_DIR, NIJIMAKU_LAUNCHER: "1" },
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      });
    } catch (err) {
      // ENOENT等はerrorイベントになるが、EPERM・EFTYPE等はspawnが同期で投げる
      fail(err);
      return;
    }
    child.on("message", (message: unknown) => {
      if (typeof message === "object" && message !== null && (message as { type?: unknown }).type === "ready") ready = true;
    });
    // spawnの失敗ではerrorの後にcloseも来る。起動後のerror（想定外）では子が動いている可能性があるので、closeを待つ
    child.on("error", (err) => {
      if (child.pid === undefined) fail(err);
      else console.error(`Nijimaku ${state.app}: ${err.message}`);
    });
    // readyのメッセージはexitより後に届くことがあるため、IPCも閉じた後のcloseで待つ
    child.on("close", (code) => settle(code));
  });
}
