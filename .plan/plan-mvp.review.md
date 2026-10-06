基準日: 2026-10-05・a033d00

## Plan Review (by GPT-6)

対象: `.plan/plan-mvp.md`

### 判定: 要修正

### Blocking

- B1: captureの置き換えと自動再接続が競合し、新しい音声入力を維持できない。
  - 根拠: PR2の`server.ts`は新規capture接続で旧接続を閉じる一方、`capture.js`は切断時に再接続する。ブラウザを開いたまま`replay.ts`を開始すると、追い出されたブラウザが再接続してreplayを追い出す。2枚のcaptureタブなら互いを追い出し続ける。これは「失敗・競合の確認」に明記された通常の切り替え操作で起き、一時的な音声欠落の受容では解決しない。加えて、旧接続の遅れて届くclose処理が新接続の音声をcommitしないよう、入力の所有権を先に決める必要がある。
  - 修正案: 置き換えによる切断を専用のclose code（例: 4001）で通知し、旧captureは送信・自動再接続を停止して「別の入力に切り替わりました」と表示する。ユーザーが再び開始した場合だけ接続を取り直し、予期しない切断だけを自動再接続の対象にする。サーバーは旧入力の受付停止→旧入力のcommitとVADリセット→新入力の採用の順を定め、旧接続の遅延message/closeでは共有パイプラインを更新しない。ブラウザ＋replay、captureタブ2枚、旧closeが新入力後に届くケースを完了条件に追加する。

