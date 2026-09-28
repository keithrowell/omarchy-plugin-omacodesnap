---
number: 0009
title: Optional subtitle, showGutter and compact fixture fields
status: accepted
date: 2026-09-10
---

# ADR-0009: Optional subtitle, showGutter and compact fixture fields

## Status

Accepted.

## Context

OmaWordl, a sibling Omarchy plugin (a daily word-game app), wants to reuse
Omasnap's rendering pipeline — the themed, Hyprland-accurate frame over a
sharp wallpaper — for its own share image, instead of building a second
renderer from scratch. Its content is nothing like a code snippet: a
handful of short lines of coloured block characters (a Wordle-style guess
grid), under a title and caption it wants to write itself ("OmaWordl 1
3/6", "OmaWordl 1"), not a filename/language pair.

Three things in the existing renderer assumed "this is a code editor
snap" too tightly for that:

- The subtitle badge (`app/Snap.qml`'s `buildFrame()`) is always
  `"EDITOR · LANGUAGE"`, forced uppercase, derived from `snap.editor` and
  `snap.language`. There was no way to say something else.
- The gutter (line-number column) always renders and always reserves its
  width in the layout, which makes sense for code but is dead space next
  to a five-character Wordle row.
- The canvas has a `minWidth` (480px) and `minLines` (3) floor, plus
  outer/inner margins derived from Hyprland's `gaps_out` (roughly 130px of
  extra margin around the frame at font size 32). These exist so a normal
  code snap reads as a real desktop window, not a cropped fragment — but
  for OmaWordl's small, fixed-shape content they produced a tiny frame
  adrift in a mostly-empty canvas.

The brief for this work was explicit that none of this could come at the
cost of the existing behaviour: every Zed/VS Code/Neovim fixture already
rendered must produce a pixel-identical image when none of the new fields
are set. OmaWordl is a separate repository — it cannot share code with
Omasnap directly, only fixture JSON through `bin/omasnap --fixture`.

## Decision

Add three fixture fields, all optional, each defaulting to today's exact
behaviour when absent (`lib/input.mjs`'s `validateFixture` and
`buildInput` now know about them; `app/Snap.qml`'s `buildFrame()` reads
them off `input.snap`):

- **`subtitle: string | null`** — when present, used verbatim as the
  header's second line, replacing the auto-built `"EDITOR · LANGUAGE"`
  badge entirely (no uppercasing, no derivation). Absent or `null` keeps
  today's badge.
- **`showGutter: boolean`** (default `true`) — `false` removes the gutter
  column and its reserved width from the layout; the code area starts
  immediately after the frame's own padding, as if the gutter never
  existed, rather than being hidden behind a blank strip.
- **`compact: boolean`** (default `false`) — `true` drops the
  `minWidth`/`minLines` floors and the Hyprland-gap-derived margins,
  replacing them with small, fixed factors (`compactPaddingFactor`,
  `compactOuterMarginFactor`) so the frame sizes to its actual content.
  `maxWidth` still applies either way — this only removes the *floors*.

One thing surfaced while wiring `compact` up that is worth recording:
dropping `minWidth` means the canvas can end up narrower than the header
text itself (a five-character-wide content block under a real title like
"OmaWordl 1 3/6" — exactly OmaWordl's own case), which silently truncated
the title. `buildFrame()` now measures the title/subtitle's own rendered
width (accounting for the header text's bold weight and, for the
subtitle, its letter-spacing — plain `TextMetrics` without those
under-measures both) and folds that into `compact`'s width floor, with a
small scaled safety margin (`headerTextSafetyFactor`) covering the
residual gap between `TextMetrics` and the font's actual rendered advance
for a full string. This only runs when `compact` is set, so it cannot
affect non-compact rendering.

All three fields are independent — a caller can set any subset, and
`showGutter`/`compact` compose (OmaWordl's own fixture sets all three
together, but a code-focused fixture could use just one).

## Consequences

- OmaWordl's share fixture (`filename`, `subtitle`, `showGutter: false`,
  `compact: true`, plus the usual `editor`/`font`/`lines`) renders a tight,
  themed, gutter-free frame with its own chrome, using the exact same
  `bin/omasnap --fixture`/`Snap.qml` path every other snap uses — no
  second renderer, no fork.
- Every existing fixture (`tests/fixtures/render/hello.json`,
  `tests/fixtures/render/long.json`, and by extension every real
  Zed/VS Code/Neovim snap, none of which set these fields) is confirmed
  pixel-identical before and after this change — verified by rendering
  both fixtures on the base commit and after, same logical/device
  dimensions both times.
- `validateFixture` grew three more optional-field checks, in the same
  style as `capture`/`fontStyle`/`fontWeight` — accept `undefined`, accept
  the correct type, reject anything else with a named `TypeError`-shaped
  message.
- `buildFrame()` picked up a second, `compact`-only width contributor
  (the measured header text) alongside the code-lines contributor it
  already had; this is a real increase in what "content" means for sizing
  purposes, scoped tightly enough (behind `compact`) that it cannot regress
  the non-compact path it was built to leave alone.
- If a third caller ever wants the gutter suppressed but the floors kept
  (or vice versa), `showGutter` and `compact` already compose independently
  today, so no further change should be needed there.
