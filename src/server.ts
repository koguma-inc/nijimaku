// HTTP静的配信とWSアップグレード、各部品の配線。
// 実行: nr start
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { AudioPipeline, type InputStats } from "./audio-pipeline.ts";
import { loadConfig, type Config } from "./config.ts";
import { Corrector, type StreamContext } from "./corrector.ts";
import { CredentialsStore } from "./credentials.ts";
import { createLogger, createNoopLogger } from "./log.ts";
import { openBrowser } from "./open-browser.ts";
import { RealtimeSession, type TranscriptionConfig } from "./realtime.ts";
import { SegmentStore, type Snapshot } from "./segments.ts";
import { SettingsStore, settingsDefaults, type Settings } from "./settings.ts";
import { Updater, type UpdateStatus } from "./update.ts";
import type { VadOptions } from "./vad.ts";

// ROOTはアプリの版のフォルダ（開発時はリポジトリ）。利用者のデータは起動役が渡すDATA_DIRに置き、更新で版のフォルダが変わっても残す
const ROOT = path.join(import.meta.dirname, "..");
const DATA_DIR = process.env.NIJIMAKU_DATA_DIR || ROOT;
const PUBLIC_DIR = path.join(ROOT, "public");
const APP_VERSION = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const HOST = "127.0.0.1";
const CLOSE_REPLACED = 4001;
// 起動役（src/launcher.ts）への終了コード。75は更新を適用したので起動し直してほしい、
// 78は起動できないが版のせいではない（起動役は前の版へ戻さない）
const EXIT_RESTART = 75;
const EXIT_NOT_VERSION_FAULT = 78;
// 起動役のプロトコルの版。起動役から起動されたときだけ更新できる
const LAUNCHER_PROTOCOL = 1;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(EXIT_NOT_VERSION_FAULT);
}

const logger = config.saveLogs ? createLogger(path.join(DATA_DIR, "logs")) : createNoopLogger();
const localOrigins = new Set([`http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`]);
const allowedOrigins = new Set([...localOrigins, ...config.allowedOrigins]);

const settingsStore = new SettingsStore(settingsDefaults(config), path.join(DATA_DIR, "settings.json"));
for (const warning of settingsStore.load()) console.warn(`[settings] ${warning}`);
const initial = settingsStore.current;
const credentials = new CredentialsStore(path.join(DATA_DIR, "credentials.json"), config.openaiApiKey);
const credentialsWarning = credentials.load();
if (credentialsWarning) console.warn(`[credentials] ${credentialsWarning}`);
const staticRoutes = buildStaticRoutes();

// --- 部品の配線 ---

type Capture = { id: number; ws: WebSocket; stats?: InputStats };

let current: Capture | null = null;
let captureSeq = 0;
const overlays = new Set<WebSocket>();

const segments = new SegmentStore({
  displaySegments: initial.displaySegments,
  contextSize: config.contextSize,
  onSnapshot: broadcastSnapshot,
});

const corrector = new Corrector(
  {
    apiKey: credentials.apiKey,
    timeoutMs: config.lunaTimeoutMs,
    mode: config.lunaMode,
    serviceTier: config.lunaServiceTier,
  },
  (id, ja, en) => {
    segments.fixed(id, ja, en);
    if (en !== undefined) console.log(`[fixed] ${ja} / ${en}`);
  },
  logger,
);
corrector.setContext(streamContext(initial));

const realtime = new RealtimeSession(
  { apiKey: credentials.apiKey, transcription: transcriptionConfig(initial), rotateMin: config.sessionRotateMin },
  {
    onPartial: (id, text) => segments.partial(id, text),
    onFinal: (id, transcript) => {
      // 空のfinalはLunaを呼ばずにセグメントを消す（SegmentStore.finalがfalseを返す）
      if (!segments.final(id, transcript)) return;
      console.log(`[final] ${transcript}`);
      corrector.correct(id, transcript, segments.context(id));
    },
    onCommitted: (seq, id) => segments.setSeq(id, seq),
    onDropped: (ids) => segments.dropPartials(ids),
    onStatus: (state, detail) => {
      console.log(`[realtime] ${state}${detail ? ` (${detail})` : ""}`);
      if (current) sendJson(current.ws, statusMessage());
      broadcastJson(settingsClients, credentialsMessage());
      // readyは保持音声のappend後に通知されるため、ここで保留中のcommitが100msのガードを通る
      if (state === "ready") pipeline.retryPendingCommit();
    },
    onUpdateRejected: (eventId, message) => revertTranscription(eventId, message),
  },
  logger,
);