- B2: SegmentStoreのcommit順と「直近3件」をoverlayへ伝える契約がなく、順不同のイベントから同じ表示を復元できない。
  - 根拠: PR2の`SegmentStore`はcommit順を保持するが、配信する`partial`/`final`/`fixed`はIDと本文だけで、`seq`はログ用にしか定義されていない。snapshotも接続時だけである。旧Realtime接続の遅延イベントと新接続のイベントが交差した場合や、表示対象から外れたセグメントのLuna応答が後着した場合、クライアントはIDだけでは挿入位置と現在の表示対象を判断できない。別セグメントへの上書き防止と、表示順・表示対象の一致は別の条件であり、現在の`segments.test.ts`だけでは配信先の整合性を確認できない。異なるターンのcompletedが順不同になることは[公式Realtime transcriptionガイド](https://developers.openai.com/api/docs/guides/realtime-transcription)にも明記されている。
  - 修正案: 小規模なMVPでは、SegmentStoreを表示対象・順序の唯一の決定元とし、変更のたびにcommit順の直近3件を既存の`snapshot`でOBSとPiPへ配信する方式を推奨する。クライアントはsnapshotを現在の表示全体として反映し、履歴に残った旧セグメントのfixedから独自に行を追加しない。partial/final/fixedはサーバー内部の更新・ログとして維持し、partial段階の仮の順序とcommit後の確定順序もPR1で確定する対象へ加える。通信契約をPR2着手前に揃え、順序が逆転する2接続、4件目の表示後に届く1件目のfixed、途中接続のsnapshotでOBSとPiPが同じ順序・件数になることを検証する。

### 確認範囲

`README.md`、`HANDOFF.md`、`.gitignore`とプラン全文を確認した。実装コードとパッケージ設定はまだ存在せず、「コードなし」という前提は一致している。既存レビューがないため初回レビューとして実施した。

APIの主要前提は公式資料で照合した。`gpt-live-transcribe`の24kHz PCM、手動commit、`languages`、サーバーVAD非対応は[Realtime transcriptionガイド](https://developers.openai.com/api/docs/guides/realtime-transcription)、`gpt-6-luna`のResponses対応と`reasoning.effort: none`は[モデル資料](https://developers.openai.com/api/docs/models/gpt-6-luna)と一致する。PR1で調べると明記された接続URL・commit前のID・API実測結果の未確定自体はBlockingにしていない。

各指摘をPR1の調査事項、不変条件、失敗・競合の確認、受容済みリスクと再照合した。B1の置き換え後の再接続停止と入力所有権、B2の配信先への順序・表示対象の伝達は既存記述では決まっておらず、いずれも通信契約と状態の持ち方を実装前に確定する必要がある。

---

## 対応記録 (round 1)

- B1: 修正 — PR2-2 `server.ts`に置き換え手順（`current`から外す→`commit()`（理由`replaced`）と到着間隔のリセット→新接続を採用→旧接続をclose code 4001で閉じる）と、`current`でない接続のmessage/closeを捨てる規則を追加。PR2-11 `capture.js`は開始ボタンで接続・停止で1000、4001なら再接続せず「別の入力に切り替わりました」を表示、それ以外の予期しない切断だけ再接続に変更。PR2-13 `replay.ts`は4001で終了。commit経路を4つに更新（PR2-4、「状態と影響経路」）、ログに`capture.close`を追加。不変条件・設計判断の根拠に追記し、「失敗・競合の確認」の二重接続行をブラウザ＋replay、タブ2枚、旧close由来のcommitが出ないことの確認に差し替えた。
- B2: 修正 — SegmentStoreを順序・表示対象の唯一の決定元にした（PR2-6）。順序は`seq`（commit順）、`seq`未確定のpartialは末尾。内容が変わるたびと接続時に末尾`DISPLAY_SEGMENTS`件（config追加、既定3）のスナップショットを全overlayへ送る。PR2-10のoverlayメッセージを`snapshot`1種にし、各セグメントに`state`（partial/final/fixed）を持たせて表示の3段階を保つ。`remove`は廃止。PR2-12 overlayはスナップショットで表示全体を置き換え、独自に行を足さない。`seq`と`item_id`の対応は接続ごとのFIFOで持つ（PR2-4）。PR1の確認事項と「PR1の疎通確認で決めること」にcommit前partialの並び順を追加。不変条件・設計判断の根拠・「状態と影響経路」を更新し、「失敗・競合の確認」と`segments.test.ts`に2接続の逆順completed、表示対象外のfixed後着、途中接続overlayの一致を追加した。

---

## Plan Review — follow-up (by GPT-6)

対象: `.plan/plan-mvp.md`

### 判定: Ready

### 前回Blockingの解消状況

- B1: 解消 — PR2の`server.ts`で旧接続を`current`から外して旧入力をcommitし、新接続を採用してから旧接続を4001で閉じる順序が明記された。旧接続のmessage/closeは共有パイプラインに触れず、`capture.js`は4001後の自動再接続を停止し、`replay.ts`も終了する。開始・停止と予期しない切断も区別され、ブラウザ＋replay、captureタブ2枚、旧close由来の二重commitを確認する手順が追加されている。
- B2: 解消 — SegmentStoreを順序と表示対象の唯一の決定元とし、内容の変更時と接続時に表示全体のsnapshotを送る契約になった。overlayはその配列どおりに表示を置き換えるため、独自の挿入位置判断や古いfixedによる行の復活が不要になった。`seq`の対応待ちはRealtime接続ごとに管理し、commit前partialの順序確定をPR2着手条件に含めている。逆順completed、表示対象外のfixed、途中接続時の一致が検証項目にも反映されている。

### Blocking

なし（未解消0件、新規0件）。

### Advisory

なし。

### 確認範囲

修正後のプラン全文と`対応記録 (round 1)`を照合し、前回2件の解消と修正に伴う新たな設計問題の有無を確認した。実装コードはまだ存在せず、今回はプランのレビューとして判定した。ReadyはPR1から着手可能という意味であり、接続URL・commit前のIDと順序などの実測、およびその結果を踏まえたPR2着手条件は引き続き有効である。

---

## Plan Review — follow-up (by GPT-6)

対象: `.plan/plan-mvp.md`（2026-10-06、疎通確認の結果を反映した未commitの差分）

### 判定: Ready

### 前回Blockingの解消状況

- B1: 解消を維持 — captureの置き換え手順、旧接続の遅延message/closeの無視、4001後の自動再接続停止は今回の更新でも維持されている。
- B2: 解消を維持 — SegmentStoreが表示順と件数を決め、全overlayへsnapshotを送る契約は維持されている。未確定の`seq`を末尾に置き、その間だけ最初のdeltaの到着順を使う今回の具体化は、疎通結果末尾の決定と一致する。

### Blocking

なし（未解消0件、新規0件）。PR2へ着手可能。

### Advisory

1. 長い無音を含むバッファの扱いを、未確認事項として明記するとよい。無音もappendし続け、発話が無ければcommitしないため、次の発話のcommitには先行する無音も含まれる。したがって末尾の「発話があったときだけの条件は費用の面でも要る」は、無音部分のusageを除ける意味にはならない。「無音だけの不要なcommitと秒の切り上げを減らすが、次のcommitには無音も含まれる。長い無音を蓄積した場合の上限と挙動は未確認」と補足するのを推奨する。`VAD_MAX_SEGMENT_MS`は発話開始からの上限で、無音中のバッファを制限しない。公式の[appendリファレンス](https://developers.openai.com/api/reference/resources/realtime/client-events#input_audio_buffer.append)にある15MiBは1イベントの上限であり、蓄積バッファ全体の上限は今回確認した資料では確定できない。PR3で長い無音→発話の確認を加えるとよい。実時間ぶんの費用想定や無音送信を続ける既存方針は変わらず、上限超過が起きる証拠も無いため、現時点ではBlockingにしない。
2. 今回具体化した境界条件をテスト方針に追加するとよい。`AudioPipeline`／`RealtimeSession`では、100ms未満で送らない・100ms以上かつ発話ありで送る・commit直後にappend量をリセットする・再接続へappend量を持ち越さないことを確認する。ready前に保持／破棄したPCMを、現接続へ送信済みの量と混同しないケースも含める。SegmentStoreでは`seq`未確定のpartialを複数投入し、`committed`後に`seq`順のsnapshotになるケースを追加する。いずれも今回決まった設計を検証する項目で、設計変更は不要。

### 確認範囲と判定根拠

プラン全文、既存レビューと対応記録、`git diff -- .plan/plan-mvp.md`、`HANDOFF.md`、`README.md`、`package.json`、`scripts/spike-realtime.ts`、`scripts/spike-luna.ts`とRealtimeの疎通ログ7本を確認した。PR1のスクリプトは存在し、PR2の`src/`と`public/`はまだ存在しない。冒頭の「コードは無い」は開始時点の記述が残っているが、今回の設計判定には影響しない。APIの再実行やブラウザ確認は行っていない。

- commitガード: 0msと50msのcommitだけが`input_audio_buffer_commit_empty`になった実測と、接続ごと・前回commit以降の100msを数える更新は整合する。正常なcommit計50件にはすべて`committed`とcompletedがあり、usageは無音を含むバッファ秒数の切り上げと一致した。
- `event_id`: errorの内側の`error.event_id`を`commit_<seq>`へ対応させる形はログと一致する。後続の`committed`が先着するとFIFOの誤対応を事後の削除だけでは直せない点も、プランは既に明記している。今回実測した空・短音声のcommitはガードで排除でき、FIFO削除は保険という決定に矛盾しない。任意のcommitエラーをガードで防げると検証したわけではない。
- セッションと`delay`: 接続URL、24kHz PCM、`languages: ["ja"]`、明示的な`turn_detection: null`、`noise_reduction`未指定は疎通設定に一致する。`TRANSCRIBE_DELAY=low`とPR3でのminimal比較、不正なdelayでの拒否確認も決定と一致する。lowをライブ字幕向けの開始点とする判断は[公式Realtime transcriptionガイド](https://developers.openai.com/api/docs/guides/realtime-transcription)とも整合する。
- 未確認事項とリスク: `expires_at`の観測と実際の60分切断、usageと請求額を区別した更新は適切。既定delayでの途中切れ、lowでも発生する可能性、検出策を作らないユーザー決定が明記されており、この受容済み方針をBlockingにはしていない。

指摘候補を不変条件、失敗・競合の確認、末尾の決定、受容済みリスクと再照合した。今回の差分による設計のやり直しを要する矛盾は確認できず、長い無音の未検証とテスト項目の補足はAdvisoryとした。

---

## 対応記録 (round 1, Advisory)

- A1（長い無音のバッファ）: 反映。「未確認のまま進めるもの」に長い無音を溜めたバッファの扱いを追加し、PR3手順1に数分の無音の後の発話の確認を追加した。末尾の「決定」の費用の説明を、無音だけのcommitと秒の切り上げを減らす意味だと補足した。
- A2（境界条件のテスト）: 一部反映。`segments.test.ts`に`seq`未確定のpartialが複数ある場合を追加し、「失敗・競合の確認」の途中切断の行に、再接続後の最初のcommitで`rt.error`が出ないことの確認を追加した。100msガードとappend量のリセット・ready前の保持分の単体テストは見送り（`RealtimeSession`のWSを差し替える仕組みが要り、テスト範囲が広がるため。手動確認の「VADと手動ボタンのcommitが重なる」と途中切断の行で`rt.error`が出ないことを確かめる）。
