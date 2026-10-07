import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonLineParser } from "./jsonl.ts";

function parseAll(deltas: string[]): Record<string, unknown>[] {
  const parser = new JsonLineParser();
  return [...deltas.flatMap((d) => parser.push(d)), ...parser.end()];
}

test("行が複数の delta に分かれる", () => {
  const text = '{"ja": "会心の一撃"}\r\n{"en": "Critical hit"}\n';
  const parser = new JsonLineParser();
  const got: Record<string, unknown>[][] = [...text].map((c) => parser.push(c));
  // 各行は改行を受けた時点で1回だけ返る
  assert.deepEqual(
    got.flatMap((r, i) => r.map((obj) => ({ i, obj }))),
    [
      { i: text.indexOf("\n"), obj: { ja: "会心の一撃" } },
      { i: text.length - 1, obj: { en: "Critical hit" } },
    ],
  );
  assert.deepEqual(parser.end(), []);
});

test("1つのdeltaの複数のJSON行をすべて返し、コードフェンスは無視する", () => {
  const parser = new JsonLineParser();
  assert.deepEqual(parser.push('```json\n{"ja": "あ"}\n{"en": "A"}\n```\n'), [{ ja: "あ" }, { en: "A" }]);
  assert.deepEqual(parser.end(), []);
});

test("JSONでない行・オブジェクトでないJSON・空行は無視する", () => {
  const text = ['\n', '  {"ja": "あ"}  \n', '{"ja": \n', '[1, 2]\n', 'null\n', '42\n', '{"en": "A"}\n'];
  assert.deepEqual(parseAll(text), [{ ja: "あ" }, { en: "A" }]);
});

test("末尾に改行が無い行は end() で取れ、バッファは空になる", () => {
  const parser = new JsonLineParser();
  assert.deepEqual(parser.push('{"ja": "あ"}\n{"en": '), [{ ja: "あ" }]);
  assert.deepEqual(parser.push('"A"}'), []);
  assert.deepEqual(parser.end(), [{ en: "A" }]);
  assert.deepEqual(parser.end(), []);
});

test("end() の残りが壊れていても例外を投げない", () => {
  const parser = new JsonLineParser();
  parser.push('{"ja": "あ');
  assert.deepEqual(parser.end(), []);
});
