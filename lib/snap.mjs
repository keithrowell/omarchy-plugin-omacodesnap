// Live-selection glue: turns a raw selection plus the active window's class,
// title and pid into the frame renderer's input. Which editor is running,
// how its selection/colours are obtained, and its font are all delegated to
// `lib/editors/registry.mjs`'s adapters — this module owns only what's
// universal across every editor: cleaning the raw text (NUL-stripping,
// dedent, `MAX_LINES` truncation), the fallback highlighter, and the CLI.
// Before any of that, `prepareSnap` gives a matching snap provider
// (ADR-0010, `lib/providers.mjs`) first refusal at the whole snap.
//
// Pure ES module (the `prepareSnap` export and everything it calls other
// than an adapter's/provider's own hooks): no Qt, no caching. The CLI entry
// point below is the only part of *this file* that touches the filesystem
// or a subprocess directly (reading the selection/window/request files and
// `xdg-user-dir`) — an adapter's own `detect()`/`resolveSelection()`, and
// `lib/providers.mjs`'s provider scan/spawn, may each run whatever they
// need to, but that's their concern, not this module's.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readTheme, DEFAULT_THEME_DIR } from "./theme.mjs";
import { detectLanguage, LANGUAGES } from "./language.mjs";
import { highlight, REPO_ROOT } from "./highlight/zed.mjs";
import { detectEditorContext } from "./editors/registry.mjs";
import { EDITOR_CLASSES, TRANSIENT_CLASSES, detectEditor, filenameFromTitle } from "./title.mjs";
import { readEditorFont, resolveFontFamily } from "./fonts.mjs";
import { buildInput } from "./input.mjs";
import { dedent } from "./indent.mjs";
import { scanProviders, runProvider, findProvider, DEFAULT_PLUGINS_DIR } from "./providers.mjs";

export const MAX_LINES = 200;

// Re-exported for backward compatibility: `EDITOR_CLASSES`/`detectEditor`/
// `filenameFromTitle` live in `lib/title.mjs` now (so `lib/editors/*.mjs`
// adapters can use them without importing this module, which imports the
// adapter registry — a cycle), but this remains the one place everything
// else in the codebase (and every existing test) imports them from.
export { EDITOR_CLASSES, TRANSIENT_CLASSES, detectEditor, filenameFromTitle };

/** How many leading characters `dedent()` actually stripped from `originalLine`, measured directly against its own dedented counterpart rather than re-deriving `dedent()`'s (first-line-may-differ, blank-lines-blanked) rules a second time. */
function strippedCharCount(originalLine, dedentedLine) {
  return Math.max(0, (originalLine?.length ?? 0) - (dedentedLine?.length ?? 0));
}

/** Drop `n` leading characters from a line's span array, dropping/truncating spans as needed. Used to keep an editor-supplied `lines` override (colours already resolved by that adapter's own `resolveSelection()`) aligned with `dedent()`'s effect on the parallel plain-text line. */
function trimLeadingChars(spans, n) {
  let remaining = n;
  const result = [];
  for (const span of spans) {
    if (remaining <= 0) {
      result.push(span);
    } else if (span.text.length <= remaining) {
      remaining -= span.text.length;
    } else {
      result.push({ ...span, text: span.text.slice(remaining) });
      remaining = 0;
    }
  }
  if (result.length > 0) return result;
  const last = spans[spans.length - 1];
  return [{ text: "", color: last?.color ?? null, fontStyle: last?.fontStyle ?? null, fontWeight: last?.fontWeight ?? null }];
}

