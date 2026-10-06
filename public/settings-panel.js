// capture.htmlの設定パネル。/ws/settingsから項目の定義と値を受け取って描画し、変更を送る。
// メッセージの形はsrc/settings.tsの先頭にある。
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;

const colorCtx = /** @type {CanvasRenderingContext2D} */ (document.createElement("canvas").getContext("2d"));
const languageNames = new Intl.DisplayNames(["ja"], { type: "language" });

/** @param {string} code */
function languageName(code) {
  return languageNames.of(code) ?? code;
}

/**
 * CSSの色を、カラーピッカー用の#rrggbbと不透明度に分ける。
 * canvasのfillStyleは不透明なら#rrggbb、透明度があればrgba(r, g, b, a)に正規化される
 * @param {string} css
 */
function splitColor(css) {
  colorCtx.fillStyle = "#000000";
  colorCtx.fillStyle = css;
  const value = String(colorCtx.fillStyle);
  if (value.startsWith("#")) return { hex: value, alpha: 1 };
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(value);
  if (!m) return { hex: "#000000", alpha: 1 };
  const hex = `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  return { hex, alpha: m[4] === undefined ? 1 : Number(m[4]) };
}

/**
 * @param {string} hex
 * @param {number} alpha
 */
function joinColor(hex, alpha) {
  if (alpha >= 1) return hex;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * @param {{card: HTMLElement, note: HTMLElement, message: HTMLElement, onValues: (values: Record<string, unknown>, styleVars: Record<string, string>) => void, onCredentials: (status: any) => void}} opts
 */
export function mountSettings({ card, note, message, onValues, onCredentials }) {
  // サーバーはlocalhostのページからの接続だけ受け付ける
  if (location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    note.hidden = false;
    return;
  }
  /** @type {Map<string, {field: any, input?: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, glossary?: {el: HTMLElement, render: (value: any[]) => void}, reset: HTMLButtonElement, hint: HTMLElement, picker?: HTMLInputElement}>} */
  const rows = new Map();
  /** @type {WebSocket | null} */
  let ws = null;
  let backoff = BACKOFF_MIN_MS;
  let built = false;
  const keyForm = card.querySelector("#cap-api-key-form");
  const keyInput = card.querySelector("#cap-api-key");
  const keySave = card.querySelector("#cap-api-key-save");
  const keyReset = card.querySelector("#cap-api-key-reset");
  const keyState = card.querySelector("#cap-api-key-state");
  const keyMessage = card.querySelector("#cap-api-key-message");
  let keyPending = false;

  function setKeyMessage(text, isError = false) {
    keyMessage.textContent = text;
    keyMessage.classList.toggle("is-error", isError);
  }

  function updateKeyButtons() {
    const disabled = keyPending || ws?.readyState !== WebSocket.OPEN;
    keyInput.disabled = keySave.disabled = keyReset.disabled = disabled;
  }

  keyForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (keyPending || !send({ type: "credentials.set", apiKey: keyInput.value })) return;
    keyPending = true;
    setKeyMessage("保存中…");
    updateKeyButtons();
  });

  keyReset.addEventListener("click", () => {
    if (keyPending || !send({ type: "credentials.reset" })) return;
    keyPending = true;
    setKeyMessage("削除中…");
    updateKeyButtons();
  });

  function renderCredentials(msg) {
    keyReset.hidden = !msg.saved;
    keyInput.placeholder = msg.configured ? "変更するAPIキーを入力" : "APIキーを入力";
    const states = { connecting: "接続中", ready: "接続済み", rotating: "接続切り替え中", reconnecting: "再接続中", failed: "接続できません" };
    keyState.textContent = msg.configured
      ? `設定済み・${states[msg.state] ?? "接続待ち"}${msg.detail ? `: ${msg.detail}` : ""}`
      : "未設定です。APIキーを入力して保存してください。";
    updateKeyButtons();
    onCredentials(msg);
  }

  function setMessage(text, isError = false) {
    message.textContent = text;
    message.classList.toggle("is-error", isError);
  }

  function send(msg) {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  // overlay.cssの既定値（capture.htmlもoverlay.cssを読み込んでいる）
  function cssDefault(cssVar) {
    return getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  }

  function createInput(field) {
    switch (field.kind) {
      case "select":
      case "font": {
        const select = document.createElement("select");
        // 空の値は未設定（OSのフォント）で、選ぶと「既定」に戻す
        if (field.kind === "font") select.add(new Option("OSのフォント", ""));
        for (const option of field.options) select.add(new Option(option, option));
        return select;
      }
      case "boolean": {
        const input = document.createElement("input");
        input.type = "checkbox";
        return input;
      }
      case "textarea": {
        const textarea = document.createElement("textarea");
        textarea.rows = 3;
        return textarea;
      }
      case "number":
      case "px":
      case "percent": {
        const input = document.createElement("input");
        input.type = "number";
        input.min = String(field.min);
        input.max = String(field.max);
        input.step = String(field.step ?? 1);
        return input;
      }
      default: {
        const input = document.createElement("input");
        input.type = "text";
        if (field.kind === "color") input.className = "cap-color-text";
        return input;
      }
    }
  }

  // 1語ごとに日本語と英語の欄を並べる（書式の入力ミスを起こさないため）。末尾の空行に書くと追加になる
  function createGlossary(field) {
    const el = document.createElement("div");
    el.className = "cap-glossary";
    /** @type {{ja: string, en?: string}[]} */
    let latest = [];

    function textInput(value, placeholder) {
      const input = document.createElement("input");
      input.type = "text";
      input.value = value;
      input.placeholder = placeholder;
      input.setAttribute("aria-label", placeholder);
      input.maxLength = field.maxLength;
      input.addEventListener("change", submit);
      return input;
    }

    function addRow(entry) {
      const row = document.createElement("div");
      row.className = "cap-glossary-row";
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "削除";
      // 末尾の空行は追加用なので消せない
      del.disabled = !entry;
      del.addEventListener("click", () => {
        row.remove();
        submit();
        render(latest);
      });
      row.append(textInput(entry?.ja ?? "", "日本語"), textInput(entry?.en ?? "", "英語"), del);
      el.append(row);
    }

    // 送った値を控え、サーバーの応答前にフォーカスが外れても入力を消さない
    function submit() {
      latest = [...el.querySelectorAll(".cap-glossary-row")]
        .map((row) => [...row.querySelectorAll("input")].map((input) => input.value.trim()))
        .filter(([ja, en]) => ja !== "" || en !== "")
        .map(([ja, en]) => (en ? { ja, en } : { ja }));
      send({ type: "set", key: field.key, value: latest });
    }

    // 入力中は描き直さない。フォーカスが外れたときに最新の値で描き直す
    function render(value) {
      latest = value;
      if (el.contains(document.activeElement)) return;
      el.replaceChildren();
      for (const entry of value) addRow(entry);
      addRow(null);
    }

    el.addEventListener("focusout", (ev) => {
      if (!el.contains(/** @type {Node | null} */ (ev.relatedTarget))) render(latest);
    });
    return { el, render };
  }

  // featuredの項目だけ並べ、他は「ほかの言語」に折りたたむ
  function createChecklist(field) {
    const el = document.createElement("div");
    el.className = "cap-checks";
    const main = document.createElement("div");
    main.className = "cap-checks-list";
    const more = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "ほかの言語";
    const moreList = document.createElement("div");
    moreList.className = "cap-checks-list";
    more.append(summary, moreList);
    el.append(main, more);

    /** @type {Map<string, HTMLInputElement>} */
    const boxes = new Map();
    const rest = field.options.filter((code) => !field.featured.includes(code));
    for (const code of [...field.featured, ...rest]) {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.addEventListener("change", () => {
        const value = [...boxes].filter(([, b]) => b.checked).map(([c]) => c);
        if (value.length > field.maxItems) {
          box.checked = false;
          setMessage(`${field.label}: ${field.maxItems}個まで選べます`, true);
          return;
        }
        send({ type: "set", key: field.key, value });
      });
      const label = document.createElement("label");
      label.append(box, `${languageName(code)}（${code}）`);
      (field.featured.includes(code) ? main : moreList).append(label);
      boxes.set(code, box);
    }

    function render(value) {
      const selected = new Set(value);
      for (const [code, box] of boxes) box.checked = selected.has(code);
      // 折りたたんだ中の言語を選んでいれば、見えるように開く
      if (rest.some((code) => selected.has(code))) more.open = true;
    }
    return { el, render };
  }

  function build(fields) {
    for (const field of fields) {
      const container = card.querySelector(`.cap-fields[data-section="${field.section}"]`);
      if (!container) continue;
      const id = `cap-set-${field.key}`;
      const label = document.createElement("label");
      label.className = "cap-field-label";
      label.textContent = field.label;

      const control = document.createElement("div");
      control.className = "cap-field-control";
      const hint = document.createElement("span");
      hint.className = "cap-field-hint";

      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "cap-field-reset";
      reset.textContent = "既定";
      reset.addEventListener("click", () => send({ type: "reset", key: field.key }));

      if (field.kind === "glossary" || field.kind === "list") {
        const widget = field.kind === "glossary" ? createGlossary(field) : createChecklist(field);
        control.append(widget.el, hint);
        container.append(label, control, reset);
        rows.set(field.key, { field, widget, reset, hint });
        continue;
      }

      label.htmlFor = id;
      const line = document.createElement("div");
      line.className = "cap-field-input";
      const input = createInput(field);
      input.id = id;
      line.append(input);
      let picker;
      if (field.kind === "color") {
        picker = createPicker(field, input);
        line.append(picker);
      }
      const unit = field.kind === "px" ? "px" : field.kind === "percent" ? "%" : field.unit;
      if (unit) line.append(unit);
      control.append(line, hint);

      input.addEventListener("change", () => onChange(field, input));
      container.append(label, control, reset);
      rows.set(field.key, { field, input, reset, hint, picker });
    }
  }

  // パレットで選べるのは不透明な色だけなので、不透明度は今の値から引き継ぐ（変えるときは文字で入れる）
  function createPicker(field, input) {
    const picker = document.createElement("input");
    picker.type = "color";
    picker.className = "cap-color-picker";
    picker.setAttribute("aria-label", `${field.label}をパレットで選ぶ`);
    // 選んでいる間も字幕に反映する。送るたびにsettings.jsonへ書くので、送る間隔を空ける
    let timer = 0;
    const submit = () => {
      clearTimeout(timer);
      timer = 0;
      const { alpha } = splitColor(input.value || cssDefault(field.cssVar));
      input.value = joinColor(picker.value, alpha);
      onChange(field, input);
    };
    picker.addEventListener("input", () => {
      if (!timer) timer = setTimeout(submit, 100);
    });
    picker.addEventListener("change", submit);
    return picker;
  }

  function onChange(field, input) {
    const raw = input.type === "checkbox" ? "" : input.value.trim();
    let value;
    switch (field.kind) {
      case "boolean":
        value = /** @type {HTMLInputElement} */ (input).checked;
        break;
      case "number":
      case "px":
      case "percent":
        if (raw === "") {
          if (field.kind !== "number") send({ type: "reset", key: field.key });
          return;
        }
        value = Number(raw);
        break;
      case "color":
      case "font":
        if (raw === "") {
          send({ type: "reset", key: field.key });
          return;
        }
        value = raw;
        break;
      default:
        value = input.value;
    }
    send({ type: "set", key: field.key, value });
  }

  function format(field, value) {
    if (value === null || value === undefined) return "";
    if (field.kind === "list") return value.map(languageName).join("、");
    if (field.kind === "glossary") return value.map((g) => (g.en ? `${g.ja} → ${g.en}` : g.ja)).join(", ");
    return String(value);
  }

  function update(row, value, defaultValue, overridden) {
    const { field, input, widget, reset, hint, picker } = row;
    if (widget) {
      widget.render(value ?? []);
    } else if (input && document.activeElement !== input) {
      // 入力中の欄は上書きしない
      if (field.kind === "boolean") /** @type {HTMLInputElement} */ (input).checked = value === true;
      else input.value = format(field, value);
    }
    let defaultText;
    if (field.kind === "px" || field.kind === "percent" || field.kind === "color") {
      const css = cssDefault(field.cssVar);
      // 未設定でも既定値を入れておき、上下キーでそこから調整できるようにする。単位は欄の右に出すので数字だけ
      let shown = css;
      if (field.kind === "px") shown = css.replace(/px$/, "");
      else if (field.kind === "percent") shown = String(Math.round(Number(css) * 100));
      if (value === null && input && document.activeElement !== input) input.value = shown;
      defaultText = `overlay.cssの値（${field.kind === "percent" ? `${shown}%` : css}）`;
      if (picker && document.activeElement !== picker) picker.value = splitColor(value ?? css).hex;
    } else if (field.kind === "font") {
      defaultText = "OSのフォント（Macはヒラギノ角ゴ、Windowsは游ゴシック）";
    } else if (field.kind === "boolean") {
      defaultText = defaultValue ? "オン" : "オフ";
    } else {
      defaultText = format(field, defaultValue) || "（空）";
    }
    hint.textContent = [field.help, `既定: ${defaultText}`].filter(Boolean).join(" / ");
    reset.hidden = !overridden;
  }

  function render(msg) {
    if (!built) {
      build(msg.fields);
      built = true;
    }
    card.hidden = false;
    setMessage("");
    const overridden = new Set(msg.overridden);
    for (const [key, row] of rows) update(row, msg.values[key], msg.defaults[key], overridden.has(key));
    onValues(msg.values, msg.styleVars ?? {});
  }

  function connect() {
    const socket = new WebSocket(`ws://${location.host}/ws/settings`);
    ws = socket;
    socket.onopen = () => {
      backoff = BACKOFF_MIN_MS;
      setMessage("");
      updateKeyButtons();
    };
    socket.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg?.type === "settings") render(msg);
      else if (msg?.type === "settings.error") setMessage(String(msg.message), true);
      else if (msg?.type === "credentials.status") renderCredentials(msg);
      else if (msg?.type === "credentials.saved") {
        keyInput.value = "";
        keyPending = false;
        setKeyMessage("APIキーの設定を保存しました。");
        updateKeyButtons();
      } else if (msg?.type === "credentials.error") {
        keyPending = false;
        setKeyMessage(String(msg.message), true);
        updateKeyButtons();
      }
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      keyInput.value = "";
      keyPending = false;
      keyState.textContent = "サーバーとの接続が切れました。再接続中…";
      setKeyMessage("");
      updateKeyButtons();
      if (built) setMessage("サーバーとの接続が切れました。再接続中…", true);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    };
  }

  connect();
}
