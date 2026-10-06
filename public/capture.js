import { mountOverlay } from "./overlay.js";
import { mountSettings } from "./settings-panel.js";
import { mountPreview } from "./subs-preview.js";

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const METER_FLOOR_DB = -60;
const RT_STATES = {
  unconfigured: { label: "APIキー未設定", tone: "error" },
  connecting: { label: "接続中", tone: "warn" },
  ready: { label: "準備完了", tone: "ok" },
  rotating: { label: "接続切り替え中", tone: "ok" },
  reconnecting: { label: "再接続中", tone: "warn" },
  failed: { label: "接続できません", tone: "error" },
};
const LIVE_LABELS = { off: "停止中", wait: "準備中", on: "LIVE" };
const TAB_STORAGE_KEY = "nijimaku.captureTab";

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const deviceSelect = /** @type {HTMLSelectElement} */ ($("cap-device"));
const startBtn = /** @type {HTMLButtonElement} */ ($("cap-start"));
const stopBtn = /** @type {HTMLButtonElement} */ ($("cap-stop"));
const pipBtn = /** @type {HTMLButtonElement} */ ($("cap-pip"));
const pipNote = $("cap-pip-note");
const meterEl = $("cap-meter");
const meterBar = $("cap-meter-bar");
const meterValue = $("cap-meter-value");
const meterThreshold = $("cap-meter-threshold");
const wsStatEl = $("cap-ws-stat");
const wsStateEl = $("cap-ws-state");
const rtStatEl = $("cap-rt-stat");
const rtStateEl = $("cap-rt-state");
const rtDetailEl = $("cap-rt-detail");
const liveEl = $("cap-live");
const setupEl = $("cap-setup");
const messageEl = $("cap-message");

/** @type {{stream: MediaStream, ctx: AudioContext, source: MediaStreamAudioSourceNode, node: AudioWorkletNode} | null} */
let audio = null;
let starting = false;
let apiKeyConfigured = location.hostname === "localhost" || location.hostname === "127.0.0.1" ? false : null;
/** @type {WebSocket | null} */
let ws = null;
let retryTimer = 0;
let backoff = BACKOFF_MIN_MS;
let levelDb = -Infinity;
let thresholdDb = NaN;
let rtState = "-";
let meterRaf = 0;
// サーバーの設定（/ws/captureのcapture.config、localhostなら設定パネルからも届く）
let mic = { noiseSuppression: true, autoGainControl: true, echoCancellation: true };
const MIC_KEYS = /** @type {const} */ (["noiseSuppression", "autoGainControl", "echoCancellation"]);

function errText(err) {
  return err?.name ? `${err.name}: ${err.message}` : String(err);
}

function setMessage(text, isError = false) {
  messageEl.textContent = text;
  messageEl.classList.toggle("is-error", isError);
}

/** @param {"idle" | "warn" | "ok" | "error"} tone */
function setWsState(text, tone = "idle") {
  wsStateEl.textContent = text;
  wsStatEl.dataset.tone = tone;
}

function setRtState(state, detail = "") {
  rtState = state;
  const info = RT_STATES[state];
  rtStateEl.textContent = info?.label ?? state;
  rtDetailEl.textContent = detail;
  rtStatEl.dataset.tone = info?.tone ?? "idle";
  updateLive();
}

// 右上の表示。音声を送っていて、文字起こしの準備ができていればLIVE
function updateLive() {
  const state = audio === null ? "off" : rtState === "ready" || rtState === "rotating" ? "on" : "wait";
  document.body.dataset.live = state;
  liveEl.textContent = LIVE_LABELS[state];
}

function updateButtons() {
  startBtn.disabled = apiKeyConfigured === false || audio !== null || starting || !navigator.mediaDevices;
  startBtn.setAttribute("aria-busy", String(starting));
  startBtn.hidden = audio !== null;
  stopBtn.disabled = stopBtn.hidden = audio === null;
  deviceSelect.disabled = audio !== null || starting;
  updateLive();
}

