// capture.htmlの設定パネルで変えられる項目。定義・検証・保存（settings.json）を持つ。
// 値の優先順は「画面で保存した値 > .env > 既定値」。保存するのは画面で変えた項目だけ。
//
// WSのメッセージ:
//   /ws/settings
//     サーバー→ページ: {type: "settings", fields, values, defaults, overridden, styleVars}
//                      {type: "settings.error", key?, message}
//     ページ→サーバー: {type: "set", key, value} / {type: "reset", key}
//   /ws/overlay  サーバー→ページ: {type: "style", vars}（画面で変えたCSS変数だけ）
//   /ws/capture  サーバー→ページ: {type: "capture.config", mic, vadThresholdDb}
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Config } from "./config.ts";

export type Section = "input" | "transcription" | "display";

export type GlossaryEntry = { ja: string; en?: string };

type Base = { key: string; section: Section; label: string; help?: string };

export type Field = Base &
  (
    | { kind: "number"; min: number; max: number; step: number; unit?: string }
    | { kind: "select"; options: string[] }
    | { kind: "boolean" }
    | { kind: "textarea"; maxLength: number }
    // 画面ではチェックボックスで選ぶ。featured以外は折りたたむ
    | { kind: "list"; maxItems: number; options: string[]; featured: string[] }
    // 画面では1語ごとに日本語と英語の欄を並べる
    | { kind: "glossary"; maxItems: number; maxLength: number }
    // 未設定（null）ならoverlay.cssの値を使う
    | { kind: "color"; cssVar: string }
    // percentは0〜100で持ち、CSSには0〜1で渡す
    | { kind: "px" | "percent"; cssVar: string; min: number; max: number }
    // 未設定（null）ならOSのフォント。選べるのはoverlay.cssでGoogle Fontsから読み込むものだけ
    | { kind: "font"; cssVar: string; options: string[] }
  );

export type Values = Record<string, unknown>;

export type Settings = {
  vadThresholdDb: number;
  vadSilenceMs: number;
  vadMinSpeechMs: number;
  vadMaxSegmentMs: number;
  micNoiseSuppression: boolean;
  micAutoGainControl: boolean;
  micEchoCancellation: boolean;
  streamDescription: string;
  glossary: GlossaryEntry[];
  transcribeLanguages: string[];
  transcribeDelay: string;
  displaySegments: number;
};

export const DEFAULT_STREAM_DESCRIPTION = "YouTubeのライブ配信。配信者一人が日本語で話しています。";

