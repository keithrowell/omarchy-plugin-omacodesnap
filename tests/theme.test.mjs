import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseColors, readTheme, zedSyntaxStyle, vscodeScopeStyle, parseFontStyle } from "../lib/theme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "tests", "fixtures", "themes");
const GRUVBOX = join(FIXTURES, "gruvbox-dark", "theme");
const FLEXOKI = join(FIXTURES, "flexoki-light", "theme");

const THEME_KEYS = [
  "mode", "accent", "selection", "muted",
  "background", "dark_background", "darker_background", "lighter_background",
  "foreground", "dark_foreground", "light_foreground", "bright_foreground",
  "red", "yellow", "orange", "green", "cyan", "blue", "magenta", "brown",
  "bright_red", "bright_yellow", "bright_green", "bright_cyan", "bright_blue", "bright_magenta",
];

function scratchDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// --- parseColors ---------------------------------------------------------

test("parseColors reads every key from both real colors.toml fixtures", () => {
  for (const dir of [GRUVBOX, FLEXOKI]) {
    const colors = parseColors(readFileSync(join(dir, "colors.toml"), "utf8"));
    for (const key of THEME_KEYS) {
      assert.ok(key in colors, `${key} missing from ${dir}`);
    }
  }
});

test("parseColors reports mode light vs dark", () => {
  assert.equal(parseColors(readFileSync(join(GRUVBOX, "colors.toml"), "utf8")).mode, "dark");
  assert.equal(parseColors(readFileSync(join(FLEXOKI, "colors.toml"), "utf8")).mode, "light");
});

test("parseColors strips a trailing comment and keeps a quoted inline string", () => {
  const text = '# header comment\naccent = "#7daea3" # trailing comment\nmuted = \'#665c54\'\n';
  assert.deepEqual(parseColors(text), { accent: "#7daea3", muted: "#665c54" });
});

test("parseColors accepts a bare (unquoted) value", () => {
  assert.deepEqual(parseColors("mode = dark"), { mode: "dark" });
});

test("parseColors skips blank lines", () => {
  assert.deepEqual(parseColors('\n\n  \naccent = "#111111"\n\n'), { accent: "#111111" });
});

test("parseColors throws on a malformed line, naming the line number and text", () => {
  assert.throws(
    () => parseColors('accent = "#7daea3"\nthis is not key = value\n'),
    /colors\.toml line 2: this is not key = value/,
  );
});

test("parseColors returns {} for empty or non-string input", () => {
  assert.deepEqual(parseColors(""), {});
  assert.deepEqual(parseColors(undefined), {});
  assert.deepEqual(parseColors(null), {});
});

// --- readTheme -------------------------------------------------------------

test("readTheme(gruvbox-dark) resolves name, mode, zed, vscode, wallpaper", () => {
  const t = readTheme(GRUVBOX);
  assert.equal(t.name, "gruvbox-dark");
  assert.equal(t.mode, "dark");
  assert.equal(t.zed.appearance, "dark");
  assert.equal(t.zed.style.editorBackground, t.zed.raw["editor.background"]);
  assert.equal(t.zed.style.selectionBackground, t.zed.raw.players[0].selection);
  assert.equal(t.zed.syntax.comment.fontStyle, "italic");
  assert.equal(t.vscode.type, "dark");
  assert.ok(Array.isArray(t.vscode.tokenColors[0].scope));
  // A real Omarchy theme's `background` is a symlink into `backgrounds/`;
  // this fixture's is a plain file (the marketplace's validator forbids
  // symlinks anywhere in the repo — ADR-0003, and see the dedicated
  // symlink-following test above).
  assert.ok(t.wallpaper.endsWith(join("gruvbox-dark", "background")));
  assert.ok(t.wallpaper.startsWith("/"));
});

test("readTheme(flexoki-light) resolves the light theme, colours differ from gruvbox", () => {
  const gruvbox = readTheme(GRUVBOX);
  const t = readTheme(FLEXOKI);
  assert.equal(t.mode, "light");
  assert.equal(t.zed.appearance, "light");
  assert.equal(t.vscode.type, "light");
  assert.notEqual(t.zed.style.editorBackground, gruvbox.zed.style.editorBackground);
  assert.notEqual(t.colors.accent, gruvbox.colors.accent);
});