async function refreshDevices() {
  if (!navigator.mediaDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  // 許可前はdeviceIdが空のエントリしか返らない
  const inputs = devices.filter((d) => d.kind === "audioinput" && d.deviceId);
  const selected = deviceSelect.value;
  deviceSelect.length = 1;
  inputs.forEach((d, i) => deviceSelect.add(new Option(d.label || `マイク ${i + 1}`, d.deviceId)));
  if ([...deviceSelect.options].some((o) => o.value === selected)) deviceSelect.value = selected;
}

// --- 音声 ---

function onFrame(ev) {
  const buf = ev.data;
  // 非表示タブでタイマーとrAFが止まるため、送信はこのハンドラ内で直接行う
  if (ws?.readyState === WebSocket.OPEN) ws.send(buf);
  const pcm = new Int16Array(buf);
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  levelDb = 20 * Math.log10(Math.sqrt(sum / pcm.length) / 32768);
}

function drawMeter() {
  meterRaf = requestAnimationFrame(drawMeter);
  const ratio = Math.max(0, Math.min(1, (levelDb - METER_FLOOR_DB) / -METER_FLOOR_DB));
  meterBar.style.width = `${(ratio * 100).toFixed(1)}%`;
  meterValue.textContent = Number.isFinite(levelDb) ? `${levelDb.toFixed(1)} dBFS` : "-∞ dBFS";
  meterEl.classList.toggle("is-over", levelDb >= thresholdDb);
}

function drawThreshold(db) {
  thresholdDb = db;
  const ratio = (db - METER_FLOOR_DB) / -METER_FLOOR_DB;
  meterThreshold.hidden = !Number.isFinite(ratio);
  meterThreshold.style.left = `${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(1)}%`;
}

function micConstraints() {
  const deviceId = deviceSelect.value;
  return { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), ...mic };
}

function applyCaptureConfig(config) {
  if (typeof config?.apiKeyConfigured === "boolean") {
    apiKeyConfigured = config.apiKeyConfigured;
    if (!apiKeyConfigured && audio) {
      stop();
      setMessage("APIキーを設定してから開始してください。", true);
    }
    updateButtons();
  }
  if (typeof config?.vadThresholdDb === "number") drawThreshold(config.vadThresholdDb);
  const next = config?.mic;
  if (!next || MIC_KEYS.every((k) => next[k] === mic[k])) return;
  mic = Object.fromEntries(MIC_KEYS.map((k) => [k, next[k] === true]));
  void applyMic();
}

// 開始中のマイクに加工のオン/オフを反映する。反映されなければ開き直しを促す
async function applyMic() {
  const track = audio?.stream.getAudioTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints(micConstraints());
  } catch {
    // 反映できたかは下のgetSettingsで判定する
  }
  const actual = track.getSettings();
  if (!MIC_KEYS.every((k) => actual[k] === mic[k])) {
    setMessage("ノイズ抑制・自動ゲイン調整・エコー除去の切り替えは、停止→開始で反映されます。");
  }
}

function stopMeter() {
  cancelAnimationFrame(meterRaf);
  meterRaf = 0;
  levelDb = -Infinity;
  meterBar.style.width = "0";
  meterValue.textContent = "-";
  meterEl.classList.remove("is-over");
}

function onTrackEnded() {
  stop();
  setMessage("マイクが切断されました。", true);
}

function stopAudio() {
  stopMeter();
  if (!audio) return;
  const { stream, ctx, source, node } = audio;
  audio = null;
  node.port.onmessage = null;
  source.disconnect();
  node.disconnect();
  for (const track of stream.getTracks()) {
    track.removeEventListener("ended", onTrackEnded);
    track.stop();
  }
  ctx.close().catch(() => {});
}