const pipeline = new AudioPipeline({ vad: vadOptions(initial) }, realtime, logger);

// --- 設定パネル ---

const settingsClients = new Set<WebSocket>();
// 拒否されたら元に戻す値。session.updateのevent_idごと（同じ変更を2接続へ送ったときは同じ記録を共有する）
type Revert = { key: string; prev: unknown; wasOverridden: boolean; done: boolean };
const pendingUpdates = new Map<string, Revert>();

function vadOptions(s: Settings): VadOptions {
  return {
    thresholdDb: s.vadThresholdDb,
    silenceMs: s.vadSilenceMs,
    minSpeechMs: s.vadMinSpeechMs,
    maxSegmentMs: s.vadMaxSegmentMs,
  };
}

// 用語集の日本語はkeywords、配信の説明はpromptとして文字起こしにも渡す
function transcriptionConfig(s: Settings): TranscriptionConfig {
  return {
    delay: s.transcribeDelay,
    languages: s.transcribeLanguages,
    prompt: s.streamDescription,
    keywords: s.glossary.map((g) => g.ja),
  };
}

function streamContext(s: Settings): StreamContext {
  return { description: s.streamDescription, glossary: s.glossary };
}

function captureConfigMessage(): Record<string, unknown> {
  const s = settingsStore.current;
  return {
    type: "capture.config",
    apiKeyConfigured: credentials.status.configured,
    mic: {
      noiseSuppression: s.micNoiseSuppression,
      autoGainControl: s.micAutoGainControl,
      echoCancellation: s.micEchoCancellation,
    },
    vadThresholdDb: s.vadThresholdDb,
  };
}

function styleMessage(): Record<string, unknown> {
  return { type: "style", vars: settingsStore.styleVars() };
}

function changeSetting(ws: WebSocket, key: string, op: () => string | undefined): void {
  const before = settingsStore.current;
  const revert: Revert = {
    key,
    prev: settingsStore.values[key],
    wasOverridden: settingsStore.overridden.includes(key),
    done: false,
  };
  const error = op();
  if (error) {
    sendJson(ws, { type: "settings.error", key, message: error });
    return;
  }
  logger.log("settings.change", { key, value: settingsStore.values[key], overridden: settingsStore.overridden.includes(key) });
  console.log(`[settings] ${key} = ${JSON.stringify(settingsStore.values[key])}`);
  for (const eventId of applySettings(before)) pendingUpdates.set(eventId, revert);
  broadcastSettings();
}

// 変わった部品へだけ反映する。文字起こしへ送ったsession.updateのevent_idを返す
function applySettings(before: Settings): string[] {
  const s = settingsStore.current;
  pipeline.setVad(vadOptions(s));
  segments.setDisplaySegments(s.displaySegments);
  corrector.setContext(streamContext(s));
  if (current) sendJson(current.ws, captureConfigMessage());
  const style = JSON.stringify(styleMessage());
  for (const ws of overlays) if (ws.readyState === WebSocket.OPEN) ws.send(style);
  const next = transcriptionConfig(s);
  if (JSON.stringify(next) === JSON.stringify(transcriptionConfig(before))) return [];
  return realtime.updateTranscription(next);
}

// 拒否された値を元に戻し、戻した設定をもう一度送る（次の接続を失敗させないため）
function revertTranscription(eventId: string, message: string): void {
  const revert = pendingUpdates.get(eventId);
  pendingUpdates.delete(eventId);
  if (!revert || revert.done) return;
  revert.done = true;
  const before = settingsStore.current;
  if (revert.wasOverridden) settingsStore.set(revert.key, revert.prev);
  else settingsStore.reset(revert.key);
  logger.log("settings.revert", { key: revert.key, message });
  console.warn(`[settings] ${revert.key}を元に戻しました: ${message}`);
  applySettings(before);
  broadcastSettings();
  broadcastJson(settingsClients, { type: "settings.error", key: revert.key, message: `${message}（元の値に戻しました）` });
}

function broadcastSettings(): void {
  broadcastJson(settingsClients, settingsStore.message());
}

// --- 更新 ---

const updater =
  process.env.NIJIMAKU_LAUNCHER === String(LAUNCHER_PROTOCOL)
    ? new Updater({
        installDir: DATA_DIR,
        version: APP_VERSION,
        launcher: LAUNCHER_PROTOCOL,
        apiUrl: process.env.NIJIMAKU_UPDATE_API || undefined,
        onStatus: (status) => {
          logger.log("update.status", status);
          broadcastJson(settingsClients, updateStatusMessage());
        },
        onRestart: () => shutdown(EXIT_RESTART),
        warn: (message) => {
          logger.log("update.warn", { message });
          console.warn(`[update] ${message}`);
        },
      })
    : null;
