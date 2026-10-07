// capture.htmlの設定パネル。/ws/settingsから項目の定義と値を受け取って描画し、変更を送る。
// メッセージの形はsrc/settings.tsの先頭にある。版と更新の状態（app.info・update.status）も同じ接続で受け取る。
import { createVersionWatch } from "./overlay.js";

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
// 読み込むファイルの上限。送るメッセージ（整形を除いたJSON）が/ws/settingsのmaxPayload（128KiB）に収まるようにする
const IMPORT_FILE_LIMIT = 100_000;

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
 * スライダーの値と、つまみの左側を塗る幅をそろえる
 * @param {HTMLInputElement} slider
 * @param {string} value
 */
function setSlider(slider, value) {
  slider.value = value;
  const min = Number(slider.min);
  const ratio = (slider.valueAsNumber - min) / (Number(slider.max) - min);
  slider.style.setProperty("--cap-fill", `${(ratio * 100).toFixed(2)}%`);
}

/**
 * @param {{card: HTMLElement, message: HTMLElement, onValues: (values: Record<string, unknown>, styleVars: Record<string, string>) => void, onCredentials: (status: any) => void, onApp: (info: any) => void, onUpdate: (status: any) => void, onUpdateError: (message: string) => void}} opts
 * @returns {{applyUpdate: () => boolean}}
 */
