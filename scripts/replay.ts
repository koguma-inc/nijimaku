// WAVをブラウザのcaptureと同じく/ws/captureへ20msずつ実時間で流す（計測用）。
//
// 実行: node scripts/replay.ts [オプション] [wav...]
//   wav省略時はsamples/sample.wav（scripts/make-sample.shで作る）。複数指定なら順に続けて流す
//   --port N      接続先ポート（既定はPORT環境変数、無ければ4649）
//   --tail-ms N   全WAVの後に流す無音（既定1500）。最後の文をサーバーのVADにcommitさせるため
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import WebSocket from "ws";

const SAMPLE_RATE = 24000;
const FRAME_MS = 20;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
const FRAME_BYTES = FRAME_MS * BYTES_PER_MS;
const ROOT = path.join(import.meta.dirname, "..");
const CLOSE_TIMEOUT_MS = 2000;
const CLOSE_REPLACED = 4001;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" },
    "tail-ms": { type: "string", default: "1500" },
  },
});

const port = Number(opts.port ?? process.env.PORT ?? 4649);
if (!Number.isInteger(port) || port <= 0) {
  console.error(`ポートが不正です: ${opts.port ?? process.env.PORT}`);
  process.exit(1);
}
const tailMs = Number(opts["tail-ms"]);
if (!Number.isFinite(tailMs) || tailMs < 0) {
  console.error(`--tail-ms は0以上の数値: ${opts["tail-ms"]}`);
  process.exit(1);
}

const wavFiles = positionals.length > 0 ? positionals : [path.join(ROOT, "samples", "sample.wav")];
const pcms: { file: string; pcm: Buffer }[] = [];
for (const file of wavFiles) {
  try {
    pcms.push({ file, pcm: readPcm16(file) });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`WAVがありません: ${file}（先に scripts/make-sample.sh を実行する）`);
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exit(1);
  }
}

// --- 接続 ---

const url = `ws://127.0.0.1:${port}/ws/capture`;
const t0 = performance.now();
const elapsed = () => Math.round(performance.now() - t0);
const print = (msg: string) => console.log(`[${String(elapsed()).padStart(6)}ms] ${msg}`);

let opened = false;
let closingBySelf = false;
let selfExitCode = 0;
let finished = false;

print(`connect ${url}`);
const ws = new WebSocket(url);

ws.on("open", () => {
  opened = true;
  print("open");
  stream().catch((err) => {
    console.error(`送信に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    finish(1);
  });
});

ws.on("message", (raw, isBinary) => {
  if (isBinary) return;
  print(`recv ${raw.toString()}`);
});

ws.on("error", (err) => {
  console.error(`WebSocketエラー: ${err.message}`);
});

ws.on("close", (code, reason) => {
  const detail = reason.length > 0 ? ` (${reason.toString()})` : "";
  if (!opened) {
    console.error(`接続できませんでした: ${url}（サーバーが起動しているか確認する）`);
    finish(1);
  } else if (closingBySelf) {
    print(`closed ${code}${detail}`);
    finish(selfExitCode);
  } else if (code === CLOSE_REPLACED) {
    console.error(`別の入力に置き換えられたため終了します（close ${code}${detail}）`);
    finish(1);
  } else {
    console.error(`予期しない切断です（close ${code}${detail}）`);
    finish(1);
  }
});

process.on("SIGINT", () => {
  if (ws.readyState !== WebSocket.OPEN) return finish(130);
  print("SIGINT");
  selfExitCode = 130;
  closeSelf();
});

// --- 送信 ---

async function stream(): Promise<void> {
  // 送信時刻は開始時刻からの絶対スケジュールで決め、sleepの誤差を積み上げない
  const start = performance.now();
  let i = 0;
  const send = async (frame: Buffer): Promise<boolean> => {
    const wait = start + i * FRAME_MS - performance.now();
    if (wait > 0) await sleep(wait);
    if (closingBySelf || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(frame);
    i += 1;
    return true;
  };

  for (const { file, pcm } of pcms) {
    print(`send ${path.basename(file)} (${Math.round(pcm.length / BYTES_PER_MS)}ms)`);
    for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
      if (!(await send(padFrame(pcm.subarray(off, off + FRAME_BYTES))))) return;
    }
  }
  print(`send tail silence (${tailMs}ms)`);
  const silent = Buffer.alloc(FRAME_BYTES);
  for (let n = Math.ceil(tailMs / FRAME_MS); n > 0; n--) {
    if (!(await send(silent))) return;
  }
  print(`sent ${i} frames`);
  closeSelf();
}

// 末尾の端数は無音で埋めて、常に20msのフレームとして送る
function padFrame(chunk: Buffer): Buffer {
  if (chunk.length === FRAME_BYTES) return chunk;
  const frame = Buffer.alloc(FRAME_BYTES);
  chunk.copy(frame);
  return frame;
}

function closeSelf(): void {
  if (closingBySelf) return;
  closingBySelf = true;
  ws.close(1000);
  // サーバーが閉じ返さないときに待ち続けない
  setTimeout(() => ws.terminate(), CLOSE_TIMEOUT_MS).unref();
}

function finish(code: number): void {
  if (finished) return;
  finished = true;
  process.exit(code);
}

// --- 補助 ---

// afconvertのWAVはfmtとdataの間にFLLR等のチャンクが入るため、チャンクを順に辿る
function readPcm16(file: string): Buffer {
  const buf = readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${file}: WAVではありません`);
  }
  let fmtOk = false;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      const format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const rate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      if (format !== 1 || channels !== 1 || rate !== SAMPLE_RATE || bits !== 16) {
        throw new Error(`${file}: 24kHz・16bit・モノラルのPCMではありません`);
      }
      fmtOk = true;
    } else if (id === "data") {
      if (!fmtOk) throw new Error(`${file}: fmtチャンクがdataより後にあります`);
      return buf.subarray(body, body + size);
    }
    off = body + size + (size % 2);
  }
  throw new Error(`${file}: dataチャンクがありません`);
}