const IDLE_STATUS: UpdateStatus = { state: "idle", version: null, url: null, message: "", failed: null };

// canApplyは、その接続から更新を適用できるか
function appInfoMessage(local: boolean): Record<string, unknown> {
  return { type: "app.info", version: APP_VERSION, nodeVersion: process.version, updater: updater !== null, canApply: updater !== null && local };
}

function updateStatusMessage(): Record<string, unknown> {
  return { type: "update.status", ...(updater?.status ?? IDLE_STATUS) };
}

function credentialsMessage(): Record<string, unknown> {
  return { type: "credentials.status", ...credentials.status, ...realtime.status };
}

function changeCredentials(ws: WebSocket, op: () => string | undefined): void {
  const before = credentials.apiKey;
  const error = op();
  if (error) {
    sendJson(ws, { type: "credentials.error", message: error });
    return;
  }
  if (before !== credentials.apiKey || (credentials.status.configured && realtime.status.state === "failed")) {
    pipeline.resetSession();
    pendingUpdates.clear();
    corrector.setApiKey(credentials.apiKey);
    realtime.setApiKey(credentials.apiKey);
    if (current) sendJson(current.ws, captureConfigMessage());
  }
  broadcastJson(settingsClients, credentialsMessage());
  sendJson(ws, { type: "credentials.saved" });
}

// --- HTTP ---

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const route = staticRoutes.get(pathnameOf(req));
  if (!route) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found");
    return;
  }
  try {
    const body = await readFile(route.file);
    res.writeHead(200, { "Content-Type": route.type, "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(500).end();
  }
});

// 起動時のpublic/の一覧だけを返す。リクエストのパスをファイルパスに連結しない
function buildStaticRoutes(): Map<string, { file: string; type: string }> {
  const routes = new Map<string, { file: string; type: string }>();
  for (const entry of readdirSync(PUBLIC_DIR, { withFileTypes: true })) {
    const type = CONTENT_TYPES[path.extname(entry.name)];
    if (!entry.isFile() || !type) continue;
    routes.set(`/${entry.name}`, { file: path.join(PUBLIC_DIR, entry.name), type });
  }
  const capture = routes.get("/capture.html");
  if (capture) routes.set("/", capture);
  return routes;
}

function pathnameOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return "";
  }
}

// --- WebSocket ---

const captureWss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
const overlayWss = new WebSocketServer({ noServer: true, maxPayload: 1 << 16 });
const settingsWss = new WebSocketServer({ noServer: true, maxPayload: 1 << 16 });

const WSS_BY_PATH: Record<string, WebSocketServer> = {
  "/ws/capture": captureWss,
  "/ws/overlay": overlayWss,
  "/ws/settings": settingsWss,
};

server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => {});
  const pathname = pathnameOf(req);
  const wss = WSS_BY_PATH[pathname];
  if (!wss) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  // Originの無い接続はcaptureとoverlayだけ許可する。同じPCの他のプロセスは信頼する前提。
  const origin = req.headers.origin;
  const allowed =
    wss === settingsWss
      ? origin !== undefined && allowedOrigins.has(origin)
      : origin === undefined || allowedOrigins.has(origin);
  if (!allowed) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

captureWss.on("connection", (ws: WebSocket) => {
  const capture: Capture = { id: ++captureSeq, ws };
  logger.log("capture.connect", { id: capture.id });
  console.log(`[capture] #${capture.id} 接続`);

  // captureは常に1本。順序を変えると、旧接続の音声が新接続のcommitに混ざったり、旧入力が区切られなかったりする
  const old = current;
  current = null;
  if (old) {
    pipeline.commit("replaced");
    old.stats = pipeline.resetInput();
  } else {
    pipeline.resetInput();
  }
  current = capture;
  if (old) old.ws.close(CLOSE_REPLACED, "replaced");

  sendJson(ws, statusMessage());
  sendJson(ws, captureConfigMessage());

  // 置き換え後に届く旧接続のmessage/closeはパイプラインに触れない
  ws.on("message", (data, isBinary) => {
    if (current !== capture || !isBinary) return;
    pipeline.pushChunk(toBuffer(data));
  });
  ws.on("close", (code) => {
    const wasCurrent = current === capture;
    if (wasCurrent) {
      current = null;
      pipeline.commit("close");
      capture.stats = pipeline.resetInput();
    }
    logger.log("capture.close", { id: capture.id, code, current: wasCurrent, ...capture.stats });
    console.log(`[capture] #${capture.id} 切断 code=${code}${wasCurrent ? "" : "（置き換え済み）"}`);
  });
  ws.on("error", (err) => console.warn(`[capture] #${capture.id} ${err.message}`));
});

