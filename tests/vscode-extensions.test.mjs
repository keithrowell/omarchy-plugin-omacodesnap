import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGrammarIndex,
  buildDefaultGrammarIndex,
  resolveGrammar,
  LANGUAGE_TO_VSCODE_ID,
  DEFAULT_APP_ROOTS,
  defaultUserExtensionDirs,
  readVscodeColorThemeSetting,
  buildThemeIndex,
  buildDefaultThemeIndex,
  loadVscodeThemeFile,
  resolveActiveVscodeTheme,
} from "../lib/vscode-extensions.mjs";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "tests", "fixtures", "vscode-extensions");
const APP_ROOT = join(FIXTURES, "app-root");
const USER_EXTENSIONS = join(FIXTURES, "user-extensions");

test("buildGrammarIndex: reads scopeName/language from a fixture app-root's package.json files", () => {
  const index = buildGrammarIndex([APP_ROOT]);
  assert.equal(index.byLanguage.get("json"), "source.json");
  assert.ok(index.byScope.get("source.json").endsWith("JSON.tmLanguage.json"));
});

test("buildGrammarIndex: a scope-only grammar (no language field) is indexed for include-resolution but not as a language entry point", () => {
  const index = buildGrammarIndex([APP_ROOT]);
  assert.ok(index.byScope.has("source.js.regexp"));
  assert.ok(!index.byLanguage.has("source.js.regexp"));
});

test("buildGrammarIndex: merges an app root and a user-extensions root, later root wins", () => {
  const index = buildGrammarIndex([APP_ROOT, USER_EXTENSIONS]);
  assert.equal(index.byLanguage.get("json"), "source.json");
  assert.equal(index.byLanguage.get("lua"), "source.lua");
  assert.ok(index.byScope.get("source.lua").endsWith("lua.tmLanguage.json"));
});

test("buildGrammarIndex: an extension with no contributes.grammars (rust-analyzer) contributes nothing, never throws", () => {
  const index = buildGrammarIndex([USER_EXTENSIONS]);
  assert.equal(index.byLanguage.has("rust"), false);
});

test("buildGrammarIndex: a nonexistent root is skipped silently", () => {
  const index = buildGrammarIndex([join(FIXTURES, "does-not-exist"), APP_ROOT]);
  assert.equal(index.byLanguage.get("json"), "source.json");
});

test("resolveGrammar: javascript resolves to source.js and its file path", () => {
  const index = buildGrammarIndex([APP_ROOT]);
  const result = resolveGrammar("javascript", index);
  assert.deepEqual(result.scopeName, "source.js");
  assert.ok(result.path.endsWith("JavaScript.tmLanguage.json"));
});

test("resolveGrammar: a language with no LANGUAGE_TO_VSCODE_ID entry is null", () => {
  const index = buildGrammarIndex([APP_ROOT]);
  assert.equal(resolveGrammar("elixir", index), null);
});

test("resolveGrammar: a language in the map but not present in the index (rust, nothing installed) is null", () => {
  const index = buildGrammarIndex([APP_ROOT, USER_EXTENSIONS]);
  assert.ok("rust" in LANGUAGE_TO_VSCODE_ID);
  assert.equal(resolveGrammar("rust", index), null);
});

test("resolveGrammar: lua resolves once a user extension provides it, even though the app root has none", () => {
  const appOnly = buildGrammarIndex([APP_ROOT]);
  assert.equal(resolveGrammar("lua", appOnly), null);

  const withUser = buildGrammarIndex([APP_ROOT, USER_EXTENSIONS]);
  assert.deepEqual(withUser.byLanguage.get("lua"), "source.lua");
  assert.equal(resolveGrammar("lua", withUser).scopeName, "source.lua");
});

test("DEFAULT_APP_ROOTS: every candidate ends in /extensions — extensionDirsIn scans a root directly, not root/extensions", () => {
  // Regression: these once pointed at .../resources/app (missing the
  // final segment), so buildDefaultGrammarIndex() silently found nothing
  // on every real machine, all the way through this feature's build,
  // without a single test catching it (every other test here injects its
  // own root, which was always correct).
  for (const root of DEFAULT_APP_ROOTS) {
    assert.ok(root.endsWith("/extensions"), `expected ${root} to end with /extensions`);
  }
});