/**
 * Build the frame renderer's input (`{ snap, warnings, detected }`) from a
 * raw selection and the active window's `class`/`title`/`pid`.
 *
 * - **Snap providers first (ADR-0010).** Before any editor detection runs,
 *   `scanProvidersFn` (defaults to the real `scanProviders` from
 *   `lib/providers.mjs`, pointed at `pluginsDir`) is checked for an
 *   installed Omarchy plugin whose manifest declares an `omasnap.provider`
 *   command for this `windowClass`. When one matches, `runProviderFn`
 *   (defaults to the real `runProvider`) runs it; a valid fixture back is
 *   used *directly* as `snap` — editor detection, `resolveSelection()`,
 *   highlighting and font resolution below are skipped entirely for this
 *   snap, because the provider is asserting a complete, final answer. No
 *   match, or the provider failing in any way (`runProviderFn` returning
 *   `null`), falls straight through to exactly the behaviour described
 *   below, unchanged — a provider can only ever add a snap, never break one.
 * - `detectContext` (defaults to the real `detectEditorContext` from
 *   `lib/editors/registry.mjs`) picks the matching editor adapter — see
 *   that module for the adapter interface every editor implements.
 * - `text` starts as the raw primary selection, but an adapter can replace
 *   it entirely via `resolveSelection()` — none of the current adapters do
 *   (Zed/VS Code/`other` all return `null`, meaning "use the primary
 *   selection as-is"), but the hook exists for an editor whose own live
 *   state is a better source than the Wayland selection. Either way, the
 *   resulting text is hygienically cleaned next: a NUL byte (a binary-looking
 *   selection) is stripped and
 *   warned about — skipped for an adapter's own override, since a real
 *   editor buffer can't contain one — then `dedentFn` (defaults to the real
 *   `dedent()` from `lib/indent.mjs`) strips the selection's common leading
 *   whitespace, so a block carved out of deeply-nested code sits flush left
 *   with its relative indent kept; when the override also supplied
 *   pre-highlighted `lines`, the exact same characters are trimmed from
 *   their span arrays (`trimLeadingChars`) so text and colour stay aligned.
 *   Finally the selection (and any override `lines`) is truncated to
 *   `MAX_LINES` lines, with a warning if it was longer.
 * - `language`: an explicit `undefined` (the default — simply not passing
 *   the option) means "detect it", via `detectLanguage({ filename, text })`;
 *   any other value, including `null`, is used as-is. `null` is the
 *   preview's language selector's "plain" entry — force no highlighting at
 *   all, distinct from "not specified, please detect."
 * - `lines`: an override that already supplied them wins outright (no
 *   highlighter runs at all). Otherwise the matched adapter's `highlight()`
 *   runs first; its `null` return (an unresolvable VS Code language,
 *   commonly Rust/Go — see `lib/vscode-extensions.mjs` — or simply an
 *   adapter with no highlighter of its own, e.g. Zed's the exception, not
 *   the rule) falls back to `highlightFn` (defaults to the real Zed
 *   highlighter), which is also what every stock Omarchy theme's generic
 *   fallback ultimately is (`lib/theme.mjs`'s `synthesizeZedTheme`).
 * - `font` comes from the matched adapter's `font()`, or `fontFn(editor)`
 *   if given (mainly for tests), or the system monospace fallback if the
 *   adapter itself has none to offer.
 * - `snap.filename` (what the title bar shows) is the extracted filename,
 *   else the language id, else `"snippet"` — `detected.filename` keeps the
 *   raw extracted value (possibly `null`) instead, for callers that care
 *   what was actually found versus what is merely displayed.
 * - `detected.removedIndent` is the whitespace `dedentFn` stripped (`""`
 *   when there was no common indent to remove).
 */
