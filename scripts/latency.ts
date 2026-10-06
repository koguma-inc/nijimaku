// サーバーのセッションログ（logs/session-*.jsonl）からセグメントごとの遅延を集計する。
//
// 実行: node scripts/latency.ts [log.jsonl]
//   省略時はlogs/session-*.jsonlのうちファイル名が最新のもの
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const TRANSCRIPT_CHARS = 20;

type LogLine = { t: number; kind: string } & Record<string, unknown>;

type Segment = {
  seq: number;
  reason: string;
  commitT: number;
  speechStartT?: number;
  speechEndT?: number;
  itemId?: string;
  commitError: boolean;
};

type Item = {
  firstDeltaT?: number;
  completedT?: number;
  transcript?: string;
  jaT?: number;
  enT?: number;
  lunaError?: string;
};

const logPath = process.argv[2] ?? latestSessionLog();
if (!logPath) {
  console.error("logs/session-*.jsonl がありません");
  process.exit(1);
}

// --- 読み込みと組み立て ---

const segments: Segment[] = [];
const segmentBySeq = new Map<number, Segment>();
const items = new Map<string, Item>();
const itemOf = (id: string): Item => {
  let item = items.get(id);
  if (!item) items.set(id, (item = {}));
  return item;
};

let brokenLines = 0;
let committedCount = 0;
let completedCount = 0;
let emptyCompletedCount = 0;
let duplicateCompletedCount = 0;
let commitErrorCount = 0;
let lunaErrorCount = 0;
const completedIds: string[] = [];
let pendingSpeechStart: number | undefined;
let pendingSpeechEnd: number | undefined;

for (const line of readLines(logPath)) {
  const itemId = typeof line.item_id === "string" ? line.item_id : undefined;
  switch (line.kind) {
    case "vad.speech_start":
      pendingSpeechStart ??= line.t;
      break;
    case "vad.speech_end":
      pendingSpeechEnd = line.t;
      break;
    case "commit": {
      if (typeof line.seq !== "number") break;
      const seg: Segment = {
        seq: line.seq,
        reason: String(line.reason ?? "?"),
        commitT: line.t,
        speechStartT: pendingSpeechStart,
        speechEndT: pendingSpeechEnd,
        commitError: false,
      };
      segments.push(seg);
      segmentBySeq.set(seg.seq, seg);
      pendingSpeechStart = undefined;
      pendingSpeechEnd = undefined;
      break;
    }
    case "rt.committed": {
      committedCount += 1;
      const seg = typeof line.seq === "number" ? segmentBySeq.get(line.seq) : undefined;
      if (seg && itemId && !seg.itemId) seg.itemId = itemId;
      break;
    }
    case "rt.error":
      if (typeof line.seq === "number") {
        commitErrorCount += 1;
        const seg = segmentBySeq.get(line.seq);
        if (seg) seg.commitError = true;
      }
      break;
    case "rt.delta":
      if (itemId) itemOf(itemId).firstDeltaT ??= line.t;
      break;
    case "rt.completed": {
      if (!itemId) break;
      completedCount += 1;
      const transcript = typeof line.transcript === "string" ? line.transcript : "";
      if (transcript.trim() === "") emptyCompletedCount += 1;
      const item = itemOf(itemId);
      if (item.completedT !== undefined) {
        duplicateCompletedCount += 1;
        break;
      }
      item.completedT = line.t;
      item.transcript = transcript;
      completedIds.push(itemId);
      break;
    }
    case "luna.ja":
      if (itemId) itemOf(itemId).jaT ??= line.t;
      break;
    case "luna.en":
      if (itemId) itemOf(itemId).enT ??= line.t;
      break;
    case "luna.error":
      lunaErrorCount += 1;
      if (itemId) itemOf(itemId).lunaError ??= String(line.reason ?? "?");
      break;
  }
}

// --- セグメントごとの表 ---

type Column = { label: string; value: (s: Segment, item: Item | undefined) => number | undefined };

const COLUMNS: Column[] = [
  { label: "発話終了→commit*", value: (s) => diff(s.commitT, s.speechEndT) },
  { label: "commit→completed", value: (s, it) => diff(it?.completedT, s.commitT) },
  { label: "completed→ja", value: (_s, it) => diff(it?.jaT, it?.completedT) },
  { label: "ja→en", value: (_s, it) => diff(it?.enT, it?.jaT) },
  { label: "発話終了→ja", value: (s, it) => diff(it?.jaT, s.speechEndT) },
  { label: "発話終了→en", value: (s, it) => diff(it?.enT, s.speechEndT) },
  { label: "発話開始→partial", value: (s, it) => diff(it?.firstDeltaT, s.speechStartT) },
];

