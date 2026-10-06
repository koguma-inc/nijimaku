import assert from "node:assert/strict";
import { test } from "node:test";
import { SegmentStore } from "./segments.ts";
import type { Snapshot, SegmentStoreOptions } from "./segments.ts";

function make(opts: Partial<SegmentStoreOptions> = {}): { store: SegmentStore; delivered: Snapshot[] } {
  const delivered: Snapshot[] = [];
  const store = new SegmentStore({
    displaySegments: 3,
    contextSize: 3,
    ...opts,
    onSnapshot: (s) => delivered.push(s),
  });
  return { store, delivered };
}

function ids(s: Snapshot): string[] {
  return s.segments.map((seg) => seg.id);
}

function seg(s: Snapshot, id: string) {
  return s.segments.find((x) => x.id === id);
}

test("finalとfixedの到着順が逆転しても、各item_idの内容が正しく別のセグメントを上書きしない", () => {
  const { store } = make({ displaySegments: 10 });
  store.setSeq("a", 1);
  store.setSeq("b", 2);
  store.setSeq("c", 3);
  assert.equal(store.final("c", "しー"), true);
  assert.equal(store.final("a", "えー"), true);
  store.fixed("c", "シー", "C");
  assert.equal(store.final("b", "びー"), true);
  store.fixed("a", "エー");
  store.fixed("b", "ビー");
  store.fixed("b", "ビー", "B");

  const snap = store.snapshot();
  assert.deepEqual(snap.segments, [
    { id: "a", state: "fixed", text: "エー" },
    { id: "b", state: "fixed", text: "ビー", en: "B" },
    { id: "c", state: "fixed", text: "シー", en: "C" },
  ]);
});

test("文脈は修正済みのjaを優先し、CONTEXT_SIZE件に絞られ、対象より後のセグメントを含まない", () => {
  const { store } = make({ contextSize: 2, displaySegments: 10 });
  for (const [id, seq] of [["a", 1], ["b", 2], ["c", 3], ["d", 4]] as const) {
    store.setSeq(id, seq);
    store.final(id, `${id}-raw`);
  }
  store.fixed("a", "a-ja");
  store.fixed("d", "d-ja");
  // seq未確定のpartialと、setSeqだけの空セグメント
  store.partial("p", "p-raw");
  store.setSeq("e", 5);

  assert.deepEqual(store.context("c"), ["a-ja", "b-raw"]);
  assert.deepEqual(store.context("b"), ["a-ja"]);
  assert.deepEqual(store.context("a"), []);
  assert.deepEqual(store.context("e"), ["c-raw", "d-ja"]);
  assert.deepEqual(store.context("p"), ["c-raw", "d-ja"]);
});

test("CONTEXT_SIZEが0なら文脈は空", () => {
  const { store } = make({ contextSize: 0 });
  store.setSeq("a", 1);
  store.final("a", "あ");
  store.setSeq("b", 2);
  store.final("b", "い");
  assert.deepEqual(store.context("b"), []);
});

test("空のfinalでセグメントが消え、その後に同じidのイベントが来ても復活しない", () => {
  const { store, delivered } = make();
  store.setSeq("a", 1);
  store.partial("a", "えー");
  store.setSeq("b", 2);
  store.partial("b", "びー");
  assert.deepEqual(ids(store.snapshot()), ["a", "b"]);

  const before = delivered.length;
  assert.equal(store.final("a", ""), false);
  assert.equal(delivered.length, before + 1);
  assert.deepEqual(ids(store.snapshot()), ["b"]);

  assert.equal(store.final("b", "  "), false);
  assert.deepEqual(ids(store.snapshot()), []);

  const count = delivered.length;
  store.partial("a", "えーと");
  store.setSeq("a", 3);
  assert.equal(store.final("a", "えーと"), false);
  store.fixed("a", "エート");
  store.partial("b", "びーと");
  assert.deepEqual(ids(store.snapshot()), []);
  assert.equal(delivered.length, count);
});

test("未知のidへの空のfinalの後、同じidのpartialでセグメントが作られない", () => {
  const { store, delivered } = make();
  assert.equal(store.final("x", ""), false);
  store.partial("x", "あ");
  store.setSeq("x", 1);
  assert.deepEqual(ids(store.snapshot()), []);
  assert.equal(delivered.length, 0);
});

