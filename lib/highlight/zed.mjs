// Zed highlighter: tree-sitter parsing + Zed's own `highlights.scm` queries,
// coloured from the Zed Omarchy theme's `syntax` map.
//
// Engine: the `tree-sitter` CLI's `query` subcommand
// (`tree-sitter query --lib-path <grammar>.so --lang-name <grammar> -c
// <highlights.scm> <file>`), against grammars vendored and compiled per
// `docs/adr/0002-grammar-sourcing.md`. The spike (spec 0002's findings.md,
// Q7) measured ~86 ms median for a 57-line JS file including process
// start — comfortably under the 200 ms target — and the CLI applies Zed's
// query predicates (`#match?`, `#eq?`, `#any-of?`) unmodified, so no Node
// binding or WASM build is needed. The CLI's own scope-discovery/config
// mechanism is never used (it cannot adopt a prebuilt `.so` with no
// registered parser directory, per the spike) — every call passes
// `--lib-path`/`--lang-name` explicitly.
//
// Capture precedence: this module implements "smallest range wins, last
// pattern wins on a tie" — process captures smallest-range-first, each
// claiming the (byte) positions in its range that no smaller capture has
// already claimed. This gives:
// (a) a capture strictly inside another's range overrides it within its own
//     sub-range ("inner wins"), because it is smaller and therefore claims
//     first;
// (b) two captures on the exact same node (same start/end — Zed does this
//     deliberately, e.g. a generic `(identifier) @variable` fires on every
//     identifier, and a later, more specific pattern re-captures the same
//     node as `@function`/`@function.method`/`@function.builtin`/
//     `@constructor`) are the same size, so ties are broken by pattern
//     order — the *later*-declared pattern wins.
//
// The plan this module was built from asked for "first pattern wins" as
// the default, to be flipped to "last pattern wins" if a live side-by-side
// against Zed showed it disagreed. That screenshot-based check could not be
// completed during this build (the desktop locked mid-session, before a
// comparison screenshot was captured — see side-by-side.md) — but the
// choice was still made here, on strong, inspectable, non-visual evidence
// instead: Zed's own `javascript` and `python` highlights.scm both, and
// consistently, declare a generic capture first (`@variable`, `@property`)
// and a specific override later on the exact same node kind
// (`@function`/`@function.method` for a call's callee, `@function.builtin`
// for a builtin call, `@function.definition`/`@constructor` for a
// definition's name) — e.g. `console.log`'s `log` is `@property` *and*
// `@function.method` on the same node; Python's `print(...)` is
// `@variable`, `@function.call` *and* `@function.builtin` on the same node.
// A first-pattern-wins reading makes every one of these resolve to the
// generic, less meaningful capture (`variable`/`property`), which is the
// opposite of what an editor's own theme conventions are for — themes
// colour `function`/`function.builtin` distinctly from `variable`/
// `property` specifically so a call site reads differently from a plain
// name. This is also the documented behaviour of the `tree-sitter-highlight`
// crate itself (which Zed uses): later-declared patterns take priority over
// earlier ones for the same node, which is *why* every Zed/Neovim/Helix
// query file in the wild is written with generic catch-alls first and
// specific refinements after. Confirming this against an actual rendered
// Zed window remains outstanding — flagged for the reviewer/ship stage, not
// resolved here.
//
// Injections are not implemented: a capture is resolved with exactly the
// grammar/query pair `lib/language.mjs`'s `LANGUAGES` names for the
// detected language, with no sub-language parsing inside embedded regions.
// Concretely this means: no colouring inside JS/TS template-literal
// CSS/HTML, no colouring inside Markdown fenced code blocks or Markdown's
// inline emphasis (Markdown here is highlighted with the *block* grammar's
// captures only — headings, code fences and list markers still colour;
// emphasis/links/inline code do not), and a regex literal's *body* is not
// re-highlighted as a separate regex grammar. Zed's LSP-driven semantic
// highlighting (identifier-specific colouring layered on top of
// tree-sitter) is out of scope entirely (SPEC.md).
//
// Unresolved captures never paint: if a capture's name has no entry
// anywhere in `theme.zed.syntax`'s dotted-fallback chain (not even a
// generic prefix), it is excluded before the "smallest range wins" pass
// runs at all — exactly as if it had never fired. This mirrors Zed's own
// `HighlightMap::get` returning `None` for an unmapped capture: nothing is
// pushed, so whatever was already active (an enclosing capture, or plain
// text) keeps showing through. Without this, an obscure or theme-specific
// capture with no colour of its own (some predicate-only captures, or a
// capture only some themes define) could still "win" a sub-range purely by
// being the smallest range there, incorrectly resetting it to the plain
// editor foreground instead of leaving an enclosing capture's real colour
// in place.
//
// Pure ES module otherwise: no Qt, no caching. The only subprocess this
// module runs is the fixed-argv `tree-sitter query` above; the text being
// highlighted is written to a 0600 temp file (never passed on argv or to a
// shell) and removed in `finally`.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zedSyntaxStyle } from "../theme.mjs";
import { LANGUAGES } from "../language.mjs";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(MODULE_DIR, "..", "..");

