基準日: 2026-10-09・8ee5713

# 設計メモ

設計を変える前に読む。既定値を決めた理由は`src/config.ts`、APIの挙動に由来する制約は該当コードのコメントにある。以前の疎通確認・計測の結果と判断の経緯は、`git show 4bf9a99:.plan/plan-mvp.md`と`git show 4bf9a99:docs/decisions.md`で読める。

## ユーザー判断

- `LUNA_MODE`・`LUNA_SERVICE_TIER`は設定パネルに出さない。
- Lunaのプロンプトの固定部分（役割と出力形式）は利用者に変えさせない。崩すとJSON行を解析できなくなる。
- 遅延の目標値は決めない。
- カラオケモード（`createTicker`）は英訳を出さず、Lunaの修正も流れている文字に反映しない。表示だけを変え、Lunaは通常どおり呼ぶ（費用が小さく、切り替え方で挙動を変えないため）。切り替えは2通り用意し、配信者が選ぶ: 設定の`karaokeMode`（overlay.htmlとPiPが追従）と、`overlay.html?mode=karaoke`（設定に関係なく常にカラオケ。OBSのシーンで切り替える）。

## 配布版の起動役

Windowsの配布版では、`start.cmd`が同梱のNode.jsで起動役（`src/launcher.ts`。ZIPでは`app/launcher.ts`）を動かし、起動役が`app/current.json`の指す版のサーバーを子として起動する。ZIPの構成は`scripts/dist.ts`、`current.json`の形式と次の動作の判定は`src/launch-state.ts`にある。

- 起動役と`start.cmd`は更新で差し替えない。前の版へ戻す役が更新で壊れると、起動も戻しもできなくなるため。変えるときは全部入りZIPを出し直し、同じフォルダへの上書き展開を案内する。起動役が`node:`の標準モジュールと`launch-state.ts`だけを使うのも、`app/`へこの2つだけを置くため。
- `start.cmd`で版を選ぶ・戻す案は採らない。実行中の`start.cmd`は書き換えられず、ready前の失敗と版のせいではない失敗を区別できない。
- `current.json`は、子が動いている間は子だけが、止まっている間は起動役だけが書く。どちらも一時ファイルに書いて`rename`で置き換える。

### 子との約束（プロトコル1）

起動役と、これから出す全てのアプリの版が守る。

- 起動役は子を`app/versions/<版>/src/server.ts`で、作業ディレクトリをインストール先、stdioに`ipc`を付けて起動する。環境変数に`NIJIMAKU_DATA_DIR`（インストール先。利用者のデータの置き場所）と`NIJIMAKU_LAUNCHER`（`1`。プロトコルの版）を足す。
- 子は`listen`の後に`process.send({ type: "ready" })`を送る。
- 子の終了コード:
  - `0`: 通常の終了。起動役も0で終わる。
  - `75`: 更新を適用したので再起動してほしい。起動役は`current.json`を読み直して起動し直す。
  - `78`: 起動できないが版のせいではない（ポートが使用中、`.env`の値の誤り）。起動役は前の版へ戻さず、同じコードで終わる。
  - それ以外: ready前なら起動の失敗、ready後なら異常終了。
- ready前の起動の失敗で、`current.json`の`pending`がtrueで`previous`があれば、起動役は`previous`へ戻して起動し直す。戻すのは起動役の1回の実行につき1回まで。
- `--open`は、起動役の実行で子が一度もreadyに達していない間だけ付ける（更新の再起動のたびにChromeのタブが増えないように）。

## 更新機能

`src/update.ts`。起動役から起動されたとき（`NIJIMAKU_LAUNCHER=1`）だけ有効にする。readyの後に初期化（`pending`の解除・`current.json`が指さない版とNode.jsの削除）を終えてから`releases/latest`を1回だけ確かめ、利用者が「更新して再起動」を押したときだけ適用する。

- 照合はReleaseに添付した`SHA256SUMS.txt`で行う。assetの`digest`は`null`になり得るため使わない。Node.jsは、アプリ部分の`runtime.json`（`fetch-node.ts`と同じ値）の`sha256`で照合し、nodejs.orgの`SHASUMS256.txt`は更新時に取りに行かない。
- 署名はしない。鍵をActionsのsecretに置くなら、GitHubのアカウントを乗っ取られたときに守れない点はSHA256と変わらない。
- 自動では適用しない（再起動で配信中の字幕が止まるため）。定期的にも確かめない（配信のたびに起動する。未認証のAPIは60回/時まで）。
- `current.json`は、照合・展開・検証を終えてから書き換える。途中で失敗したら`app/tmp/`を消し、`current.json`は変えない。
- 初期化と適用は重ならない。適用は確認で新しい版が分かった後だけ受け付けるため。
- `update.apply`は`http://localhost:PORT`・`http://127.0.0.1:PORT`のページからだけ受け付け、`ALLOWED_ORIGINS`（`nr share`）からは拒否する。通知は全員に送る。
- 更新でサーバーの版が変わったら、capture.html（`/ws/settings`の`app.info`）とoverlay.html（`/ws/overlay`の`app`）はページを読み直す。どちらも、読み込んでから最初に受けた版を基準にする（同じ版への再接続や、起動の失敗での戻しでは読み直さない）。
- `update.ts`は`launch-state.ts`から型だけを使う。`launch-state.ts`は起動役と一緒に`app/`にだけ置かれ、版のフォルダには入らないため。

## 既知の問題

- `gpt-live-transcribe`で、文がerror無しで途中から切れ、続きが字幕に出ないことがある。`delay: low`でも起きる。検出策は作らない（ユーザー判断）。同じ症状の報告: https://community.openai.com/t/gpt-live-transcribe-deltas-stop-mid-item-with-no-event-and-audio-appended-after-that-is-never-transcribed/1403323

## 採用しなかった案

- WebRTCでRealtime APIへ直結する: WebRTCで送った音声をcommitで区切れるか確認できず、Chromeの非表示タブではタイマーが1秒単位に丸められる。そのため音声はNodeへ送り、無音判定・commit・Realtime接続はNodeで行う。
- `gpt-realtime-translate`で音声から直接英訳する: 約$2/時かかり、LunaのFast modeで足りる（ユーザー判断）。
- ローカルASR: 遅延の大半は無音待ちとLunaで、縮むのはネット往復分だけ。オフライン必須になったら再検討する。
- Lunaの出力を`json_schema`の1オブジェクトにする: `combined`で`ja`が`en`より先に完成する保証を確認できなかった。
- 文字起こしの`noise_reduction: near_field`: Chromeのノイズ抑制と役割が重なり、誤りが増えた（1回だけの比較）。
- 配布物を1つのexeにまとめる（Node.jsのSingle Executable Applications・`bun build --compile`・`deno compile`）: Node.jsを同梱したZIPより小さくならない。Node.jsのSEAはESMに対応せず、事前に1ファイルへまとめる必要があり、ビルドしない方針と合わない。
