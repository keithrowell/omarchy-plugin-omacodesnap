// Discovers TextMate grammars from the VS Code installation itself (its
// built-in extensions) and whatever marketplace extensions the user has
// installed, instead of vendoring copies of grammar files.
//
// Why: VS Code's built-in languages (JavaScript, JSON, Python, ...) ship as
// ordinary extensions inside its own install tree (e.g.
// `/usr/share/code/resources/app/extensions/javascript/syntaxes/*.json`),
// laid out exactly like a marketplace extension. Reading them directly means
// OmaCodeSnap always matches *this machine's actual installed VS Code version* —
// no pinning, no re-vendoring when VS Code updates — and, for anything not
// built in (Rust, Go, Lua, ...), the same mechanism picks up a real grammar
// automatically the moment the user installs a marketplace extension that
// ships one, with no code change here. Nothing is fetched over the network;
// this only ever reads files already on disk. Contrast with
// `docs/adr/0002-grammar-sourcing.md`'s vendoring choice for Zed: Zed
// statically links tree-sitter grammars into its own binary and never lays
// them out as loose files on disk, so reading-from-install isn't an option
// there the way it is for VS Code's plain-file extension layout.
//
// Pure ES module: only synchronous fs reads, no subprocess, no network.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { stripJsonc } from "./fonts.mjs";
import { normalizeVscodeTheme } from "./theme.mjs";

/**
 * `resources/app/extensions` directories of known VS Code-family installs, most
 * specific/likely first. Best-effort: an install this list doesn't cover
 * (an unusual distro package, a Flatpak/Snap sandbox path) simply yields no
 * built-in grammars, and every affected language falls back to the generic
 * highlighter — the same degrade-gracefully posture as the rest of this
 * module.
 */
export const DEFAULT_APP_ROOTS = [
  "/usr/share/code/resources/app/extensions",
  "/usr/lib/code/resources/app/extensions",
  "/opt/visual-studio-code/resources/app/extensions",
  "/usr/share/code-insiders/resources/app/extensions",
  "/opt/visual-studio-code-insiders/resources/app/extensions",
  "/usr/share/codium/resources/app/extensions",
  "/usr/share/vscodium-bin/resources/app/extensions",
  "/opt/vscodium-bin/resources/app/extensions",
  "/usr/share/code-oss/resources/app/extensions",
  "/opt/cursor/resources/app/extensions",
  "/usr/share/cursor/resources/app/extensions",
];

/** User marketplace-extension directories for the same VS Code family, checked against `home`. */
export function defaultUserExtensionDirs(home = homedir()) {
  return [
    join(home, ".vscode/extensions"),
    join(home, ".vscode-insiders/extensions"),
    join(home, ".vscode-oss/extensions"),
    join(home, ".vscodium/extensions"),
    join(home, ".cursor/extensions"),
  ];
}

/**
 * `lib/language.mjs` id -> the VS Code language id its grammar is
 * registered under. Small and static (unlike the grammar lookup itself,
 * which is fully dynamic): VS Code's language ids for these are effectively
 * fixed, well-known strings, and keeping this table lets grammar discovery
 * below stay a single generic scan instead of a per-language special case.
 * Rust and Go are listed even though nothing ships one today (see the
 * module header) — installing a marketplace extension for either starts
 * working with no change here.
 */
export const LANGUAGE_TO_VSCODE_ID = {
  javascript: "javascript",
  typescript: "typescript",
  tsx: "typescriptreact",
  json: "json",
  yaml: "yaml",
  markdown: "markdown",
  python: "python",
  ruby: "ruby",
  c: "c",
  bash: "shellscript",
  lua: "lua",
  rust: "rust",
  go: "go",
};

/**
 * Read and parse a JSON file, tolerating comments and trailing commas
 * (`stripJsonc`) — package.json/package.nls.json are almost always strict
 * JSON, so this is a no-op for them, but real-world VS Code *theme* files
 * routinely aren't (confirmed on this machine: a community theme with
 * `// #region ...` comments), and VS Code's own theme loader accepts them.
 * A plain `JSON.parse` silently failing here (caught below, `null`) used
 * to degrade an entire resolved theme to zero `tokenColors` and no
 * `editor.foreground` — every span's colour then resolving to `null` and
 * failing `validateFixture`, crashing the snap outright instead of
 * degrading gracefully. Returns `null` on any read/parse failure.
 */
