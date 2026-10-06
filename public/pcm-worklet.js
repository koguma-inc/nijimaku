// 入力をPCM16（20ms = 480サンプル）に切り、ArrayBufferをメインスレッドへ転送する。
const FRAME_SAMPLES = 480;

class PcmWriter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    // 入力が未接続のブロックではチャンネルが0本になる
    const ch = inputs[0]?.[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        // Int16Arrayはプラットフォームのエンディアン（x86/ARMはリトルエンディアン）
        this.frame[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.filled === FRAME_SAMPLES) {
          // 転送でbufferはdetachされるため、毎回新しく確保する
          this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
          this.frame = new Int16Array(FRAME_SAMPLES);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-writer", PcmWriter);
