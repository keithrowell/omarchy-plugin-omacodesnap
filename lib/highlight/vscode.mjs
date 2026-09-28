// VS Code highlighter: `vscode-textmate` (the tokenizer VS Code itself
// runs, vendored under `vendor/textmate/`) parses `text` with a real TextMate
// grammar read live off the installed VS Code (see
// `lib/vscode-extensions.mjs`), then each token's scope stack is resolved to
// a colour with `vscodeScopeStyle()` from `lib/theme.mjs` — a hand-rolled
// TextMate scope-selector matcher already built and tested against
// `vscode-theme.json`'s `tokenColors` (spec 0003), so this module never
// needs `vscode-textmate`'s own theme-matching machinery (`Registry`'s
// `theme` option, `tokenizeLine2`): it calls the scope-name API
// (`tokenizeLine`) and resolves colour itself.
//
// The theme resolving those colours is the installed VS Code's own *active*
// theme (`resolveActiveVscodeTheme()` — whatever `workbench.colorTheme` is
// actually set to, resolved from the real theme file, `include` chain and
// all), not Omarchy's `vscode-theme.json` — see
// `docs/adr/0006-vscode-active-theme.md` for why colouring from the theme
// Omarchy *expects* VS Code to use, rather than the one it's actually
// showing, was a real bug, not a documented limitation. `theme.vscode`
// (Omarchy's file) is only the fallback for when the active theme can't be
// resolved at all (a broken/uninstalled theme reference).
//
// This mirrors `lib/highlight/zed.mjs`'s shape and its scope limits:
// injections are not implemented (a grammar's own embedded-language
// `include`s of a *different* scope resolve automatically through the same
// grammar index — e.g. Markdown fencing real JS still colours, since
// `source.js` is already indexed for JS's own use — but standalone
// injection grammars like a JSDoc-in-comments overlay are not loaded), and
// VS Code's semantic (LSP) highlighting layered on top of TextMate is out of
// scope entirely, same as Zed's LSP layer. Unlike Zed, no language having an
// installed grammar (see `lib/vscode-extensions.mjs`'s header — Rust and Go
// commonly don't) is not a bug to fix here: `highlight()` returns `null` and
// the caller falls back to the generic highlighter, exactly the outcome
// `docs/DEVELOPING.md` already describes for "anything else".
//
// Pure ES module except for the tokenizer engine itself: `vscode-textmate`
// and `vscode-oniguruma` (vendored, MIT) are loaded from disk once per
// process (module-level singletons below) and never touch the network.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { vscodeScopeStyle } from "../theme.mjs";
import { LANGUAGE_TO_VSCODE_ID, buildDefaultGrammarIndex, resolveGrammar, resolveActiveVscodeTheme } from "../vscode-extensions.mjs";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(MODULE_DIR, "..", "..");

let onigLibPromise = null;
let textmatePromise = null;

/** Lazily load the vendored `vscode-oniguruma` WASM binary and its `IOnigLib` adapter, once per process. */
function loadOnigLib(root) {
  if (!onigLibPromise) {
    onigLibPromise = (async () => {
      const mainPath = join(root, "vendor", "textmate", "vscode-oniguruma", "release", "main.js");
      const oniguruma = (await import(pathToFileURL(mainPath).href)).default;
      const wasmPath = join(root, "vendor", "textmate", "vscode-oniguruma", "release", "onig.wasm");
      await oniguruma.loadWASM(readFileSync(wasmPath).buffer);
      return {
        createOnigScanner(patterns) {
          return new oniguruma.OnigScanner(patterns);
        },
        createOnigString(s) {
          return new oniguruma.OnigString(s);
        },
      };
    })();
  }
  return onigLibPromise;
}

/** Lazily import the vendored `vscode-textmate` bundle, once per process. */
function loadTextmate(root) {
  if (!textmatePromise) {
    const mainPath = join(root, "vendor", "textmate", "vscode-textmate", "release", "main.js");
    textmatePromise = import(pathToFileURL(mainPath).href).then((m) => m.default);
  }
  return textmatePromise;
}

/**
 * Build a `Registry` whose `loadGrammar` resolves any scope name (the
 * language's own, or one an `include` pulls in, e.g. JavaScript's
 * `source.js.regexp`) through `index` — `lib/vscode-extensions.mjs`'s
 * scan of the installed VS Code, injected as `grammarIndex` for tests.
 */
