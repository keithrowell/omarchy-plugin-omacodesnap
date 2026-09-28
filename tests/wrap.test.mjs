import { test } from "node:test";
import assert from "node:assert/strict";
import { breakText, wrapLine, wrapLines } from "../lib/wrap.mjs";

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

test("wrapLine: a word-boundary break drops the space and keeps each span's own colour", () => {
  // "function " (9, blue) + "hi" (2, green) at width 10: the space is the
  // last boundary that fits, so the row ends before it and "hi" moves down.
  const spans = [span("function ", "#00f"), span("hi", "#0f0")];
  const rows = wrapLine(spans, 10);
  assert.deepEqual(rows, [[span("function", "#00f")], [span("hi", "#0f0")]]);
});

test("wrapLine: a break inside a span splits it, both halves keeping its colour", () => {
  const spans = [span("# the quick brown", "#888")];
  const rows = wrapLine(spans, 12);
  assert.deepEqual(rows, [[span("# the quick", "#888")], [span("brown", "#888")]]);
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

test("wrapLines: rows rejoined with the dropped spaces reproduce each source line", () => {
  const lines = [[span("the quick brown fox jumps over")], [span("x")]];
  const { lines: outLines, lineNumbers } = wrapLines(lines, 8);
  const rows = outLines.map((row) => row.map((s) => s.text).join(""));
  assert.deepEqual(rows, ["the", "quick", "brown", "fox", "jumps", "over", "x"]);
  assert.deepEqual(lineNumbers, [1, null, null, null, null, null, 2]);
});

// --- breakText: where rows break -----------------------------------------------

function rowsOf(text, width) {
  return breakText(text, width).map(([a, b]) => text.slice(a, b));
}

test("breakText: breaks at the last space that fits, never mid-word", () => {
  assert.deepEqual(rowsOf("return someValue + otherValue;", 20), ["return someValue +", "otherValue;"]);
});

test("breakText: a word that ends exactly at the width is kept whole", () => {
  assert.deepEqual(rowsOf("abcde fghij", 5), ["abcde", "fghij"]);
});

test("breakText: a run of several spaces at the break is dropped entirely", () => {
  assert.deepEqual(rowsOf("alpha     beta", 7), ["alpha", "beta"]);
});

test("breakText: a hyphen joining two words stays at the end of the row that did not wrap", () => {
  assert.deepEqual(rowsOf("die Donau-Dampfschifffahrt", 16), ["die Donau-", "Dampfschifffahrt"]);
});

test("breakText: the later of a space and a hyphen wins", () => {
  // The hyphen in "well-known" comes after the space before it.
  assert.deepEqual(rowsOf("a well-known fact", 10), ["a well-", "known fact"]);
});

test("breakText: a hyphen not between two word characters is not a break point", () => {
  // In "--verbose-flag" only the last hyphen joins two word characters;
  // in "x - y" the hyphen stands alone, so the spaces are the boundaries.
  assert.deepEqual(rowsOf("run --verbose-flag now", 14), ["run --verbose-", "flag now"]);
  assert.deepEqual(rowsOf("total = x - y", 11), ["total = x -", "y"]);
});

test("breakText: a word longer than the width hard-breaks at exactly the width", () => {
  assert.deepEqual(rowsOf("go https://example.com/a/very/long/path", 12), ["go", "https://exam", "ple.com/a/ve", "ry/long/path"]);
});

test("breakText: the line's own leading indentation is never a break point", () => {
  assert.deepEqual(rowsOf("    return aVeryLongName", 16), ["    return", "aVeryLongName"]);
});

test("breakText: trailing whitespace past the width adds no empty row", () => {
  assert.deepEqual(rowsOf("abc" + " ".repeat(20), 10), ["abc"]);
});

test("breakText: non-ASCII letters count as word characters for the hyphen rule", () => {
  assert.deepEqual(rowsOf("Größen-Übersicht", 10), ["Größen-", "Übersicht"]);
});
