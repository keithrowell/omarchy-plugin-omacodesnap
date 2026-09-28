import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { validateFixture, resolveSpans, buildInput, CONSTANTS, parseUserShellFont, parseThemeShellFont, readHeaderFont } from "../lib/input.mjs";
import { readTheme } from "../lib/theme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RENDER_FIXTURES = join(ROOT, "tests", "fixtures", "render");
const HELLO_PATH = join(RENDER_FIXTURES, "hello.json");
const LONG_PATH = join(RENDER_FIXTURES, "long.json");
const HELLO = JSON.parse(readFileSync(HELLO_PATH, "utf8"));
const LONG = JSON.parse(readFileSync(LONG_PATH, "utf8"));

const GRUVBOX_DIR = join(ROOT, "tests", "fixtures", "themes", "gruvbox-dark", "theme");
const FLEXOKI_DIR = join(ROOT, "tests", "fixtures", "themes", "flexoki-light", "theme");
const GRUVBOX = readTheme(GRUVBOX_DIR);
const FLEXOKI = readTheme(FLEXOKI_DIR);

function scratchDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// --- validateFixture -------------------------------------------------------

test("validateFixture accepts both committed render fixtures", () => {
  assert.doesNotThrow(() => validateFixture(HELLO));
  assert.doesNotThrow(() => validateFixture(LONG));
});

test("validateFixture throws naming the path of a span missing text", () => {
  const broken = structuredClone(HELLO);
  delete broken.lines[3][1].text;
  assert.throws(() => validateFixture(broken), /lines\[3\]\[1\]\.text/);
});

test("validateFixture throws naming the path of a line that is not an array", () => {
  const broken = structuredClone(HELLO);
  broken.lines[2] = { text: "not a line" };
  assert.throws(() => validateFixture(broken), /lines\[2\]/);
});

// --- validateFixture: subtitle/showGutter/compact (OmaWordl share-fit) ----

test("validateFixture: subtitle absent, or explicitly null, or a string, are all accepted", () => {
  assert.doesNotThrow(() => validateFixture(HELLO)); // absent
  assert.doesNotThrow(() => validateFixture({ ...HELLO, subtitle: null }));
  assert.doesNotThrow(() => validateFixture({ ...HELLO, subtitle: "OmaWordl 1" }));
});

test("validateFixture: subtitle throws naming its path when neither a string nor null", () => {
  assert.throws(() => validateFixture({ ...HELLO, subtitle: 42 }), /subtitle: must be a string or null/);
});

test("validateFixture: showGutter absent, true, or false are all accepted", () => {
  assert.doesNotThrow(() => validateFixture(HELLO)); // absent
  assert.doesNotThrow(() => validateFixture({ ...HELLO, showGutter: true }));
  assert.doesNotThrow(() => validateFixture({ ...HELLO, showGutter: false }));
});

test("validateFixture: showGutter throws naming its path when not a boolean", () => {
  assert.throws(() => validateFixture({ ...HELLO, showGutter: "false" }), /showGutter: must be a boolean/);
});

test("validateFixture: compact absent, true, or false are all accepted", () => {
  assert.doesNotThrow(() => validateFixture(HELLO)); // absent
  assert.doesNotThrow(() => validateFixture({ ...HELLO, compact: true }));
  assert.doesNotThrow(() => validateFixture({ ...HELLO, compact: false }));
});

test("validateFixture: compact throws naming its path when not a boolean", () => {
  assert.throws(() => validateFixture({ ...HELLO, compact: 1 }), /compact: must be a boolean/);
});

// --- validateFixture: centerContent (ADR-0011) ----------------------------

test("validateFixture: centerContent absent, true, or false are all accepted", () => {
  assert.doesNotThrow(() => validateFixture(HELLO)); // absent
  assert.doesNotThrow(() => validateFixture({ ...HELLO, centerContent: true }));
  assert.doesNotThrow(() => validateFixture({ ...HELLO, centerContent: false }));
});

