// セグメント履歴。overlayに出す並び順と表示対象はここだけが決める。
// 異なるターンのcompletedは順不同で届き、ローテーション中は2接続のイベントが交差するため、
// 到着順ではなくcommit順（seq）で並べ、表示全体のスナップショットとして配信する。
// 1つのitem（commit）は、話し続けて無音で区切れないとき、句点で複数のセグメント（文）に分かれる。

export type SegmentState = "partial" | "final" | "fixed";

export type SnapshotSegment = { id: string; state: SegmentState; text: string; en?: string };

export type Snapshot = { type: "snapshot"; segments: SnapshotSegment[] };

// Lunaに回す文。idはセグメントのid
export type Sentence = { id: string; text: string };

export type SegmentStoreOptions = {
  displaySegments: number;
  contextSize: number;
  sentenceSplitMs: number;
  maxHistory?: number;
  onSnapshot?: (snapshot: Snapshot) => void;
};

type Item = {
  id: string;
  seq?: number;
  // 最初のイベントの到着順。seq未確定のitem同士の並びにだけ使う
  arrival: number;
  // 最後のセグメント。partialの間だけ途中経過を受ける。消えたら無くなり、後から届いたイベントでは作り直さない
  tail?: Segment;
  parts: number;
  live: number;
  // partialのtext上で、区切り終えた位置と句点を探し終えた位置
  offset: number;
  scanned: number;
  // tailの最初の文字（空白と句点を除く）が届いた時刻
  startedAt?: number;
};

type Segment = {
  id: string;
  item: Item;
  part: number;
  raw: string;
  ja?: string;
  en?: string;
  state: SegmentState;
};

const DEFAULT_MAX_HISTORY = 50;
// 消したitemに遅れて届いたイベントで、セグメントを作り直さないための記録
const MAX_CLOSED = 200;
const TERMINATOR = /[。？！?!]/;

export class SegmentStore {
  #segments = new Map<string, Segment>();
  #items = new Map<string, Item>();
  #closed = new Set<string>();
  #arrival = 0;
  #displaySegments: number;
  #contextSize: number;
  #sentenceSplitMs: number;
  #maxHistory: number;
  #onSnapshot?: (snapshot: Snapshot) => void;
  #lastSnapshot: string;

  constructor(opts: SegmentStoreOptions) {
    this.#displaySegments = opts.displaySegments;
    this.#contextSize = opts.contextSize;
    this.#sentenceSplitMs = opts.sentenceSplitMs;
    this.#maxHistory = opts.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.#onSnapshot = opts.onSnapshot;
    this.#lastSnapshot = JSON.stringify(this.snapshot());
  }

  setDisplaySegments(n: number): void {
    this.#displaySegments = n;
    this.#changed();
  }

  setSentenceSplitMs(ms: number): void {
    this.#sentenceSplitMs = ms;
  }

