import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export class CredentialsStore {
  #file: string;
  #fallback: string;
  #saved = "";

  constructor(file: string, fallback = "") {
    this.#file = file;
    this.#fallback = fallback.trim();
  }

  load(): string | undefined {
    try {
      const saved: unknown = JSON.parse(readFileSync(this.#file, "utf8"));
      if (typeof saved !== "object" || saved === null || !("openaiApiKey" in saved)) {
        return "APIキーの保存ファイルの形式が不正です。画面から設定し直してください。";
      }
      const key = validateApiKey(saved.openaiApiKey);
      if (key === undefined) return "保存されたAPIキーの形式が不正です。画面から設定し直してください。";
      this.#saved = key;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // JSONの解析エラーにはファイル内のキーが含まれることがあるため、詳細は返さない。
        return "APIキーの保存ファイルを読めません。画面から設定し直してください。";
      }
    }
    return undefined;
  }

  get apiKey(): string {
    return this.#saved || this.#fallback;
  }

  get status(): { configured: boolean; saved: boolean } {
    return { configured: this.apiKey !== "", saved: this.#saved !== "" };
  }

  set(value: unknown): string | undefined {
    const apiKey = validateApiKey(value);
    if (apiKey === undefined) return "空白や改行を含まないAPIキーを入力してください。";
    const temp = `${this.#file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ openaiApiKey: apiKey }) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temp, this.#file);
    } catch {
      try {
        rmSync(temp, { force: true });
      } catch {
        // 保存失敗時に一時ファイルの削除も失敗しても、使用中のキーは維持する。
      }
      return "APIキーを保存できません。このフォルダへの書き込み権限を確認してください。";
    }
    this.#saved = apiKey;
    return undefined;
  }

  reset(): string | undefined {
    try {
      rmSync(this.#file, { force: true });
    } catch {
      return "保存したAPIキーを削除できません。このフォルダへの書き込み権限を確認してください。";
    }
    this.#saved = "";
    return undefined;
  }
}

function validateApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  return key.length > 0 && key.length <= 1024 && /^[\x21-\x7e]+$/.test(key) ? key : undefined;
}
