基準日: 2026-10-07・9ce900f

# 残作業

上から順に着手する。

## 配布

開発者とは別の利用者へZIPで配り、ダブルクリックで起動できるようにする。まずWindows（x64）だけを配り、OSごとにZIPを分ける。ZIPはこのリポジトリのReleasesに置く。Windows用のZIPは`nr dist`で作れる（`scripts/dist.ts`）。タグ（`v*`）をpushすると、GitHub ActionsがZIPを作ってReleasesに公開する。v0.3.0を公開済みで、配信者のWindowsでv0.2.0からの更新が成功した。

1. Mac: `start.command`を作る。Gatekeeperで止められないかは要確認。`runtime.json`はOSごとの項目なので、Macを足すときは項目と、Node.jsの取得・展開の方法（nodejs.orgのMac版は`.tar.gz`）も足す。

## その後

- Whisperによるローカル文字起こし（issue #2）。

## 確認待ち

配信者にWindows用のZIPを渡して確かめる。

- 全部入りZIPの展開・起動時の警告と、READMEと画面の「使い方」の操作手順が合っているか。
- VADの値（`VAD_THRESHOLD_DB`・`VAD_SILENCE_MS`）をマイクで決め直す。
- captureのタブを非表示にしたまま音声が途切れないか。途切れる場合の運用をREADMEに書く。
- 更新の再起動の後、OBSのoverlayが手で読み直さずに新しい版で出るか。
- 設定の「バックアップ」での書き出し・読み込みが、配信者のWindowsで使えるか。
- Node.jsの版を上げる更新で、取得した`node.exe`にSmartScreenの警告が出ないか。v0.3.0はNode.jsの版を変えていないので、まだ取得していない。
