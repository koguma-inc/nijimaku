基準日: 2026-10-06・c145459

# 残作業

上から順に着手する。

## 配布

開発者とは別の利用者へZIPで配り、ダブルクリックで起動できるようにする。まずWindows（x64）だけを配り、OSごとにZIPを分ける。Windows用のZIPは`nr dist`で作れる（`scripts/dist.ts`）。ZIPはこのリポジトリのReleasesに置く。

1. リリースの自動化: タグ（`v*`）のpushで、GitHub ActionsのWindowsの実行環境がZIPを作り、展開して起動を確かめてからReleasesに置く。初回用の全部入りZIP、更新用のアプリ部分だけのZIP、SHA256のチェックサムを添付する。
2. 更新機能: 起動時に新しい版を通知し、利用者の操作で更新する。更新ではアプリ部分だけを差し替え、Node.jsは入れ替えない（Node.js自体を上げる方法は実装時に決める）。更新してもAPIキーと設定は残し、失敗したら旧版を使えるようにする。
3. Mac: `start.command`を作る。Gatekeeperで止められないかは要確認。

## その後

- Whisperによるローカル文字起こし（issue #2）。リリースと更新機能の後に着手する。

## 確認待ち

配信者にWindows用のZIPを渡して確かめる。

- `start.cmd`で起動し、Chromeでcapture.htmlが開くか。展開・起動時の警告と、READMEの操作手順が合っているか。
- 実APIでの動作。
- VADの値（`VAD_THRESHOLD_DB`・`VAD_SILENCE_MS`）をマイクで決め直す。
- captureのタブを非表示にしたまま音声が途切れないか。途切れる場合の運用をREADMEに書く。