// gpt-live-transcribeのlanguagesに使える値。不正な値を送ったときのAPIのエラーメッセージにある一覧（2026-10-06）。
// iwはheと同じヘブライ語の旧コードで、画面に同じ言語名が2つ並ぶため除く
const TRANSCRIBE_LANGUAGES = ["af", "ar", "az", "be", "bg", "bs", "ca", "cs", "cy", "da", "de", "el", "en", "es", "et", "fa", "fi", "fr", "gl", "he", "hi", "hr", "hu", "hy", "id", "is", "it", "ja", "kk", "kn", "ko", "lt", "lv", "mi", "mk", "mr", "ms", "ne", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sl", "sr", "sv", "sw", "ta", "th", "tl", "tr", "uk", "ur", "vi", "zh"];

// 用語集の件数はnekote-voiceで100件まで通ったことの確認だけで、公式の上限ではない
export const FIELDS: Field[] = [
  { key: "vadThresholdDb", section: "input", label: "発話とみなす音量", kind: "number", min: -80, max: -10, step: 1, unit: "dBFS" },
  { key: "vadSilenceMs", section: "input", label: "文を区切る無音の長さ", kind: "number", min: 100, max: 3000, step: 50, unit: "ms" },
  { key: "vadMinSpeechMs", section: "input", label: "発話とみなす最短の長さ", kind: "number", min: 20, max: 2000, step: 20, unit: "ms" },
  { key: "vadMaxSegmentMs", section: "input", label: "1文の最大の長さ", kind: "number", min: 3000, max: 60000, step: 1000, unit: "ms", help: "話し続けていても、この長さで区切ります。" },
  { key: "micNoiseSuppression", section: "input", label: "ノイズ抑制（Chrome）", kind: "boolean" },
  { key: "micAutoGainControl", section: "input", label: "自動ゲイン調整（Chrome）", kind: "boolean" },
  { key: "micEchoCancellation", section: "input", label: "エコー除去（Chrome）", kind: "boolean" },
  { key: "streamDescription", section: "transcription", label: "配信の説明", kind: "textarea", maxLength: 1000, help: "文字起こしと英訳のAIに、配信の前提として渡します。" },
  { key: "glossary", section: "transcription", label: "用語集", kind: "glossary", maxItems: 100, maxLength: 100, help: "末尾の空欄に書くと追加されます。日本語は文字起こしの手がかりに使い、英語を入れた語は英訳をその表記に揃えます（英語は空でもかまいません）。" },
  { key: "transcribeLanguages", section: "transcription", label: "話す言語", kind: "list", maxItems: 10, options: TRANSCRIBE_LANGUAGES, featured: ["ja", "en", "ko", "zh"], help: "配信で話す言語です。どれも選ばなければ自動で判定します。" },
  { key: "transcribeDelay", section: "transcription", label: "認識の待ち時間", kind: "select", options: ["minimal", "low", "medium", "high", "xhigh"], help: "長いほど途中経過が遅れ、精度が上がります。" },
  { key: "displaySegments", section: "display", label: "表示する文の数", kind: "number", min: 1, max: 10, step: 1 },
  { key: "styleFont", section: "display", label: "フォント", kind: "font", cssVar: "--nm-font-family", options: ["Noto Sans JP", "Noto Serif JP"], help: "NotoはGoogle Fontsから読み込みます（OBSのPCがインターネットにつながっている必要があります）。" },
  { key: "styleJaSize", section: "display", label: "日本語の文字の大きさ", kind: "px", cssVar: "--nm-ja-size", min: 8, max: 200 },
  { key: "styleEnSize", section: "display", label: "英語の文字の大きさ", kind: "px", cssVar: "--nm-en-size", min: 8, max: 200 },
  { key: "styleEnGap", section: "display", label: "日本語と英語の間隔", kind: "px", cssVar: "--nm-en-gap", min: -10, max: 10, help: "0で標準の行間です。負の値で詰めます。" },
  { key: "styleJaColor", section: "display", label: "日本語の色", kind: "color", cssVar: "--nm-ja-color" },
  { key: "styleEnColor", section: "display", label: "英語の色", kind: "color", cssVar: "--nm-en-color" },
  { key: "stylePartialOpacity", section: "display", label: "途中経過の不透明度", kind: "percent", cssVar: "--nm-partial-opacity", min: 0, max: 100, help: "確定前の文を、縁取りごと薄くします。" },
  { key: "styleStrokeColor", section: "display", label: "縁取りの色", kind: "color", cssVar: "--nm-stroke-color" },
  { key: "styleStrokeWidth", section: "display", label: "縁取りの太さ", kind: "px", cssVar: "--nm-stroke-width", min: 0, max: 20 },
  { key: "styleBottom", section: "display", label: "下からの位置", kind: "px", cssVar: "--nm-bottom", min: 0, max: 2000 },
  { key: "styleMaxWidth", section: "display", label: "字幕の最大幅", kind: "px", cssVar: "--nm-max-width", min: 100, max: 4000 },
];

const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));
// CSSの値として1つに収まる文字だけ許す（setPropertyに渡すので、;や{}で他の宣言を作れないようにする）
const COLOR_PATTERN = /^[#a-zA-Z0-9(),.%\s/-]{1,64}$/;
// 文字起こしのkeywordsは<、>、CR、LFを含められない
const KEYWORD_FORBIDDEN = /[<>\r\n]/;

export function settingsDefaults(config: Config): Values {
  const values: Values = {
    vadThresholdDb: config.vadThresholdDb,
    vadSilenceMs: config.vadSilenceMs,
    vadMinSpeechMs: config.vadMinSpeechMs,
    vadMaxSegmentMs: config.vadMaxSegmentMs,
    micNoiseSuppression: true,
    micAutoGainControl: true,
    micEchoCancellation: true,
    streamDescription: DEFAULT_STREAM_DESCRIPTION,
    glossary: [],
    transcribeLanguages: ["ja"],
    transcribeDelay: config.transcribeDelay,
    displaySegments: config.displaySegments,
  };
  for (const f of FIELDS) if ("cssVar" in f) values[f.key] = null;
  return values;
}

type Validated = { ok: true; value: unknown } | { ok: false; message: string };

export function validate(field: Field, value: unknown): Validated {
  const fail = (message: string): Validated => ({ ok: false, message: `${field.label}: ${message}` });
  switch (field.kind) {
    case "number":
    case "px":
    case "percent": {
      if (typeof value !== "number" || !Number.isFinite(value)) return fail("数値を入れてください");
      if (value < field.min || value > field.max) return fail(`${field.min}〜${field.max}の範囲で入れてください`);
      return { ok: true, value };
    }
    case "select":
    case "font":
      return typeof value === "string" && field.options.includes(value)
        ? { ok: true, value }
        : fail(`${field.options.join("・")}のどれかにしてください`);
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : fail("オン/オフで指定してください");
    case "textarea": {
      if (typeof value !== "string") return fail("文字列で入れてください");
      const text = value.trim();
      if (text.length > field.maxLength) return fail(`${field.maxLength}文字以内にしてください`);
      return { ok: true, value: text };
    }
    case "list": {
      if (!Array.isArray(value)) return fail("一覧で入れてください");
      const items: string[] = [];
      for (const raw of value) {
        if (typeof raw !== "string") return fail("文字列で入れてください");
        const item = raw.trim();
        if (item === "" || items.includes(item)) continue;
        if (!field.options.includes(item)) return fail(`「${item}」は使えません`);
        items.push(item);
      }
      if (items.length > field.maxItems) return fail(`${field.maxItems}個以内にしてください`);
      return { ok: true, value: items };
    }
    case "glossary": {
      if (!Array.isArray(value)) return fail("一覧で入れてください");
      const entries: GlossaryEntry[] = [];
      for (const raw of value) {
        const obj = raw as Record<string, unknown> | null;
        if (typeof obj !== "object" || obj === null || typeof obj.ja !== "string") return fail("形式が不正です");
        const ja = obj.ja.trim();
        const en = typeof obj.en === "string" ? obj.en.trim() : "";
        // 入力の取りこぼしに気づけるよう、空行以外は黙って捨てない
        if (ja === "") {
          if (en === "") continue;
          return fail(`「${en}」の日本語が空です`);
        }
        if (entries.some((e) => e.ja === ja)) return fail(`「${ja}」が重複しています`);
        if (KEYWORD_FORBIDDEN.test(ja)) return fail(`「${ja}」に<、>、改行は使えません`);
        if (/[\r\n]/.test(en)) return fail(`「${en}」に改行は使えません`);
        if (ja.length > field.maxLength || en.length > field.maxLength) {
          return fail(`1語${field.maxLength}文字以内にしてください`);
        }
        entries.push(en === "" ? { ja } : { ja, en });
      }
      if (entries.length > field.maxItems) return fail(`${field.maxItems}語以内にしてください`);
      return { ok: true, value: entries };
    }
    case "color":
      return typeof value === "string" && COLOR_PATTERN.test(value.trim())
        ? { ok: true, value: value.trim() }
        : fail("色の値（#ffffffやrgba(255, 255, 255, 0.6)など）を入れてください");
  }
}

export class SettingsStore {
  #defaults: Values;
  #overrides: Values = {};
  #file: string;

  constructor(defaults: Values, file: string) {
    this.#defaults = defaults;
    this.#file = file;
  }

  // 読めない値は捨てて既定値に戻す。捨てた理由を返す
  load(): string[] {
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(this.#file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      return [`${this.#file}を読めません: ${err instanceof Error ? err.message : String(err)}`];
    }
    if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return [`${this.#file}の形式が不正です`];
    const warnings: string[] = [];
    for (const [key, value] of Object.entries(saved)) {
      const field = FIELD_BY_KEY.get(key);
      if (!field) {
        warnings.push(`不明な設定を無視しました: ${key}`);
        continue;
      }
      const result = validate(field, value);
      if (result.ok) this.#overrides[key] = result.value;
      else warnings.push(`保存された値を無視しました: ${result.message}`);
    }
    return warnings;
  }

  get current(): Settings {
    return { ...this.#defaults, ...this.#overrides } as Settings;
  }

  get values(): Values {
    return { ...this.#defaults, ...this.#overrides };
  }

  get overridden(): string[] {
    return Object.keys(this.#overrides);
  }

  // 成功ならundefined、失敗なら理由を返す
  set(key: string, value: unknown): string | undefined {
    const field = FIELD_BY_KEY.get(key);
    if (!field) return `不明な設定です: ${key}`;
    const result = validate(field, value);
    if (!result.ok) return result.message;
    this.#overrides[key] = result.value;
    this.#save();
    return undefined;
  }

  reset(key: string): string | undefined {
    if (!FIELD_BY_KEY.has(key)) return `不明な設定です: ${key}`;
    if (!(key in this.#overrides)) return undefined;
    delete this.#overrides[key];
    this.#save();
    return undefined;
  }

  // CSS変数を画面で変えた項目だけ返す（overlay.cssの値を上書きする分）
  styleVars(): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const f of FIELDS) {
      const value = this.#overrides[f.key];
      if (value === undefined || value === null) continue;
      if (f.kind === "px") vars[f.cssVar] = `${value}px`;
      else if (f.kind === "percent") vars[f.cssVar] = String(Number(value) / 100);
      else if (f.kind === "color") vars[f.cssVar] = String(value);
      // Google Fontsを読めないときはOSのフォントで出す
      else if (f.kind === "font") vars[f.cssVar] = `"${value}", var(--nm-font-system)`;
    }
    return vars;
  }

  message(): Record<string, unknown> {
    return {
      type: "settings",
      fields: FIELDS,
      values: this.values,
      defaults: this.#defaults,
      overridden: this.overridden,
      // 設定パネルのプレビュー用
      styleVars: this.styleVars(),
    };
  }

  // 書き込み途中で落ちても壊れたファイルを残さないよう、一時ファイルから置き換える
  #save(): void {
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#overrides, null, 2) + "\n");
    renameSync(tmp, this.#file);
  }
}
