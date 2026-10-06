基準日: 2026-10-06・4bf9a99

# 遅延の計測

音声ファイルを流して、毎回同じ条件で遅延を測る。`scripts/latency.ts`はログを読むため、`.env`で`SAVE_LOGS=1`にしておく。

1. `scripts/make-sample.sh`で`samples/`に日本語の音声サンプルを作る（macOSの`say`を使う）。
2. サーバーを起動し、別のターミナルで`node scripts/replay.ts`を実行する。サンプルが実時間で`/ws/capture`へ流れ、ブラウザから送ったときと同じ経路を通る。
3. `node scripts/latency.ts`で、最新のログから文ごとの遅延と中央値・p90を出す。