test("buildDefaultGrammarIndex: resolves a real built-in grammar when a known VS Code install is actually present on this machine", () => {
  if (!DEFAULT_APP_ROOTS.some((root) => existsSync(root))) return; // hermetic elsewhere: skip rather than assume an install
  const index = buildDefaultGrammarIndex();
  const resolved = resolveGrammar("javascript", index);
  assert.ok(resolved, "expected a real installed VS Code to provide a javascript grammar");
  assert.ok(existsSync(resolved.path));
});

test("defaultUserExtensionDirs: derives every candidate path from the given home", () => {
  const dirs = defaultUserExtensionDirs("/home/nobody");
  assert.ok(dirs.includes("/home/nobody/.vscode/extensions"));
  assert.ok(dirs.every((d) => d.startsWith("/home/nobody/")));
});

// --- the active VS Code theme (docs/adr/0006-vscode-active-theme.md) -------

test("buildThemeIndex: reads label/path from a fixture extension's contributes.themes", () => {
  const index = buildThemeIndex([APP_ROOT]);
  assert.ok(index.get("Fixture Dark").endsWith("fixture-dark-base.json"));
  assert.ok(index.get("Fixture Dark Child").endsWith("fixture-dark-child.json"));
});

test("buildThemeIndex: an NLS-wrapped label (%key%) resolves via the extension's own package.nls.json", () => {
  const index = buildThemeIndex([APP_ROOT]);
  assert.ok(index.get("Fixture NLS Resolved"), "expected the resolved label, not the raw %nlsLabel% placeholder");
  assert.equal(index.has("%nlsLabel%"), false);
});

test("loadVscodeThemeFile: a standalone theme (no include) loads as-is", () => {
  const path = buildThemeIndex([APP_ROOT]).get("Fixture Dark");
  const theme = loadVscodeThemeFile(path);
  assert.equal(theme.tokenColors.length, 2);
  assert.equal(theme.tokenColors.find((r) => r.scope === "keyword").settings.foreground, "#ff0000");
});

test("loadVscodeThemeFile: include chains base-then-child, colors shallow-merge (child wins), tokenColors concatenate (child's rule still wins a tie, later-declared)", () => {
  const path = buildThemeIndex([APP_ROOT]).get("Fixture Dark Child");
  const theme = loadVscodeThemeFile(path);
  assert.equal(theme.colors["editor.background"], "#000000"); // child override
  assert.equal(theme.colors["editor.foreground"], "#e0e0e0"); // inherited from base, not overridden
  assert.equal(theme.tokenColors.length, 3); // base's 2 + child's own 1
  assert.equal(theme.tokenColors[0].settings.foreground, "#ff0000"); // base's keyword rule, first
  assert.equal(theme.tokenColors[2].settings.foreground, "#00ff00"); // child's keyword override, last (wins the tie)
});

test("loadVscodeThemeFile: a missing file degrades to an empty theme shape, never throws", () => {
  const theme = loadVscodeThemeFile("/does/not/exist.json");
  assert.deepEqual(theme, { name: null, type: null, colors: {}, tokenColors: [], semanticTokenColors: {} });
});

test("resolveActiveVscodeTheme: resolves the configured label to a normalised theme, tokenColors' scope always an array", () => {
  const themeIndex = buildThemeIndex([APP_ROOT]);
  const theme = resolveActiveVscodeTheme({ colorThemeSetting: "Fixture Dark Child", themeIndex });
  assert.ok(theme);
  assert.equal(theme.colors["editor.background"], "#000000");
  assert.deepEqual(theme.tokenColors.find((r) => r.settings.foreground === "#00ff00").scope, ["keyword"]);
});

test("resolveActiveVscodeTheme: no configured theme falls back to VS Code's own default label, 'Dark Modern'", () => {
  const themeIndex = new Map([["Dark Modern", buildThemeIndex([APP_ROOT]).get("Fixture Dark")]]);
  const theme = resolveActiveVscodeTheme({ colorThemeSetting: null, themeIndex });
  assert.ok(theme);
  assert.equal(theme.name, "Fixture Dark");
});

