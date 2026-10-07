import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

// 偽のサーバー。版のフォルダのbehavior.jsonどおりに動き、起動の記録をインストール先のlaunches.jsonlへ1行ずつ追記する
const FAKE_SERVER = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const versionDir = path.dirname(import.meta.dirname);
const behavior = JSON.parse(readFileSync(path.join(versionDir, "behavior.json"), "utf8"));
const dataDir = process.env.NIJIMAKU_DATA_DIR;
appendFileSync(path.join(dataDir, "launches.jsonl"), JSON.stringify({
  version: path.basename(versionDir),
  args: process.argv.slice(2),
  launcher: process.env.NIJIMAKU_LAUNCHER,
  dataDir,
  cwd: process.cwd(),
  argv0: process.argv0,
}) + "\\n");
if (behavior.ready) await new Promise((resolve) => process.send({ type: "ready" }, resolve));
if (behavior.waitFor) {
  const file = path.join(dataDir, behavior.waitFor);
  const deadline = Date.now() + 10000;
  while (!existsSync(file) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
}
if (behavior.write) writeFileSync(path.join(dataDir, "app", "current.json"), JSON.stringify(behavior.write));
process.exit(behavior.exit);
`;

type Behavior = { ready?: boolean; exit: number; write?: unknown; waitFor?: string };
type Launch = { version: string; args: string[]; launcher: string; dataDir: string; cwd: string; argv0: string };
type Launcher = ChildProcessByStdio<null, Readable, Readable>;

// 配布物と同じ配置のインストール先を作る。currentが文字列ならそのままcurrent.jsonに書く
function install(t: TestContext, current: unknown, versions: Record<string, Behavior>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "nijimaku-launcher-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = path.join(dir, "app");
  mkdirSync(app);
  writeFileSync(path.join(app, "package.json"), JSON.stringify({ private: true, type: "module" }));
  copyFileSync(path.join(import.meta.dirname, "launcher.ts"), path.join(app, "launcher.ts"));
  copyFileSync(path.join(import.meta.dirname, "launch-state.ts"), path.join(app, "launch-state.ts"));
  writeFileSync(path.join(app, "current.json"), typeof current === "string" ? current : JSON.stringify(current));
  for (const [version, behavior] of Object.entries(versions)) {
    const versionDir = path.join(app, "versions", version);
    mkdirSync(path.join(versionDir, "src"), { recursive: true });
    writeFileSync(path.join(versionDir, "src", "server.ts"), FAKE_SERVER);
    writeFileSync(path.join(versionDir, "behavior.json"), JSON.stringify(behavior));
  }
  return realpathSync(dir);
}

function start(t: TestContext, dir: string, args: string[]): { launcher: Launcher; result: Promise<{ code: number | null; signal: string | null; output: string }> } {
  // 作業ディレクトリに依らないことも確かめるため、インストール先の外から起動する
  const launcher = spawn(process.execPath, [path.join(dir, "app", "launcher.ts"), ...args], { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
  });
  let output = "";
  launcher.stdout.on("data", (data) => { output += data; });
  launcher.stderr.on("data", (data) => { output += data; });
  const result = once(launcher, "close").then(([code, signal]) => ({ code: code as number | null, signal: signal as string | null, output }));
  return { launcher, result };
}

function launch(t: TestContext, dir: string, args: string[] = ["--open"]) {
  return start(t, dir, args).result;
}

function launches(dir: string): Launch[] {
  const file = path.join(dir, "launches.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function summary(dir: string): [string, string[]][] {
  return launches(dir).map((l) => [l.version, l.args]);
}

function current(dir: string): unknown {
  return JSON.parse(readFileSync(path.join(dir, "app", "current.json"), "utf8"));
}

function assertFailedAt(dir: string, app: string, startedAt: number): void {
  const state = current(dir) as { failed: { app: string; at: string } };
  assert.equal(state.failed.app, app);
  const at = Date.parse(state.failed.at);
  assert.ok(at >= startedAt - 1000 && at <= Date.now(), state.failed.at);
}

const PENDING = { app: "0.3.0", pending: true, previous: { app: "0.2.0" } };

test("current.jsonの版を起動し、インストール先と起動役の印を渡して、0で終わる", { timeout: 15000 }, async (t) => {
  const dir = install(t, { app: "0.2.0" }, { "0.2.0": { ready: true, exit: 0 } });
  const { code, output } = await launch(t, dir);
  assert.equal(code, 0, output);
  assert.deepEqual(summary(dir), [["0.2.0", ["--open"]]]);
  const [first] = launches(dir);
  assert.equal(first.launcher, "1");
  assert.equal(first.argv0, process.execPath);
  // tmpdirはMacではシンボリックリンク、Windowsでは短い名前（RUNNER~1等）を含むことがあるので、実体で比べる
  assert.equal(realpathSync.native(first.dataDir), realpathSync.native(dir));
  assert.equal(realpathSync.native(first.cwd), realpathSync.native(dir));
});

test("--openなしで起動されたら子にも付けない", { timeout: 15000 }, async (t) => {
  const dir = install(t, { app: "0.2.0" }, { "0.2.0": { ready: true, exit: 0 } });
  const { code, output } = await launch(t, dir, []);
  assert.equal(code, 0, output);
  assert.deepEqual(summary(dir), [["0.2.0", []]]);
});

test("75でcurrent.jsonを読み直して起動し直し、readyの後なので--openを付けない", { timeout: 15000 }, async (t) => {
  const next = { app: "0.3.0", pending: true, previous: { app: "0.2.0" } };
  const dir = install(t, { app: "0.2.0" }, {
    "0.2.0": { ready: true, write: next, exit: 75 },
    "0.3.0": { ready: true, exit: 0 },
  });
  const { code, output } = await launch(t, dir);
  assert.equal(code, 0, output);
  assert.deepEqual(summary(dir), [["0.2.0", ["--open"]], ["0.3.0", []]]);
  assert.deepEqual(current(dir), next);
});

test("pendingの版がready前に失敗したら前の版へ戻して起動し直し、戻した版にも--openを付ける", { timeout: 15000 }, async (t) => {
  const dir = install(t, PENDING, {
    "0.3.0": { exit: 1 },
    "0.2.0": { ready: true, exit: 0 },
  });
  const startedAt = Date.now();
  const { code, output } = await launch(t, dir);
  assert.equal(code, 0, output);
  assert.match(output, /Nijimaku 0\.3\.0 failed to start\. Rolling back to 0\.2\.0\./);
  assert.deepEqual(summary(dir), [["0.3.0", ["--open"]], ["0.2.0", ["--open"]]]);
  const state = current(dir) as Record<string, unknown>;
  assert.deepEqual(Object.keys(state).sort(), ["app", "failed"]);
  assert.equal(state.app, "0.2.0");
  assertFailedAt(dir, "0.3.0", startedAt);
});

test("戻すのは1回の実行につき1回までで、75で再起動した後のpendingの版の失敗では戻さない", { timeout: 15000 }, async (t) => {
  const dir = install(t, PENDING, {
    "0.3.0": { exit: 1 },
    "0.2.0": { ready: true, write: { app: "0.3.1", pending: true, previous: { app: "0.2.0" } }, exit: 75 },
    "0.3.1": { exit: 4 },
  });
  const { code, output } = await launch(t, dir);
  assert.equal(code, 4, output);
  assert.deepEqual(summary(dir), [["0.3.0", ["--open"]], ["0.2.0", ["--open"]], ["0.3.1", []]]);
  assert.deepEqual(current(dir), { app: "0.3.1", pending: true, previous: { app: "0.2.0" } });
});

test("ready後の異常終了は戻さない", { timeout: 15000 }, async (t) => {
  const dir = install(t, PENDING, { "0.3.0": { ready: true, exit: 1 }, "0.2.0": { ready: true, exit: 0 } });
  const { code, output } = await launch(t, dir);
  assert.equal(code, 1, output);
  assert.deepEqual(summary(dir), [["0.3.0", ["--open"]]]);
  assert.deepEqual(current(dir), PENDING);
});

test("pendingの版のフォルダが無ければ起動の失敗として戻す", { timeout: 15000 }, async (t) => {
  const dir = install(t, { ...PENDING, app: "0.9.0" }, { "0.2.0": { ready: true, exit: 0 } });
  const startedAt = Date.now();
  const { code, output } = await launch(t, dir);
  assert.equal(code, 0, output);
  assert.match(output, /Nijimaku 0\.9\.0 is not installed/);
  assert.deepEqual(summary(dir), [["0.2.0", ["--open"]]]);
  assertFailedAt(dir, "0.9.0", startedAt);
});

test("pendingの版のruntimeが無ければ起動の失敗として戻す", { timeout: 15000 }, async (t) => {
  const dir = install(t, { ...PENDING, runtime: "app/runtimes/v99.0.0/node.exe" }, {
    "0.3.0": { ready: true, exit: 0 },
    "0.2.0": { ready: true, exit: 0 },
  });
  const startedAt = Date.now();
  const { code, output } = await launch(t, dir);
  assert.equal(code, 0, output);
  assert.match(output, /Cannot start .*node\.exe/);
  assert.deepEqual(summary(dir), [["0.2.0", ["--open"]]]);
  assertFailedAt(dir, "0.3.0", startedAt);
  assert.equal((current(dir) as Record<string, unknown>).runtime, undefined);
});

test("runtimeを指定したら、そのnode.exeで子を起動する", { timeout: 15000 }, async (t) => {
  const runtime = "app/runtimes/v99.0.0/node.exe";
  const dir = install(t, { app: "0.2.0", runtime }, { "0.2.0": { ready: true, exit: 0 } });
  const runtimePath = path.join(dir, runtime);
  mkdirSync(path.dirname(runtimePath), { recursive: true });
  try {
    symlinkSync(process.execPath, runtimePath);
  } catch {
    // Windowsでは権限が無いとシンボリックリンクを作れない
    copyFileSync(process.execPath, runtimePath);
  }
  const { code, output } = await launch(t, dir);
  assert.equal(code, 0, output);
  assert.deepEqual(launches(dir).map((l) => l.argv0), [runtimePath]);
});

test("current.jsonが壊れていたら、英語で案内して1で終わる", { timeout: 15000 }, async (t) => {
  const dir = install(t, '{"app": "0.2.0"', { "0.2.0": { ready: true, exit: 0 } });
  const { code, output } = await launch(t, dir);
  assert.equal(code, 1, output);
  assert.match(output, /Cannot read .*current\.json: invalid JSON/);
  assert.match(output, /Extract the full Nijimaku ZIP into this folder again/);
  assert.deepEqual(launches(dir), []);
});

// WindowsではSIGINTを送れない（killは強制終了になる）
test("SIGINTでは終わらずに子の終了を待ち、その後の75でも再起動しない", { timeout: 15000, skip: process.platform === "win32" }, async (t) => {
  const dir = install(t, { app: "0.2.0" }, {
    "0.2.0": { ready: true, waitFor: "go", write: { app: "0.3.0" }, exit: 75 },
    "0.3.0": { ready: true, exit: 0 },
  });
  const { launcher, result } = start(t, dir, ["--open"]);
  while (launches(dir).length === 0) await delay(20);
  launcher.kill("SIGINT");
  await delay(200);
  writeFileSync(path.join(dir, "go"), "");
  const { code, signal, output } = await result;
  assert.equal(signal, null, output);
  assert.equal(code, 75, output);
  assert.deepEqual(summary(dir), [["0.2.0", ["--open"]]]);
});
