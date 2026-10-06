import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import WebSocket from "ws";

const ROOT = path.join(import.meta.dirname, "..");

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return address.port;
}

function copyApp(dir: string): void {
  cpSync(path.join(ROOT, "src"), path.join(dir, "src"), { recursive: true, filter: (src) => !src.endsWith(".test.ts") });
  cpSync(path.join(ROOT, "public"), path.join(dir, "public"), { recursive: true });
  copyFileSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "junction");
}

// 子プロセスの終了を待ってから一時フォルダを消す。Windowsでは、動いているプロセスの作業フォルダを消せない。
// t.afterは登録順に走り、1つが失敗すると残りが走らないので、分けて登録せずこの順で1つにまとめる
async function cleanup(dir: string, children: ChildProcess[], sockets: WebSocket[] = []): Promise<void> {
  for (const socket of sockets) socket.terminate();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

test(".env・APIキーなしで画面を配信し、許可URLから設定を変更でき、不正なキーを保存も出力もしない", { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "nijimaku-server-"));
  const children: ChildProcess[] = [];
  const sockets: WebSocket[] = [];
  t.after(() => cleanup(dir, children, sockets));
  copyApp(dir);
  const secret = "sk-test-secret";
  writeFileSync(path.join(dir, "credentials.json"), `{"openaiApiKey":"${secret}`);
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const { version, scripts } = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const script = scripts.start as string;
  const child = spawn(process.execPath, script.split(" ").slice(1), {
    cwd: dir,
    env: { ...process.env, OPENAI_API_KEY: "", PORT: String(port), ALLOWED_ORIGINS: "https://shared.example" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", () => { if (output.includes("capture:")) resolve(); });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("テスト用サーバーが起動前に終了しました")));
  });
  const httpBase = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(httpBase)).status, 200);
  assert.equal((await fetch(`${httpBase}/credentials.json`)).status, 404);

  // overlay.htmlが版の変化で読み直せるよう、最初に版を送る
  const overlay = new WebSocket(`ws://127.0.0.1:${port}/ws/overlay`);
  sockets.push(overlay);
  const [first] = await once(overlay, "message");
  assert.deepEqual(JSON.parse(first.toString()), { type: "app", version });
  overlay.close();

  for (const blockedOrigin of [undefined, "null", "https://untrusted.example"]) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/settings`, {
      headers: blockedOrigin ? { Origin: blockedOrigin } : {},
    });
    sockets.push(socket);
    const [error] = await once(socket, "error");
    assert.match(error.message, /403/);
  }

  for (const allowedOrigin of [origin, httpBase, "https://shared.example"]) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/settings`, { headers: { Origin: allowedOrigin } });
    sockets.push(socket);
    const messages: Record<string, unknown>[] = [];
    const pending: Record<string, unknown>[] = [];
    let notify = () => {};
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      pending.push(message);
      notify();
    });
    async function receive(type: string): Promise<Record<string, unknown>> {
      for (;;) {
        const index = pending.findIndex((msg) => msg.type === type);
        if (index !== -1) return pending.splice(index, 1)[0]!;
        await new Promise<void>((resolve) => { notify = resolve; });
      }
    }
    const initial = await receive("settings");
    const status = await receive("credentials.status");
    assert.equal(status.configured, false);
    assert.equal(status.saved, false);
    assert.equal(status.state, "unconfigured");
    // 起動役から起動していないので、更新機能は無効で版だけを知らせる
    const info = await receive("app.info");
    assert.deepEqual(info, { type: "app.info", version, nodeVersion: process.version, updater: false, canApply: false });
    assert.equal((await receive("update.status")).state, "idle");
    socket.send(JSON.stringify({ type: "update.apply" }));
    if (allowedOrigin === "https://shared.example") assert.match(String((await receive("update.error")).message), /PCで開いたページ/);
    else assert.equal((await receive("update.status")).state, "idle");

    socket.send(JSON.stringify({ type: "set", key: "displaySegments", value: 4 }));
    const changed = await receive("settings");
    assert.equal((changed.values as Record<string, unknown>).displaySegments, 4);
    assert.equal(JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8")).displaySegments, 4);
    socket.send(JSON.stringify({ type: "reset", key: "displaySegments" }));
    const reset = await receive("settings");
    assert.equal((reset.values as Record<string, unknown>).displaySegments, (initial.defaults as Record<string, unknown>).displaySegments);
    assert.ok(!Object.hasOwn(JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8")), "displaySegments"));

    socket.send(JSON.stringify({ type: "credentials.set", apiKey: `${secret} invalid` }));
    const error = await receive("credentials.error");
    assert.ok(!JSON.stringify({ messages, output }).includes(secret));
    assert.match(String(error.message), /APIキー/);
    assert.equal(readFileSync(path.join(dir, "credentials.json"), "utf8"), `{"openaiApiKey":"${secret}`);
    socket.close();
    await once(socket, "close");
  }
});

