import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { nextAction, parseCurrent, readCurrent, resolveLaunch, writeCurrent, type ChildExit, type CurrentState } from "./launch-state.ts";

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "nijimaku-launch-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

const FULL: CurrentState = {
  app: "0.3.0",
  runtime: "app/runtimes/v24.22.0/node.exe",
  pending: true,
  previous: { app: "0.2.0", runtime: "app/runtimes/v24.21.0/node.exe" },
  failed: { app: "0.3.1", at: "2026-10-07T12:00:00.000Z" },
};

test("current.jsonの全項目と省略形を読み、知らない項目は無視する", () => {
  assert.deepEqual(parseCurrent(JSON.stringify(FULL)), FULL);
  assert.deepEqual(parseCurrent('{"app": "0.2.0"}'), { app: "0.2.0" });
  assert.deepEqual(parseCurrent('{"app": "10.20.30", "pending": false, "previous": {"app": "0.1.0"}, "future": 1}'), {
    app: "10.20.30",
    pending: false,
    previous: { app: "0.1.0" },
  });
});

test("版・runtimeの形が違うcurrent.jsonは理由付きで拒む", () => {
  const cases: [unknown, RegExp][] = [
    [{}, /^app /],
    [{ app: "0.3" }, /^app /],
    [{ app: "v0.3.0" }, /^app /],
    [{ app: "0.3.0-rc.1" }, /^app /],
    [{ app: "../0.3.0" }, /^app /],
    [{ app: "0.3.0\n" }, /^app /],
    [{ app: 3 }, /^app /],
    [{ app: "0.3.0", runtime: "app/runtimes/v24.22.0/../../../node.exe" }, /^runtime /],
    [{ app: "0.3.0", runtime: "/usr/bin/node" }, /^runtime /],
    [{ app: "0.3.0", runtime: "C:\\node\\node.exe" }, /^runtime /],
    [{ app: "0.3.0", runtime: "app\\runtimes\\v24.22.0\\node.exe" }, /^runtime /],
    [{ app: "0.3.0", runtime: "app/runtimes/v24.22.0/evil.exe" }, /^runtime /],
    [{ app: "0.3.0", runtime: "app/runtimes/24.22.0/node.exe" }, /^runtime /],
    [{ app: "0.3.0", runtime: null }, /^runtime /],
    [{ app: "0.3.0", pending: "true" }, /^pending /],
    [{ app: "0.3.0", previous: "0.2.0" }, /^previous /],
    [{ app: "0.3.0", previous: { app: "../x" } }, /^previous\.app /],
    [{ app: "0.3.0", previous: { app: "0.2.0", runtime: "node.exe" } }, /^previous\.runtime /],
    [{ app: "0.3.0", failed: [] }, /^failed /],
    [{ app: "0.3.0", failed: { app: "0.3.1" } }, /^failed\.at /],
    [{ app: "0.3.0", failed: { app: "x", at: "2026-10-07T12:00:00.000Z" } }, /^failed\.app /],
    [[], /not a JSON object/],
    [null, /not a JSON object/],
    ["0.3.0", /not a JSON object/],
  ];
  for (const [data, message] of cases) {
    assert.throws(() => parseCurrent(JSON.stringify(data)), { message }, JSON.stringify(data));
  }
  assert.throws(() => parseCurrent('{"app": "0.3.0"'), { message: /^invalid JSON/ });
  assert.throws(() => parseCurrent(""), { message: /^invalid JSON/ });
});

test("ファイルが無ければ読み込みの失敗にする", (t) => {
  const dir = tempDir(t);
  assert.throws(() => readCurrent(path.join(dir, "current.json")), { message: "file not found" });
});

test("書いた内容を読み直せ、一時ファイルの残骸（壊れた中身）があっても読めて書ける", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "current.json");
  const tmp = `${file}.tmp`;
  writeFileSync(file, '{"app": "0.2.0"}');
  writeFileSync(tmp, '{"app": "0.3');
  assert.deepEqual(readCurrent(file), { app: "0.2.0" });
  await writeCurrent(file, FULL);
  assert.deepEqual(readCurrent(file), FULL);
  assert.equal(existsSync(tmp), false);
  // 省略した項目はキーごと書かない
  await writeCurrent(file, { app: "0.2.0", runtime: undefined, failed: { app: "0.3.0", at: "2026-10-07T12:00:00.000Z" } });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { app: "0.2.0", failed: { app: "0.3.0", at: "2026-10-07T12:00:00.000Z" } });
});

test("renameがEPERM/EBUSYなら間を置いて再試行する", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "current.json");
  writeFileSync(file, '{"app": "0.2.0"}');
  const failures = ["EPERM", "EBUSY", "EPERM"];
  let renames = 0;
  const waits: number[] = [];
  await writeCurrent(file, { app: "0.3.0" }, {
    rename: (from, to) => {
      renames++;
      const code = failures.shift();
      if (code) throw errnoError(code);
      renameSync(from, to);
    },
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  assert.equal(renames, 4);
  assert.deepEqual(waits, [100, 100, 100]);
  assert.deepEqual(readCurrent(file), { app: "0.3.0" });
});

test("renameの再試行は5回までで、それ以外のエラーは再試行しない", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "current.json");
  writeFileSync(file, '{"app": "0.2.0"}');
  for (const [code, attempts] of [["EBUSY", 6], ["EACCES", 1], ["ENOENT", 1]] as const) {
    let renames = 0;
    let waits = 0;
    await assert.rejects(
      writeCurrent(file, { app: "0.3.0" }, {
        rename: () => {
          renames++;
          throw errnoError(code);
        },
        wait: async () => {
          waits++;
        },
      }),
      { code },
    );
    assert.equal(renames, attempts, code);
    assert.equal(waits, attempts - 1, code);
    assert.deepEqual(readCurrent(file), { app: "0.2.0" });
  }
});

