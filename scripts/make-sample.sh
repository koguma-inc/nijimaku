#!/usr/bin/env bash
# 日本語の音声サンプルをsamples/に作る（macOSのsay・afconvertを使う）。
# 出力: sentences/NN.wav（1文ずつ）、sample.wav（文の間に無音を挟んだ連結版）、sentences.txt（原文）
# いずれも24kHz・16bit・モノラルのWAV。
set -euo pipefail

VOICE="Kyoko"
GAP_MS="${GAP_MS:-1200}"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/samples"

# 固有名詞・同音異義語など、誤認識しやすい語を含める
SENTENCES=(
  "こんにちは、今日も配信を見に来てくれてありがとうございます。"
  "昨日のアップデートで、新しいボスのマレニアが追加されました。"
  "この武器は会心率が高いので、火力がかなり出ます。"
  "公園で講演を聞いたあと、劇場で公演を見ました。"
  "次回はスプラトゥーンのフェスに参加する予定です。"
  "機械学習の精度を上げるには、きれいな学習データが大事です。"
  "渋谷のスクランブル交差点で、友達と待ち合わせをしました。"
  "字幕はニジマクというツールで表示しています。"
)

to_wav() {
  afconvert -f WAVE -d LEI16@24000 -c 1 "$1" "$2"
}

mkdir -p "$OUT_DIR/sentences"
rm -f "$OUT_DIR"/sentences/*.wav
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

: > "$OUT_DIR/sentences.txt"
combined="[[slnc $GAP_MS]]"
for i in "${!SENTENCES[@]}"; do
  n="$(printf '%02d' $((i + 1)))"
  text="${SENTENCES[$i]}"
  say -v "$VOICE" -o "$TMP_DIR/$n.aiff" "$text"
  to_wav "$TMP_DIR/$n.aiff" "$OUT_DIR/sentences/$n.wav"
  printf '%s\t%s\n' "$n" "$text" >> "$OUT_DIR/sentences.txt"
  combined+="$text[[slnc $GAP_MS]]"
done

say -v "$VOICE" -o "$TMP_DIR/sample.aiff" "$combined"
to_wav "$TMP_DIR/sample.aiff" "$OUT_DIR/sample.wav"

echo "wrote $OUT_DIR"
