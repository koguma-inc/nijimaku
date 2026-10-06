基準日: 2026-10-06・95f2f2c

# 残作業

上から順に着手する。

## 配布

開発者とは別の利用者へZIPで配り、ダブルクリックで起動できるようにする。まずWindows（x64）だけを配り、OSごとにZIPを分ける。Windows用のZIPは`nr dist`で作れる（`scripts/dist.ts`）。

1. 更新機能: 開発リポジトリとは別に、配布用の新しいGitHubの公開リポジトリを作り、ReleasesにZIPを置く。起動時に新しい版を通知し、利用者の操作で更新する。更新ではアプリ部分だけを差し替え、Node.jsは入れ替えない（Node.js自体を上げる方法は実装時に決める）。更新してもAPIキーと設定は残し、失敗したら旧版を使えるようにする。
2. Mac: `start.command`を作る。Gatekeeperで止められないかは要確認。

## 確認待ち

配信者にWindows用のZIPを渡して確かめる。

- `start.cmd`で起動し、Chromeでcapture.htmlが開くか。展開・起動時の警告と、READMEの操作手順が合っているか。
- 実APIでの動作。
- VADの値（`VAD_THRESHOLD_DB`・`VAD_SILENCE_MS`）をマイクで決め直す。
- captureのタブを非表示にしたまま音声が途切れないか。途切れる場合の運用をREADMEに書く。