  // text はその item_id のdeltaを連結した途中経過。前の区切りの後の最初の文字からsentenceSplitMs以上経って
  // 届いた句点で区切り、区切った文を返す
  partial(id: string, text: string, t = Date.now()): Sentence[] {
    const item = this.#items.get(id) ?? this.#createItem(id);
    if (!item || item.tail?.state !== "partial") return [];
    const sentences: Sentence[] = [];
    for (let i = Math.max(item.scanned, item.offset); i < text.length; i++) {
      const char = text.charAt(i);
      if (!TERMINATOR.test(char)) {
        if (item.startedAt === undefined && char.trim() !== "") item.startedAt = t;
        continue;
      }
      if (item.startedAt === undefined || t - item.startedAt < this.#sentenceSplitMs) continue;
      // 「？！」のように続く句点は同じ文に含める
      let end = i + 1;
      while (end < text.length && TERMINATOR.test(text.charAt(end))) end++;
      const sentence = this.#split(item, text.slice(item.offset, end).trim(), end);
      if (sentence) sentences.push(sentence);
      if (item.tail === undefined) break;
      i = end - 1;
    }
    item.scanned = text.length;
    if (item.tail) item.tail.raw = text.slice(item.offset).trimStart();
    this.#changed();
    return sentences;
  }

  // Lunaに回す文（初回のfinalで、区切った残りが空でないとき）を返す。
  // completedのtranscriptはdeltaの連結と同じ前提で、区切った位置より後ろを残りとする
  // （ログの607件で全件一致。APIの仕様としては確かめていない）
  final(id: string, transcript: string): Sentence | undefined {
    const existing = this.#items.get(id);
    if (existing && existing.tail?.state !== "partial") return undefined;
    const text = transcript.slice(existing?.offset ?? 0).trim();
    if (text === "") {
      if (existing?.tail) this.#remove(existing.tail);
      else this.#close(id);
      this.#changed();
      return undefined;
    }
    const seg = (existing ?? this.#createItem(id))?.tail;
    if (!seg) return undefined;
    seg.raw = text;
    seg.state = "final";
    this.#changed();
    return { id: seg.id, text };
  }

  // committedより先にdeltaが来ないこともあるため、未知のidなら空のセグメントを作って順序だけ確定させる
  setSeq(id: string, seq: number): void {
    const item = this.#items.get(id) ?? this.#createItem(id);
    if (!item || item.seq !== undefined) return;
    item.seq = seq;
    this.#changed();
  }

  fixed(id: string, ja: string, en?: string): void {
    const seg = this.#segments.get(id);
    if (!seg || seg.state === "partial") return;
    seg.ja = ja;
    if (en !== undefined) seg.en = en;
    seg.state = "fixed";
    this.#changed();
  }

  // Realtime接続が閉じてcompletedが来なくなったitem。区切ってfinalになった文は残す
  dropPartials(ids: string[]): void {
    let removed = false;
    for (const id of ids) {
      const tail = this.#items.get(id)?.tail;
      if (tail?.state !== "partial") continue;
      this.#remove(tail);
      removed = true;
    }
    if (removed) this.#changed();
  }

  // 対象より前の直近contextSize件。修正済みのjaがあればそれ、無ければraw。前の文のLuna応答は待たない
  context(id: string): string[] {
    if (this.#contextSize <= 0) return [];
    const ordered = this.#ordered();
    const index = ordered.findIndex((s) => s.id === id);
    const before = index === -1 ? ordered : ordered.slice(0, index);
    return before
      .map((s) => s.ja ?? s.raw)
      .filter((text) => text.trim() !== "")
      .slice(-this.#contextSize);
  }

  snapshot(): Snapshot {
    const segments = this.#ordered()
      .filter((s) => displayText(s) !== "")
      .slice(-this.#displaySegments)
      .map((s): SnapshotSegment => {
        const out: SnapshotSegment = { id: s.id, state: s.state, text: displayText(s) };
        if (s.state === "fixed" && s.en !== undefined) out.en = s.en;
        return out;
      });
    return { type: "snapshot", segments };
  }

  #createItem(id: string): Item | undefined {
    if (this.#closed.has(id)) return undefined;
    const item: Item = { id, arrival: this.#arrival++, parts: 0, live: 0, offset: 0, scanned: 0 };
    this.#items.set(id, item);
    this.#createSegment(item);
    return this.#items.get(id);
  }

  // 最初のセグメントのidはitem_id、句点で区切った後は「item_id#番号」
  #createSegment(item: Item): void {
    const part = item.parts++;
    const seg: Segment = { id: part === 0 ? item.id : `${item.id}#${part}`, item, part, raw: "", state: "partial" };
    this.#segments.set(seg.id, seg);
    item.tail = seg;
    item.live++;
    if (this.#segments.size > this.#maxHistory) {
      const oldest = this.#ordered()[0];
      if (oldest) this.#remove(oldest);
    }
  }

  // tailを文として確定させ、続きを新しいセグメントで受ける
  #split(item: Item, text: string, end: number): Sentence | undefined {
    const seg = item.tail!;
    seg.raw = text;
    seg.state = "final";
    item.offset = end;
    item.startedAt = undefined;
    this.#createSegment(item);
    return this.#segments.has(seg.id) ? { id: seg.id, text } : undefined;
  }

  #remove(seg: Segment): void {
    this.#segments.delete(seg.id);
    const item = seg.item;
    if (item.tail === seg) item.tail = undefined;
    if (--item.live > 0) return;
    this.#items.delete(item.id);
    this.#close(item.id);
  }

  #close(id: string): void {
    this.#closed.add(id);
    if (this.#closed.size > MAX_CLOSED) {
      const first = this.#closed.values().next();
      if (!first.done) this.#closed.delete(first.value);
    }
  }

  // seq確定済みのitemをseq順に並べ、seq未確定（commit前のpartial）は末尾に最初のdeltaの到着順で置く。
  // 同じitemの中は区切った順
  #ordered(): Segment[] {
    return [...this.#segments.values()].sort((x, y) => {
      const a = x.item;
      const b = y.item;
      if (a === b) return x.part - y.part;
      if (a.seq !== undefined && b.seq !== undefined) return a.seq - b.seq;
      if (a.seq !== undefined) return -1;
      if (b.seq !== undefined) return 1;
      return a.arrival - b.arrival;
    });
  }

  // 表示対象外のセグメントだけが変わったときは同じスナップショットになるので送らない
  #changed(): void {
    const snapshot = this.snapshot();
    const json = JSON.stringify(snapshot);
    if (json === this.#lastSnapshot) return;
    this.#lastSnapshot = json;
    this.#onSnapshot?.(snapshot);
  }
}

function displayText(s: Segment): string {
  return s.state === "fixed" ? (s.ja ?? s.raw) : s.raw;
}
