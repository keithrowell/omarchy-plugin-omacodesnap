# Gallery sources

| Image | Code | Theme |
|---|---|---|
| `../hero.png` (README) | `commonIndent`/`sharedPrefix` from OmaCodeSnap's own `lib/indent.mjs` — JavaScript, snapped as from Zed | Gruvbox (dark) |
| `01-ruby-push-kanagawa.png` | A realtime push demo, cut down from DaisyStack's own — Ruby | Kanagawa |
| `02-go-ristretto.png` | A bounded worker pool — Go | Ristretto |
| `03-rust-catppuccin.png` | `sigmoid`/`softmax` — Rust | Catppuccin |
| `04-ruby-quotes-rose-pine.png` | Quotes on why Ruby is beautiful — plain text, no editor | Rosé Pine (light) |
| `05-fortran77-nord.png` | Trapezoidal-rule integration — Fortran 77 | Nord |
| `06-delphi-everforest.png` | A small stack class — Delphi (Object Pascal) | Everforest |
| `07-vax-macro32-osaka-jade.png` | A greeting routine — VAX MACRO-32 | Osaka Jade |
| `08-6809-asm-retro82.png` | A clear-screen routine, in the style of the Hitachi Basic Master — 6809 assembly | Retro 82 |

## Code provenance

- **The push demo** (Ruby) is a cut-down version of `LiveRating`, from Keith
  Rowell's DaisyStack project (private repo; MIT licensed) — the same short
  form DaisyStack's own docs use to show `ds_push`: subscribe once, a
  component listens, the server emits with `DaisyStack::Push.emit`.
- **The worker pool** (Go) and **`sigmoid`/`softmax`** (Rust) were written
  for this gallery; the Rust is adapted from a forward-pass building block
  in Keith Rowell's `neural_network` project.
- **The Ruby quotes**: three real, attributed quotes on why Ruby is
  considered beautiful — Yukihiro "Matz" Matsumoto (Ruby's creator) on
  designing for programmer happiness and on Ruby's simple-looking,
  intricate design; David Heinemeier Hansson on Ruby as "the most
  beautiful, poetic, and productive programming language"; and MINASWAN
  ("Matz is nice and so we are nice"), the community's own motto.
- **Fortran 77, Delphi, VAX MACRO-32, 6809 assembly**: short, idiomatic
  examples written for this gallery — real syntax, not lifted from any
  specific archive. The VAX and 6809 examples reflect real hardware (a
  1980s DEC minicomputer; the Hitachi Basic Master, a 1980 Japanese home
  computer built around the 6809), but the exact bytes are illustrative,
  not transcribed from a manual.

## How the last four are coloured

OmaCodeSnap has no tree-sitter grammar for Fortran, Delphi, VAX assembly, or
6809 assembly — realistically, it may never need one; these exist to show
the frame works for anything, not to promise real support for them. Their
spans were hand-tokenized (`docs/gallery/hand-tokenize.mjs`, a small regex
lexer that exists only for this gallery) and coloured through the theme's
own syntax map, the same `zedSyntaxStyle` lookup a real grammar result goes
through. Every colour is still theme-accurate; only the decision of *which
word gets which capture* was made by hand instead of by a parser.

## Theme provenance

**Kanagawa**, **Ristretto**, **Nord**, **Everforest**, and **Retro 82** are
stock Omarchy themes with no `zed-theme.json` of their own — OmaCodeSnap's
`readTheme()` synthesizes one from each theme's `colors.toml`
(`synthesizeZedTheme` in `lib/theme.mjs`; see "Where the colours come from"
in the README), the same mechanism live on every install, not a
gallery-only trick. **Catppuccin** and **Rosé Pine** are stock themes
too, coloured the same way. **Osaka Jade** is one of Keith's own themes,
with a bespoke `zed-theme.json`.

## Reproducing a render

```
node docs/gallery/render.mjs
```

regenerates all eight images (and their fixture JSONs, for inspection) in
place from the source under `docs/gallery/code/`, through the real,
unmodified `bin/omacodesnap --fixture` path for each — the same margin and
padding floors `app/Snap.qml` applies to any snap, on any Hyprland setup,
including one (like this machine's) with `gaps_out` at 0. Only the theme
and wallpaper differ per image, both through the CLI's own `--theme-dir`
and `--wallpaper` flags — nothing gallery-only is involved in the frame
itself. Pass `--out-dir DIR` to render elsewhere instead of overwriting
the committed images. The raw renders are then scaled to a uniform 1400px
width (`magick <file> -resize 1400x`) before committing — the only
gallery-only step, purely cosmetic (a consistent table), applied after
every image is already a faithful render.

Osaka Jade's image needs `~/.config/omarchy/themes/osaka-jade/zed-theme.json`
(Keith's own bespoke Zed theme for it — see "Theme provenance" above); on a
machine without it, that one image still renders, just via the
synthesized-from-`colors.toml` fallback every theme without a real Zed
theme gets, not the exact original.
