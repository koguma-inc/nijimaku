基準日: 2026-10-06・4bf9a99

# 残作業

上から順に着手する。

## 配布

開発者とは別の利用者へZIPで配り、ダブルクリックで起動できるようにする。

1. 配布形式: 公式配布物の`node.exe`だけをZIPに同梱する（利用者がNode.jsを入れずに起動できるようにするため）。まずWindows（x64）だけを配り、Macは後から対応する。OSごとにZIPを分ける。
2. 起動ファイル: Windowsは`start.cmd`（Macは後から`start.command`）。同梱のNode.jsでサーバーを起動し、Chromeでcapture.htmlを開く。ダウンロードしたファイルの実行をOSが止めないか（MacのGatekeeper、WindowsのSmartScreen等）は要確認。
3. ZIPの作成スクリプト: 含めるファイルを列挙する方式（許可リスト）にする。`credentials.json`・`.env`・`settings.json`・`logs/`と、`note/`等の開発用ファイルを入れない。作成後に、除外したはずのファイルが入っていないか検査する。
4. 更新機能: 開発リポジトリとは別に、配布用の新しいGitHubの公開リポジトリを作り、ReleasesにZIPを置く。起動時に新しい版を通知し、利用者の操作で更新する。更新ではアプリ部分だけを差し替え、Node.jsは入れ替えない（Node.js自体を上げる方法は実装時に決める）。更新してもAPIキーと設定は残し、失敗したら旧版を使えるようにする。

## 確認待ち

- 実APIとWindows実機で動作を確かめる。
- VADの値（`VAD_THRESHOLD_DB`・`VAD_SILENCE_MS`）をマイクで決め直す。
- captureのタブを非表示にしたまま音声が途切れないか。途切れる場合の運用をREADMEに書く。
- `nr share`中は、`/ws/settings`への`Origin`の偽装を防げない（READMEの「セキュリティ上の前提」）。受け入れるか、対策するかを決める。
