// Builds the one JSON document `app/Snap.qml` renders from: a fixture (or,
// from spec 0006, the live selection) plus the current Omarchy theme.
//
// Pure ES module: no Qt, no caching. `bin/omasnap` runs this with Node
// *before* starting Quickshell (see the plan for spec 0004 — QML cannot
// import `lib/theme.mjs`, which uses `node:fs`), so every render re-reads
// the fixture and the theme from disk.

import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { readTheme, zedSyntaxStyle, DEFAULT_THEME_DIR } from "./theme.mjs";
import { readHyprlandLook } from "./hypr.mjs";

export const CONSTANTS = { minWidth: 480, maxWidth: 1600, minLines: 3, tabWidth: 4 };

const EDITORS = ["zed", "vscode", "neovim", "other"];

/**
 * Validate the fixture/selection shape `buildInput` expects:
 * `{ filename: string|null, language: string|null, editor: "zed"|"vscode"|"neovim"|"other",
 * font: { family: string, size: number }, lines: [ [ { text, capture?, color?,
 * fontStyle?, fontWeight? } ] ], subtitle?: string|null, showGutter?: boolean,
 * compact?: boolean, centerContent?: boolean }`. Throws on the first problem,
 * naming its path (e.g. `lines[3][1].text`).
 */
export function validateFixture(obj) {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new Error("fixture: must be an object");
  }
  if (obj.filename !== null && typeof obj.filename !== "string") {
    throw new Error("filename: must be a string or null");
  }
  if (obj.language !== null && typeof obj.language !== "string") {
    throw new Error("language: must be a string or null");
  }
  if (!EDITORS.includes(obj.editor)) {
    throw new Error(`editor: must be one of ${EDITORS.join(", ")}`);
  }
  // `subtitle` is optional (absent/undefined or null keeps today's
  // auto-built editor/language badge — see `app/Snap.qml`'s `buildFrame`);
  // when given, it must be a string used verbatim.
  if (obj.subtitle !== undefined && obj.subtitle !== null && typeof obj.subtitle !== "string") {
    throw new Error("subtitle: must be a string or null");
  }
  // `showGutter` is optional and defaults to `true` (today's behaviour) —
  // only an explicit `false` suppresses the gutter.
  if (obj.showGutter !== undefined && typeof obj.showGutter !== "boolean") {
    throw new Error("showGutter: must be a boolean");
  }
  // `compact` is optional and defaults to `false` (today's behaviour).
  if (obj.compact !== undefined && typeof obj.compact !== "boolean") {
    throw new Error("compact: must be a boolean");
  }
  // `centerContent` is optional and defaults to `false` (today's exact
  // left-aligned behaviour) — only an explicit `true` centres each line's
  // rendered content within the code column's available width. Orthogonal
  // to `showGutter`/`compact` — see `app/Snap.qml`'s `buildFrame`.
  if (obj.centerContent !== undefined && typeof obj.centerContent !== "boolean") {
    throw new Error("centerContent: must be a boolean");
  }
  if (typeof obj.font !== "object" || obj.font === null) {
    throw new Error("font: must be an object");
  }
  if (typeof obj.font.family !== "string" || obj.font.family === "") {
    throw new Error("font.family: must be a non-empty string");
  }
  if (typeof obj.font.size !== "number" || !(obj.font.size > 0)) {
    throw new Error("font.size: must be a positive number");
  }
  if (!Array.isArray(obj.lines)) {
    throw new Error("lines: must be an array");
  }

  obj.lines.forEach((line, i) => {
    if (!Array.isArray(line)) {
      throw new Error(`lines[${i}]: must be an array of spans`);
    }
    line.forEach((span, j) => {
      const path = `lines[${i}][${j}]`;
      if (typeof span !== "object" || span === null || Array.isArray(span)) {
        throw new Error(`${path}: must be an object`);
      }
      if (typeof span.text !== "string") {
        throw new Error(`${path}.text: must be a string`);
      }
      if (span.text === "" && line.length !== 1) {
        throw new Error(`${path}.text: empty text is only allowed as a line's sole span`);
      }
      if (span.capture !== undefined && typeof span.capture !== "string") {
        throw new Error(`${path}.capture: must be a string`);
      }
      if (span.color !== undefined && typeof span.color !== "string") {
        throw new Error(`${path}.color: must be a string`);
      }
      if (span.fontStyle !== undefined && span.fontStyle !== null && span.fontStyle !== "italic") {
        throw new Error(`${path}.fontStyle: must be "italic" or null`);
      }
      if (span.fontWeight !== undefined && span.fontWeight !== null && typeof span.fontWeight !== "number") {
        throw new Error(`${path}.fontWeight: must be a number or null`);
      }
    });
  });
}

