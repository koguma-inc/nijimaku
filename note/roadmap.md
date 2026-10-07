基準日: 2026-10-07・892481c

# 残作業

上から順に着手する。

## 配布

開発者とは別の利用者へZIPで配り、ダブルクリックで起動できるようにする。まずWindows（x64）だけを配り、OSごとにZIPを分ける。ZIPはこのリポジトリのReleasesに置く。Windows用のZIPは`nr dist`で作れる（`scripts/dist.ts`）。タグ（`v*`）をpushすると、GitHub ActionsがZIPを作ってReleasesに公開する。v0.2.0を公開済み。

1. Mac: `start.command`を作る。Gatekeeperで止められないかは要確認。`runtime.json`はOSごとの項目なので、Macを足すときは項目と、Node.jsの取得・展開の方法（nodejs.orgのMac版は`.tar.gz`）も足す。

## その後

- Whisperによるローカル文字起こし（issue #2）。

## 確認待ち

配信者にWindows用のZIPを渡して確かめる。

- Releaseから落としたv0.2.0の全部入りZIPを`start.cmd`で起動し、Chromeでcapture.htmlが開くか。展開・起動時の警告と、READMEと画面の「使い方」の操作手順が合っているか。
- 実APIでの動作。
- VADの値（`VAD_THRESHOLD_DB`・`VAD_SILENCE_MS`）をマイクで決め直す。
- captureのタブを非表示にしたまま音声が途切れないか。途切れる場合の運用をREADMEに書く。
- 次の版の公開後、配信者のWindowsで次を確かめる: 更新の通知、「更新して再起動」、再起動後の動作（capture.htmlの読み直し、OBSのoverlayの読み直し）。
- 更新で取得した`node.exe`にSmartScreenの警告が出ないか（未確認）。