export async function prepareSnap({
  text,
  windowClass,
  title,
  pid,
  language,
  theme,
  root = REPO_ROOT,
  detectContext = detectEditorContext,
  highlightFn = highlight,
  fontFn,
  dedentFn = dedent,
  scanProvidersFn = scanProviders,
  runProviderFn = runProvider,
  pluginsDir = DEFAULT_PLUGINS_DIR,
} = {}) {
  const warnings = [];

  // Snap providers (ADR-0010) run before any editor detection. `windowClass`
  // is the exact same value `detectContext` below would otherwise use — no
  // second Hyprland lookup — so a plugin with no `omasnap` block, or one
  // whose provider fails for any reason, costs one directory scan and one
  // failed subprocess call before falling through to today's behaviour.
  if (windowClass) {
    const providers = scanProvidersFn(pluginsDir);
    const provider = findProvider(providers, windowClass);
    if (provider) {
      const fixture = await runProviderFn(provider);
      if (fixture) {
        return {
          snap: fixture,
          warnings: [],
          detected: { editor: fixture.editor, language: fixture.language, filename: fixture.filename, removedIndent: "" },
        };
      }
    }
  }

  const { editor: editorAdapter, context } = await detectContext({ windowClass, pid });
  const editor = editorAdapter.id;

  const rawText = typeof text === "string" ? text : "";
  const override = await editorAdapter.resolveSelection({ context, primaryText: rawText });

  let cleanText = override ? override.text : rawText;
  if (!override && cleanText.includes("\0")) {
    warnings.push("selection contains binary data");
    cleanText = cleanText.replace(/\0/g, "");
  }

  const { text: dedented, removed: removedIndent } = dedentFn(cleanText);
  let overrideLines = override?.lines;
  if (overrideLines && removedIndent !== "") {
    const originalLines = cleanText.split("\n");
    const dedentedLines = dedented.split("\n");
    overrideLines = overrideLines.map((spans, i) => {
      const n = strippedCharCount(originalLines[i], dedentedLines[i]);
      return n > 0 ? trimLeadingChars(spans, n) : spans;
    });
  }
  cleanText = dedented;

  const allLines = cleanText.split("\n");
  if (allLines.length > MAX_LINES) {
    cleanText = allLines.slice(0, MAX_LINES).join("\n");
    warnings.push("snapping first 200 lines");
    if (overrideLines) overrideLines = overrideLines.slice(0, MAX_LINES);
  }

  const extractedFilename = override?.filename ?? editorAdapter.filenameFromTitle(title);
  const resolvedLanguage = language !== undefined ? language : detectLanguage({ filename: extractedFilename, text: cleanText });

  const highlighted = overrideLines
    ? { lines: overrideLines, warnings: [] }
    : ((await editorAdapter.highlight({ text: cleanText, language: resolvedLanguage, theme, root, context })) ??
      highlightFn({ text: cleanText, language: resolvedLanguage, theme, root }));
  warnings.push(...(highlighted.warnings ?? []));

  const font = fontFn ? fontFn(editor) : (editorAdapter.font({ context }) ?? systemFont());

  const displayFilename = extractedFilename ?? resolvedLanguage ?? "snippet";

  return {
    snap: {
      filename: displayFilename,
      language: resolvedLanguage,
      editor,
      font,
      lines: highlighted.lines,
    },
    warnings,
    detected: { editor, language: resolvedLanguage, filename: extractedFilename, removedIndent },
  };
}

/** The system monospace font (`fc-match`), for an editor adapter with no font of its own to report. */
function systemFont() {
  const raw = readEditorFont(null);
  const resolved = resolveFontFamily(raw.family);
  return { family: resolved.family, size: raw.size };
}

// --- CLI ---------------------------------------------------------------