test("既定の50件を超えると、seq順で先頭のセグメントから消える", () => {
  const { store } = make({ displaySegments: 100 });
  // Mapの挿入順とseq順を食い違わせるため、seqの大きい順に作る
  for (let seq = 50; seq >= 1; seq--) {
    store.setSeq(`s${seq}`, seq);
    store.final(`s${seq}`, `文${seq}`);
  }
  assert.equal(store.snapshot().segments.length, 50);

  store.setSeq("s51", 51);
  store.final("s51", "文51");
  const snap = store.snapshot();
  assert.equal(snap.segments.length, 50);
  assert.equal(snap.segments[0]?.id, "s2");
  assert.equal(snap.segments.at(-1)?.id, "s51");
  assert.equal(seg(snap, "s1"), undefined);

  store.fixed("s1", "修正1");
  store.partial("s1", "文1");
  assert.equal(store.final("s1", "文1"), false);
  assert.equal(seg(store.snapshot(), "s1"), undefined);
});

test("maxHistoryを超えたとき、seq未確定のpartialより先にseqの小さいセグメントが消える", () => {
  const { store } = make({ displaySegments: 10, maxHistory: 3 });
  store.partial("p", "途中");
  store.setSeq("a", 1);
  store.final("a", "あ");
  store.setSeq("b", 2);
  store.final("b", "い");
  store.setSeq("c", 3);
  store.final("c", "う");
  assert.deepEqual(ids(store.snapshot()), ["b", "c", "p"]);
});

test("ローテーション中に2接続のcompletedが逆順で届いても、スナップショットはseq順", () => {
  const { store, delivered } = make({ displaySegments: 10 });
  store.setSeq("a", 1);
  store.partial("a", "旧接続の文");
  store.setSeq("b", 2);
  store.partial("b", "新接続の文");
  assert.deepEqual(ids(store.snapshot()), ["a", "b"]);
  const count = delivered.length;

  store.final("b", "新接続の文。");
  assert.deepEqual(ids(store.snapshot()), ["a", "b"]);
  store.final("a", "旧接続の文。");
  assert.deepEqual(ids(store.snapshot()), ["a", "b"]);
  assert.equal(delivered.length, count + 2);
  for (const s of delivered.slice(count)) assert.deepEqual(ids(s), ["a", "b"]);
});

test("後のcommitのcompletedが、前のcommitのcommitted・deltaより先に届いてもseq順", () => {
  const { store } = make({ displaySegments: 10 });
  store.setSeq("b", 2);
  store.final("b", "い");
  assert.deepEqual(ids(store.snapshot()), ["b"]);
  store.partial("a", "あ");
  store.setSeq("a", 1);
  assert.deepEqual(ids(store.snapshot()), ["a", "b"]);
  store.final("a", "あ。");
  assert.deepEqual(ids(store.snapshot()), ["a", "b"]);
});

test("seq未確定のpartialは、先に到着していてもseq確定済みのセグメントより後に並ぶ", () => {
  const { store } = make({ displaySegments: 10 });
  store.partial("p", "話し中");
  store.setSeq("a", 1);
  store.partial("a", "確定済みの文");
  assert.deepEqual(ids(store.snapshot()), ["a", "p"]);
  store.final("a", "確定済みの文。");
  assert.deepEqual(ids(store.snapshot()), ["a", "p"]);
});

test("seq未確定のpartialが複数あると最初のdeltaの到着順で並び、setSeq後はseq順になる", () => {
  const { store } = make({ displaySegments: 10 });
  store.setSeq("a", 1);
  store.final("a", "前の文");
  store.partial("x", "えっくす");
  store.partial("y", "わい");
  store.partial("x", "えっくすの続き");
  assert.deepEqual(ids(store.snapshot()), ["a", "x", "y"]);

  store.setSeq("y", 2);
  assert.deepEqual(ids(store.snapshot()), ["a", "y", "x"]);
  store.setSeq("x", 3);
  assert.deepEqual(ids(store.snapshot()), ["a", "y", "x"]);
});

test("表示対象外のセグメントのfixedで、スナップショットの内容・件数が変わらずonSnapshotも呼ばれない", () => {
  const { store, delivered } = make({ displaySegments: 3, contextSize: 3 });
  for (const n of [1, 2, 3, 4]) {
    store.setSeq(`${n}`, n);
    store.final(`${n}`, `文${n}`);
  }
  const before = store.snapshot();
  assert.deepEqual(ids(before), ["2", "3", "4"]);
  const count = delivered.length;

  store.fixed("1", "修正1");
  store.fixed("1", "修正1", "Fixed 1");
  assert.equal(delivered.length, count);
  assert.deepEqual(store.snapshot(), before);
  // 履歴は更新されている
  assert.deepEqual(store.context("4"), ["修正1", "文2", "文3"]);
});