test("readTheme reads vscode.json into vscode.descriptor", () => {
  const t = readTheme(GRUVBOX);
  assert.deepEqual(t.vscode.descriptor, { name: "Gruvbox Dark Hard", extension: "jdinhlife.gruvbox" });
});

test("readTheme throws when colors.toml is missing", () => {
  const dir = scratchDir("omacodesnap-theme-missing-colors-");
  assert.throws(() => readTheme(dir));
  rmSync(dir, { recursive: true, force: true });
});

test("readTheme picks the themes[] entry whose appearance matches mode", () => {
  const dir = scratchDir("omacodesnap-theme-multi-");
  writeFileSync(join(dir, "colors.toml"), 'mode = "dark"\n');
  writeFileSync(
    join(dir, "zed-theme.json"),
    JSON.stringify({
      themes: [
        { name: "light-one", appearance: "light", style: { syntax: {} } },
        { name: "dark-one", appearance: "dark", style: { syntax: {} } },
      ],
    }),
  );
  assert.equal(readTheme(dir).zed.name, "dark-one");
  rmSync(dir, { recursive: true, force: true });
});

test("readTheme falls back to themes[0] when no appearance matches", () => {
  const dir = scratchDir("omacodesnap-theme-multi-nomatch-");
  writeFileSync(join(dir, "colors.toml"), 'mode = "dark"\n');
  writeFileSync(
    join(dir, "zed-theme.json"),
    JSON.stringify({ themes: [{ name: "only-one", appearance: "weird", style: { syntax: {} } }] }),
  );
  assert.equal(readTheme(dir).zed.name, "only-one");
  rmSync(dir, { recursive: true, force: true });
});

test("readTheme returns null vscode when its file is absent, other keys still populated", () => {
  const dir = scratchDir("omacodesnap-theme-noopt-");
  writeFileSync(join(dir, "colors.toml"), 'mode = "dark"\naccent = "#111111"\n');
  const t = readTheme(dir);
  assert.equal(t.vscode, null);
  assert.equal(t.colors.accent, "#111111");
  rmSync(dir, { recursive: true, force: true });
});

test("readTheme synthesizes a generic zed theme from colors.toml when zed-theme.json is absent", () => {
  // No stock Omarchy theme ships a zed-theme.json — only a handful of
  // hand-authored community themes do. Without a synthesized fallback,
  // every one of those installs would render plain, uncoloured text (and,
  // before this, would have thrown inside highlight() the moment a
  // recognised language actually needed theme.zed.syntax).
  const dir = scratchDir("omacodesnap-theme-synth-");
  writeFileSync(
    join(dir, "colors.toml"),
    [
      'mode = "dark"',
      'accent = "#88c0d0"',
      'background = "#2e3440"',
      'foreground = "#d8dee9"',
      'lighter_background = "#3b4252"',
      'dark_background = "#242933"',
      'darker_background = "#1c212b"',
      'red = "#bf616a"',
      'green = "#a3be8c"',
      'yellow = "#ebcb8b"',
      'blue = "#81a1c1"',
      'magenta = "#b48ead"',
      'cyan = "#88c0d0"',
      'orange = "#d08770"',
    ].join("\n"),
  );
  const t = readTheme(dir);
  assert.notEqual(t.zed, null);
  assert.equal(t.zed.appearance, "dark");
  assert.equal(t.zed.style.editorBackground, t.colors.background);
  assert.equal(t.zed.style.editorForeground, t.colors.foreground);
  assert.equal(t.zed.syntax.string.color, t.colors.green);
  assert.equal(t.zed.syntax.comment.fontStyle, "italic");
  rmSync(dir, { recursive: true, force: true });
});