const values = segments.map((s) => {
  const item = s.itemId ? items.get(s.itemId) : undefined;
  return { seg: s, item, cols: COLUMNS.map((c) => c.value(s, item)) };
});

console.log(`log: ${logPath}`);
console.log("");
printTable(
  ["seq", "reason", ...COLUMNS.map((c) => c.label), "transcript"],
  values.map(({ seg, item, cols }) => [
    String(seg.seq),
    seg.reason,
    ...cols.map(fmt),
    describe(seg, item),
  ]),
  [false, false, ...COLUMNS.map(() => true), false],
);
console.log("");
console.log("単位はms。*「発話終了→commit」はVADの無音待ちの時間（最後の発話フレームからcommitまで）。");
console.log("発話開始→partialは発話開始から最初のrt.deltaまで。値が無い項目は「-」。");

// --- 統計 ---

console.log("");
printTable(
  ["項目", "中央値", "p90", "件数"],
  COLUMNS.map((c, i) => {
    const xs = values.map((v) => v.cols[i]).filter((v): v is number => v !== undefined);
    return [c.label, fmt(percentile(xs, 50)), fmt(percentile(xs, 90)), String(xs.length)];
  }),
  [false, true, true, true],
);

// --- 件数の突き合わせ ---

const reasons = new Map<string, number>();
for (const s of segments) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
const reasonText = [...reasons].map(([r, n]) => `${r} ${n}`).join(", ");
const noItem = segments.filter((s) => !s.itemId);
const linkedIds = new Set(segments.map((s) => s.itemId).filter((id) => id !== undefined));
const orphanCompleted = completedIds.filter((id) => !linkedIds.has(id));

console.log("");
console.log("件数:");
console.log(`  commit: ${segments.length}${reasonText ? `（${reasonText}）` : ""}`);
console.log(`  rt.committed: ${committedCount}`);
console.log(`  rt.completed: ${completedCount}（空transcript ${emptyCompletedCount}、同じitem_idの重複 ${duplicateCompletedCount}）`);
console.log(`  commitのエラー（seq付きrt.error）: ${commitErrorCount}`);
console.log(`  item_idが対応しないcommit: ${noItem.length}${seqList(noItem)}`);
console.log(`  commitに対応しないrt.completed: ${orphanCompleted.length}${orphanCompleted.length ? `（${orphanCompleted.join(", ")}）` : ""}`);
console.log(`  luna.error: ${lunaErrorCount}`);
if (brokenLines > 0) console.log(`  読み飛ばした行: ${brokenLines}`);

// --- 補助 ---

function latestSessionLog(): string | undefined {
  const dir = path.join(ROOT, "logs");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const latest = names
    .filter((f) => f.startsWith("session-") && f.endsWith(".jsonl"))
    .sort()
    .at(-1);
  return latest ? path.join(dir, latest) : undefined;
}

function readLines(file: string): LogLine[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const lines: LogLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const v: unknown = JSON.parse(raw);
      const obj = v as Record<string, unknown>;
      if (typeof v === "object" && v !== null && typeof obj.t === "number" && typeof obj.kind === "string") {
        lines.push(obj as LogLine);
        continue;
      }
    } catch {}
    brokenLines += 1;
  }
  return lines;
}

function describe(seg: Segment, item: Item | undefined): string {
  const notes: string[] = [];
  if (seg.commitError) notes.push("[rt.error]");
  if (item?.lunaError) notes.push(`[luna.error:${item.lunaError}]`);
  let text = "-";
  if (item?.transcript !== undefined) {
    const chars = Array.from(item.transcript);
    text = chars.length === 0 ? "(空)" : chars.slice(0, TRANSCRIPT_CHARS).join("") + (chars.length > TRANSCRIPT_CHARS ? "…" : "");
  }
  return [...notes, text].join(" ");
}

function seqList(segs: Segment[]): string {
  return segs.length > 0 ? `（seq ${segs.map((s) => s.seq).join(", ")}）` : "";
}

function diff(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined || b === undefined ? undefined : a - b;
}

function fmt(v: number | null | undefined): string {
  return v === null || v === undefined ? "-" : String(Math.round(v));
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)]!;
}

// CJK以降を幅2として列を揃える（→や…は多くの端末で幅1）
function width(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0)! >= 0x2e80 ? 2 : 1;
  return w;
}

function printTable(header: string[], rows: string[][], alignRight: boolean[]): void {
  const widths = header.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ""))));
  const pad = (s: string, i: number) => {
    const fill = " ".repeat(widths[i]! - width(s));
    return alignRight[i] ? fill + s : s + fill;
  };
  // 最終列（transcript等）は右側を埋めない
  const render = (cells: string[]) =>
    cells.map((c, i) => (i === cells.length - 1 && !alignRight[i] ? c : pad(c, i))).join("  ");
  console.log(render(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(render(row));
}
