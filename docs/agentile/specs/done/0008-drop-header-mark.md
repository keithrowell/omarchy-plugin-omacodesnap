---
title: Drop the Omarchy maze mark from the snap header
slug: drop-header-mark
status: shipped
depends_on: []
type: feature
route: foreground
business_value: medium
technical_certainty: high
created: 2026-09-07
outcome: a fresh live snap shows a plain two-line header (title, source/language) with no icon of any kind top-left; every gallery image and the README hero match
claimed_by:
label:
claimed_at:
shipped_at: 2026-09-07T21:25:30Z
---

# Drop the Omarchy maze mark from the snap header

## Problem / why now

Keith's call, see ADR-0008 for the full reasoning: the small Omarchy maze
glyph in the header (spec 0001's compromise between a full wordmark and no
mark at all) doesn't match how Omarchy's own icon-plus-title pattern
(`PanelHero`) is actually used elsewhere — every stock panel puts *its
own* icon there, never the platform's mark — and the branding system
itself reserves the maze mark for full-canvas surfaces (boot unlock,
screensaver, About), never a per-window badge. The frame is already
unmistakably Omarchy through the theme, the wallpaper, and the live
Hyprland border/corners; the mark is redundant on top of that.

## Acceptance criteria

- [x] `app/Snap.qml`'s header shows only the two-line title/subtitle,
      left-aligned at the header's own left padding — no glyph, no
      fallback image, no reserved icon space.
- [x] The glyph machinery is removed, not hidden: `iconFontPath`,
      `mazeGlyph`, `headerGlyphFactor`, `glyphSize`, the `iconFont`
      `FontLoader`, the glyph `Text`, the fallback `Image`, its
      `ColorOverlay`, and the `ready` property's wait on `iconFont.status`.
- [x] The now-unused `Qt5Compat.GraphicalEffects` import is removed.
- [x] Every gallery image (`docs/gallery/0*.png`) and the README hero
      (`docs/hero.png`) are regenerated the same way `docs/gallery/
      SOURCES.md` documents — same code, same themes, no other change —
      and show the new plain header.
- [x] `docs/gallery/SOURCES.md` and any other doc describing the header
      (top-of-file comment in `Snap.qml`) are updated; the shipped spec
      0001 and 0004 records are left as historical record, not rewritten.
- [x] All tests pass; a live snap (real selection, real binding) confirms
      the change outside the fixture path too.

## Scope boundary

**In scope:** `app/Snap.qml`'s header rendering and the constants that
size it; regenerating every rendered gallery/hero image; `docs/gallery/
SOURCES.md`; ADR-0008 (already written).

**Out of scope:** any settings/toggle to bring the mark back — this is a
straight removal, matching the project's existing "no configuration
surface" stance. The rest of the frame (border, corners, gaps, wallpaper,
no wordmark) is untouched. No change to highlighting, editors, or
language detection.

## Edge cases and failure paths

- `frame.ready` currently waits on `iconFont.status !== FontLoader.Loading`
  before `Overlay.qml` shows the window — dropping the font loader means
  dropping that clause too, not leaving a dangling reference.
- No JS/unit test currently asserts glyph geometry (it's QML-only,
  unverified by `node --test`), so no test file needs editing beyond a
  visual/manual check of the regenerated images.

## Affected areas

`app/Snap.qml`, `docs/adr/0008-drop-header-mark.md` (done), `docs/gallery/
SOURCES.md`, `docs/gallery/*.png`, `docs/hero.png`.

## Open questions

None.

## Verification

- `node --test tests/*.test.mjs` green (no test targets the glyph, so this
  only confirms nothing else broke).
- Every regenerated PNG opened and checked: no icon, title flush left,
  everything else (border, corners, wallpaper, colours) unchanged from a
  same-theme render before this spec.
- A live snap via the real binding, screenshotted, confirms the change
  outside the fixture/gallery path.
