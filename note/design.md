基準日: 2026-10-06・4bf9a99

# 設計メモ

設計を変える前に読む。既定値を決めた理由は`src/config.ts`、APIの挙動に由来する制約は該当コードのコメントにある。以前の疎通確認・計測の結果と判断の経緯は、`git show 4bf9a99:.plan/plan-mvp.md`と`git show 4bf9a99:docs/decisions.md`で読める。

## ユーザー判断

- `LUNA_MODE`・`LUNA_SERVICE_TIER`は設定パネルに出さない。
- Lunaのプロンプトの固定部分（役割と出力形式）は利用者に変えさせない。崩すとJSON行を解析できなくなる。
- 遅延の目標値は決めない。

## 既知の問題

- `gpt-live-transcribe`で、文がerror無しで途中から切れ、続きが字幕に出ないことがある。`delay: low`でも起きる。検出策は作らない（ユーザー判断）。同じ症状の報告: https://community.openai.com/t/gpt-live-transcribe-deltas-stop-mid-item-with-no-event-and-audio-appended-after-that-is-never-transcribed/1403323

## 採用しなかった案

- WebRTCでRealtime APIへ直結する: WebRTCで送った音声をcommitで区切れるか確認できず、Chromeの非表示タブではタイマーが1秒単位に丸められる。そのため音声はNodeへ送り、無音判定・commit・Realtime接続はNodeで行う。
- `gpt-realtime-translate`で音声から直接英訳する: 約$2/時かかり、LunaのFast modeで足りる（ユーザー判断）。
- ローカルASR: 遅延の大半は無音待ちとLunaで、縮むのはネット往復分だけ。オフライン必須になったら再検討する。
- Lunaの出力を`json_schema`の1オブジェクトにする: `combined`で`ja`が`en`より先に完成する保証を確認できなかった。
- 文字起こしの`noise_reduction: near_field`: Chromeのノイズ抑制と役割が重なり、誤りが増えた（1回だけの比較）。
- 配布物を1つのexeにまとめる（Node.jsのSingle Executable Applications・`bun build --compile`・`deno compile`）: Node.jsを同梱したZIPより小さくならない。Node.jsのSEAはESMに対応せず、事前に1ファイルへまとめる必要があり、ビルドしない方針と合わない。