overlayWss.on("connection", (ws: WebSocket) => {
  overlays.add(ws);
  // overlay.htmlは版が変わったら読み直す（更新後に古いoverlay.js・overlay.cssを使い続けない）
  sendJson(ws, { type: "app", version: APP_VERSION });
  sendJson(ws, styleMessage());
  sendJson(ws, segments.snapshot());
  ws.on("close", () => overlays.delete(ws));
  ws.on("error", () => overlays.delete(ws));
});

settingsWss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  // 更新の適用はこのPCのページからだけ受け付け、nr shareの公開URLからは拒否する
  const local = localOrigins.has(req.headers.origin ?? "");
  settingsClients.add(ws);
  sendJson(ws, settingsStore.message());
  sendJson(ws, credentialsMessage());
  sendJson(ws, appInfoMessage(local));
  sendJson(ws, updateStatusMessage());
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!isObject(message)) return;
    if (message.type === "credentials.set") {
      changeCredentials(ws, () => credentials.set(message.apiKey));
      return;
    }
    if (message.type === "credentials.reset") {
      changeCredentials(ws, () => credentials.reset());
      return;
    }
    if (message.type === "update.apply") {
      if (!local) sendJson(ws, { type: "update.error", message: "更新は、Nijimakuを動かしているPCで開いたページからだけ実行できます" });
      // 受け付けなかったとき（確認中・適用中など）は今の状態を返す
      else if (!updater?.apply()) sendJson(ws, updateStatusMessage());
      return;
    }
    if (typeof message.key !== "string") return;
    const key = message.key;
    if (message.type === "set") changeSetting(ws, key, () => settingsStore.set(key, message.value));
    else if (message.type === "reset") changeSetting(ws, key, () => settingsStore.reset(key));
  });
  ws.on("close", () => settingsClients.delete(ws));
  ws.on("error", () => settingsClients.delete(ws));
});

function broadcastJson(clients: Set<WebSocket>, message: unknown): void {
  const data = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function broadcastSnapshot(snapshot: Snapshot): void {
  const data = JSON.stringify(snapshot);
  for (const ws of overlays) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function statusMessage(): Record<string, unknown> {
  return { type: "status", ...realtime.status };
}

function sendJson(ws: WebSocket, message: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- 起動と終了 ---

server.on("error", (err: NodeJS.ErrnoException) => {
  const inUse = err.code === "EADDRINUSE";
  const reason = inUse ? `ポート${config.port}は使用中です。Nijimakuを二重に起動していないか確かめてください` : err.message;
  console.error(`サーバーを起動できません: ${reason}`);
  process.exit(inUse ? EXIT_NOT_VERSION_FAULT : 1);
});

server.listen(config.port, HOST, () => {
  console.log(`capture: http://localhost:${config.port}/`);
  console.log(`overlay: http://localhost:${config.port}/overlay.html`);
  for (const origin of config.allowedOrigins) console.log(`公開URL: ${origin}/`);
  console.log(`log: ${logger.path ?? "保存しない（SAVE_LOGS=1で保存する）"}`);
  console.log(`luna: mode=${config.lunaMode} service_tier=${config.lunaServiceTier}`);
  logger.log("luna.config", { mode: config.lunaMode, service_tier: config.lunaServiceTier });
  realtime.start();
  // listenの後に開く。start.cmdで先に開くと、ページの読み込みがサーバーの起動に間に合わないことがある
  if (process.argv.includes("--open")) {
    console.log("このウィンドウを閉じるとNijimakuが止まります");
    openBrowser(`http://localhost:${config.port}/`);
  }
  // 起動役は、readyの前に終わった版を起動の失敗とみなす
  process.send?.({ type: "ready" });
  void updater?.start();
});

let shuttingDown = false;

function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  realtime.stop();
  current?.ws.close(1001);
  for (const ws of [...overlays, ...settingsClients]) ws.close(1001);
  server.close();
  setTimeout(() => process.exit(code), 1000).unref();
  void logger.close().then(() => process.exit(code));
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
