import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";

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

function inbox(socket: WebSocket) {
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
  return { messages, receive };
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
    const { messages, receive } = inbox(socket);
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

    if (allowedOrigin !== "https://shared.example") {
      socket.close();
      await once(socket, "close");
      continue;
    }

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

    socket.send(JSON.stringify({ type: "import", values: { vadSilenceMs: 600, displaySegments: 4 } }));
    const imported = await receive("settings");
    assert.equal((imported.values as Record<string, unknown>).vadSilenceMs, 600);
    assert.deepEqual((await receive("settings.imported")).warnings, []);
    const settingsFile = path.join(dir, "settings.json");
    const saved = readFileSync(settingsFile, "utf8");
    assert.deepEqual(JSON.parse(saved), { vadSilenceMs: 600, displaySegments: 4 });

    mkdirSync(`${settingsFile}.tmp`);
    socket.send(JSON.stringify({ type: "set", key: "vadSilenceMs", value: 700 }));
    await Promise.race([
      receive("settings.error"),
      once(child, "exit").then(() => { throw new Error("設定の保存失敗でサーバーが終了しました"); }),
    ]);
    socket.send(JSON.stringify({ type: "import", values: { vadSilenceMs: 900, displaySegments: 8 } }));
    await receive("settings.import.error");
    assert.equal(readFileSync(settingsFile, "utf8"), saved);
    rmSync(`${settingsFile}.tmp`, { recursive: true });
    socket.send(JSON.stringify({ type: "set", key: "displaySegments", value: 5 }));
    const recovered = await receive("settings");
    assert.equal((recovered.values as Record<string, unknown>).vadSilenceMs, 600);
    assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), { vadSilenceMs: 600, displaySegments: 5 });
    socket.close();
    await once(socket, "close");
  }
});

test("readyで保留commitを送り、入力を置き換える前にcommitし、拒否された設定の読み込みをまとめて戻す", { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "nijimaku-server-"));
  const children: ChildProcess[] = [];
  const sockets: WebSocket[] = [];
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await cleanup(dir, children, sockets);
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  });
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const connected = new Promise<{ socket: WebSocket } & ReturnType<typeof inbox>>((resolve) => {
    upstream.once("connection", (socket) => {
      sockets.push(socket);
      resolve({ socket, ...inbox(socket) });
    });
  });
  copyApp(dir);
  const settingsFile = path.join(dir, "settings.json");
  const saved = { displaySegments: 4, styleJaColor: "#fff", streamDescription: "before" };
  writeFileSync(settingsFile, JSON.stringify(saved));
  // 接続先だけ差し替え、サーバーとRealtimeSessionは実物を通す。
  writeFileSync(path.join(dir, "test-server.mjs"), `
import { mock } from "node:test";
import WebSocket from "ws";
import { RealtimeSession } from "./src/realtime.ts";
mock.module("./src/realtime.ts", { namedExports: {
  RealtimeSession: class extends RealtimeSession {
    constructor(options, handlers, logger) {
      super(options, handlers, logger, () => new WebSocket("ws://127.0.0.1:${address.port}"));
    }
  }
} });
await import("./src/server.ts");
`);
  const port = await freePort();
  const child = spawn(process.execPath, ["--experimental-test-module-mocks", "test-server.mjs"], {
    cwd: dir,
    env: { ...process.env, OPENAI_API_KEY: "sk-test-key", PORT: String(port), SAVE_LOGS: "0", NIJIMAKU_DATA_DIR: dir, NIJIMAKU_LAUNCHER: "" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (data) => { output += data; });
  child.stderr!.on("data", (data) => { output += data; });
  await Promise.race([
    once(child, "message"),
    once(child, "exit").then(() => { throw new Error(`テスト用サーバーが起動前に終了しました: ${output}`); }),
  ]);
  const remote = await connected;
  await remote.receive("session.update");
  const settings = new WebSocket(`ws://127.0.0.1:${port}/ws/settings`, { headers: { Origin: `http://localhost:${port}` } });
  sockets.push(settings);
  const { receive } = inbox(settings);
  await receive("settings");

  const audio = Buffer.alloc(9_600);
  for (let offset = 0; offset < audio.length; offset += 2) audio.writeInt16LE(8_000, offset);
  const first = new WebSocket(`ws://127.0.0.1:${port}/ws/capture`);
  sockets.push(first);
  await once(first, "open");
  first.send(audio);
  first.close();
  await once(first, "close");
  while (!output.includes("[capture] #1 切断")) await once(child.stdout!, "data");
  remote.socket.send(JSON.stringify({ type: "session.updated" }));
  assert.equal((await remote.receive("input_audio_buffer.commit")).event_id, "commit_1");

  const second = new WebSocket(`ws://127.0.0.1:${port}/ws/capture`);
  sockets.push(second);
  await once(second, "open");
  second.send(audio);
  // 初回に保持された10フレームと今回の10フレームが、commitの前にすべて送られる。
  for (let frame = 0; frame < 20; frame++) await remote.receive("input_audio_buffer.append");
  const boundary = remote.messages.length;
  const replaced = once(second, "close");
  const third = new WebSocket(`ws://127.0.0.1:${port}/ws/capture`);
  sockets.push(third);
  await once(third, "open");
  third.send(audio);
  assert.equal((await remote.receive("input_audio_buffer.commit")).event_id, "commit_2");
  assert.equal((await replaced)[0], 4001);
  for (let frame = 0; frame < 10; frame++) await remote.receive("input_audio_buffer.append");
  assert.deepEqual(remote.messages.slice(boundary).map((message) => message.type), [
    "input_audio_buffer.commit",
    ...Array(10).fill("input_audio_buffer.append"),
  ]);

  settings.send(JSON.stringify({ type: "import", values: { streamDescription: "after", transcribeLanguages: ["en"], displaySegments: 7, micNoiseSuppression: false } }));
  await receive("settings");
  await receive("settings.imported");
  const update = await remote.receive("session.update");
  remote.socket.send(JSON.stringify({ type: "error", error: { event_id: update.event_id, message: "rejected" } }));
  const reverted = await receive("settings");
  await receive("settings.error");
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), saved);
  const values = reverted.values as Record<string, unknown>;
  assert.equal(values.streamDescription, "before");
  assert.equal(values.displaySegments, 4);
  assert.equal(values.styleJaColor, "#fff");
  assert.equal(values.micNoiseSuppression, true);
  assert.deepEqual(values.transcribeLanguages, ["ja"]);
  const restored = await remote.receive("session.update");
  const session = restored.session as { audio: { input: { transcription: { prompt: string } } } };
  assert.equal(session.audio.input.transcription.prompt, "before");

  settings.send(JSON.stringify({ type: "import", values: { streamDescription: "after", displaySegments: 7 } }));
  const changed = await receive("settings");
  await receive("settings.imported");
  const rejected = await remote.receive("session.update");
  const beforeFailure = readFileSync(settingsFile, "utf8");
  mkdirSync(`${settingsFile}.tmp`);
  remote.socket.send(JSON.stringify({ type: "error", error: { event_id: rejected.event_id, message: "rejected" } }));
  assert.match(String((await receive("settings.error")).message), /保存できません/);
  assert.equal(readFileSync(settingsFile, "utf8"), beforeFailure);
  const observer = new WebSocket(`ws://127.0.0.1:${port}/ws/settings`, { headers: { Origin: `http://localhost:${port}` } });
  sockets.push(observer);
  assert.deepEqual((await inbox(observer).receive("settings")).values, changed.values);
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
