// JSONLロガー。起動ごとに1ファイル、1行1イベントで {t, kind, ...} を書く。
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

export type Logger = {
  // 保存しないときはnull
  readonly path: string | null;
  // t は既定でDate.now()。vad.speech_end等、発生時刻が記録時刻と違うときだけ渡す
  log(kind: string, fields?: Record<string, unknown>, t?: number): void;
  close(): Promise<void>;
};

export function createLogger(dir: string): Logger {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `session-${stamp(new Date())}.jsonl`);
  const stream = createWriteStream(file, { flags: "a" });
  stream.on("error", (err) => console.error(`ログを書けません: ${err.message}`));
  let closed = false;

  return {
    path: file,
    log(kind, fields = {}, t = Date.now()) {
      // 終了処理中に届くclose等のイベントで、end後のwriteエラーにしない
      if (closed) return;
      stream.write(JSON.stringify({ t, kind, ...fields }) + "\n");
    },
    close() {
      closed = true;
      return new Promise((resolve) => stream.end(resolve));
    },
  };
}

export function createNoopLogger(): Logger {
  return { path: null, log() {}, close: async () => {} };
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