function parseArgs(argv) {
  const args = { selection: null, window: null, request: null, out: null, language: undefined, themeDir: DEFAULT_THEME_DIR };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--selection") args.selection = argv[++i];
    else if (arg === "--window") args.window = argv[++i];
    else if (arg === "--request") args.request = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--language") args.language = argv[++i];
    else if (arg === "--theme-dir") args.themeDir = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

/**
 * `--language`'s CLI value to `prepareSnap`'s `language` parameter: absent
 * (`undefined`) means "detect it"; the literal `"plain"` (the preview's
 * language selector's no-highlighting entry) means "force no language, no
 * highlighting" (`null`); anything else is used as the override id as-is.
 */
function resolveLanguageArg(raw) {
  if (raw === undefined) return undefined;
  if (raw === "plain") return null;
  return raw;
}

/** `xdg-user-dir PICTURES`, falling back to `~/Pictures` if the tool is missing or fails. Never throws. */
function picturesDir() {
  try {
    const out = execFileSync("xdg-user-dir", ["PICTURES"], { encoding: "utf8" }).trim();
    if (out) return out;
  } catch {
    // fall through to the default below
  }
  return join(homedir(), "Pictures");
}

/** Read a window-info JSON file (as `hyprctl activewindow -j` writes, or `{}`); never throws. */
function readWindowInfo(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeInput({ outPath, snap, warnings, detected, theme }) {
  const input = buildInput({ snap, theme });
  input.warnings = warnings;
  input.languages = Object.keys(LANGUAGES);
  input.detected = detected;
  writeFileSync(outPath, JSON.stringify(input));
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`snap: ${err.message}`);
    process.exit(2);
  }

  if (!args.out) {
    console.error("snap: --out is required");
    process.exit(2);
  }

  // Re-highlight mode: a `--request` with no `--selection`/`--window` means
  // "re-read what an earlier CLI run recorded and rebuild with a language
  // override" (the preview's language selector). Nothing but the request
  // file may be assumed to still exist by then.
  if (args.request && !args.selection && !args.window) {
    if (!args.language) {
      console.error("snap: --language is required when re-highlighting from --request");
      process.exit(2);
    }
    let request;
    try {
      request = JSON.parse(readFileSync(args.request, "utf8"));
      // The request is self-contained: the first run recorded the selection
      // text and the window info *inline*, because `bin/omasnap` deletes its
      // SELECTION/WINDOW files the moment it exits — long before the preview
      // (and any re-highlight from its language selector) is done with them.
      // The path fields are only read as a fallback for a request written
      // before they were inlined.
      const text = typeof request.text === "string" ? request.text : readFileSync(request.selection, "utf8");
      const windowInfo = typeof request.windowInfo === "object" && request.windowInfo !== null ? request.windowInfo : readWindowInfo(request.window);
      const theme = readTheme(args.themeDir);
      const result = await prepareSnap({
        text,
        windowClass: windowInfo.class,
        title: windowInfo.title,
        pid: windowInfo.pid,
        language: resolveLanguageArg(args.language),
        theme,
        root: request.root ?? REPO_ROOT,
      });
      writeInput({ outPath: args.out, snap: result.snap, warnings: result.warnings, detected: result.detected, theme });
    } catch (err) {
      console.error(`snap: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (!args.selection || !args.window || !args.request) {
    console.error("snap: --selection, --window and --request are required (or --request alone with --language, to re-highlight)");
    process.exit(2);
  }

  let text;
  try {
    text = readFileSync(args.selection, "utf8");
  } catch (err) {
    console.error(`snap: ${err.message}`);
    process.exit(1);
  }

  const windowInfo = readWindowInfo(args.window);

  // An empty selection (bin/omasnap no longer filters this out itself —
  // ADR-0010) is only fatal when no snap provider is registered for the
  // focused window's class either: a provider is a complete,
  // self-sufficient answer regardless of what's selected, so it must get a
  // chance to run even with nothing on the primary selection/clipboard.
  // This is a plain synchronous match check (`scanProviders`'s own default
  // `pluginsDir`, no subprocess) — short-circuited by `&&` so it never runs
  // at all when there *is* a selection, keeping that (overwhelmingly
  // common) path exactly as cheap as before. The actual provider
  // invocation, if any, happens once, inside `prepareSnap` below.
  if (text.trim() === "" && !findProvider(scanProviders(), windowInfo.class)) {
    process.exit(3);
  }

  try {
    const theme = readTheme(args.themeDir);
    const result = await prepareSnap({
      text,
      windowClass: windowInfo.class,
      title: windowInfo.title,
      pid: windowInfo.pid,
      language: resolveLanguageArg(args.language),
      theme,
      root: REPO_ROOT,
    });

    writeInput({ outPath: args.out, snap: result.snap, warnings: result.warnings, detected: result.detected, theme });

    // Everything a later `--request` re-highlight needs, carried inline:
    // `bin/omasnap` removes SELECTION and WINDOW when it exits, which is
    // right after handing the preview to the shell service, while the
    // request file itself lives (and is cleaned up) with the preview.
    const request = {
      text,
      windowInfo,
      root: REPO_ROOT,
      pictures: picturesDir(),
      language: result.detected.language,
    };
    writeFileSync(args.request, JSON.stringify(request));
  } catch (err) {
    console.error(`snap: ${err.message}`);
    process.exit(1);
  }
}

// CLI entry point: `node lib/snap.mjs --selection F --window F --request F --out F [--language X]`
// or `node lib/snap.mjs --request F --language X --out F` (re-highlight).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`snap: ${err.message}`);
    process.exit(1);
  });
}
