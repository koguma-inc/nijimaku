// --open（start.cmdが付ける）で起動したとき、capture.htmlをブラウザで開く。
// Document PiPがChromeにしか無いため、Chromeが見つかればChromeで開き、無ければ既定のブラウザで開く。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Chromeの標準のインストール先（全ユーザー・32bit版・ユーザー単位）
export function findChromeOnWindows(env: NodeJS.ProcessEnv, exists: (file: string) => boolean = existsSync): string | null {
  for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]) {
    if (!base) continue;
    const file = path.win32.join(base, "Google", "Chrome", "Application", "chrome.exe");
    if (exists(file)) return file;
  }
  return null;
}

export function openBrowser(url: string): void {
  if (process.platform === "win32") {
    const chrome = findChromeOnWindows(process.env);
    // detachedでないと、Chromeを新しく起動した場合にサーバーの終了と一緒に閉じられる（libuvのジョブオブジェクト）
    if (chrome) watch(spawn(chrome, [url], { detached: true, stdio: "ignore" }));
    // startの最初の引用符付き引数はウィンドウのタイトルとして扱われる
    else watch(spawn("cmd.exe", ["/d", "/c", "start", '""', url], { stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true }));
  } else if (process.platform === "darwin") {
    watch(spawn("open", ["-a", "Google Chrome", url], { stdio: "ignore" }), () => watch(spawn("open", [url], { stdio: "ignore" })));
  }
}

function watch(child: ChildProcess, fallback?: () => void): void {
  child.on("error", (err) => console.error(`ブラウザを開けません: ${err.message}`));
  if (fallback) child.on("exit", (code) => code !== 0 && fallback());
  child.unref();
}