function readJson(path) {
  try {
    return JSON.parse(stripJsonc(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/** Every immediate subdirectory of `dir` that has a `package.json`, or `[]` if `dir` doesn't exist. */
function extensionDirsIn(dir) {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => join(dir, e.name))
    .filter((p) => existsSync(join(p, "package.json")));
}

/**
 * Scan `roots` (extension-root directories, each containing `<ext>/package.json`)
 * and build `{ byScope: Map<scopeName, absPath>, byLanguage: Map<vscodeLanguageId, scopeName> }`
 * from every extension's `contributes.grammars`. A later root's entry for
 * the same scope/language overrides an earlier one (user-installed
 * extensions are scanned after built-ins, so an explicit user choice wins).
 * A grammar with no `language` field (e.g. an embedded/dependency grammar
 * like `source.js.regexp`) is added to `byScope` only — exactly what a
 * `loadGrammar` include-resolution callback needs, without being a
 * top-level language entry point. Never throws: an unreadable or malformed
 * `package.json` is skipped.
 */
export function buildGrammarIndex(roots) {
  const byScope = new Map();
  const byLanguage = new Map();

  for (const root of roots) {
    for (const extDir of extensionDirsIn(root)) {
      const pkg = readJson(join(extDir, "package.json"));
      const grammars = pkg?.contributes?.grammars;
      if (!Array.isArray(grammars)) continue;

      for (const g of grammars) {
        if (typeof g?.scopeName !== "string" || typeof g?.path !== "string") continue;
        const absPath = isAbsolute(g.path) ? g.path : join(extDir, g.path);
        byScope.set(g.scopeName, absPath);
        if (typeof g.language === "string") byLanguage.set(g.language, g.scopeName);
      }
    }
  }

  return { byScope, byLanguage };
}

/** `buildGrammarIndex` over every existing default app root plus every existing default user-extension dir. */
export function buildDefaultGrammarIndex({ appRoots = DEFAULT_APP_ROOTS, userExtensionDirs = defaultUserExtensionDirs() } = {}) {
  return buildGrammarIndex([...appRoots, ...userExtensionDirs]);
}

/**
 * Resolve `languageId` (a `lib/language.mjs` id) to `{ scopeName, path }` via
 * `index`, or `null` if there's no VS Code id mapping for it
 * (`LANGUAGE_TO_VSCODE_ID`) or no installed extension grammars that id.
 */
export function resolveGrammar(languageId, index) {
  const vscodeId = LANGUAGE_TO_VSCODE_ID[languageId];
  if (!vscodeId) return null;
  const scopeName = index.byLanguage.get(vscodeId);
  if (!scopeName) return null;
  const path = index.byScope.get(scopeName);
  if (!path) return null;
  return { scopeName, path };
}

// --- the *active* VS Code colour theme (not Omarchy's own vscode-theme.json) ---
//
// docs/adr/0006-vscode-active-theme.md: colouring from Omarchy's own
// vscode-theme.json assumes the installed VS Code is actually set to the
// "Omarchy" theme it ships. It commonly isn't — a user's own long-standing
// preference (a popular theme they know well), or just a leftover from
// browsing the theme picker (VS Code updates workbench.colorTheme live as
// you arrow through it, before you've picked anything). Either way, the
// code OmaCodeSnap draws should match whatever VS Code is *actually* showing,
// not what Omarchy expects it to show — the same "editor-exact" standard
// Zed is already held to. This resolves and parses that real,
// active theme file directly, the same way `buildGrammarIndex` resolves a
// real grammar file: nothing here is specific to Omarchy's own theme.

/** VS Code's own `workbench.colorTheme` setting (a theme's `label`, not its `id`), or `null` if unset/unreadable. JSONC, like every VS Code settings file. */
export function readVscodeColorThemeSetting(home = homedir()) {
  const path = join(home, ".config/Code/User/settings.json");
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(stripJsonc(readFileSync(path, "utf8")));
    return typeof data["workbench.colorTheme"] === "string" ? data["workbench.colorTheme"] : null;
  } catch {
    return null;
  }
}

/** `<extDir>/package.nls.json` (localized string bundle), or `{}` if absent/unreadable. */
function readNlsBundle(extDir) {
  return readJson(join(extDir, "package.nls.json")) ?? {};
}

/** A theme's `label`/`id` field is sometimes an NLS reference (`"%foo%"`, resolved via the extension's own `package.nls.json`) — built-in themes ("Dark Modern", ...) do this; third-party ones almost never do. Returns `raw` unchanged if it isn't `%...%`-wrapped or the key isn't in `nls`. */
function resolveNlsString(raw, nls) {
  const m = /^%(.+)%$/.exec(raw);
  if (!m) return raw;
  return typeof nls[m[1]] === "string" ? nls[m[1]] : raw;
}

/**
 * Scan `roots` for every extension's `contributes.themes`, building
 * `Map<label, absPath>` — the same shape/merge behaviour as
 * `buildGrammarIndex` (a later root overrides an earlier one for the same
 * label). `label` is NLS-resolved, so VS Code's own built-in themes
 * ("Dark Modern", "Dark+", ...) are matchable by their real display name,
 * not their raw `%darkModernThemeLabel%` manifest string.
 */
export function buildThemeIndex(roots) {
  const byLabel = new Map();
  for (const root of roots) {
    for (const extDir of extensionDirsIn(root)) {
      const pkg = readJson(join(extDir, "package.json"));
      const themes = pkg?.contributes?.themes;
      if (!Array.isArray(themes)) continue;
      const nls = readNlsBundle(extDir);
      for (const t of themes) {
        if (typeof t?.label !== "string" || typeof t?.path !== "string") continue;
        const label = resolveNlsString(t.label, nls);
        const absPath = isAbsolute(t.path) ? t.path : join(extDir, t.path);
        byLabel.set(label, absPath);
      }
    }
  }
  return byLabel;
}

/** `buildThemeIndex` over every existing default app root plus every existing default user-extension dir. */
export function buildDefaultThemeIndex({ appRoots = DEFAULT_APP_ROOTS, userExtensionDirs = defaultUserExtensionDirs() } = {}) {
  return buildThemeIndex([...appRoots, ...userExtensionDirs]);
}

/**
 * Load a VS Code colour theme JSON file, following its `include` chain
 * (VS Code's own bundled themes lean on this heavily — "Dark Modern"
 * includes "Dark+" includes "Visual Studio Dark") to produce one merged
 * `{ name, type, colors, tokenColors, semanticTokenColors }`: `colors`/
 * `semanticTokenColors` shallow-merge (the includer's own keys win),
 * `tokenColors` concatenates base-then-includer (matching
 * `vscodeScopeStyle`'s own "later rule wins a tie" rule, so an includer's
 * override still wins). `seen` guards against a cyclic `include` (never
 * observed in practice, but a malformed/malicious theme could try).
 * Returns an empty theme shape for a missing/unreadable/cyclic file —
 * never throws.
 */
export function loadVscodeThemeFile(path, seen = new Set()) {
  const empty = { name: null, type: null, colors: {}, tokenColors: [], semanticTokenColors: {} };
  if (seen.has(path)) return empty;
  seen.add(path);

  const data = readJson(path);
  if (!data) return empty;

  const base = typeof data.include === "string" ? loadVscodeThemeFile(join(dirname(path), data.include), seen) : empty;

  return {
    name: data.name ?? base.name,
    type: data.type ?? base.type,
    colors: { ...base.colors, ...(data.colors ?? {}) },
    tokenColors: [...base.tokenColors, ...(Array.isArray(data.tokenColors) ? data.tokenColors : [])],
    semanticTokenColors: { ...base.semanticTokenColors, ...(data.semanticTokenColors ?? {}) },
  };
}

/**
 * The installed VS Code's *actual* active colour theme, normalised the
 * same way `lib/theme.mjs`'s `readTheme()` normalises Omarchy's own
 * `vscode-theme.json` (`normalizeVscodeTheme`) — a drop-in for
 * `theme.vscode` wherever `vscodeScopeStyle` is called. `null` when
 * nothing can be resolved (no settings file *and* no default theme found,
 * the configured theme's extension isn't installed, *or* its theme file
 * failed to read/parse and came back with nothing usable — a hollow
 * theme with zero `tokenColors` and no `editor.foreground` is exactly as
 * unusable as no theme at all, and returning one anyway used to make
 * every span's colour resolve to `null` and crash the snap instead of
 * falling back) — callers should fall back to Omarchy's own theme file in
 * that case, the same "degrade, never fail the snap" posture as
 * everywhere else in this module. `themeIndex` and `colorThemeSetting`
 * are injectable for tests.
 */
export function resolveActiveVscodeTheme({
  home = homedir(),
  appRoots = DEFAULT_APP_ROOTS,
  userExtensionDirs = defaultUserExtensionDirs(),
  themeIndex,
  colorThemeSetting,
} = {}) {
  const label = colorThemeSetting !== undefined ? colorThemeSetting : readVscodeColorThemeSetting(home);
  const index = themeIndex ?? buildThemeIndex([...appRoots, ...userExtensionDirs]);
  // VS Code's own real out-of-the-box default (no workbench.colorTheme set at all).
  const path = index.get(label ?? "Dark Modern");
  if (!path) return null;

  const raw = loadVscodeThemeFile(path);
  const hasUsableColour = raw.tokenColors.length > 0 || typeof raw.colors?.["editor.foreground"] === "string";
  if (!hasUsableColour) return null;

  return normalizeVscodeTheme(raw);
}
