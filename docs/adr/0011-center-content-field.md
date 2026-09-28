---
number: 0011
title: Optional centerContent fixture field
status: accepted
date: 2026-09-11
---

# ADR-0011: Optional centerContent fixture field

## Status

Accepted.

## Context

ADR-0009 gave OmaWordl `compact`/`showGutter`/`subtitle` so its share image
(a small Wordle-style tile grid under a title/subtitle) could reuse
Omasnap's renderer instead of building a second one. `compact` sizes the
canvas to `Math.max(codeContentWidth, headerTextWidth)` — for OmaWordl's
short grid rows under a longer title ("OmaWordl #2"), the header text is
usually the wider of the two, so the canvas ends up wider than the grid.
The grid renders like ordinary code — left-aligned within the code
column — so it sits flush left with empty space to its right instead of
appearing centred under the title, which is what OmaWordl actually wants.

## Decision

Add one more optional fixture field, in the same style as ADR-0009's
three, defaulting to today's exact behaviour when absent:

- **`centerContent: boolean`** (default `false`) — `true` centres each
  line's own rendered width within the code column's available width
  (`app/Snap.qml`'s `codeColumn.width`, already net of `padding` and
  `gutterWidth` however `showGutter`/`compact` computed them) instead of
  rendering it flush left at `x: 0`.

`buildFrame()` already measures each line's final (post-clip) width with
`measureWidth` to track the longest line for sizing; this reuses that same
per-line width (`lineWidths`, one new array alongside `lines` in the
returned frame) rather than re-measuring in QML. Each code-line delegate's
`Row` picks up one line: `x: frame.centerContent ? Math.max(0, (parent.width - frame.lineWidths[index]) / 2) : 0`
(guarded for the padded blank lines beyond the fixture's own content in
non-compact mode, which have no measured width and render nothing anyway).

Because the offset is computed from `codeColumn`'s own already-resolved
width rather than from `compact`/`showGutter`'s inputs directly, centring
is orthogonal to both: it works the same whether the gutter is shown or
hidden and whether the canvas floors are the desktop-window ones or
`compact`'s content-sized ones.

## Consequences

- OmaWordl's share fixture can now add `centerContent: true` alongside its
  existing `compact`/`showGutter: false`/`subtitle` fields and get a
  genuinely centred tile grid, still through the one
  `bin/omasnap --fixture`/`Snap.qml` render path every other snap uses.
- `tests/fixtures/render/hello.json` (unmodified, `centerContent` absent)
  renders pixel-identical before and after — verified by rendering both on
  the base commit and after this change, same logical/device dimensions
  both times, and an ImageMagick `compare -metric AE` diff of ~0 (sub-pixel
  noise only).
- A hand-built OmaWordl-shaped fixture (`compact: true`, `showGutter:
  false`, `centerContent: true`, `filename: "OmaWordl #2"`, `subtitle:
  "Solved 3/6"`, three short block-character lines) was rendered and
  visually confirmed centred under the header; the same fixture with
  `centerContent` removed reproduced today's exact flush-left placement —
  same canvas dimensions either way, since centring only changes each
  line's `x`, never the frame's sizing.
- `validateFixture` grew one more optional-field check, in the same style
  as `showGutter`/`compact`. No automated PNG/pixel test exists for this
  suite (the same gap ADR-0009 documented) — this was verified by the
  manual render above, not a new automated check.
- Purely cosmetic/layout: no new execution or trust surface, unlike
  ADR-0010's provider protocol — this only changes where a `Text`'s `Row`
  sits horizontally.
