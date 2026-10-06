// 環境変数と既定値。数値は初期値で、計測（PR3）で調整する。
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
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const openaiApiKey = (env.OPENAI_API_KEY ?? "").trim();

  const lunaMode = env.LUNA_MODE || "translate";
  if (lunaMode !== "translate" && lunaMode !== "combined") {
    throw new Error(`LUNA_MODE は translate か combined: ${lunaMode}`);
  }

  return {
    openaiApiKey,
    port: num(env, "PORT", 4649),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    vadThresholdDb: num(env, "VAD_THRESHOLD_DB", -45),
    vadSilenceMs: num(env, "VAD_SILENCE_MS", 800),
    vadMinSpeechMs: num(env, "VAD_MIN_SPEECH_MS", 200),
    vadMaxSegmentMs: num(env, "VAD_MAX_SEGMENT_MS", 15000),
    transcribeDelay: env.TRANSCRIBE_DELAY || "low",
    sessionRotateMin: num(env, "SESSION_ROTATE_MIN", 55),
    lunaTimeoutMs: num(env, "LUNA_TIMEOUT_MS", 8000),
    lunaMode,
    lunaServiceTier: env.LUNA_SERVICE_TIER || "fast",
    contextSize: num(env, "CONTEXT_SIZE", 3),
    displaySegments: num(env, "DISPLAY_SEGMENTS", 3),
  };
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} は数値: ${raw}`);
  return value;
}