test("resolveActiveVscodeTheme: a configured theme with no matching installed extension -> null", () => {
  const theme = resolveActiveVscodeTheme({ colorThemeSetting: "Some Theme Nobody Has", themeIndex: buildThemeIndex([APP_ROOT]) });
  assert.equal(theme, null);
});

test("readVscodeColorThemeSetting: reads workbench.colorTheme from a fixture settings.json (JSONC, trailing comma and all)", () => {
  const dir = mkdtempSync(join(tmpdir(), "omacodesnap-vscode-settings-"));
  try {
    // readVscodeColorThemeSetting reads "<home>/.config/Code/User/settings.json" — build that structure under a temp home.
    const fakeHome = join(dir, "fakehome");
    mkdirDeep(join(fakeHome, ".config/Code/User"));
    writeFileSync(join(fakeHome, ".config/Code/User/settings.json"), '{ "workbench.colorTheme": "Gruvbox Dark Medium", "update.mode": "none", }');
    assert.equal(readVscodeColorThemeSetting(fakeHome), "Gruvbox Dark Medium");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readVscodeColorThemeSetting: no settings file, or no workbench.colorTheme key, is null", () => {
  const dir = mkdtempSync(join(tmpdir(), "omacodesnap-vscode-settings-"));
  try {
    assert.equal(readVscodeColorThemeSetting(dir), null); // no .config/Code/User/settings.json at all
    mkdirDeep(join(dir, ".config/Code/User"));
    writeFileSync(join(dir, ".config/Code/User/settings.json"), '{ "update.mode": "none" }');
    assert.equal(readVscodeColorThemeSetting(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function mkdirDeep(dir) {
  mkdirSync(dir, { recursive: true });
}

// Regression: a real installed theme (jovejonovski.ocean-green's) has a
// `// #region ...` line comment in its theme JSON — plain `JSON.parse`
// threw, `readJson` swallowed it to `null`, and the resolved theme silently
// came back with zero `tokenColors` and no `editor.foreground`. Every
// span's colour then resolved to `null`, which isn't a valid fixture colour
// — `validateFixture` rejected it and the *entire snap* crashed
// ("lines[0][0].color: must be a string") instead of falling back to
// Omarchy's own theme. Caught live, against this exact real file, not
// found by any test before shipping it.
test("loadVscodeThemeFile: a theme file with JSONC comments (a real community theme's actual shape) parses instead of silently returning nothing", () => {
  const path = buildThemeIndex([APP_ROOT]).get("Fixture JSONC");
  const theme = loadVscodeThemeFile(path);
  assert.equal(theme.colors["editor.background"], "#101010");
  assert.equal(theme.tokenColors[0].settings.foreground, "#ff00ff");
});

test("resolveActiveVscodeTheme: a theme resolved to a real file with nothing usable in it (no tokenColors, no editor.foreground) is null, not a hollow theme", () => {
  const themeIndex = buildThemeIndex([APP_ROOT]);
  const theme = resolveActiveVscodeTheme({ colorThemeSetting: "Fixture Empty", themeIndex });
  assert.equal(theme, null);
});

test("resolveActiveVscodeTheme: a JSONC theme file resolves to a real, usable theme end to end (not just loadVscodeThemeFile in isolation)", () => {
  const themeIndex = buildThemeIndex([APP_ROOT]);
  const theme = resolveActiveVscodeTheme({ colorThemeSetting: "Fixture JSONC", themeIndex });
  assert.ok(theme);
  assert.equal(theme.colors["editor.foreground"], "#e0e0e0");
});

test("buildDefaultThemeIndex + resolveActiveVscodeTheme: resolves this machine's real active VS Code theme, if one is installed", () => {
  if (!DEFAULT_APP_ROOTS.some((root) => existsSync(root))) return; // hermetic elsewhere: skip rather than assume an install
  const theme = resolveActiveVscodeTheme();
  // Some machine somewhere might have workbench.colorTheme pointing at a
  // theme whose extension got removed since — that's a real null, not a
  // test failure. What matters is it never throws and, when it does
  // resolve, the shape is right.
  if (theme) {
    assert.equal(typeof theme.colors, "object");
    assert.ok(Array.isArray(theme.tokenColors));
  }
});