// 起動役（src/launcher.ts）から起動されたときの約束
test("起動役の子として、利用者のデータをNIJIMAKU_DATA_DIRに置き、listenの後にreadyを送る", { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "nijimaku-server-"));
  const children: ChildProcess[] = [];
  const sockets: WebSocket[] = [];
  t.after(() => cleanup(dir, children, sockets));
  const appDir = path.join(dir, "app");
  const dataDir = path.join(dir, "data");
  mkdirSync(appDir);
  mkdirSync(dataDir);
  copyApp(appDir);
  writeFileSync(path.join(dataDir, "credentials.json"), "{}");
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(appDir, "src", "server.ts")], {
    cwd: dataDir,
    // 更新の確認は、閉じたポートへ向けて失敗させる
    env: { ...process.env, OPENAI_API_KEY: "", PORT: String(port), SAVE_LOGS: "1", NIJIMAKU_DATA_DIR: dataDir, NIJIMAKU_LAUNCHER: "1", NIJIMAKU_UPDATE_API: `http://127.0.0.1:${await freePort()}/releases/latest` },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (data) => { output += data; });
  child.stderr!.on("data", (data) => { output += data; });
  const [message] = await Promise.race([
    once(child, "message"),
    once(child, "exit").then(() => { throw new Error(`テスト用サーバーが起動前に終了しました: ${output}`); }),
  ]);
  assert.deepEqual(message, { type: "ready" });
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  assert.match(output, /APIキーの保存ファイルの形式が不正です/);
  assert.ok(existsSync(path.join(dataDir, "logs")));
  assert.ok(!existsSync(path.join(appDir, "logs")));

  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/settings`, { headers: { Origin: `http://localhost:${port}` } });
  sockets.push(socket);
  const messages: Record<string, unknown>[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await once(socket, "open");
  // 起動役から起動されたので更新機能が有効。確認に失敗しても動き続ける
  while (!messages.some((m) => m.type === "update.status" && m.state === "error")) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(messages.find((m) => m.type === "app.info")?.updater, true);
  assert.equal(messages.find((m) => m.type === "app.info")?.canApply, true);
  assert.match(output, /\[update\] 新しい版を確認できませんでした/);
  socket.send(JSON.stringify({ type: "set", key: "displaySegments", value: 4 }));
  while (!existsSync(path.join(dataDir, "settings.json"))) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(JSON.parse(readFileSync(path.join(dataDir, "settings.json"), "utf8")).displaySegments, 4);
  assert.ok(!existsSync(path.join(appDir, "settings.json")));
});

test("設定の誤りとポートの使用中は、版のせいではない失敗として78で終わる", { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "nijimaku-server-"));
  const children: ChildProcess[] = [];
  t.after(() => cleanup(dir, children));
  copyApp(dir);
  const busy = createServer();
  busy.listen(0, "127.0.0.1");
  await once(busy, "listening");
  t.after(() => busy.close());
  const address = busy.address();
  assert.ok(address && typeof address !== "string");

  for (const env of [{ LUNA_MODE: "bad" }, { PORT: String(address.port) }]) {
    const child = spawn(process.execPath, [path.join(dir, "src", "server.ts")], {
      cwd: dir,
      env: { ...process.env, OPENAI_API_KEY: "", PORT: String(await freePort()), ...env },
      stdio: "ignore",
    });
    children.push(child);
    const [code] = await once(child, "exit");
    assert.equal(code, 78, JSON.stringify(env));
  }
});
