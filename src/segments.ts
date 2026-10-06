// セグメント履歴。overlayに出す並び順と表示対象はここだけが決める。
// 異なるターンのcompletedは順不同で届き、ローテーション中は2接続のイベントが交差するため、
// 到着順ではなくcommit順（seq）で並べ、表示全体のスナップショットとして配信する。

export type SegmentState = "partial" | "final" | "fixed";

export type SnapshotSegment = { id: string; state: SegmentState; text: string; en?: string };

export type Snapshot = { type: "snapshot"; segments: SnapshotSegment[] };

export type SegmentStoreOptions = {
  displaySegments: number;
  contextSize: number;
  maxHistory?: number;
  onSnapshot?: (snapshot: Snapshot) => void;
};

type Segment = {
  id: string;
  seq?: number;
  // 最初のイベントの到着順。seq未確定のセグメント同士の並びにだけ使う
  arrival: number;
  raw: string;
  ja?: string;
  en?: string;
  state: SegmentState;
};

const DEFAULT_MAX_HISTORY = 50;
// 消したセグメントに遅れて届いたイベントで、セグメントを作り直さないための記録
const MAX_CLOSED = 200;

export class SegmentStore {
  #segments = new Map<string, Segment>();
  #closed = new Set<string>();
  #arrival = 0;
  #displaySegments: number;
  #contextSize: number;
  #maxHistory: number;
  #onSnapshot?: (snapshot: Snapshot) => void;
  #lastSnapshot: string;

  constructor(opts: SegmentStoreOptions) {
    this.#displaySegments = opts.displaySegments;
    this.#contextSize = opts.contextSize;
    this.#maxHistory = opts.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.#onSnapshot = opts.onSnapshot;
    this.#lastSnapshot = JSON.stringify(this.snapshot());
  }

  setDisplaySegments(n: number): void {
    this.#displaySegments = n;
    this.#changed();
  }

  // text はその item_id のdeltaを連結した途中経過
  partial(id: string, text: string): void {
    const seg = this.#segments.get(id) ?? this.#create(id);
    if (!seg || seg.state !== "partial") return;
    seg.raw = text;
    this.#changed();
  }

  // Lunaを呼ぶべきとき（初回のfinalで文字列が空でない）だけtrueを返す
  final(id: string, transcript: string): boolean {
    const existing = this.#segments.get(id);
    if (existing && existing.state !== "partial") return false;
    if (transcript.trim() === "") {
      if (existing) this.#remove(id);
      else this.#close(id);
      this.#changed();
      return false;
    }
    const seg = existing ?? this.#create(id);
    if (!seg) return false;
    seg.raw = transcript;
    seg.state = "final";
    this.#changed();
    return true;
  }

  // committedより先にdeltaが来ないこともあるため、未知のidなら空のセグメントを作って順序だけ確定させる
  setSeq(id: string, seq: number): void {
    const seg = this.#segments.get(id) ?? this.#create(id);
    if (!seg || seg.seq !== undefined) return;
    seg.seq = seq;
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

  // Realtime接続が閉じてcompletedが来なくなったitem。finalになったものは残す
  dropPartials(ids: string[]): void {
    let removed = false;
    for (const id of ids) {
      if (this.#segments.get(id)?.state !== "partial") continue;
      this.#remove(id);
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

  #create(id: string): Segment | undefined {
    if (this.#closed.has(id)) return undefined;
    const seg: Segment = { id, arrival: this.#arrival++, raw: "", state: "partial" };
    this.#segments.set(id, seg);
    if (this.#segments.size > this.#maxHistory) {
      const oldest = this.#ordered()[0];
      if (oldest) this.#remove(oldest.id);
    }
    return this.#segments.get(id);
  }

  #remove(id: string): void {
    this.#segments.delete(id);
    this.#close(id);
  }

  #close(id: string): void {
    this.#closed.add(id);
    if (this.#closed.size > MAX_CLOSED) {
      const first = this.#closed.values().next();
      if (!first.done) this.#closed.delete(first.value);
    }
  }

  // seq確定済みをseq順に並べ、seq未確定（commit前のpartial）は末尾に最初のdeltaの到着順で置く
  #ordered(): Segment[] {
    return [...this.#segments.values()].sort((a, b) => {
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