test("validateFixture: centerContent throws naming its path when not a boolean", () => {
  assert.throws(() => validateFixture({ ...HELLO, centerContent: "true" }), /centerContent: must be a boolean/);
});

// --- resolveSpans ------------------------------------------------------------

function flat(lines) {
  return lines.flat();
}

test("resolveSpans(gruvbox): keyword gets zed's syntax colour and font weight", () => {
  const resolved = resolveSpans([[{ text: "function", capture: "keyword" }]], GRUVBOX);
  const expected = GRUVBOX.zed.syntax.keyword;
  assert.equal(resolved[0][0].color, expected.color);
  assert.equal(resolved[0][0].fontWeight, expected.fontWeight ?? null);
});

test("resolveSpans(gruvbox): an unknown dotted capture falls back to its parent (punctuation.delimiter)", () => {
  const resolved = resolveSpans([[{ text: ";", capture: "punctuation.delimiter.x" }]], GRUVBOX);
  const expected = GRUVBOX.zed.syntax["punctuation.delimiter"];
  assert.equal(resolved[0][0].color, expected.color);
});

test("resolveSpans(gruvbox): a capture with no match at all gets the editor foreground", () => {
  const resolved = resolveSpans([[{ text: "x", capture: "totally.unknown.capture" }]], GRUVBOX);
  assert.equal(resolved[0][0].color, GRUVBOX.zed.style.editorForeground);
});

test("resolveSpans: an explicit color passes through unchanged, ignoring any capture", () => {
  const resolved = resolveSpans([[{ text: "x", capture: "keyword", color: "#123456", fontStyle: "italic" }]], GRUVBOX);
  assert.deepEqual(resolved[0][0], { text: "x", color: "#123456", fontStyle: "italic", fontWeight: null });
});

test("resolveSpans: a tab expands to the next multiple of 4 columns", () => {
  const resolved = resolveSpans([[{ text: "ab\tc" }]], GRUVBOX);
  assert.equal(resolved[0][0].text, "ab  c"); // column 2 -> pad 2 to reach column 4
  const resolved2 = resolveSpans([[{ text: "a" }, { text: "\t" }]], GRUVBOX);
  assert.equal(resolved2[0].map((s) => s.text).join(""), "a   "); // column 1 -> pad 3
});

test("resolveSpans(gruvbox): every fixture line's spans concatenate to the original text (tabs expanded)", () => {
  for (const fixture of [HELLO, LONG]) {
    const resolved = resolveSpans(fixture.lines, GRUVBOX);
    resolved.forEach((line, i) => {
      const original = fixture.lines[i].map((s) => s.text).join("");
      assert.equal(line.map((s) => s.text).join(""), original, `line ${i}`);
    });
  }
});

test("resolveSpans(flexoki): colours differ from gruvbox for the same captures", () => {
  const spans = [
    { text: "function", capture: "keyword" },
    { text: "// hi", capture: "comment" },
    { text: "x", capture: "string" },
  ];
  const g = resolveSpans([spans], GRUVBOX)[0];
  const f = resolveSpans([spans], FLEXOKI)[0];
  g.forEach((span, i) => {
    assert.notEqual(span.color, f[i].color, spans[i].capture);
  });
});

// --- buildInput --------------------------------------------------------------

test("buildInput: a missing wallpaper file resolves to null", () => {
  const input = buildInput({ snap: HELLO, theme: GRUVBOX, wallpaperOverride: "/no/such/file.webp" });
  assert.equal(input.theme.wallpaper, null);
});

test("buildInput: the fixture theme's own wallpaper resolves to an absolute path", () => {
  // The marketplace's plugin validator forbids symlinks anywhere in the
  // repo, so this fixture's `background` is a plain file, not the symlink
  // a real Omarchy theme directory uses — readTheme()'s symlink-following
  // is covered directly, with a runtime-created symlink, in
  // tests/theme.test.mjs ("resolves wallpaper through a real symlink").
  const input = buildInput({ snap: HELLO, theme: GRUVBOX });
  assert.ok(input.theme.wallpaper, "expected a wallpaper path");
  assert.ok(isAbsolute(input.theme.wallpaper));
  assert.ok(input.theme.wallpaper.endsWith("background"));
});

