// cloudflaredのquick tunnelでサーバーを一時的に外部公開する。
// トンネルのURLをALLOWED_ORIGINSに入れてサーバーを起動し、どちらかが終了したらもう片方も止める。
//
// 実行: nr share（cloudflaredが必要。Macは brew install cloudflared）
import { spawn, type ChildProcess } from "node:child_process";
import { devNull } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { loadConfig } from "../src/config.ts";

const ROOT = path.join(import.meta.dirname, "..");
const URL_TIMEOUT_MS = 30_000;
// api.trycloudflare.comはトンネル発行APIのURLで、失敗時のログに出る
const TUNNEL_URL = /https:\/\/(?!api\.)[-a-z0-9]+\.trycloudflare\.com/;

let port: number;
try {
  port = loadConfig().port;
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// ~/.cloudflared/config.ymlにingressがあると--urlが無視され、全リクエストがそちらに流れる。
// 空の設定ファイルを指定して読ませない
const tunnel = spawn(
  "cloudflared",
  ["tunnel", "--config", devNull, "--no-autoupdate", "--grace-period", "1s", "--url", `http://127.0.0.1:${port}`],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const children: ChildProcess[] = [tunnel];
let stopping = false;

// Ctrl+Cは同じプロセスグループの子にも届くので、ここでは子の終了を待つだけにする
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", stopAll);

const publicUrl = await waitForUrl(tunnel).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  stopAll();
  process.exit(1);
});

// 公開URLはサーバーが起動時に表示する
const server = spawn(process.execPath, [path.join(ROOT, "src/server.ts")], {
  stdio: "inherit",
  env: { ...process.env, ALLOWED_ORIGINS: publicUrl },
});
children.push(server);
server.on("exit", (code) => {
  process.exitCode = code ?? 0;
  stopAll();
});
tunnel.on("exit", () => {
  if (!stopping) console.error("[tunnel] cloudflaredが終了したため、サーバーを止めます");
  stopAll();
});

function waitForUrl(child: ChildProcess): Promise<string> {
  const lines: string[] = [];
  let found = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(`${URL_TIMEOUT_MS / 1000}秒以内にトンネルのURLが出ませんでした`), URL_TIMEOUT_MS);
    function fail(message: string): void {
      clearTimeout(timer);
      reject(new Error([message, ...lines].join("\n")));
    }
    child.on("error", (err) =>
      fail((err as NodeJS.ErrnoException).code === "ENOENT" ? "cloudflaredが見つかりません" : err.message),
    );
    child.on("exit", () => fail("URLの取得前にcloudflaredが終了しました"));
    // URLの取得後はエラーの行だけを出す（cloudflaredのINFログは多い）
    readline.createInterface({ input: child.stderr! }).on("line", (line) => {
      if (found) {
        if (/\bERR\b/.test(line)) console.error(`[tunnel] ${line}`);
        return;
      }
      lines.push(line);
      const match = TUNNEL_URL.exec(line);
      if (!match) return;
      found = true;
      clearTimeout(timer);
      resolve(match[0]);
    });
  });
}

function stopAll(): void {
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}