test("runtimeを省略したら起動役自身のNode.jsを使い、指定したらインストール先からの相対で解決する", () => {
  const installDir = path.join(tmpdir(), "nijimaku");
  const server = path.join(installDir, "app", "versions", "0.3.0", "src", "server.ts");
  assert.deepEqual(resolveLaunch(installDir, { app: "0.3.0" }, "/opt/node"), { runtime: "/opt/node", server });
  assert.deepEqual(resolveLaunch(installDir, { app: "0.3.0", runtime: "app/runtimes/v24.22.0/node.exe" }, "/opt/node"), {
    runtime: path.join(installDir, "app", "runtimes", "v24.22.0", "node.exe"),
    server,
  });
});

const NOW = new Date("2026-10-07T12:00:00.000Z");
const PENDING: CurrentState = { app: "0.3.1", runtime: "app/runtimes/v24.22.0/node.exe", pending: true, previous: { app: "0.3.0" } };

function decide(exit: ChildExit, state: CurrentState = PENDING, flags: { rolledBack?: boolean; interrupted?: boolean } = {}) {
  return nextAction(exit, { state, rolledBack: flags.rolledBack ?? false, interrupted: flags.interrupted ?? false, now: NOW });
}

test("75はreadyの前後どちらでも再起動する", () => {
  assert.deepEqual(decide({ code: 75, ready: true }), { type: "restart" });
  assert.deepEqual(decide({ code: 75, ready: false }), { type: "restart" });
  assert.deepEqual(decide({ code: 75, ready: false }, PENDING, { rolledBack: true }), { type: "restart" });
});

test("pendingの版がready前に失敗したらpreviousへ戻し、failedを書く", () => {
  const failed = { app: "0.3.1", at: "2026-10-07T12:00:00.000Z" };
  assert.deepEqual(decide({ code: 1, ready: false }), { type: "rollback", state: { app: "0.3.0", failed } });
  // シグナルでの終了も起動の失敗
  assert.deepEqual(decide({ code: null, ready: false }), { type: "rollback", state: { app: "0.3.0", failed } });
  // spawnの失敗
  assert.deepEqual(decide({ code: -2, ready: false }), { type: "rollback", state: { app: "0.3.0", failed } });
  // previousのruntimeは引き継ぎ、pending・previous・前のfailedは残さない
  const withRuntime: CurrentState = {
    ...PENDING,
    previous: { app: "0.3.0", runtime: "app/runtimes/v24.21.0/node.exe" },
    failed: { app: "0.2.9", at: "2026-10-01T00:00:00.000Z" },
  };
  assert.deepEqual(decide({ code: 3, ready: false }, withRuntime), {
    type: "rollback",
    state: { app: "0.3.0", runtime: "app/runtimes/v24.21.0/node.exe", failed },
  });
});

test("pendingでない・previousが無い・既に戻した・ready後の失敗は戻さずに子のコードで終わる", () => {
  assert.deepEqual(decide({ code: 1, ready: false }, { app: "0.3.1", previous: { app: "0.3.0" } }), { type: "exit", code: 1 });
  assert.deepEqual(decide({ code: 1, ready: false }, { ...PENDING, pending: false }), { type: "exit", code: 1 });
  assert.deepEqual(decide({ code: 1, ready: false }, { app: "0.3.1", pending: true }), { type: "exit", code: 1 });
  assert.deepEqual(decide({ code: 1, ready: false }, PENDING, { rolledBack: true }), { type: "exit", code: 1 });
  assert.deepEqual(decide({ code: 3, ready: true }), { type: "exit", code: 3 });
  assert.deepEqual(decide({ code: 3221225477, ready: true }), { type: "exit", code: 3221225477 });
});

test("0と78はready前でも戻さず同じコードで終わる", () => {
  assert.deepEqual(decide({ code: 0, ready: false }), { type: "exit", code: 0 });
  assert.deepEqual(decide({ code: 0, ready: true }), { type: "exit", code: 0 });
  assert.deepEqual(decide({ code: 78, ready: false }), { type: "exit", code: 78 });
  assert.deepEqual(decide({ code: 78, ready: true }), { type: "exit", code: 78 });
});

test("シグナルでの終了は、戻さないなら1で終わる", () => {
  assert.deepEqual(decide({ code: null, ready: true }), { type: "exit", code: 1 });
  assert.deepEqual(decide({ code: null, ready: false }, { app: "0.3.1" }), { type: "exit", code: 1 });
  assert.deepEqual(decide({ code: null, ready: false }, PENDING, { rolledBack: true }), { type: "exit", code: 1 });
});

test("SIGINTを受けた後は、再起動も戻しもせず子のコードで終わる", () => {
  const interrupted = { interrupted: true };
  assert.deepEqual(decide({ code: 75, ready: true }, PENDING, interrupted), { type: "exit", code: 75 });
  assert.deepEqual(decide({ code: 1, ready: false }, PENDING, interrupted), { type: "exit", code: 1 });
  assert.deepEqual(decide({ code: null, ready: false }, PENDING, interrupted), { type: "exit", code: 1 });
  assert.deepEqual(decide({ code: 0, ready: true }, PENDING, interrupted), { type: "exit", code: 0 });
});