export function mountSettings({ card, message, onValues, onCredentials, onApp, onUpdate, onUpdateError }) {
  /** @type {Map<string, {field: any, input?: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, widget?: {el: HTMLElement, render: (value: any[]) => void}, reset: HTMLButtonElement, picker?: HTMLInputElement, slider?: HTMLInputElement}>} */
  const rows = new Map();
  /** @type {WebSocket | null} */
  let ws = null;
  let backoff = BACKOFF_MIN_MS;
  let built = false;
  // 更新の再起動の後、新しい版のpublic/を読むためにページを読み直す
  const isNewVersion = createVersionWatch();
  const keyForm = card.querySelector("#cap-api-key-form");
  const keyInput = card.querySelector("#cap-api-key");
  const keySave = card.querySelector("#cap-api-key-save");
  const keyReset = card.querySelector("#cap-api-key-reset");
  const keyState = card.querySelector("#cap-api-key-state");
  const keyMessage = card.querySelector("#cap-api-key-message");
  // サーバーは保存にも削除にもcredentials.savedで応えるため、どちらを送ったかを覚えておく
  /** @type {"" | "set" | "reset"} */
  let keyPending = "";
  const backupExport = card.querySelector("#cap-backup-export");
  const backupImport = card.querySelector("#cap-backup-import");
  const backupFile = /** @type {HTMLInputElement} */ (card.querySelector("#cap-backup-file"));
  const backupMessage = card.querySelector("#cap-backup-message");
  /** @type {{values: Record<string, unknown>, overridden: string[]} | null} */
  let latest = null;

  function setKeyMessage(text, isError = false) {
    keyMessage.textContent = text;
    keyMessage.classList.toggle("is-error", isError);
  }

  function updateKeyButtons() {
    const disabled = keyPending !== "" || ws?.readyState !== WebSocket.OPEN;
    keyInput.disabled = keySave.disabled = keyReset.disabled = disabled;
  }

  keyForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (keyPending || !send({ type: "credentials.set", apiKey: keyInput.value })) return;
    keyPending = "set";
    setKeyMessage("保存中…");
    updateKeyButtons();
  });

  keyReset.addEventListener("click", () => {
    if (keyPending || !send({ type: "credentials.reset" })) return;
    keyPending = "reset";
    setKeyMessage("削除中…");
    updateKeyButtons();
  });

  function setBackupMessage(text, isError = false) {
    backupMessage.textContent = text;
    backupMessage.classList.toggle("is-error", isError);
  }

  // settings.jsonと同じ形（画面で変えた項目だけ）で書き出す。APIキーは含めない
  backupExport.addEventListener("click", () => {
    if (!latest) return;
    const { values, overridden } = latest;
    const data = Object.fromEntries(overridden.map((key) => [key, values[key]]));
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" }));
    const d = new Date();
    const a = document.createElement("a");
    a.href = url;
    a.download = `nijimaku-settings-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setBackupMessage("書き出しました。");
  });

  backupImport.addEventListener("click", () => backupFile.click());

  backupFile.addEventListener("change", async () => {
    const file = backupFile.files?.[0];
    // 同じファイルを選び直しても読み込めるようにする
    backupFile.value = "";
    if (!file) return;
    if (file.size > IMPORT_FILE_LIMIT) {
      setBackupMessage("ファイルが大きすぎます。書き出した設定のファイルを選んでください。", true);
      return;
    }
    let values;
    try {
      values = JSON.parse(await file.text());
    } catch {
      setBackupMessage("ファイルを読めません。書き出した設定のファイルを選んでください。", true);
      return;
    }
    if (!send({ type: "import", values })) {
      setBackupMessage("サーバーとの接続が切れています。", true);
      return;
    }
    setBackupMessage("読み込み中…");
  });

  function renderCredentials(msg) {
    keyReset.hidden = !msg.saved;
    keyInput.placeholder = msg.configured ? "新しいAPIキーを入力" : "APIキーを入力";
    keyState.dataset.tone = !msg.configured || msg.state === "failed" ? "error" : msg.state === "ready" ? "ok" : "warn";
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
        input.className = "cap-switch";
        input.setAttribute("role", "switch");
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
      const arrow = document.createElement("span");
      arrow.className = "cap-glossary-arrow";
      arrow.textContent = "→";
      arrow.setAttribute("aria-hidden", "true");
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "×";
      del.title = "削除";
      del.setAttribute("aria-label", "削除");
      // 末尾の空行は追加用なので消せない
      del.disabled = !entry;
      del.addEventListener("click", () => {
        row.remove();
        submit();
        render(latest);
      });
      row.append(textInput(entry?.ja ?? "", "日本語"), arrow, textInput(entry?.en ?? "", "英語"), del);
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
      hint.textContent = field.help ?? "";
      hint.hidden = !field.help;

      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "cap-field-reset";
      reset.textContent = "リセット";
      reset.addEventListener("click", () => send({ type: "reset", key: field.key }));

      if (field.kind === "glossary" || field.kind === "list") {
        const widget = field.kind === "glossary" ? createGlossary(field) : createChecklist(field);
        control.append(widget.el, hint);
        container.append(label, control, reset);
        rows.set(field.key, { field, widget, reset });
        continue;
      }

      label.htmlFor = id;
      const line = document.createElement("div");
      line.className = "cap-field-input";
      const input = createInput(field);
      input.id = id;
      line.append(input);
      let picker;
      let slider;
      if (field.kind === "color") {
        picker = createPicker(field, input);
        line.prepend(picker);
      } else if (input.type === "number") {
        slider = createSlider(field, /** @type {HTMLInputElement} */ (input));
        line.prepend(slider);
      }
      const unit = field.kind === "px" ? "px" : field.kind === "percent" ? "%" : field.unit;
      // 単位が無い数値の項目にも同じ幅の枠を置き、スライダーと数値の欄の位置を項目間でそろえる
      if (unit || slider) {
        const unitEl = document.createElement("span");
        unitEl.className = "cap-field-unit";
        unitEl.textContent = unit ?? "";
        line.append(unitEl);
      }
      control.append(line, hint);

      input.addEventListener("change", () => onChange(field, input));
      container.append(label, control, reset);
      rows.set(field.key, { field, input, reset, picker, slider });
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

  // 数値の欄に添えるスライダー。ドラッグ中も字幕に反映する。送るたびにsettings.jsonへ書くので、送る間隔を空ける
  function createSlider(field, input) {
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "cap-range";
    slider.min = input.min;
    slider.max = input.max;
    slider.step = input.step;
    // 同じ値を数値の欄でも変えられるので、Tabの移動と読み上げからは外す
    slider.tabIndex = -1;
    slider.setAttribute("aria-hidden", "true");
    let timer = 0;
    const submit = () => {
      clearTimeout(timer);
      timer = 0;
      input.value = slider.value;
      onChange(field, input);
    };
    slider.addEventListener("input", () => {
      input.value = slider.value;
      setSlider(slider, slider.value);
      if (!timer) timer = setTimeout(submit, 100);
    });
    slider.addEventListener("change", submit);
    input.addEventListener("input", () => {
      if (input.value !== "") setSlider(slider, input.value);
    });
    return slider;
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

  function update(row, value, overridden) {
    const { field, input, widget, reset, picker, slider } = row;
    // 入力中の欄とドラッグ中のスライダーは上書きしない（届くのは送った途中の値のこともある）
    const editing = document.activeElement === input || slider?.matches(":active") === true;
    if (widget) {
      widget.render(value ?? []);
    } else if (input && !editing) {
      if (field.kind === "boolean") /** @type {HTMLInputElement} */ (input).checked = value === true;
      else input.value = format(field, value);
    }
    if (field.kind === "px" || field.kind === "percent" || field.kind === "color") {
      const css = cssDefault(field.cssVar);
      // 未設定でも既定値を入れておき、上下キーでそこから調整できるようにする。単位は欄の右に出すので数字だけ
      let shown = css;
      if (field.kind === "px") shown = css.replace(/px$/, "");
      else if (field.kind === "percent") shown = String(Math.round(Number(css) * 100));
      if (value === null && input && !editing) input.value = shown;
      if (picker && document.activeElement !== picker) picker.value = splitColor(value ?? css).hex;
    }
    if (slider && input && !slider.matches(":active") && input.value !== "") setSlider(slider, input.value);
    reset.hidden = !overridden;
  }

  function render(msg) {
    if (!built) {
      build(msg.fields);
      built = true;
    }
    card.hidden = false;
    setMessage("");
    latest = msg;
    const overridden = new Set(msg.overridden);
    for (const [key, row] of rows) update(row, msg.values[key], overridden.has(key));
    onValues(msg.values, msg.styleVars ?? {});
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${location.host}/ws/settings`);
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
      else if (msg?.type === "settings.imported") {
        const warnings = Array.isArray(msg.warnings) ? msg.warnings.map(String) : [];
        setBackupMessage(warnings.length > 0 ? `読み込みました。${warnings.join("。")}。` : "読み込みました。", warnings.length > 0);
      } else if (msg?.type === "settings.import.error") setBackupMessage(String(msg.message), true);
      else if (msg?.type === "credentials.status") renderCredentials(msg);
      else if (msg?.type === "app.info") {
        if (isNewVersion(msg.version)) location.reload();
        else onApp(msg);
      } else if (msg?.type === "update.status") onUpdate(msg);
      else if (msg?.type === "update.error") onUpdateError(String(msg.message));
      else if (msg?.type === "credentials.saved") {
        keyInput.value = "";
        setKeyMessage(keyPending === "reset" ? "保存したキーを削除しました。" : "APIキーを保存しました。");
        keyPending = "";
        updateKeyButtons();
      } else if (msg?.type === "credentials.error") {
        keyPending = "";
        setKeyMessage(String(msg.message), true);
        updateKeyButtons();
      }
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      keyInput.value = "";
      keyPending = "";
      keyState.textContent = "サーバーとの接続が切れました。再接続中…";
      keyState.dataset.tone = "warn";
      setKeyMessage("");
      setBackupMessage("");
      updateKeyButtons();
      if (built) setMessage("サーバーとの接続が切れました。再接続中…", true);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    };
  }

  connect();
  return { applyUpdate: () => send({ type: "update.apply" }) };
}
