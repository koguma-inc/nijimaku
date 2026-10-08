const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;

/**
 * 字幕の要素を作り、セグメントの配列を描画する。mountOverlayと設定パネルのプレビューで使う。
 * @param {HTMLElement} container
 * @returns {{render: (segments: any[]) => void, remove: () => void}}
 */
export function createSubs(container) {
  // PiPは別documentなので要素はcontainer側のdocumentで作る
  const doc = container.ownerDocument;
  const root = doc.createElement("div");
  root.className = "nm-subs";
  container.append(root);

  /** @type {Map<string, {el: HTMLElement, ja: HTMLElement, en: HTMLElement}>} */
  const views = new Map();

  function createView(id) {
    const el = doc.createElement("div");
    el.className = "nm-seg";
    el.dataset.id = id;
    const ja = doc.createElement("div");
    ja.className = "nm-line nm-ja";
    ja.lang = "ja";
    const en = doc.createElement("div");
    en.className = "nm-line nm-en";
    en.lang = "en";
    en.hidden = true;
    el.append(ja, en);
    return { el, ja, en };
  }

  function render(segments) {
    const keep = new Set();
    const ordered = [];
    for (const seg of segments) {
      if (!seg || typeof seg.id !== "string" || keep.has(seg.id)) continue;
      keep.add(seg.id);
      let view = views.get(seg.id);
      if (!view) {
        view = createView(seg.id);
        views.set(seg.id, view);
      }
      const text = typeof seg.text === "string" ? seg.text : "";
      const en = typeof seg.en === "string" ? seg.en : "";
      const state = String(seg.state);
      if (view.el.dataset.state !== state) view.el.dataset.state = state;
      if (view.ja.textContent !== text) view.ja.textContent = text;
      if (view.en.textContent !== en) view.en.textContent = en;
      view.en.hidden = en === "";
      ordered.push(view.el);
    }
    for (const [id, view] of views) {
      if (!keep.has(id)) {
        view.el.remove();
        views.delete(id);
      }
    }
    // スナップショットの順に並べ直す（既に正しい位置の要素は動かさない）
    ordered.forEach((el, i) => {
      if (root.children[i] !== el) root.insertBefore(el, root.children[i] ?? null);
    });
  }

  function remove() {
    views.clear();
    root.remove();
  }

  return { render, remove };
}

// カラオケモードが覚えておく文の数。表示中の文（最大10）と再接続で送り直される分に十分な数
const TICKER_MEMORY = 200;

/**
 * カラオケモード用に、スナップショットを「足す文字」に変える。
 * 表示済みの文はスナップショットから消えても（再接続の送り直し・表示する文の数の上限）覚えておき、二重に足さない。
 * 確定やLunaの修正で文字が変わっても、流れている文字は置き換えず、末尾が伸びた分だけ足す。
 * @param {Map<string, string>} shown idごとの表示済みの文字。呼ぶたびに更新する
 * @param {any[]} segments
 * @returns {{id: string, state: string, text: string}[]} textは足す文字。空なら状態の更新だけ
 */
export function tickerUpdates(shown, segments) {
  const updates = [];
  for (const seg of segments) {
    if (!seg || typeof seg.id !== "string" || typeof seg.text !== "string") continue;
    const prev = shown.get(seg.id);
    let text = "";
    if (prev === undefined) text = seg.text;
    else if (seg.text.startsWith(prev)) text = seg.text.slice(prev.length);
    if (prev === undefined || text !== "") shown.set(seg.id, seg.text);
    updates.push({ id: seg.id, state: String(seg.state), text });
  }
  while (shown.size > TICKER_MEMORY) shown.delete(shown.keys().next().value);
  return updates;
}

/**
 * カラオケモード（設定の「カラオケモード」か、overlay.html?mode=karaoke）。字幕を1行で右から左へ流し続ける。英訳は出さない。
 * 文ごとの要素を画面の右端の外に置き、毎フレームtransformで左へ動かす。
 * @param {HTMLElement} container
 * @returns {{render: (segments: any[]) => void, remove: () => void}}
 */
