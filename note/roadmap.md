基準日: 2026-10-06・bef9675

# 残作業

上から順に着手する。

## 配布

開発者とは別の利用者へZIPで配り、ダブルクリックで起動できるようにする。まずWindows（x64）だけを配り、OSごとにZIPを分ける。Windowsの起動ファイル（`start.cmd`）と、同梱する`node.exe`の取得（`scripts/fetch-node.ts`）はできている。

1. ZIPの作成スクリプト: 含めるファイルを列挙する方式（許可リスト）にする。`credentials.json`・`.env`・`settings.json`・`logs/`と、`note/`・テスト等の開発用ファイルを入れない。作成後に、除外したはずのファイルが入っていないか検査する。
   - `node.exe`とLICENSEは`node/`に置く（`start.cmd`がそこを見る）。
   - `node_modules`はpnpmのシンボリックリンクなので、`openai`と`ws`の実体をコピーする（どちらも実行時の依存が無い）。
   - `start.cmd`の改行がCRLFのままか検査する。
2. 更新機能: 開発リポジトリとは別に、配布用の新しいGitHubの公開リポジトリを作り、ReleasesにZIPを置く。起動時に新しい版を通知し、利用者の操作で更新する。更新ではアプリ部分だけを差し替え、Node.jsは入れ替えない（Node.js自体を上げる方法は実装時に決める）。更新してもAPIキーと設定は残し、失敗したら旧版を使えるようにする。
3. Mac: `start.command`を作る。Gatekeeperで止められないかは要確認。

## 確認待ち

配信者にWindows用のZIPを渡して確かめる。

- `start.cmd`で起動し、Chromeでcapture.htmlが開くか。展開・起動時の警告と、READMEの操作手順が合っているか。
- 実APIでの動作。
- VADの値（`VAD_THRESHOLD_DB`・`VAD_SILENCE_MS`）をマイクで決め直す。
- captureのタブを非表示にしたまま音声が途切れないか。途切れる場合の運用をREADMEに書く。
