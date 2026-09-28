// Reflows already-resolved, tab-expanded line spans (see `lib/input.mjs`'s
// `resolveSpans`) to a fixed character width, splitting a line's span array
// at the chosen break points and preserving each span's own colour/style
// across the break — never re-highlighting, never touching text content.
//
// Word wrap: a row breaks at the last word boundary that fits.
// - At whitespace, the whitespace run itself is dropped at the break, so no
//   row ends in trailing blanks and no continuation row starts with them.
//   A line's own leading indentation is never a break point.
// - At a hyphen joining two word characters ("Donau-Dampfschiff"), the
//   hyphen stays at the end of the row that did not wrap, German style,
//   and the next row starts with the rest of the word.
// - A word longer than the whole width (a long identifier, a URL in a
//   comment) has no boundary to use, so it hard-breaks at exactly `width`.
//
// Pure ES module: no I/O, no Qt.

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const WHITESPACE = /\s/;

/**
 * The break points for one line of plain text: an array of `[start, end)`
 * ranges, one per row, each at most `width` characters long.
 */
export function breakText(text, width) {
  const rows = [];
  let start = 0;
  while (text.length - start > width) {
    const limit = start + width; // the first index that does not fit
    let rowEnd = -1;
    let nextStart = -1;

    // Whitespace: a run that begins after this row's start and no later
    // than `limit` (a run starting exactly at `limit` means the row's
    // `width` characters fit and the next word starts after the run).
    for (let i = start + 1; i <= limit; i++) {
      if (WHITESPACE.test(text[i]) && !WHITESPACE.test(text[i - 1])) {
        let j = i;
        while (j < text.length && WHITESPACE.test(text[j])) j++;
        rowEnd = i;
        nextStart = j;
      }
    }

    // Hyphen inside a word: break after it, if that fits better.
    for (let k = start + 1; k < limit; k++) {
      if (text[k] === "-" && WORD_CHAR.test(text[k - 1]) && k + 1 < text.length && WORD_CHAR.test(text[k + 1])) {
        if (k + 1 > rowEnd) {
          rowEnd = k + 1;
          nextStart = k + 1;
        }
      }
    }

    if (rowEnd === -1) {
      rowEnd = limit;
      nextStart = limit;
    }
    rows.push([start, rowEnd]);
    start = nextStart;
  }
  if (start < text.length) rows.push([start, text.length]);
  return rows;
}

/** The part of `spans` covering characters `[start, end)` of their joined text. */
function sliceSpans(spans, start, end) {
  const out = [];
  let offset = 0;
  for (const span of spans) {
    const spanStart = offset;
    const spanEnd = offset + span.text.length;
    offset = spanEnd;
    const from = Math.max(start, spanStart);
    const to = Math.min(end, spanEnd);
    if (to <= from) continue;
    out.push({ text: span.text.slice(from - spanStart, to - spanStart), color: span.color, fontStyle: span.fontStyle, fontWeight: span.fontWeight });
  }
  return out;
}

/**
 * Reflow one line's spans into one or more rows of at most `width`
 * characters each. A line already within `width` (including an empty
 * line — its sole empty-text span is never split) is returned unchanged,
 * as `[spans]`. `width <= 0` or non-finite disables wrapping (also
 * `[spans]`) rather than looping forever.
 */
export function wrapLine(spans, width) {
  if (!Number.isFinite(width) || width <= 0) return [spans];

  const text = spans.map((span) => span.text).join("");
  if (text.length <= width) return [spans];

  return breakText(text, width).map(([start, end]) => sliceSpans(spans, start, end));
}

/**
 * Reflow every line in `lines` (an array of resolved span-arrays) at
 * `width` characters. Returns `{ lines, lineNumbers }`: `lines` has one
 * entry per *rendered* row — more than `lines.length` when any source line
 * wrapped — and `lineNumbers` is the same length, holding each row's
 * 1-based source line number on the first row of each source line and
 * `null` on every continuation row (the renderer's gutter leaves those
 * blank, the conventional soft-wrap treatment).
 */
export function wrapLines(lines, width) {
  const outLines = [];
  const lineNumbers = [];
  lines.forEach((spans, i) => {
    const rows = wrapLine(spans, width);
    rows.forEach((row, j) => {
      outLines.push(row);
      lineNumbers.push(j === 0 ? i + 1 : null);
    });
  });
  return { lines: outLines, lineNumbers };
}
