import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapLine, wrapLines } from "../lib/wrap.mjs";

function span(text, color = "#fff") {
  return { text, color, fontStyle: null, fontWeight: null };
}

// --- wrapLine ----------------------------------------------------------------

test("wrapLine: a line within width is returned unchanged, as the one row", () => {
  const spans = [span("const x = 1;")];
  assert.deepEqual(wrapLine(spans, 80), [spans]);
});

test("wrapLine: an empty line's sole empty-text span is never split", () => {
  const spans = [span("")];
  assert.deepEqual(wrapLine(spans, 80), [spans]);
});

test("wrapLine: width <= 0 or non-finite disables wrapping (never loops)", () => {
  const spans = [span("a".repeat(200))];
  assert.deepEqual(wrapLine(spans, 0), [spans]);
  assert.deepEqual(wrapLine(spans, -5), [spans]);
  assert.deepEqual(wrapLine(spans, NaN), [spans]);
  assert.deepEqual(wrapLine(spans, Infinity), [spans]);
});

test("wrapLine: a single span longer than width hard-breaks at exactly width characters per row", () => {
  const spans = [span("a".repeat(25))];
  const rows = wrapLine(spans, 10);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.map((s) => s.text).join("")), ["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
});

test("wrapLine: a break inside a multi-span line splits the crossing span, keeping each half's own colour", () => {
  // "function " (9, blue) + "hi" (2, green) at width 10: the break falls
  // one character into the second span.
  const spans = [span("function ", "#00f"), span("hi", "#0f0")];
  const rows = wrapLine(spans, 10);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], [span("function ", "#00f"), span("h", "#0f0")]);
  assert.deepEqual(rows[1], [span("i", "#0f0")]);
  // Round-trips: every character survives the split, none duplicated.
  assert.equal(rows.flat().map((s) => s.text).join(""), spans.map((s) => s.text).join(""));
});

test("wrapLine: a break landing exactly on a span boundary needs no split", () => {
  const spans = [span("aaaaa", "#00f"), span("bbbbb", "#0f0")];
  const rows = wrapLine(spans, 5);
  assert.deepEqual(rows, [[span("aaaaa", "#00f")], [span("bbbbb", "#0f0")]]);
});

test("wrapLine: fontStyle/fontWeight survive a split along with colour", () => {
  const spans = [{ text: "abcdefghij", color: "#fff", fontStyle: "italic", fontWeight: 700 }];
  const rows = wrapLine(spans, 4);
  for (const row of rows) {
    for (const s of row) {
      assert.equal(s.fontStyle, "italic");
      assert.equal(s.fontWeight, 700);
    }
  }
});

// --- wrapLines -----------------------------------------------------------------

test("wrapLines: unwrapped lines get sequential 1-based line numbers, one row each", () => {
  const lines = [[span("a")], [span("b")], [span("c")]];
  const { lines: outLines, lineNumbers } = wrapLines(lines, 80);
  assert.equal(outLines.length, 3);
  assert.deepEqual(lineNumbers, [1, 2, 3]);
});

test("wrapLines: a wrapped line's continuation rows get null, later lines keep their real number", () => {
  const lines = [[span("a".repeat(25))], [span("short")]];
  const { lines: outLines, lineNumbers } = wrapLines(lines, 10);
  // Line 1 (25 chars, width 10) wraps to 3 rows; line 2 stays 1 row.
  assert.equal(outLines.length, 4);
  assert.deepEqual(lineNumbers, [1, null, null, 2]);
});

test("wrapLines: every row's text, concatenated back per source line, reproduces the original line", () => {
  const lines = [[span("the quick brown fox jumps over")], [span("x")]];
  const { lines: outLines, lineNumbers } = wrapLines(lines, 8);
  let rebuilt = "";
  const bySourceLine = new Map();
  outLines.forEach((row, i) => {
    const n = lineNumbers[i] ?? [...bySourceLine.keys()].pop();
    bySourceLine.set(n, (bySourceLine.get(n) ?? "") + row.map((s) => s.text).join(""));
  });
  assert.equal(bySourceLine.get(1), "the quick brown fox jumps over");
  assert.equal(bySourceLine.get(2), "x");
});