async function start() {
  if (audio || starting) return;
  starting = true;
  updateButtons();
  setMessage("");
  /** @type {MediaStream | undefined} */
  let stream;
  /** @type {AudioContext | undefined} */
  let ctx;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
    ctx = new AudioContext({ sampleRate: 24000 });
    await ctx.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url));
    await ctx.resume();
    const source = new MediaStreamAudioSourceNode(ctx, { mediaStream: stream });
    const node = new AudioWorkletNode(ctx, "pcm-writer", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
    });
    node.port.onmessage = onFrame;
    source.connect(node);
    // destinationへつながないとprocessが呼ばれないことがある（出力は無音）
    node.connect(ctx.destination);
    for (const track of stream.getAudioTracks()) track.addEventListener("ended", onTrackEnded);
    audio = { stream, ctx, source, node };
  } catch (err) {
    stream?.getTracks().forEach((t) => t.stop());
    ctx?.close().catch(() => {});
    setMessage(`マイクを開始できません: ${errText(err)}`, true);
    return;
  } finally {
    starting = false;
    updateButtons();
  }
  refreshDevices().catch(() => {});
  meterRaf = requestAnimationFrame(drawMeter);
  backoff = BACKOFF_MIN_MS;
  connect();
}

function stop() {
  clearTimeout(retryTimer);
  retryTimer = 0;
  const socket = ws;
  // 先に外しておき、この接続のcloseイベントを無視させる
  ws = null;
  if (socket) {
    socket.onopen = socket.onmessage = socket.onclose = null;
    socket.close(1000);
  }
  stopAudio();
  setWsState("未接続");
  setRtState("-");
  updateButtons();
}

// --- WebSocket ---

function connect() {
  retryTimer = 0;
  if (!audio) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${proto}//${location.host}/ws/capture`);
  socket.binaryType = "arraybuffer";
  ws = socket;
  setWsState("接続中", "warn");
  updateButtons();

  socket.onopen = () => {
    if (ws !== socket) return;
    backoff = BACKOFF_MIN_MS;
    setWsState("接続済み", "ok");
    updateButtons();
  };

  socket.onmessage = (ev) => {
    if (ws !== socket || typeof ev.data !== "string") return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg?.type === "status" && typeof msg.state === "string") {
      setRtState(msg.state, typeof msg.detail === "string" ? msg.detail : "");
    } else if (msg?.type === "capture.config") {
      applyCaptureConfig(msg);
    }
  };

  socket.onclose = (ev) => {
    if (ws !== socket) return;
    ws = null;
    setRtState("-");
    if (ev.code === 4001) {
      // 置き換えられた側が再接続すると入力を奪い合うため、開始が押されるまで繋がない
      stopAudio();
      setWsState("切断（別のページで開始）", "error");
      setMessage("別のタブやPCのページで開始されたため、このページからの送信を止めました。", true);
      updateButtons();
      return;
    }
    const delay = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    setWsState(`切断（code ${ev.code}）: ${delay / 1000}秒後に再接続`, "warn");
    retryTimer = setTimeout(connect, delay);
    updateButtons();
  };
}

// --- PiP ---

function copyStyleSheets(targetDoc) {
  for (const sheet of document.styleSheets) {
    try {
      const style = targetDoc.createElement("style");
      style.textContent = [...sheet.cssRules].map((r) => r.cssText).join("\n");
      targetDoc.head.append(style);
    } catch {
      if (!sheet.href) continue;
      const link = targetDoc.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      link.media = sheet.media.mediaText;
      targetDoc.head.append(link);
    }
  }
}

async function openPip() {
  if (documentPictureInPicture.window) {
    setMessage("字幕のPiPは既に開いています。");
    return;
  }
  let pipWin;
  try {
    // ユーザー操作の直後でないと拒否されるため、awaitを挟まずに最初に呼ぶ
    pipWin = await documentPictureInPicture.requestWindow({ width: 640, height: 220 });
  } catch (err) {
    setMessage(`PiPを開けません: ${errText(err)}`, true);
    return;
  }
  const pipDoc = pipWin.document;
  pipDoc.title = "Nijimaku 字幕";
  pipDoc.documentElement.lang = "ja";
  copyStyleSheets(pipDoc);
  pipDoc.body.classList.add("is-pip");
  const container = pipDoc.createElement("div");
  pipDoc.body.append(container);
  const unmount = mountOverlay(container);
  pipWin.addEventListener("pagehide", unmount, { once: true });
}

// --- 初期化 ---

