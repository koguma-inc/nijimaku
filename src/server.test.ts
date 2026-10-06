import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test(".env・APIキーなしで画面を配信し、キーの状態はlocalhostにだけ返し、不正なキーを保存も出力もしない", { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "nijimaku-server-"));
  const sockets: WebSocket[] = [];
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(path.join(ROOT, "src"), path.join(dir, "src"), { recursive: true, filter: (src) => !src.endsWith(".test.ts") });
  cpSync(path.join(ROOT, "public"), path.join(dir, "public"), { recursive: true });
  copyFileSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "junction");
  const secret = "sk-test-secret";
  writeFileSync(path.join(dir, "credentials.json"), `{"openaiApiKey":"${secret}`);
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const script = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).scripts.start as string;
  const child = spawn(process.execPath, script.split(" ").slice(1), {
    cwd: dir,
    env: { ...process.env, OPENAI_API_KEY: "", PORT: String(port), ALLOWED_ORIGINS: "https://shared.example" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", () => { if (output.includes("capture:")) resolve(); });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("テスト用サーバーが起動前に終了しました")));
  });
  const httpBase = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(httpBase)).status, 200);
  assert.equal((await fetch(`${httpBase}/credentials.json`)).status, 404);

  for (const blockedOrigin of [undefined, "https://shared.example", "https://untrusted.example"]) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/settings`, {
      headers: blockedOrigin ? { Origin: blockedOrigin } : {},
    });
    sockets.push(socket);
    const [error] = await once(socket, "error");
    assert.match(error.message, /403/);
  }

  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/settings`, { headers: { Origin: origin } });
  sockets.push(socket);
  const messages: Record<string, unknown>[] = [];
  let notify = () => {};
  socket.on("message", (raw) => { messages.push(JSON.parse(raw.toString())); notify(); });
  async function receive(type: string): Promise<Record<string, unknown>> {
    for (;;) {
      const message = messages.find((msg) => msg.type === type);
      if (message) return message;
      await new Promise<void>((resolve) => { notify = resolve; });
    }
  }
  const status = await receive("credentials.status");
  assert.equal(status.configured, false);
  assert.equal(status.saved, false);
  assert.equal(status.state, "unconfigured");
  socket.send(JSON.stringify({ type: "credentials.set", apiKey: `${secret} invalid` }));
  const error = await receive("credentials.error");
  assert.ok(!JSON.stringify({ messages, output }).includes(secret));
  assert.match(String(error.message), /APIキー/);
  assert.equal(readFileSync(path.join(dir, "credentials.json"), "utf8"), `{"openaiApiKey":"${secret}`);
});
