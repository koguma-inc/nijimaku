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

/**
 * /ws/overlayのスナップショットを描画する。overlay.htmlとPiPの両方で使う。
 * @param {HTMLElement} container
 * @returns {() => void} アンマウント関数
 */
export function mountOverlay(container) {
  // WebSocketとlocationはこのモジュールのwindowのもの（PiPのlocationはサーバーを指さない）
  const doc = container.ownerDocument;
  const { render, remove } = createSubs(container);

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
      if (msg?.type === "snapshot" && Array.isArray(msg.segments)) render(msg.segments);
      else if (msg?.type === "style" && msg.vars && typeof msg.vars === "object") applyStyle(msg.vars);
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      // 切断中に古い字幕を出し続けない。再接続時のスナップショットで戻る
      render([]);
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
    remove();
  };
}