// 押したボタンは隠れるので、フォーカスをもう一方へ移す
startBtn.addEventListener("click", async () => {
  await start();
  if (audio) stopBtn.focus();
});
stopBtn.addEventListener("click", () => {
  stop();
  setMessage("");
  startBtn.focus();
});

if ("documentPictureInPicture" in window) {
  pipBtn.addEventListener("click", () => void openPip());
} else {
  pipBtn.disabled = true;
  pipNote.textContent = "このブラウザはDocument Picture-in-Pictureに対応していません。Chromeで開いてください。";
}

// --- OBSのURL ---

const overlayUrlInput = /** @type {HTMLInputElement} */ ($("cap-overlay-url"));
const copyUrlBtn = $("cap-copy-url");
const overlayUrl = new URL("./overlay.html", location.href).href;
let copyTimer = 0;
overlayUrlInput.value = overlayUrl;
overlayUrlInput.addEventListener("focus", () => overlayUrlInput.select());
copyUrlBtn.addEventListener("click", async () => {
  let text = "コピーしました";
  try {
    await navigator.clipboard.writeText(overlayUrl);
  } catch {
    // http://localhost以外のhttpではクリップボードを使えない
    overlayUrlInput.focus();
    text = "選択したURLをコピーしてください";
  }
  copyUrlBtn.textContent = text;
  copyUrlBtn.classList.add("is-done");
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copyUrlBtn.textContent = "コピー";
    copyUrlBtn.classList.remove("is-done");
  }, 2000);
});

// --- 設定のタブ ---

const tabs = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll(".cap-tab")]);
const keyTab = $("cap-tab-key");

function showTab(name) {
  const target = tabs.find((t) => t.dataset.tab === name) ?? tabs[0];
  for (const tab of tabs) {
    const selected = tab === target;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(/** @type {string} */ (tab.getAttribute("aria-controls"))).hidden = !selected;
  }
  try {
    localStorage.setItem(TAB_STORAGE_KEY, target.dataset.tab ?? "");
  } catch {
    // 保存できなくても切り替えはできる
  }
  return target;
}

for (const tab of tabs) {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
  tab.addEventListener("keydown", (ev) => {
    const i = tabs.indexOf(tab);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[ev.key];
    if (next === undefined) return;
    ev.preventDefault();
    showTab(tabs[(next + tabs.length) % tabs.length].dataset.tab).focus();
  });
}

let savedTab = null;
try {
  savedTab = localStorage.getItem(TAB_STORAGE_KEY);
} catch {
  // 読めなければ最初のタブ
}
showTab(savedTab);

$("cap-setup-key").addEventListener("click", () => {
  showTab("key");
  $("cap-settings").scrollIntoView({ behavior: "smooth", block: "start" });
  $("cap-api-key").focus({ preventScroll: true });
});

// 広い画面ではコンソールが上に留まるので、その下にプレビューを留める
const consoleEl = $("cap-console");
new ResizeObserver(() => {
  document.body.style.setProperty("--cap-console-h", `${consoleEl.offsetHeight}px`);
}).observe(consoleEl);

const updatePreview = mountPreview($("cap-preview"));

mountSettings({
  card: $("cap-settings"),
  note: $("cap-settings-note"),
  message: $("cap-settings-message"),
  onCredentials: (status) => {
    setupEl.hidden = status.configured;
    keyTab.classList.toggle("has-alert", !status.configured);
    applyCaptureConfig({ apiKeyConfigured: status.configured });
    if (!audio) setRtState(status.state, status.detail ?? "");
  },
  onValues: (values, styleVars) => {
    applyCaptureConfig({
      vadThresholdDb: values.vadThresholdDb,
      mic: {
        noiseSuppression: values.micNoiseSuppression,
        autoGainControl: values.micAutoGainControl,
        echoCancellation: values.micEchoCancellation,
      },
    });
    updatePreview(values, styleVars);
  },
});

if (navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener("devicechange", () => refreshDevices().catch(() => {}));
  // 許可済みならラベル付きで埋まる。未許可なら開始後に埋める
  refreshDevices().catch(() => {});
} else {
  setMessage("マイクを使えません。http://localhost のURLで開いてください。", true);
}
updateButtons();