/** Expand a line's tabs to the next multiple of `tabWidth` columns, tracking column across spans. */
function expandLineTabs(line, tabWidth) {
  let column = 0;
  return line.map((span) => {
    let text = "";
    for (const ch of span.text) {
      if (ch === "\t") {
        const spaces = tabWidth - (column % tabWidth);
        text += " ".repeat(spaces);
        column += spaces;
      } else {
        text += ch;
        column += 1;
      }
    }
    return { ...span, text };
  });
}

/** The editor foreground colour to fall back to: Zed's when loaded, else the theme's flat foreground. */
function fallbackForeground(theme) {
  return theme.zed ? theme.zed.style.editorForeground : theme.colors.foreground;
}

/**
 * Resolve one span's colour/style: an explicit `color` passes through
 * unchanged; a `capture` resolves through `zedSyntaxStyle` (Zed's syntax map
 * is the only highlighter this spec renders from, regardless of `editor` —
 * see the module header); anything else gets the plain editor foreground.
 */
function resolveSpanStyle(span, theme) {
  if (span.color) {
    return { color: span.color, fontStyle: span.fontStyle ?? null, fontWeight: span.fontWeight ?? null };
  }
  if (span.capture && theme.zed) {
    return zedSyntaxStyle(theme.zed, span.capture);
  }
  return { color: fallbackForeground(theme), fontStyle: null, fontWeight: null };
}

/**
 * Resolve every span in every line to `{ text, color, fontStyle, fontWeight }`,
 * expanding tabs first so column-aware expansion sees the original text.
 */
export function resolveSpans(lines, theme) {
  return lines.map((line) => {
    const expanded = expandLineTabs(line, CONSTANTS.tabWidth);
    return expanded.map((span) => {
      const style = resolveSpanStyle(span, theme);
      return { text: span.text, color: style.color, fontStyle: style.fontStyle, fontWeight: style.fontWeight };
    });
  });
}

/** The editor's chrome colours: from Zed's theme when loaded, else `colors.toml`. */
function editorStyle(theme) {
  if (theme.zed) {
    return {
      background: theme.zed.style.editorBackground,
      foreground: theme.zed.style.editorForeground,
      gutterBackground: theme.zed.style.gutterBackground,
      lineNumber: theme.zed.style.lineNumber,
      lineNumberActive: theme.zed.style.lineNumberActive,
      selectionBackground: theme.zed.style.selectionBackground,
    };
  }
  return {
    background: theme.colors.background,
    foreground: theme.colors.foreground,
    gutterBackground: theme.colors.background,
    lineNumber: theme.colors.dark_foreground,
    lineNumberActive: theme.colors.foreground,
    selectionBackground: theme.colors.selection,
  };
}

/**
 * `~/.config/omarchy/shell.json`'s `font.family`, if that key is a
 * non-empty string; `null` otherwise (file absent, invalid JSON, or the key
 * missing/empty) — never throws.
 */
