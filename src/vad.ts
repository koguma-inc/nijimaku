export const FRAME_MS = 20;
export const FRAME_SAMPLES = 480;

export type VadOptions = { thresholdDb: number; silenceMs: number; minSpeechMs: number; maxSegmentMs: number };

export type VadEvent =
  | { type: "speech_start"; t: number }
  | { type: "speech_end"; t: number }
  | { type: "commit"; reason: "silence" | "max" };

export function rmsDbfs(frame: Int16Array): number {
  if (frame.length === 0) return -Infinity;
  let sum = 0;
  for (const s of frame) sum += s * s;
  return 20 * Math.log10(Math.sqrt(sum / frame.length) / 32768);
}

function msToFrames(ms: number): number {
  return Math.max(1, Math.ceil(ms / FRAME_MS));
}

// 継続時間はフレーム数で数え、tはイベントの時刻にだけ使う。
// 非表示タブ等でチャンクがまとめて届いても判定が変わらないようにするため。
export class Vad {
  private thresholdDb!: number;
  private minSpeechFrames!: number;
  private silenceFrames!: number;
  private maxSegmentMs!: number;

  private started = false;
  private speaking = false;
  private loudRun = 0;
  private runStartT = 0;
  private silenceRun = 0;
  private lastSpeechT = 0;
  private segFrames = 0;
  private maxFired = false;

  constructor(opts: VadOptions) {
    this.setOptions(opts);
  }

  // 発話中でも状態は保ったまま、次のフレームから新しい値で判定する
  setOptions(opts: VadOptions): void {
    this.thresholdDb = opts.thresholdDb;
    this.minSpeechFrames = msToFrames(opts.minSpeechMs);
    this.silenceFrames = msToFrames(opts.silenceMs);
    this.maxSegmentMs = opts.maxSegmentMs;
  }

  push(frame: Int16Array, t: number): VadEvent[] {
    const events: VadEvent[] = [];
    const loud = rmsDbfs(frame) > this.thresholdDb;
    let startedNow = false;
    let committed = false;

    if (this.speaking) {
      if (loud) {
        this.lastSpeechT = t;
        this.silenceRun = 0;
      } else if (++this.silenceRun >= this.silenceFrames) {
        events.push({ type: "speech_end", t: this.lastSpeechT });
        events.push({ type: "commit", reason: "silence" });
        committed = true;
        this.speaking = false;
        this.silenceRun = 0;
        this.loudRun = 0;
      }
    } else if (loud) {
      if (this.loudRun === 0) this.runStartT = t;
      if (++this.loudRun >= this.minSpeechFrames) {
        events.push({ type: "speech_start", t: this.runStartT });
        this.speaking = true;
        this.lastSpeechT = t;
        this.silenceRun = 0;
        if (!this.started) {
          this.started = true;
          // 最大長は連続区間の最初のフレームから数える
          this.segFrames = this.loudRun;
          startedNow = true;
        }
      }
    } else {
      this.loudRun = 0;
    }

    if (this.started) {
      if (!startedNow) this.segFrames++;
      if (!this.maxFired && this.segFrames * FRAME_MS >= this.maxSegmentMs) {
        this.maxFired = true;
        if (!committed) events.push({ type: "commit", reason: "max" });
      }
    }
    return events;
  }

  hasSpeech(): boolean {
    return this.started;
  }

  reset(): void {
    this.started = false;
    this.speaking = false;
    this.loudRun = 0;
    this.runStartT = 0;
    this.silenceRun = 0;
    this.lastSpeechT = 0;
    this.segFrames = 0;
    this.maxFired = false;
  }
}