export function createTicker(container) {
  const doc = container.ownerDocument;
  const win = doc.defaultView ?? window;
  const root = doc.createElement("div");
  root.className = "nm-ticker";
  container.append(root);

  /** @type {Map<string, string>} */
  const shown = new Map();
  /** @type {Map<string, {el: HTMLElement, x: number}>} 画面に残っている文 */
  const views = new Map();
  /** @type {{el: HTMLElement, x: number} | null} 最後に置いた文。文字が増えるのはこの文だけという前提 */
  let tail = null;
  let raf = 0;
  let last = win.performance.now();

  // 1秒に流す距離（px）。設定パネルで変えられるので毎フレーム読む。
  // 倍率はPiPでbody.is-pipが上書きするので、:rootではなく要素から読む
  function speed() {
    const style = win.getComputedStyle(root);
    const base = parseFloat(style.getPropertyValue("--nm-ticker-speed")) || 180;
    const scale = parseFloat(style.getPropertyValue("--nm-scale")) || 1;
    return base * scale;
  }

  function render(segments) {
    const width = root.clientWidth;
    for (const { id, state, text } of tickerUpdates(shown, segments)) {
      let view = views.get(id);
      if (!view) {
        // 流れ去った文の状態だけの更新
        if (text === "") continue;
        const el = doc.createElement("span");
        el.className = "nm-ticker-seg";
        // 文字は画面の右端から入る。前の文がまだ右端の外にあればその後ろに並べる
        const x = Math.max(width, tail ? tail.x + tail.el.offsetWidth : 0);
        el.style.transform = `translateX(${x}px)`;
        root.append(el);
        view = { el, x };
        views.set(id, view);
        tail = view;
      }
      if (text !== "") view.el.append(doc.createTextNode(text));
      if (view.el.dataset.state !== state) view.el.dataset.state = state;
    }
  }

  function frame(now) {
    // 非表示タブでrAFが止まった後に一気に進めない
    const dt = Math.min(now - last, 100) / 1000;
    last = now;
    const width = root.clientWidth || 1;
    // 右端の外に溜まった分に応じて速める（1画面分で2倍、上限3倍）。歌う速さと流す速さの差で遅れが溜まり続けないように
    const end = tail ? tail.x + tail.el.offsetWidth : 0;
    const dx = speed() * (1 + Math.min(Math.max(end - width, 0) / width, 2)) * dt;
    for (const [id, view] of views) {
      view.x -= dx;
      if (view.x + view.el.offsetWidth < 0) {
        view.el.remove();
        views.delete(id);
        if (tail === view) tail = null;
        continue;
      }
      view.el.style.transform = `translateX(${view.x}px)`;
    }
    raf = win.requestAnimationFrame(frame);
  }
  raf = win.requestAnimationFrame(frame);

  function remove() {
    win.cancelAnimationFrame(raf);
    views.clear();
    shown.clear();
    tail = null;
    root.remove();
  }

  return { render, remove };
}

/**
 * ページを読み込んでから最初に受けた版を基準にし、違う版を受けたらtrueを返す関数を作る
 * @returns {(version: unknown) => boolean}
 */
export function createVersionWatch() {
  /** @type {string | null} */
  let base = null;
  return (version) => {
    if (typeof version !== "string") return false;
    if (base === null) {
      base = version;
      return false;
    }
    return version !== base;
  };
}

/**
 * /ws/overlayのスナップショットを描画する。overlay.htmlとPiPの両方で使う。
 * @param {HTMLElement} container
 * @param {{onVersion?: (version: string) => void, mode?: string | null}} [options]
 *   onVersionは接続ごとにサーバーの版を受ける。modeが"karaoke"なら設定に関係なく常に1行で流す表示にする
 * @returns {() => void} アンマウント関数
 */
export function mountOverlay(container, { onVersion, mode } = {}) {
  // WebSocketとlocationはこのモジュールのwindowのもの（PiPのlocationはサーバーを指さない）
  const doc = container.ownerDocument;
  // クエリで固定しなければ、設定の「カラオケモード」（modeメッセージ）に従って表示を切り替える
  const fixedKaraoke = mode === "karaoke";
  let karaoke = fixedKaraoke;
  let view = karaoke ? createTicker(container) : createSubs(container);
  /** @type {any[]} 最後に受けたスナップショット。表示を切り替えたときに描き直す */
  let segments = [];

  function setKaraoke(on) {
    if (fixedKaraoke || on === karaoke) return;
    karaoke = on;
    view.remove();
    view = on ? createTicker(container) : createSubs(container);
    view.render(segments);
  }

  /** @type {Set<string>} */
  let styleKeys = new Set();
  /** @type {WebSocket | null} */
  let ws = null;
  let retryTimer = 0;
  let backoff = BACKOFF_MIN_MS;
  let unmounted = false;

  // 設定パネルで変えたCSS変数だけを:rootに上書きする。PiPではbody.is-pipで定義した変数（倍率・位置）が優先される
  function applyStyle(vars) {
    const style = doc.documentElement.style;
    const next = new Set();
    for (const [name, value] of Object.entries(vars)) {
      if (!name.startsWith("--nm-") || typeof value !== "string") continue;
      style.setProperty(name, value);
      next.add(name);
    }
    for (const name of styleKeys) if (!next.has(name)) style.removeProperty(name);
    styleKeys = next;
  }

  function connect() {
    retryTimer = 0;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${location.host}/ws/overlay`);
    ws = socket;
    socket.onopen = () => {
      if (ws !== socket) return;
      backoff = BACKOFF_MIN_MS;
    };
    socket.onmessage = (ev) => {
      if (ws !== socket || typeof ev.data !== "string") return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg?.type === "snapshot" && Array.isArray(msg.segments)) {
        segments = msg.segments;
        view.render(segments);
      } else if (msg?.type === "style" && msg.vars && typeof msg.vars === "object") applyStyle(msg.vars);
      else if (msg?.type === "mode" && typeof msg.karaoke === "boolean") setKaraoke(msg.karaoke);
      else if (msg?.type === "app" && typeof msg.version === "string") onVersion?.(msg.version);
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      // 切断中に古い字幕を出し続けない。再接続時のスナップショットで戻る（カラオケモードでは流れ去るのを待つ）
      segments = [];
      view.render(segments);
      if (unmounted) return;
      retryTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    };
  }

  connect();

  return function unmount() {
    if (unmounted) return;
    unmounted = true;
    clearTimeout(retryTimer);
    const socket = ws;
    ws = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = null;
      socket.close(1000);
    }
    applyStyle({});
    view.remove();
  };
}
