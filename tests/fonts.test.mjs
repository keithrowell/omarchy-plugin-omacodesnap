import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripJsonc, readEditorFont, resolveFontFamily } from "../lib/fonts.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "tests", "fixtures", "editors");

// --- stripJsonc ------------------------------------------------------------

test("stripJsonc removes line comments", () => {
  assert.equal(stripJsonc('{\n  // a comment\n  "a": 1\n}'), '{\n  \n  "a": 1\n}');
});

test("stripJsonc removes block comments", () => {
  assert.equal(stripJsonc('{ /* block\n comment */ "a": 1 }'), '{  "a": 1 }');
});

test("stripJsonc removes trailing commas before } and ]", () => {
  const parsed = JSON.parse(stripJsonc('{ "a": [1, 2,], "b": 3, }'));
  assert.deepEqual(parsed, { a: [1, 2], b: 3 });
});

test("stripJsonc leaves // inside a string alone", () => {
  const text = '{ "url": "https://example.com/path" }';
  assert.equal(stripJsonc(text), text);
  assert.deepEqual(JSON.parse(stripJsonc(text)), { url: "https://example.com/path" });
});

test("stripJsonc does not let an escaped quote end a string early", () => {
  const text = '{ "a": "esc \\" quote // still in string" }';
  const stripped = stripJsonc(text);
  assert.deepEqual(JSON.parse(stripped), { a: 'esc " quote // still in string' });
});

// --- readEditorFont ----------------------------------------------------------

test("readEditorFont(zed) reads buffer_font_family / buffer_font_size from a JSONC fixture", () => {
  const font = readEditorFont("zed", { home: join(FIXTURES, "zed") });
  assert.deepEqual(font, { family: "FiraCode Nerd Font", size: 13, source: "zed" });
});

test("readEditorFont(vscode) reads editor.fontFamily / editor.fontSize, unquoting the first family", () => {
  const font = readEditorFont("vscode", { home: join(FIXTURES, "vscode") });
  assert.deepEqual(font, { family: "JetBrainsMono Nerd Font", size: 14, source: "vscode" });
});

test("readEditorFont(zed) falls back to the regex scan when the file does not parse", () => {
  const font = readEditorFont("zed", { home: join(FIXTURES, "zed-broken") });
  assert.deepEqual(font, { family: "Iosevka Nerd Font", size: 13, source: "zed" });
});

test("readEditorFont falls back to the system font when the settings file is missing", () => {
  const font = readEditorFont("zed", { home: "/nonexistent/omacodesnap-fixture-home", fcMatch: () => "Foo Mono" });
  assert.deepEqual(font, { family: "Foo Mono", size: 13, source: "system" });
});

test("readEditorFont falls back to monospace when the injected fcMatch throws", () => {
  const font = readEditorFont("zed", {
    home: "/nonexistent/omacodesnap-fixture-home",
    fcMatch: () => {
      throw new Error("fc-match: command not found");
    },
  });
  assert.deepEqual(font, { family: "monospace", size: 13, source: "system" });
});

test('readEditorFont("other") always returns the system font', () => {
  const font = readEditorFont("other", { fcMatch: () => "Bar Mono" });
  assert.deepEqual(font, { family: "Bar Mono", size: 13, source: "system" });
});

// --- resolveFontFamily -------------------------------------------------------

test("resolveFontFamily: an uninstalled family substitutes to the system monospace family", () => {
  const fcMatch = (family) => (family === "FiraCode Nerd Font" ? "Liberation Sans" : "JetBrainsMono Nerd Font,JetBrainsMono NF");
  const result = resolveFontFamily("FiraCode Nerd Font", { fcMatch });
  assert.deepEqual(result, { family: "JetBrainsMono Nerd Font", substituted: true });
});

test("resolveFontFamily: an installed family (fc-match echoes it back) is unchanged", () => {
  const fcMatch = (family) => family;
  const result = resolveFontFamily("JetBrainsMono Nerd Font", { fcMatch });
  assert.deepEqual(result, { family: "JetBrainsMono Nerd Font", substituted: false });
});

test("resolveFontFamily: the comparison is case-insensitive and trims whitespace", () => {
  const fcMatch = () => "  jetbrainsmono nerd font  ";
  const result = resolveFontFamily("JetBrainsMono Nerd Font", { fcMatch });
  assert.deepEqual(result, { family: "JetBrainsMono Nerd Font", substituted: false });
});

test("resolveFontFamily: a throwing fcMatch never throws, falls back to plain monospace", () => {
  const fcMatch = () => {
    throw new Error("fc-match: command not found");
  };
  const result = resolveFontFamily("FiraCode Nerd Font", { fcMatch });
  assert.deepEqual(result, { family: "monospace", substituted: true });
});