export function parseUserShellFont(jsonText) {
  if (typeof jsonText !== "string" || jsonText.trim() === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const family = parsed && typeof parsed === "object" && parsed.font ? parsed.font.family : undefined;
  return typeof family === "string" && family.trim() !== "" ? family : null;
}

/**
 * A theme's `shell.toml`'s `[font]` section's `family` key, if present;
 * `null` otherwise. Only a `family` key inside the `[font]` section counts —
 * the same key name in a different section (e.g. `[bar]`) is ignored. A
 * minimal line-oriented reader, not a general TOML parser: `shell.toml` has
 * many sections this never needs to understand.
 */
export function parseThemeShellFont(tomlText) {
  if (typeof tomlText !== "string" || tomlText.trim() === "") return null;
  let inFontSection = false;
  for (const raw of tomlText.split(/\r?\n/)) {
    const stripped = raw.trim();
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      inFontSection = stripped === "[font]";
      continue;
    }
    if (!inFontSection || stripped === "" || stripped.startsWith("#")) continue;
    const match = /^family\s*=\s*(.+?)\s*(#.*)?$/.exec(stripped);
    if (match) {
      const value = match[1].trim().replace(/^["']|["']$/g, "");
      return value !== "" ? value : null;
    }
  }
  return null;
}

/**
 * Resolve the header's font family (see the plan/spec's "header" acceptance
 * criterion): the user's `~/.config/omarchy/shell.json` `font.family`, else
 * the current theme's `shell.toml` `[font]` `family`, else `codeFontFamily`
 * — the header is never left without a family. Never throws: a missing or
 * unreadable file is treated the same as an absent key. `homeDir` is
 * injectable for tests; defaults to the real `$HOME`.
 */
export function readHeaderFont({ themeDir, codeFontFamily, homeDir = homedir() } = {}) {
  const userShellJsonPath = join(homeDir, ".config", "omarchy", "shell.json");
  if (existsSync(userShellJsonPath)) {
    const userFamily = parseUserShellFont(readFileSync(userShellJsonPath, "utf8"));
    if (userFamily) return userFamily;
  }

  const themeShellTomlPath = join(themeDir, "shell.toml");
  if (existsSync(themeShellTomlPath)) {
    const themeFamily = parseThemeShellFont(readFileSync(themeShellTomlPath, "utf8"));
    if (themeFamily) return themeFamily;
  }

  return codeFontFamily;
}

/**
 * Build the JSON document `app/Snap.qml` renders: the snap (spans resolved
 * to colours) plus the theme colours it needs, this desktop's Hyprland
 * "look" (border/rounding/gaps/shadow — see `lib/hypr.mjs`) and the
 * header's font family. `wallpaperOverride` (the `--wallpaper` flag) wins
 * over `theme.wallpaper`; either resolves to `null` when the file does not
 * exist, per the spec's "wallpaper missing" edge case. `look` and
 * `headerFont` are each computed for free when omitted (so the CLI and
 * `lib/snap.mjs` get them without extra plumbing); tests pass them
 * explicitly to avoid depending on a live desktop/filesystem.
 */
export function buildInput({ snap, theme, look, headerFont, wallpaperOverride } = {}) {
  validateFixture(snap);

  // A relative `--wallpaper` resolves against cwd here (readTheme's own
  // `theme.wallpaper` is already absolute — it comes from `realpathSync`),
  // because `app/Snap.qml` turns this into a `file://` URL, which needs an
  // absolute path; a relative one silently gave a flat backdrop instead of
  // an error, since the `Image` just failed to load with no visible sign
  // beyond a missing blur.
  let wallpaper = wallpaperOverride ? resolve(wallpaperOverride) : (theme.wallpaper ?? null);
  if (wallpaper && !existsSync(wallpaper)) wallpaper = null;

  const resolvedLook = look ?? readHyprlandLook({ accent: theme.colors.accent });
  const resolvedHeaderFont = headerFont ?? readHeaderFont({ themeDir: theme.dir, codeFontFamily: snap.font.family });

  return {
    snap: {
      filename: snap.filename,
      language: snap.language,
      editor: snap.editor,
      font: snap.font,
      // Optional, backward-compatible fixture fields (see `validateFixture`
      // and `app/Snap.qml`'s `buildFrame`): normalized here so `Snap.qml`
      // never has to guess between "absent" and "explicitly false/null".
      subtitle: snap.subtitle ?? null,
      showGutter: snap.showGutter ?? true,
      compact: snap.compact ?? false,
      centerContent: snap.centerContent ?? false,
      lines: resolveSpans(snap.lines, theme),
    },
    theme: {
      name: theme.name,
      mode: theme.mode,
      colors: theme.colors,
      editor: editorStyle(theme),
      wallpaper,
    },
    look: resolvedLook,
    headerFont: resolvedHeaderFont,
    meta: {
      generatedAt: new Date().toISOString(),
      themeDir: theme.dir,
    },
  };
}

function parseArgs(argv) {
  const args = { fixture: null, themeDir: DEFAULT_THEME_DIR, wallpaper: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fixture") args.fixture = argv[++i];
    else if (arg === "--theme-dir") args.themeDir = argv[++i];
    else if (arg === "--wallpaper") args.wallpaper = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`input: ${err.message}`);
    process.exit(2);
  }
  if (!args.fixture) {
    console.error("input: --fixture is required");
    process.exit(2);
  }

  let snap;
  let theme;
  try {
    snap = JSON.parse(readFileSync(args.fixture, "utf8"));
    validateFixture(snap);
    theme = readTheme(args.themeDir);
  } catch (err) {
    console.error(`input: ${err.message}`);
    process.exit(2);
  }

  const input = buildInput({ snap, theme, wallpaperOverride: args.wallpaper });
  console.log(JSON.stringify(input));
}

// CLI entry point: `node lib/input.mjs --fixture F [--theme-dir D] [--wallpaper W]`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
