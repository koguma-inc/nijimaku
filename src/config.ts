// 環境変数と既定値。
import type { LunaMode } from "./corrector.ts";

export type Config = {
  openaiApiKey: string;
  port: number;
  // localhost以外に許可するWSのOrigin（トンネル経由で外部に公開するとき用）
  allowedOrigins: string[];
  vadThresholdDb: number;
  vadSilenceMs: number;
  vadMinSpeechMs: number;
  vadMaxSegmentMs: number;
  // 不正な値もそのままRealtimeへ送り、session.updateの拒否として扱う
  transcribeDelay: string;
  sessionRotateMin: number;
  lunaTimeoutMs: number;
  lunaMode: LunaMode;
  // 不正な値もそのまま送り、APIのエラー（luna.error）として扱う
  lunaServiceTier: string;
  contextSize: number;
  displaySegments: number;
  // 文字起こしの結果が平文で残るため、既定では保存しない
  saveLogs: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const openaiApiKey = (env.OPENAI_API_KEY ?? "").trim();

  const lunaMode = env.LUNA_MODE || "translate";
  if (lunaMode !== "translate" && lunaMode !== "combined") {
    throw new Error(`LUNA_MODE は translate か combined: ${lunaMode}`);
  }

  const saveLogs = env.SAVE_LOGS || "0";
  if (saveLogs !== "0" && saveLogs !== "1") {
    throw new Error(`SAVE_LOGS は 0 か 1: ${saveLogs}`);
  }

  return {
    openaiApiKey,
    port: num(env, "PORT", 4649),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // -45と600は仮の値で、マイクでの実機確認で決め直す。無音500msでは区切りの約4分の1で1秒以内に話が続き、
    // 短い断片ほど誤認識が増えた
    vadThresholdDb: num(env, "VAD_THRESHOLD_DB", -45),
    vadSilenceMs: num(env, "VAD_SILENCE_MS", 600),
    vadMinSpeechMs: num(env, "VAD_MIN_SPEECH_MS", 200),
    vadMaxSegmentMs: num(env, "VAD_MAX_SEGMENT_MS", 15000),
    // 未指定では文が途中から切れた。minimalはpartialが約0.28秒早いだけでfinalは早まらず、誤りが増えた
    // （8文中5文。lowは2〜4文）
    transcribeDelay: env.TRANSCRIBE_DELAY || "low",
    sessionRotateMin: num(env, "SESSION_ROTATE_MIN", 55),
    lunaTimeoutMs: num(env, "LUNA_TIMEOUT_MS", 8000),
    // translateは話し終わり→日本語が中央値1048ms（combinedは2270ms。修正と英訳を別々に同時に呼ぶparallelは
    // 2562msで費用も約1.5倍）。combinedの修正は、マイクで話した50文で表記の1件しか効かなかった
    lunaMode,
    // 最初のトークンまでの中央値が約0.8〜1.0秒→約0.6秒。単価は2倍だが、translateなら約$0.05/時
    lunaServiceTier: env.LUNA_SERVICE_TIER || "fast",
    // 文脈を0にしても、Lunaの遅延の差はばらつきに埋もれた
    contextSize: num(env, "CONTEXT_SIZE", 3),
    displaySegments: num(env, "DISPLAY_SEGMENTS", 3),
    saveLogs: saveLogs === "1",
  };
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} は数値: ${raw}`);
  return value;
}