test("buildInput: a relative --wallpaper resolves to an absolute path (Snap.qml needs one for its file:// URL)", () => {
  const relativeWallpaper = relative(process.cwd(), GRUVBOX.wallpaper);
  assert.ok(!isAbsolute(relativeWallpaper), "test setup: expected a relative path to exercise");
  const input = buildInput({ snap: HELLO, theme: GRUVBOX, wallpaperOverride: relativeWallpaper });
  assert.equal(input.theme.wallpaper, resolve(relativeWallpaper));
  assert.ok(isAbsolute(input.theme.wallpaper));
});

test("buildInput: theme.editor.* is populated from Zed when a zed theme is loaded", () => {
  const input = buildInput({ snap: HELLO, theme: GRUVBOX });
  assert.equal(input.theme.editor.background, GRUVBOX.zed.style.editorBackground);
  assert.equal(input.theme.editor.foreground, GRUVBOX.zed.style.editorForeground);
  assert.equal(input.theme.editor.lineNumber, GRUVBOX.zed.style.lineNumber);
});

test("buildInput: a theme with no Zed file still colours from a synthesized one, matching colors.toml's background/foreground", () => {
  // Most Omarchy themes ship no zed-theme.json at all — readTheme()
  // synthesizes a generic one from colors.toml (synthesizeZedTheme) rather
  // than leaving `zed` null, so this never falls all the way back to flat,
  // uncoloured text (tests/theme.test.mjs covers the synthesis itself).
  const dir = scratchDir("omacodesnap-input-novscode-");
  try {
    writeFileSync(
      join(dir, "colors.toml"),
      [
        'mode = "dark"',
        'accent = "#7daea3"',
        'selection = "#504945"',
        'muted = "#665c54"',
        'background = "#161616"',
        'dark_background = "#0e0e0e"',
        'darker_background = "#080808"',
        'lighter_background = "#282828"',
        'foreground = "#d4be98"',
        'dark_foreground = "#7c6f64"',
        'light_foreground = "#bdae93"',
        'bright_foreground = "#d4be98"',
      ].join("\n"),
    );
    const theme = readTheme(dir);
    assert.notEqual(theme.zed, null);
    const input = buildInput({ snap: HELLO, theme });
    assert.equal(input.theme.editor.background, theme.colors.background);
    assert.equal(input.theme.editor.foreground, theme.colors.foreground);
    const resolved = resolveSpans([[{ text: "function", capture: "keyword" }]], theme);
    assert.ok(/^#[0-9a-f]{6}$/.test(resolved[0][0].color), "expected a real colour, not a crash or a missing value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- look (Hyprland's chrome, see lib/hypr.mjs) ---------------------------

test("buildInput: an explicit look passes straight through into the JSON", () => {
  const look = { borderSize: 4, rounding: 8, gapsOut: 12, gapsIn: 6, activeBorder: "#ff00ff", shadowEnabled: true, source: "hyprctl" };
  const input = buildInput({ snap: HELLO, theme: GRUVBOX, look });
  assert.deepEqual(input.look, look);
});

test("buildInput: without an explicit look, one is still computed (falls back to defaults off-Hyprland, accent as activeBorder)", () => {
  const input = buildInput({ snap: HELLO, theme: GRUVBOX });
  assert.equal(typeof input.look.borderSize, "number");
  assert.equal(typeof input.look.rounding, "number");
  assert.equal(typeof input.look.gapsOut, "number");
  assert.equal(typeof input.look.gapsIn, "number");
  assert.match(input.look.activeBorder, /^#[0-9a-f]{6}$/);
  assert.equal(typeof input.look.shadowEnabled, "boolean");
});

test("CLI: the printed JSON's look has all six keys", () => {
  const out = execFileSync(
    process.execPath,
    [join(ROOT, "lib", "input.mjs"), "--fixture", HELLO_PATH, "--theme-dir", GRUVBOX_DIR],
    { encoding: "utf8" },
  );
  const input = JSON.parse(out);
  assert.deepEqual(Object.keys(input.look).sort(), ["activeBorder", "borderSize", "gapsIn", "gapsOut", "rounding", "shadowEnabled", "source"].sort());
});

// --- headerFont (the shell's configured font, see lib/input.mjs) ---------

test("parseUserShellFont: a font.family key is used", () => {
  assert.equal(parseUserShellFont(JSON.stringify({ font: { family: "Iosevka" } })), "Iosevka");
});

test("parseUserShellFont: missing key, missing font object, blank family, invalid JSON, or a non-string are all null", () => {
  assert.equal(parseUserShellFont(JSON.stringify({})), null);
  assert.equal(parseUserShellFont(JSON.stringify({ font: {} })), null);
  assert.equal(parseUserShellFont(JSON.stringify({ font: { family: "  " } })), null);
  assert.equal(parseUserShellFont(JSON.stringify({ font: { family: 12 } })), null);
  assert.equal(parseUserShellFont("not json"), null);
  assert.equal(parseUserShellFont(""), null);
  assert.equal(parseUserShellFont(undefined), null);
});

test("parseThemeShellFont: a family key inside [font] is used", () => {
  const toml = ['[bar]', 'background = "#161616"', '', '[font]', 'base-size = 12', 'family = "Iosevka"', '', '[popups]', 'family = "ignored"'].join("\n");
  assert.equal(parseThemeShellFont(toml), "Iosevka");
});

test("parseThemeShellFont: a family key outside [font] is ignored; no [font] section at all is null", () => {
  const toml = ['[bar]', 'family = "not this one"'].join("\n");
  assert.equal(parseThemeShellFont(toml), null);
  assert.equal(parseThemeShellFont(""), null);
  assert.equal(parseThemeShellFont(undefined), null);
});

test("parseThemeShellFont: [font] with no family key at all is null", () => {
  const toml = ['[font]', 'base-size = 12'].join("\n");
  assert.equal(parseThemeShellFont(toml), null);
});

test("readHeaderFont: the user shell.json wins over the theme's shell.toml and the code font", () => {
  const dir = scratchDir("omacodesnap-headerfont-user-");
  try {
    mkdirSync(join(dir, "home", ".config", "omarchy"), { recursive: true });
    writeFileSync(join(dir, "home", ".config", "omarchy", "shell.json"), JSON.stringify({ font: { family: "UserFont" } }));
    mkdirSync(join(dir, "theme"), { recursive: true });
    writeFileSync(join(dir, "theme", "shell.toml"), '[font]\nfamily = "ThemeFont"\n');
    const family = readHeaderFont({ themeDir: join(dir, "theme"), codeFontFamily: "CodeFont", homeDir: join(dir, "home") });
    assert.equal(family, "UserFont");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readHeaderFont: falls back to the theme's shell.toml when there is no user shell.json", () => {
  const dir = scratchDir("omacodesnap-headerfont-theme-");
  try {
    mkdirSync(join(dir, "theme"), { recursive: true });
    writeFileSync(join(dir, "theme", "shell.toml"), '[font]\nfamily = "ThemeFont"\n');
    const family = readHeaderFont({ themeDir: join(dir, "theme"), codeFontFamily: "CodeFont", homeDir: join(dir, "home-does-not-exist") });
    assert.equal(family, "ThemeFont");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readHeaderFont: falls back to the code font when neither shell.json nor shell.toml set one", () => {
  const dir = scratchDir("omacodesnap-headerfont-code-");
  try {
    mkdirSync(join(dir, "theme"), { recursive: true });
    writeFileSync(join(dir, "theme", "shell.toml"), "# no [font] section\n");
    const family = readHeaderFont({ themeDir: join(dir, "theme"), codeFontFamily: "CodeFont", homeDir: join(dir, "home-does-not-exist") });
    assert.equal(family, "CodeFont");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildInput: without an explicit headerFont, one is still computed (falls back to the code font off this machine's real home)", () => {
  const input = buildInput({ snap: HELLO, theme: GRUVBOX });
  assert.equal(typeof input.headerFont, "string");
  assert.ok(input.headerFont.length > 0);
});

test("buildInput: an explicit headerFont passes straight through", () => {
  const input = buildInput({ snap: HELLO, theme: GRUVBOX, headerFont: "Iosevka" });
  assert.equal(input.headerFont, "Iosevka");
});

// --- wrap (lib/wrap.mjs, wired in via buildInput) -------------------------

test("buildInput: wrap defaults to 80 characters; a short fixture (HELLO's longest line is 37) is unaffected", () => {
  const input = buildInput({ snap: HELLO, theme: GRUVBOX });
  assert.equal(input.snap.wrap, true);
  assert.equal(input.snap.wrapWidth, 80);
  assert.equal(input.snap.lines.length, HELLO.lines.length);
  assert.deepEqual(input.snap.lineNumbers, HELLO.lines.map((_, i) => i + 1));
});

test("buildInput: a fixture line past the wrap width reflows into extra rows, continuation rows numbered null", () => {
  const wide = { ...HELLO, lines: [[{ text: "a".repeat(25) }], [{ text: "short" }]] };
  const input = buildInput({ snap: wide, theme: GRUVBOX, wrapWidth: 10 });
  // 25 chars at width 10 -> 3 rows, plus the second line's own 1 row.
  assert.equal(input.snap.lines.length, 4);
  assert.deepEqual(input.snap.lineNumbers, [1, null, null, 2]);
  assert.equal(input.snap.lines[0].map((s) => s.text).join("").length, 10);
  assert.equal(input.snap.lines[2].map((s) => s.text).join("").length, 5);
});

test("buildInput: wrap: false leaves lines exactly as resolveSpans produced them, one row per source line", () => {
  const wide = { ...HELLO, lines: [[{ text: "a".repeat(200) }]] };
  const input = buildInput({ snap: wide, theme: GRUVBOX, wrap: false });
  assert.equal(input.snap.wrap, false);
  assert.equal(input.snap.lines.length, 1);
  assert.equal(input.snap.lines[0].map((s) => s.text).join("").length, 200);
  assert.deepEqual(input.snap.lineNumbers, [1]);
});

test("buildInput: wrapping runs after tab expansion, so a tab counts as the columns it renders, not one character", () => {
  // A tab at column 0 expands to 4 spaces (tabWidth); six of them is 24
  // rendered columns even though the raw span text is only 6 characters.
  const withTabs = { ...HELLO, lines: [[{ text: "\t".repeat(6) }]] };
  const input = buildInput({ snap: withTabs, theme: GRUVBOX, wrapWidth: 10 });
  assert.equal(input.snap.lines.length, 3); // 24 columns at width 10 -> 3 rows
});

test("CLI: --wrap-width reflows a long fixture line; --no-wrap turns it off", () => {
  const wrapped = JSON.parse(
    execFileSync(process.execPath, [join(ROOT, "lib", "input.mjs"), "--fixture", LONG_PATH, "--theme-dir", GRUVBOX_DIR, "--wrap-width", "80"], { encoding: "utf8" }),
  );
  assert.ok(wrapped.snap.lines.length > LONG.lines.length, "expected extra rows from wrapping the 240-char line");
  assert.ok(wrapped.snap.lines.every((line) => line.map((s) => s.text).join("").length <= 80));

  const unwrapped = JSON.parse(
    execFileSync(process.execPath, [join(ROOT, "lib", "input.mjs"), "--fixture", LONG_PATH, "--theme-dir", GRUVBOX_DIR, "--no-wrap"], { encoding: "utf8" }),
  );
  assert.equal(unwrapped.snap.lines.length, LONG.lines.length);
  assert.equal(unwrapped.snap.wrap, false);
});

// --- buildInput: subtitle/showGutter/compact (OmaWordl share-fit) --------

test("buildInput: an explicit subtitle passes through verbatim into snap.subtitle, no case change", () => {
  const input = buildInput({ snap: { ...HELLO, subtitle: "OmaWordl 1" }, theme: GRUVBOX });
  assert.equal(input.snap.subtitle, "OmaWordl 1");
});

test("buildInput: without a subtitle, snap.subtitle normalizes to null (today's auto-built badge, unchanged)", () => {
  const input = buildInput({ snap: HELLO, theme: GRUVBOX });
  assert.equal(input.snap.subtitle, null);
});

test("buildInput: showGutter defaults to true when absent, and an explicit false passes through", () => {
  const withDefault = buildInput({ snap: HELLO, theme: GRUVBOX });
  assert.equal(withDefault.snap.showGutter, true);
  const withOverride = buildInput({ snap: { ...HELLO, showGutter: false }, theme: GRUVBOX });
  assert.equal(withOverride.snap.showGutter, false);
});

test("buildInput: compact defaults to false when absent, and an explicit true passes through", () => {
  const withDefault = buildInput({ snap: HELLO, theme: GRUVBOX });
  assert.equal(withDefault.snap.compact, false);
  const withOverride = buildInput({ snap: { ...HELLO, compact: true }, theme: GRUVBOX });
  assert.equal(withOverride.snap.compact, true);
});

// --- buildInput: centerContent (ADR-0011) ---------------------------------

test("buildInput: centerContent defaults to false when absent, and an explicit true passes through", () => {
  const withDefault = buildInput({ snap: HELLO, theme: GRUVBOX });
  assert.equal(withDefault.snap.centerContent, false);
  const withOverride = buildInput({ snap: { ...HELLO, centerContent: true }, theme: GRUVBOX });
  assert.equal(withOverride.snap.centerContent, true);
});

// --- CLI -----------------------------------------------------------------

test("CLI: prints valid JSON whose snap.lines.length matches the fixture", () => {
  const out = execFileSync(
    process.execPath,
    [join(ROOT, "lib", "input.mjs"), "--fixture", HELLO_PATH, "--theme-dir", GRUVBOX_DIR],
    { encoding: "utf8" },
  );
  const input = JSON.parse(out);
  assert.equal(input.snap.lines.length, HELLO.lines.length);
});

test("CLI: exits 2 when --fixture is missing", () => {
  assert.throws(() => {
    execFileSync(process.execPath, [join(ROOT, "lib", "input.mjs")], { encoding: "utf8", stdio: "pipe" });
  }, (err) => err.status === 2);
});

// --- Constants agreement between lib/input.mjs and app/Snap.qml -----------

test("app/Snap.qml declares the same minWidth/maxWidth/minLines constants as lib/input.mjs", () => {
  const qml = readFileSync(join(ROOT, "app", "Snap.qml"), "utf8");
  const minWidth = /readonly property int\s+minWidth:\s*(\d+)/.exec(qml);
  const maxWidth = /readonly property int\s+maxWidth:\s*(\d+)/.exec(qml);
  const minLines = /readonly property int\s+minLines:\s*(\d+)/.exec(qml);
  assert.ok(minWidth, "Snap.qml must declare minWidth");
  assert.ok(maxWidth, "Snap.qml must declare maxWidth");
  assert.ok(minLines, "Snap.qml must declare minLines");
  assert.equal(Number(minWidth[1]), CONSTANTS.minWidth);
  assert.equal(Number(maxWidth[1]), CONSTANTS.maxWidth);
  assert.equal(Number(minLines[1]), CONSTANTS.minLines);
});

test("app/Snap.qml declares outerGapFactor and innerPadFactor as named constants (the Hyprland-gap-derived margins)", () => {
  const qml = readFileSync(join(ROOT, "app", "Snap.qml"), "utf8");
  assert.match(qml, /readonly property real\s+outerGapFactor:\s*\d/);
  assert.match(qml, /readonly property real\s+innerPadFactor:\s*\d/);
});
