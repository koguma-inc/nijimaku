// captureからのPCMをVadとRealtimeSessionへ流す。commitは必ずcommit()を通す
// （VAD・capture切断・captureの置き換えの3経路で、ガード・保留・Vadのリセットを共通にするため）。
import type { Logger } from "./log.ts";
import type { RealtimeSession } from "./realtime.ts";
import { FRAME_SAMPLES, Vad, type VadEvent, type VadOptions } from "./vad.ts";

const FRAME_BYTES = FRAME_SAMPLES * 2;
// Realtimeのcommitの下限（前回のcommit以降のバッファ長で判定される）
const MIN_COMMIT_MS = 100;
const GAP_WARN_MS = 1000;

export type CommitReason = "vad" | "vad_max" | "close" | "replaced";

export type InputStats = { chunks: number; maxGapMs: number };

type PipelineRealtime = Pick<RealtimeSession, "append" | "appendedMsSinceCommit" | "commit">;

export class AudioPipeline {
  #vad: Vad;
  #realtime: PipelineRealtime;
  #logger: Logger;
  #seq = 0;
  // 発話があるのに接続待ち等で送れなかったcommit要求。Vadは無音終了を1回しか通知しないため保持して再試行する
  #pending: CommitReason | null = null;
  #rest = Buffer.alloc(0);
  #lastChunkAt: number | undefined;
  #chunks = 0;
  #maxGapMs = 0;

  constructor(opts: { vad: VadOptions }, realtime: PipelineRealtime, logger: Logger) {
    this.#vad = new Vad(opts.vad);
    this.#realtime = realtime;
    this.#logger = logger;
  }

  setVad(opts: VadOptions): void {
    this.#vad.setOptions(opts);
  }

  // APIキーの切り替えで旧接続の音声を捨てるときは、保留中の区切りも捨てる。
  resetSession(): void {
    this.#pending = null;
    this.#vad.reset();
    this.resetInput();
  }

  // 無音区間も送り続ける。各フレームはappendしてからVadに渡す（commitがそのフレームを含むように）
  pushChunk(chunk: Buffer, t = Date.now()): void {
    this.#trackGap(t);
    const data = this.#rest.length > 0 ? Buffer.concat([this.#rest, chunk]) : chunk;
    let offset = 0;
    for (; offset + FRAME_BYTES <= data.length; offset += FRAME_BYTES) {
      const frame = data.subarray(offset, offset + FRAME_BYTES);
      this.#realtime.append(frame);
      this.#onVadEvents(this.#vad.push(toInt16(frame), t));
      this.retryPendingCommit();
    }
    this.#rest = Buffer.from(data.subarray(offset));
  }

  // 前回のcommit以降に発話があり、現在のappend先の接続へ100ms以上appendしたときだけ送る。
  // 発話があるのに送れなければ保留し、後続のappendとready通知で再試行する
  commit(reason: CommitReason): boolean {
    if (!this.#vad.hasSpeech()) return false;
    const appendedMs = this.#realtime.appendedMsSinceCommit();
    const seq = this.#seq + 1;
    const conn = appendedMs < MIN_COMMIT_MS ? null : this.#realtime.commit(seq);
    if (conn === null) {
      if (this.#pending === null) {
        this.#pending = reason;
        this.#logger.log("commit.pending", { reason, appendedMs });
      }
      return false;
    }
    this.#seq = seq;
    this.#logger.log("commit", { seq, reason, appendedMs, conn });
    this.#pending = null;
    this.#vad.reset();
    return true;
  }

  // RealtimeSessionがready（保持していた音声の送信後）になったときにも呼ぶ
  retryPendingCommit(): void {
    if (this.#pending !== null) this.commit(this.#pending);
  }

  // captureの接続が替わるとき（切断・置き換え）に、到着間隔の計測と端数を捨てる
  resetInput(): InputStats {
    const stats = { chunks: this.#chunks, maxGapMs: this.#maxGapMs };
    this.#lastChunkAt = undefined;
    this.#chunks = 0;
    this.#maxGapMs = 0;
    this.#rest = Buffer.alloc(0);
    return stats;
  }

  #onVadEvents(events: VadEvent[]): void {
    for (const event of events) {
      if (event.type === "speech_start") this.#logger.log("vad.speech_start", {}, event.t);
      else if (event.type === "speech_end") this.#logger.log("vad.speech_end", {}, event.t);
      else this.commit(event.reason === "silence" ? "vad" : "vad_max");
    }
  }

  // 非表示タブでの音切れ検出用
  #trackGap(t: number): void {
    if (this.#lastChunkAt !== undefined) {
      const gapMs = t - this.#lastChunkAt;
      if (gapMs > this.#maxGapMs) this.#maxGapMs = gapMs;
      if (gapMs >= GAP_WARN_MS) {
        this.#logger.log("capture.gap", { gapMs });
        console.warn(`captureのチャンクが${gapMs}ms途切れました`);
      }
    }
    this.#lastChunkAt = t;
    this.#chunks++;
  }
}

// Bufferのsubarrayは2バイト境界に揃っているとは限らないため、Int16Arrayへコピーする
function toInt16(frame: Buffer): Int16Array {
  const out = new Int16Array(frame.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = frame.readInt16LE(i * 2);
  return out;
}
