// Reflows already-resolved, tab-expanded line spans (see `lib/input.mjs`'s
// `resolveSpans`) to a fixed character width, splitting a line's span array
// wherever it crosses the wrap column and preserving each span's own
// colour/style across the break — never re-highlighting, never touching
// text content.
//
// Character-based hard wrap, not word-wrap: the frame renders every
// character at the same fixed advance regardless of what word it belongs
// to, so a mid-word break reads no worse than any other column, and a
// word-boundary search would still have to hard-break an unbroken run
// longer than `width` on its own anyway (a long identifier, a URL in a
// comment). Simpler, and exactly what "wrap at N chars" means literally.
//
// Pure ES module: no I/O, no Qt.

/**
 * Reflow one line's spans into one or more rows of at most `width`
 * characters each. A line already within `width` (including an empty
 * line — its sole empty-text span is never split) is returned unchanged,
 * as `[spans]`. `width <= 0` or non-finite disables wrapping (also
 * `[spans]`) rather than looping forever.
 */
export function wrapLine(spans, width) {
  if (!Number.isFinite(width) || width <= 0) return [spans];

  const lineLength = spans.reduce((n, span) => n + span.text.length, 0);
  if (lineLength <= width) return [spans];

  const rows = [];
  let row = [];
  let rowLength = 0;
  for (const span of spans) {
    let text = span.text;
    while (text.length > 0) {
      const room = width - rowLength;
      if (room <= 0) {
        rows.push(row);
        row = [];
        rowLength = 0;
        continue;
      }
      const chunk = text.slice(0, room);
      row.push({ text: chunk, color: span.color, fontStyle: span.fontStyle, fontWeight: span.fontWeight });
      rowLength += chunk.length;
      text = text.slice(chunk.length);
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
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