test("スナップショットの件数はDISPLAY_SEGMENTSを超えず、seq順で末尾の件数だけが出る", () => {
  const { store, delivered } = make({ displaySegments: 3 });
  // 到着順とseq順を食い違わせる
  for (const n of [3, 1, 5, 2, 4]) {
    store.setSeq(`${n}`, n);
    store.final(`${n}`, `文${n}`);
  }
  store.partial("p", "話し中");
  assert.deepEqual(ids(store.snapshot()), ["4", "5", "p"]);
  for (const s of delivered) assert.ok(s.segments.length <= 3);
});

test("途中で接続したoverlayが受けるsnapshot()は、最後に配信されたスナップショットと一致する", () => {
  const { store, delivered } = make({ displaySegments: 3 });
  const check = () => assert.deepEqual(store.snapshot(), delivered.at(-1));

  store.partial("a", "あ");
  store.setSeq("a", 1);
  store.partial("b", "い");
  check();
  store.final("a", "あ。");
  store.setSeq("b", 2);
  store.final("b", "い。");
  store.fixed("b", "イ。", "I.");
  check();
  store.setSeq("c", 3);
  store.partial("c", "う");
  store.setSeq("d", 4);
  store.partial("d", "え");
  store.fixed("a", "ア。");
  store.partial("c", "う");
  check();
  store.final("c", "");
  store.dropPartials(["d"]);
  check();
});

test("final・fixedは単調で、後から来たイベントで内容が戻らない", () => {
  const { store, delivered } = make();
  store.setSeq("a", 1);
  store.partial("a", "あ");

  store.fixed("a", "ア");
  assert.deepEqual(seg(store.snapshot(), "a"), { id: "a", state: "partial", text: "あ" });

  assert.equal(store.final("a", "あい"), true);
  let count = delivered.length;
  store.partial("a", "あ");
  assert.equal(delivered.length, count);
  assert.equal(store.final("a", "あいう"), false);
  assert.deepEqual(seg(store.snapshot(), "a"), { id: "a", state: "final", text: "あい" });

  store.fixed("a", "アイ");
  assert.equal(store.final("a", "あい"), false);
  assert.equal(store.final("a", ""), false);
  store.partial("a", "あ");
  assert.deepEqual(seg(store.snapshot(), "a"), { id: "a", state: "fixed", text: "アイ" });

  store.fixed("a", "アイ", "Ai");
  assert.deepEqual(seg(store.snapshot(), "a"), { id: "a", state: "fixed", text: "アイ", en: "Ai" });
  count = delivered.length;
  store.setSeq("a", 9);
  assert.equal(delivered.length, count);
});

test("dropPartialsはpartialだけを消し、final・fixedは残す", () => {
  const { store, delivered } = make({ displaySegments: 10 });
  store.setSeq("f", 1);
  store.final("f", "確定");
  store.setSeq("x", 2);
  store.final("x", "修正前");
  store.fixed("x", "修正後");
  store.setSeq("p", 3);
  store.partial("p", "途中");
  store.partial("q", "commit前");

  const count = delivered.length;
  store.dropPartials(["f", "x", "p", "q", "unknown"]);
  assert.equal(delivered.length, count + 1);
  assert.deepEqual(ids(store.snapshot()), ["f", "x"]);

  store.dropPartials(["f", "x"]);
  assert.equal(delivered.length, count + 1);

  store.partial("p", "途中の続き");
  assert.equal(store.final("q", "遅れたcompleted"), false);
  assert.deepEqual(ids(store.snapshot()), ["f", "x"]);
});

test("committedがdeltaより先に来てもseq順に並び、中身が空のセグメントはスナップショットに出ない", () => {
  const { store, delivered } = make({ displaySegments: 10 });
  store.setSeq("a", 1);
  store.partial("a", "あ");
  store.partial("c", "う");
  const count = delivered.length;

  store.setSeq("b", 2);
  assert.equal(delivered.length, count);
  assert.deepEqual(ids(store.snapshot()), ["a", "c"]);

  store.partial("b", "い");
  assert.deepEqual(ids(store.snapshot()), ["a", "b", "c"]);
  store.partial("b", "");
  assert.deepEqual(ids(store.snapshot()), ["a", "c"]);
});

test("setDisplaySegmentsで表示件数を変えると、新しい件数のスナップショットを配信する", () => {
  const { store, delivered } = make({ displaySegments: 3 });
  for (const [id, seq] of [["a", 1], ["b", 2], ["c", 3]] as const) {
    store.setSeq(id, seq);
    store.final(id, id);
  }
  const count = delivered.length;
  store.setDisplaySegments(1);
  assert.equal(delivered.length, count + 1);
  assert.deepEqual(ids(store.snapshot()), ["c"]);
  store.setDisplaySegments(1);
  assert.equal(delivered.length, count + 1);
});