async function buildRegistry({ root, index, textmate, onigLib }) {
  return new textmate.Registry({
    onigLib,
    loadGrammar: async (scopeName) => {
      const path = index.byScope.get(scopeName);
      if (!path) return null;
      const content = readFileSync(path, "utf8");
      return textmate.parseRawGrammar(content, path);
    },
  });
}

/**
 * Tokenize `text` (already-parsed `lines`, one per source line) with
 * `grammar`, resolving each token's scope stack to a style via
 * `vscodeScopeStyle(vscodeTheme, scopes)` — `vscodeTheme` is whichever
 * theme `highlight()` resolved (the installed VS Code's real active one,
 * normally; Omarchy's own as a fallback). RuleStack (the tokenizer's
 * multi-line state — open block comments, template strings, ...) threads
 * across lines exactly as `vscode-textmate`'s own consumers do.
 *
 * Adjacent spans that resolve to the same style are merged, matching the
 * Zed highlighter's span-merging contract for the renderer.
 */
function tokenizeLines({ lines, grammar, vscodeTheme, INITIAL }) {
  let ruleStack = INITIAL;
  return lines.map((line) => {
    const result = grammar.tokenizeLine(line, ruleStack);
    ruleStack = result.ruleStack;

    const spans = [];
    for (const token of result.tokens) {
      const text = line.slice(token.startIndex, token.endIndex);
      if (text === "") continue;
      const style = vscodeScopeStyle(vscodeTheme, token.scopes);
      spans.push({ text, color: style.color, fontStyle: style.fontStyle, fontWeight: style.fontWeight });
    }
    if (spans.length === 0) {
      const style = vscodeScopeStyle(vscodeTheme, []);
      return [{ text: "", color: style.color, fontStyle: style.fontStyle, fontWeight: style.fontWeight }];
    }

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

/**
 * Highlight `text` as `language` (a `lib/language.mjs` id) using VS Code's
 * own TextMate tokenizer, coloured from the installed VS Code's real
 * *active* theme (`resolveActiveVscodeTheme()`) — falling back to
 * `theme.vscode` (Omarchy's own `vscode-theme.json`, from `readTheme()`)
 * only when the active theme can't be resolved at all. Returns `null` —
 * never throws — when there is nothing to colour it with: no theme
 * resolved by either path, no `LANGUAGE_TO_VSCODE_ID` entry, no installed
 * extension providing that language's grammar, or a tokenizer failure. The
 * caller (`lib/snap.mjs`) treats `null` as "fall back to the generic
 * highlighter", exactly as `docs/DEVELOPING.md` describes for a language VS Code
 * itself has nothing to colour.
 *
 * `root` is where `vendor/textmate/` is resolved from (defaults to this
 * repo's root). `grammarIndex`/`activeVscodeTheme` let tests inject a fake
 * installed-extension index / a fake resolved theme instead of scanning
 * the real machine (`buildDefaultGrammarIndex`/`resolveActiveVscodeTheme`).
 */
export async function highlight({ text, language, theme, root = REPO_ROOT, grammarIndex, activeVscodeTheme } = {}) {
  if (!language || !LANGUAGE_TO_VSCODE_ID[language]) return null;

  const vscodeTheme = (activeVscodeTheme !== undefined ? activeVscodeTheme : resolveActiveVscodeTheme()) ?? theme?.vscode ?? null;
  if (!vscodeTheme) return null;

  const index = grammarIndex ?? buildDefaultGrammarIndex();
  const resolved = resolveGrammar(language, index);
  if (!resolved) return null;

  try {
    const [textmate, onigLib] = await Promise.all([loadTextmate(root), loadOnigLib(root)]);
    const registry = await buildRegistry({ root, index, textmate, onigLib });
    const grammar = await registry.loadGrammar(resolved.scopeName);
    if (!grammar) return null;

    const lines = String(text ?? "").split("\n");
    return { lines: tokenizeLines({ lines, grammar, vscodeTheme, INITIAL: textmate.INITIAL }), language, warnings: [] };
  } catch {
    // A grammar was resolved but tokenizing it failed (a malformed/unusual
    // installed grammar, most likely) — null, like every other unresolved
    // case above, so the caller falls back to the generic highlighter
    // rather than showing broken/partial output.
    return null;
  }
}