test("readTheme's synthesized zed theme never throws even when colors.toml is missing most keys", () => {
  const dir = scratchDir("omacodesnap-theme-synth-minimal-");
  writeFileSync(join(dir, "colors.toml"), 'mode = "dark"\n');
  const t = readTheme(dir);
  assert.notEqual(t.zed, null);
  // Every colour resolves to *something* real (never undefined, never a
  // crash) — the exact value doesn't matter here, only that there is one.
  for (const capture of Object.values(t.zed.syntax)) {
    assert.match(capture.color, /^#[0-9a-f]{6}$/);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("readTheme resolves wallpaper as null when background is absent", () => {
  const dir = scratchDir("omacodesnap-theme-nowallpaper-");
  writeFileSync(join(dir, "colors.toml"), 'mode = "dark"\n');
  assert.equal(readTheme(dir).wallpaper, null);
  rmSync(dir, { recursive: true, force: true });
});

test("readTheme resolves wallpaper through a real symlink to its target", () => {
  // A real Omarchy theme's `background` is always a symlink into its
  // `theme/backgrounds/` directory; the committed fixtures under
  // tests/fixtures/themes/ use a plain file instead (the marketplace's
  // plugin validator forbids symlinks anywhere in the repo — ADR-0003), so
  // this behaviour is covered here with a symlink created at test time,
  // never committed.
  const dir = scratchDir("omacodesnap-theme-symlink-");
  const themeDir = join(dir, "theme");
  const backgroundsDir = join(themeDir, "backgrounds");
  mkdirSync(backgroundsDir, { recursive: true });
  writeFileSync(join(themeDir, "colors.toml"), 'mode = "dark"\n');
  const target = join(backgroundsDir, "wallpaper.webp");
  writeFileSync(target, "not a real image, just needs to exist");
  symlinkSync(target, join(dir, "background"));
  assert.equal(readTheme(themeDir).wallpaper, target);
  rmSync(dir, { recursive: true, force: true });
});

test("readTheme resolves wallpaper as null when background is a dangling symlink", () => {
  const dir = scratchDir("omacodesnap-theme-dangling-");
  const themeDir = join(dir, "theme");
  writeFileSync(join(dir, "theme.name"), "scratch\n");
  mkdirSync(themeDir, { recursive: true });
  writeFileSync(join(themeDir, "colors.toml"), 'mode = "dark"\n');
  symlinkSync(join(themeDir, "backgrounds", "nope.webp"), join(dir, "background"));
  assert.equal(readTheme(themeDir).wallpaper, null);
  rmSync(dir, { recursive: true, force: true });
});

test("readTheme falls back to the theme dir's basename when theme.name is missing", () => {
  const dir = scratchDir("omacodesnap-theme-noname-");
  writeFileSync(join(dir, "colors.toml"), 'mode = "dark"\n');
  const t = readTheme(dir);
  assert.equal(t.name, basename(dir));
  rmSync(dir, { recursive: true, force: true });
});

test("readTheme never caches: rereading after an edit sees the new value", () => {
  const dir = scratchDir("omacodesnap-theme-nocache-");
  cpSync(GRUVBOX, dir, { recursive: true });
  const before = readTheme(dir).colors.accent;
  const text = readFileSync(join(dir, "colors.toml"), "utf8").replace(before, "#123456");
  writeFileSync(join(dir, "colors.toml"), text);
  const after = readTheme(dir).colors.accent;
  assert.notEqual(before, after);
  assert.equal(after, "#123456");
  rmSync(dir, { recursive: true, force: true });
});

// --- zedSyntaxStyle ----------------------------------------------------------

test("zedSyntaxStyle: exact capture match", () => {
  const t = readTheme(GRUVBOX);
  const style = zedSyntaxStyle(t.zed, "punctuation.bracket");
  assert.deepEqual(style, t.zed.syntax["punctuation.bracket"]);
});

test("zedSyntaxStyle: falls back by dropping the last dotted segment", () => {
  const t = readTheme(GRUVBOX);
  assert.deepEqual(zedSyntaxStyle(t.zed, "function.method"), t.zed.syntax.function);
  assert.deepEqual(zedSyntaxStyle(t.zed, "punctuation.bracket.x"), t.zed.syntax["punctuation.bracket"]);
});

test("zedSyntaxStyle: no match at all falls back to the editor foreground", () => {
  const t = readTheme(GRUVBOX);
  assert.deepEqual(zedSyntaxStyle(t.zed, "zzz.yyy"), {
    color: t.zed.style.editorForeground,
    fontStyle: null,
    fontWeight: null,
  });
});

test("zedSyntaxStyle: throws when zed is null", () => {
  assert.throws(() => zedSyntaxStyle(null, "comment"), /no Zed theme loaded/);
});

// --- vscodeScopeStyle --------------------------------------------------------

test("vscodeScopeStyle: comment rule's colour and italic fontStyle", () => {
  const t = readTheme(GRUVBOX);
  const style = vscodeScopeStyle(t.vscode, ["source.js", "comment.line.js"]);
  assert.equal(style.fontStyle, "italic");
  assert.equal(style.color, "#665c54");
});

test("vscodeScopeStyle: variable.parameter beats plain variable", () => {
  const t = readTheme(GRUVBOX);
  const style = vscodeScopeStyle(t.vscode, ["source.js", "variable.parameter.js"]);
  assert.equal(style.color, "#89b482");
  assert.equal(style.fontStyle, "italic");
});

test("vscodeScopeStyle: descendant selector matches only when the ancestor scope is present", () => {
  const vscode = {
    tokenColors: [
      { scope: ["variable"], settings: { foreground: "#111111" } },
      { scope: ["string constant.other.placeholder"], settings: { foreground: "#222222" } },
    ],
    colors: { "editor.foreground": "#ffffff" },
  };
  const withAncestor = vscodeScopeStyle(vscode, ["source.js", "string.quoted.js", "constant.other.placeholder.js"]);
  assert.equal(withAncestor.color, "#222222");

  const withoutAncestor = vscodeScopeStyle(vscode, ["source.js", "constant.other.placeholder.js"]);
  assert.equal(withoutAncestor.color, "#ffffff");
});

test("vscodeScopeStyle: unknown scope falls back to editor.foreground", () => {
  const t = readTheme(GRUVBOX);
  const style = vscodeScopeStyle(t.vscode, ["zzz.totally.unknown"]);
  assert.equal(style.color, t.vscode.colors["editor.foreground"]);
});

test("vscodeScopeStyle: throws when vscode is null", () => {
  assert.throws(() => vscodeScopeStyle(null, ["source.js"]), /no VS Code theme loaded/);
});

test("vscodeScopeStyle: a later rule wins ties at the same specificity", () => {
  const vscode = {
    tokenColors: [
      { scope: ["keyword"], settings: { foreground: "#111111" } },
      { scope: ["keyword"], settings: { foreground: "#222222" } },
    ],
    colors: { "editor.foreground": "#ffffff" },
  };
  assert.equal(vscodeScopeStyle(vscode, ["keyword.control.js"]).color, "#222222");
});

test("vscodeScopeStyle: an explicit empty fontStyle resets to none", () => {
  const vscode = {
    tokenColors: [{ scope: ["keyword"], settings: { foreground: "#111111", fontStyle: "" } }],
    colors: { "editor.foreground": "#ffffff" },
  };
  const style = vscodeScopeStyle(vscode, ["keyword.control.js"]);
  assert.equal(style.fontStyle, null);
  assert.equal(style.fontWeight, null);
  assert.equal(style.underline, false);
});

test("vscodeScopeStyle: exclusion selectors starting with - are ignored", () => {
  const vscode = {
    tokenColors: [{ scope: ["-comment", "keyword"], settings: { foreground: "#333333" } }],
    colors: { "editor.foreground": "#ffffff" },
  };
  assert.equal(vscodeScopeStyle(vscode, ["comment.line.js"]).color, "#ffffff");
  assert.equal(vscodeScopeStyle(vscode, ["keyword.control.js"]).color, "#333333");
});

// --- parseFontStyle -----------------------------------------------------------

test("parseFontStyle parses italic, bold, underline in combination", () => {
  assert.deepEqual(parseFontStyle("italic bold underline"), { fontStyle: "italic", fontWeight: 700, underline: true });
  assert.deepEqual(parseFontStyle("italic"), { fontStyle: "italic", fontWeight: null, underline: false });
  assert.deepEqual(parseFontStyle(""), { fontStyle: null, fontWeight: null, underline: false });
  assert.deepEqual(parseFontStyle(undefined), { fontStyle: null, fontWeight: null, underline: false });
});