const CAPTURE_HEADER_RE =
  /pattern:\s*(\d+),\s*capture:\s*\d+\s*-\s*([\w.]+),\s*start:\s*\((\d+),\s*(\d+)\),\s*end:\s*\((\d+),\s*(\d+)\)/g;
const TEXT_FIELD_RE = /^,\s*text:\s*`/;

function clamp(value, lo, hi) {
  return Math.min(Math.max(value, lo), hi);
}

/** Map each UTF-8 byte offset in `line` that lands on a code-point boundary to its UTF-16 string index. */
function byteToCharMap(line) {
  const map = [0];
  let byteIndex = 0;
  let charIndex = 0;
  for (const ch of line) {
    byteIndex += Buffer.byteLength(ch, "utf8");
    charIndex += ch.length;
    map[byteIndex] = charIndex;
  }
  return map;
}

/**
 * Precompute, once per `text`, everything both `parseQueryOutput` (with a
 * `text` argument) and `spansFromCaptures` need to convert a `(row,
 * byte-column)` position into an absolute offset: per-line byte length,
 * per-line UTF-16 char length, and the running byte/char offset of each
 * line's start (each line counted as ending in one `\n`, matching how
 * tree-sitter itself advances `row`).
 */
function buildLineIndex(text) {
  const lines = String(text ?? "").split("\n");
  const byteLens = lines.map((line) => Buffer.byteLength(line, "utf8"));
  const byteStarts = new Array(lines.length);
  const charStarts = new Array(lines.length);
  let byteOffset = 0;
  let charOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    byteStarts[i] = byteOffset;
    charStarts[i] = charOffset;
    byteOffset += byteLens[i] + 1;
    charOffset += lines[i].length + 1;
  }
  return { lines, byteLens, byteStarts, charStarts };
}

/** Absolute UTF-16 char offset of a `(row, byte-column)` position within `buildLineIndex`'s `text`. */
function charOffsetOf(index, pos) {
  const row = clamp(pos.row, 0, index.lines.length - 1);
  const map = byteToCharMap(index.lines[row]);
  const col = map[clamp(pos.col, 0, index.byteLens[row])] ?? index.lines[row].length;
  return index.charStarts[row] + col;
}

/**
 * Best-effort fallback for when `parseQueryOutput` has no source `text` to
 * work out exact field lengths from (a canned/synthetic stdout in a test,
 * say): scan for capture headers directly, anchored to the start of a
 * line. This is the format's known ambiguity the `text`-driven path below
 * exists to avoid — a multi-line capture's own `text:` field could itself
 * contain a line that looks like a capture header — so this path is never
 * used by `highlight()` against real `tree-sitter` output.
 */
function scanHeadersWithoutText(stdout) {
  const lineAnchored = new RegExp(`^[ \t]*${CAPTURE_HEADER_RE.source}`, "gm");
  const captures = [];
  for (const match of stdout.matchAll(lineAnchored)) {
    captures.push({
      pattern: Number(match[1]),
      capture: match[2],
      start: { row: Number(match[3]), col: Number(match[4]) },
      end: { row: Number(match[5]), col: Number(match[6]) },
    });
  }
  return captures;
}

/**
 * Parse `tree-sitter query -c`'s stdout into `[{ pattern, capture, start:
 * {row, col}, end: {row, col} }]`, ordered as the CLI emitted them (by
 * position). `row`/`col` are `(row, byte-column)` pairs, per the CLI.
 *
 * The CLI prints each capture as `pattern: P, capture: N - NAME, start:
 * (R, C), end: (R, C), text: \`...\`` — the `text:` field is a verbatim,
 * unescaped copy of the captured source, so it can itself contain
 * backticks and newlines, including (in the worst case) a line that reads
 * exactly like another capture's header. Passing the original `text` this
 * stdout was generated from lets this function sidestep that ambiguity
 * entirely: `end` minus `start` (converted through `text`, the same way
 * `spansFromCaptures` does) gives the *exact* character length of that
 * capture's own text field, so after matching a header this jumps straight
 * past exactly that many characters plus the closing backtick, rather than
 * searching for the next occurrence of `pattern:` and risking a false
 * match inside the field it just skipped. Without `text` (a canned stdout
 * in a test, where this ambiguity doesn't arise), it falls back to
 * `scanHeadersWithoutText`.
 */
export function parseQueryOutput(stdout, { text } = {}) {
  if (typeof stdout !== "string") return [];
  if (typeof text !== "string") return scanHeadersWithoutText(stdout);

  const index = buildLineIndex(text);
  const captures = [];
  let pos = 0;
  CAPTURE_HEADER_RE.lastIndex = 0;
  while (pos <= stdout.length) {
    CAPTURE_HEADER_RE.lastIndex = pos;
    const match = CAPTURE_HEADER_RE.exec(stdout);
    if (!match) break;

    const capture = {
      pattern: Number(match[1]),
      capture: match[2],
      start: { row: Number(match[3]), col: Number(match[4]) },
      end: { row: Number(match[5]), col: Number(match[6]) },
    };
    captures.push(capture);

    const afterHeader = match.index + match[0].length;
    const fieldOpen = TEXT_FIELD_RE.exec(stdout.slice(afterHeader, afterHeader + 16));
    if (fieldOpen) {
      const fieldStart = afterHeader + fieldOpen[0].length;
      const fieldCharLen = Math.max(0, charOffsetOf(index, capture.end) - charOffsetOf(index, capture.start));
      const closingBacktick = fieldStart + fieldCharLen;
      if (stdout[closingBacktick] === "`") {
        pos = closingBacktick + 1;
        continue;
      }
    }
    // The expected `, text: \`...\`` shape (or its computed length) didn't
    // match what's actually there — an unexpected CLI format change, most
    // likely. Resume scanning right after this header rather than
    // guessing further; the next real header is still found correctly as
    // long as it doesn't fall inside whatever this capture's field turns
    // out to actually contain.
    pos = afterHeader;
  }
  return captures;
}

/** The editor foreground colour to fall back to: Zed's when loaded, else the theme's flat foreground. */
function fallbackForeground(theme) {
  return theme?.zed ? theme.zed.style.editorForeground : (theme?.colors?.foreground ?? null);
}

/**
 * Does `name` resolve to an actual entry in `zedTheme.syntax`, via the same
 * dotted-prefix fallback `zedSyntaxStyle` walks (`a.b.c` -> `a.b` -> `a`)?
 * Unlike `zedSyntaxStyle` itself, this returns `false` rather than falling
 * back to the editor foreground when nothing matches — used to decide
 * whether a capture should be allowed to claim a range at all (see the
 * module header on unresolved captures never painting).
 */
function hasThemeEntry(zedTheme, name) {
  let key = name;
  while (key) {
    if (zedTheme.syntax[key]) return true;
    const dot = key.lastIndexOf(".");
    if (dot === -1) break;
    key = key.slice(0, dot);
  }
  return false;
}

/** One plain span per line, in the theme's editor foreground. Used whenever this module gives up without throwing. */
function plainLines(text, theme) {
  const color = fallbackForeground(theme);
  return String(text ?? "")
    .split("\n")
    .map((line) => [{ text: line, color, fontStyle: null, fontWeight: null }]);
}

/**
 * Resolve `captures` (as `parseQueryOutput` returns) against `text` and
 * `theme.zed`'s syntax map into `{ lines: [[{ text, color, fontStyle,
 * fontWeight }]] }`. See the module header for the precedence rule.
 *
 * Lines are `text.split("\n")` verbatim — a trailing newline in `text`
 * yields a trailing empty line (matching `text.split("\n").length`), a
 * missing one doesn't add one, and a `\r` before a `\n` (CRLF) stays as the
 * last character of the line it terminates; none of that needs special
 * handling here because `split("\n")` already does exactly that. Ranges are
 * tracked in bytes (matching the CLI's columns) and only converted to
 * string indices when slicing a line's text, so multi-byte characters
 * split correctly. **Invariant**: for every line, the concatenation of its
 * spans' `text` equals that line, unchanged.
 */
export function spansFromCaptures({ text, captures, theme }) {
  const { lines, byteLens, byteStarts } = buildLineIndex(text);

  const clampRow = (row) => clamp(row, 0, lines.length - 1);
  const absOffset = (pos) => {
    const row = clampRow(pos.row);
    return byteStarts[row] + clamp(pos.col, 0, byteLens[row]);
  };

  const enriched = (captures ?? [])
    .map((capture, order) => ({ ...capture, order, startAbs: absOffset(capture.start), endAbs: absOffset(capture.end) }))
    .filter((capture) => capture.endAbs > capture.startAbs)
    // A capture with no theme entry at all never fires (see the module
    // header) — it must not claim a range just for being the smallest one
    // there, which would incorrectly hide an enclosing capture's colour.
    .filter((capture) => hasThemeEntry(theme.zed, capture.capture));
  // Smallest range first: it "claims" its bytes before any larger,
  // enclosing range gets a chance to. Ties (same start and end — the same
  // node captured twice) are broken in *reverse* emission order, so the
  // last-declared query pattern claims the bytes and earlier, more generic
  // captures for that exact node are silently skipped below — see the
  // module header for why this is "last pattern wins", not first.
  enriched.sort((a, b) => a.endAbs - a.startAbs - (b.endAbs - b.startAbs) || b.order - a.order);

  const winners = lines.map((line, row) => new Array(byteLens[row]).fill(null));
  for (const capture of enriched) {
    const startRow = clampRow(capture.start.row);
    const endRow = clampRow(capture.end.row);
    for (let row = startRow; row <= endRow; row++) {
      const len = byteLens[row];
      const from = row === capture.start.row ? clamp(capture.start.col, 0, len) : 0;
      const to = row === capture.end.row ? clamp(capture.end.col, 0, len) : len;
      const arr = winners[row];
      for (let b = from; b < to; b++) {
        if (arr[b] === null) arr[b] = capture.capture;
      }
    }
  }

  const foreground = fallbackForeground(theme);
  const styleCache = new Map();
  const styleFor = (name) => {
    if (name === null) return { color: foreground, fontStyle: null, fontWeight: null };
    if (!styleCache.has(name)) styleCache.set(name, zedSyntaxStyle(theme.zed, name));
    return styleCache.get(name);
  };

  return lines.map((line, row) => {
    const len = byteLens[row];
    if (len === 0) {
      const style = styleFor(null);
      return [{ text: "", color: style.color, fontStyle: style.fontStyle, fontWeight: style.fontWeight }];
    }

    const map = byteToCharMap(line);
    const arr = winners[row];
    const spans = [];
    let runStart = 0;
    for (let b = 1; b <= len; b++) {
      if (b === len || arr[b] !== arr[runStart]) {
        const style = styleFor(arr[runStart]);
        spans.push({
          text: line.slice(map[runStart], map[b]),
          color: style.color,
          fontStyle: style.fontStyle,
          fontWeight: style.fontWeight,
        });
        runStart = b;
      }
    }

    // Adjacent spans that resolved to the same style merge, whether they
    // came from the same capture, different captures with the same theme
    // colour, or an uncaptured run next to one that happens to match.
    const merged = [];
    for (const span of spans) {
      const prev = merged[merged.length - 1];
      if (prev && prev.color === span.color && prev.fontStyle === span.fontStyle && prev.fontWeight === span.fontWeight) {
        prev.text += span.text;
      } else {
        merged.push({ ...span });
      }
    }
    return merged;
  });
}

/** Write `text` to a 0600 temp file, run `tree-sitter query` against it, and remove the file, always. */
function runTreeSitterQuery({ text, grammar, grammarPath, queryPath, runQuery }) {
  if (typeof runQuery === "function") {
    return runQuery({ text, grammar, grammarPath, queryPath });
  }

  const runtimeDir = join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "omacodesnap");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const tmpFile = join(runtimeDir, `highlight-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmpFile, text, { encoding: "utf8", mode: 0o600 });
  try {
    return execFileSync("tree-sitter", ["query", "--lib-path", grammarPath, "--lang-name", grammar, "-c", queryPath, tmpFile], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // best-effort cleanup; nothing more to do if this fails
    }
  }
}

/**
 * Highlight `text` as `language` (a `lib/language.mjs` id) using `theme`
 * (from `readTheme`). Never throws: an unknown/`null` language, a missing
 * grammar `.so` or query file, or a non-zero `tree-sitter` exit all degrade
 * to one plain span per line in the editor foreground, with the reason
 * recorded in `warnings`. `root` is where `vendor/` is resolved from
 * (defaults to this repo's root); `runQuery` lets tests substitute canned
 * `tree-sitter query` output for `{ text, grammar, grammarPath, queryPath }`.
 */
export function highlight({ text, language, theme, root = REPO_ROOT, runQuery } = {}) {
  const config = language ? LANGUAGES[language] : null;
  if (!config) {
    const warnings = language ? [`highlight: unknown language "${language}"`] : [];
    return { lines: plainLines(text, theme), language: language ?? null, warnings };
  }

  // Most Omarchy themes ship no zed-theme.json at all (only a handful of
  // hand-authored community themes do — see docs/gallery/SOURCES.md); a
  // recognised language with nothing to colour it against degrades the
  // same way an unrecognised one does, rather than dereferencing null.
  if (!theme?.zed) {
    return { lines: plainLines(text, theme), language, warnings: [`highlight: theme has no zed-theme.json; rendering "${language}" as plain text`] };
  }

  const grammarPath = join(root, "vendor", "grammars", "lib", `${config.grammar}.so`);
  const queryPath = join(root, "vendor", "zed-queries", config.queries, "highlights.scm");

  if (!runQuery && !existsSync(grammarPath)) {
    return {
      lines: plainLines(text, theme),
      language,
      warnings: [`highlight: grammar not built: ${grammarPath} (run bin/build-grammars)`],
    };
  }
  if (!runQuery && !existsSync(queryPath)) {
    return { lines: plainLines(text, theme), language, warnings: [`highlight: query file missing: ${queryPath}`] };
  }

  let stdout;
  try {
    stdout = runTreeSitterQuery({ text, grammar: config.grammar, grammarPath, queryPath, runQuery });
  } catch (err) {
    return { lines: plainLines(text, theme), language, warnings: [`highlight: tree-sitter query failed: ${err.message}`] };
  }

  const captures = parseQueryOutput(stdout, { text });
  return { lines: spansFromCaptures({ text, captures, theme }), language, warnings: [] };
}
