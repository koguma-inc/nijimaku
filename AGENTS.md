# AGENTS.md

Nijimaku: OBS配信の日本語音声を文字起こしし、日本語と英訳を字幕に出すツール。

## 文書の置き場所

- `README.md`: 利用者向けの使い方・設定・セキュリティ上の前提
- `note/`: 開発者向けのメモ。設計を変える前に`note/design.md`を読む。設計判断の記録ファイルは別に作らない
- 既定値を決めた理由と、APIの挙動に由来する制約: 該当コードのコメント
- `.plan/`: 実装プラン（gitに含めない）

## 実装の制約

- Macで開発し、Windowsでも動かす。Nodeの型ストリッピングで`.ts`を直接実行し、ビルド・tsx・dotenvは使わない。
- ネイティブモジュールを使わない。実行時の依存は`ws`と`openai`だけにする。
- `public/`は素のJSモジュールで、バンドラーを使わない。

## 秘密情報

- `credentials.json`と`.env`の中身を表示しない。
- `credentials.json`・`.env`・`settings.json`・`logs/`を、gitにも配布物にも含めない。
- APIキーをブラウザ・ログ・エラーメッセージに出さない。

## 確認

- 変更後は`nr typecheck`と`nr test`を通す。
