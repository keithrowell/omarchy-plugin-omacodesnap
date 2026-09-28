import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readTheme, zedSyntaxStyle } from "../lib/theme.mjs";
import { highlight, parseQueryOutput, spansFromCaptures, REPO_ROOT } from "../lib/highlight/zed.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CODE = join(ROOT, "tests", "fixtures", "code");
const GRUVBOX = readTheme(join(ROOT, "tests", "fixtures", "themes", "gruvbox-dark", "theme"));
const FLEXOKI = readTheme(join(ROOT, "tests", "fixtures", "themes", "flexoki-light", "theme"));

// Every language this build landed a grammar + query set for (see the
// report for what didn't land and why). Each entry names one occurrence of
// a keyword, a string, a comment and a function/definition name in its
// fixture, plus the Zed capture that token actually resolves through
// (found by running the CLI once by hand — see spec 0005's plan.md) so the
// assertion is "this token gets its capture's theme colour", not a guess.
const FIXTURES = [
  {
    language: "javascript",
    file: "sample.js",
    keyword: { text: "function", capture: "keyword.declaration" },
    string: { text: '"Ada"', capture: "string" },
    comment: { text: "// Greets someone by name.", capture: "comment" },
    functionName: { text: "greet", capture: "function" },
  },
  {
    language: "python",
    file: "sample.py",
    keyword: { text: "def", capture: "keyword.definition" },
    string: { text: '"Ada"', capture: "string" },
    comment: { text: "# Greets someone by name.", capture: "comment" },
    functionName: { text: "greet", capture: "function" },
  },
  {
    language: "typescript",
    file: "sample.ts",
    keyword: { text: "function", capture: "keyword.declaration" },
    string: { text: '"Ada"', capture: "string" },
    comment: { text: "// Greets someone by name.", capture: "comment" },
    functionName: { text: "greet", capture: "function" },
  },
  {
    language: "tsx",
    file: "sample.tsx",
    keyword: { text: "function", capture: "keyword.declaration" },
    string: { text: '"greeting"', capture: "string" },
    comment: { text: "// Greets someone by name.", capture: "comment" },
    functionName: { text: "Greet", capture: "function" },
  },
  {
    language: "rust",
    file: "sample.rs",
    keyword: { text: "fn", capture: "keyword" },
    string: { text: '"Hello, {}!"', capture: "string" },
    comment: { text: "// Greets someone by name.", capture: "comment" },
    functionName: { text: "greet", capture: "function.definition" },
  },
  {
    language: "go",
    file: "sample.go",
    keyword: { text: "func", capture: "keyword" },
    string: { text: '"Hello, %s!"', capture: "string" },
    comment: { text: "// Greets someone by name.", capture: "comment" },
    functionName: { text: "greet", capture: "function" },
  },
  {
    language: "c",
    file: "sample.c",
    keyword: { text: "const", capture: "keyword" },
    string: { text: '"Ada"', capture: "string" },
    comment: { text: "// Greets someone by name.", capture: "comment" },
    functionName: { text: "greet", capture: "function" },
  },
  {
    language: "bash",
    file: "sample.sh",
    keyword: { text: "local", capture: "keyword" },
    string: { text: '"Ada"', capture: "string" },
    comment: { text: "# Greets someone by name.", capture: "comment" },
    functionName: { text: "greet", capture: "function" },
  },
  // JSON has no real keyword/function concept; the closest analogues Zed's
  // own json/highlights.scm offers are used instead — a boolean literal for
  // "keyword", and the first object key for "function name" (both, like
  // every other language here, resolve through the same
  // capture-to-theme-colour mechanism).
  {
    language: "json",
    file: "sample.json",
    keyword: { text: "true", capture: "boolean" },
    string: { text: '"Ada"', capture: "string" },
    comment: { text: "// a comment", capture: "comment" },
    functionName: { text: '"name"', capture: "property.json_key" },
  },
  // YAML has no function concept either; the first mapping key stands in
  // for "function name", same reasoning as JSON above.
  {
    language: "yaml",
    file: "sample.yml",
    keyword: { text: "true", capture: "boolean" },
    string: { text: "Ada", capture: "string" },
    comment: { text: "# Greets someone by name.", capture: "comment" },
    functionName: { text: "name", capture: "property" },
  },
  {
    language: "ruby",
    file: "sample.rb",
    keyword: { text: "def", capture: "keyword.function" },
    string: { text: '"Ada"', capture: "string" },
    comment: { text: "# Greets someone by name.", capture: "comment" },
    functionName: { text: "greet", capture: "function.method.definition" },
  },
  {
    language: "lua",
    file: "sample.lua",
    keyword: { text: "local", capture: "keyword" },
    // Not "Ada": its capture (string) resolves to the same colour as the
    // table constructor's adjacent "{", so the adjacent-same-style merge
    // rule folds them into one "{\"Ada\"" span — "Grace" isn't adjacent to
    // any other capture and stays a clean, isolated span.
    string: { text: '"Grace"', capture: "string" },
    comment: { text: "-- Greets someone by name.", capture: "comment" },
    functionName: { text: "greet", capture: "function.definition" },
  },
];

before(() => {
  execFileSync(join(ROOT, "bin", "build-grammars"), { stdio: "inherit" });
});

function coverageHolds(text, lines) {
  const expected = text.split("\n");
  assert.equal(lines.length, expected.length);
  lines.forEach((line, i) => {
    assert.equal(
      line.map((s) => s.text).join(""),
      expected[i],
      `line ${i} does not reconstruct the original text`,
    );
  });
}

function findSpan(lines, text) {
  for (const line of lines) {
    for (const span of line) {
      if (span.text === text) return span;
    }
  }
  return null;
}

/** The byte-column range (on row 0) of the first occurrence of `needle` in `line` — avoids brittle hand-counted offsets. */
function byteRangeOf(line, needle) {
  const charIndex = line.indexOf(needle);
  assert.ok(charIndex !== -1, `${JSON.stringify(needle)} not found in ${JSON.stringify(line)}`);
  const col = Buffer.byteLength(line.slice(0, charIndex), "utf8");
  const len = Buffer.byteLength(needle, "utf8");
  return { start: { row: 0, col }, end: { row: 0, col: col + len } };
}

// --- parseQueryOutput ------------------------------------------------------

test("parseQueryOutput parses a canned tree-sitter query -c snippet, ignoring the text field", () => {
  const stdout = [
    "sample.js",
    "    pattern:  1, capture: 1 - keyword, start: (0, 0), end: (0, 5), text: `local`",
    "    pattern:  0, capture: 0 - variable, start: (0, 6), end: (0, 7), text: `x`",
    "    pattern:  0, capture: 3 - func, start: (2, 0), end: (4, 3), text: `function greet() {",
    "  return `hi`",
    "}`",
    "    pattern:  1, capture: 1 - string, start: (3, 9), end: (3, 14), text: `\"hi \"`",
  ].join("\n");

  const captures = parseQueryOutput(stdout);
  assert.deepEqual(captures, [
    { pattern: 1, capture: "keyword", start: { row: 0, col: 0 }, end: { row: 0, col: 5 } },
    { pattern: 0, capture: "variable", start: { row: 0, col: 6 }, end: { row: 0, col: 7 } },
    { pattern: 0, capture: "func", start: { row: 2, col: 0 }, end: { row: 4, col: 3 } },
    { pattern: 1, capture: "string", start: { row: 3, col: 9 }, end: { row: 3, col: 14 } },
  ]);
});

test("parseQueryOutput returns [] for empty or non-string input", () => {
  assert.deepEqual(parseQueryOutput(""), []);
  assert.deepEqual(parseQueryOutput(undefined), []);
});

test("parseQueryOutput (text-aware): immune to a decoy capture-header line inside a multi-line capture's own text field", () => {
  // A template literal (or any multi-line capture) whose own source text
  // happens to contain a line that reads exactly like a capture header —
  // e.g. a test fixture describing tree-sitter's own output format, like
  // this very file's canned-snippet tests above. The text-aware path must
  // not be fooled into treating that line as a second, bogus capture.
  const lines = [
    "const s = `line one",
    "    pattern: 1, capture: 1 - keyword, start: (5, 0), end: (5, 20)",
    "line three`;",
    "const ok = true;",
  ];
  const text = lines.join("\n");

  const stringStart = { row: 0, col: Buffer.byteLength("const s = ", "utf8") };
  const stringEnd = { row: 2, col: Buffer.byteLength("line three`", "utf8") };
  const capturedText = [lines[0].slice("const s = ".length), lines[1], lines[2].slice(0, "line three`".length)].join(
    "\n",
  );

  const trueStart = { row: 3, col: Buffer.byteLength("const ok = ", "utf8") };
  const trueEnd = { row: 3, col: Buffer.byteLength("const ok = true", "utf8") };

  const stdout = [
    "sample.js",
    `    pattern: 0, capture: 0 - string, start: (${stringStart.row}, ${stringStart.col}), end: (${stringEnd.row}, ${stringEnd.col}), text: \`${capturedText}\``,
    `    pattern: 1, capture: 1 - constant.builtin, start: (${trueStart.row}, ${trueStart.col}), end: (${trueEnd.row}, ${trueEnd.col}), text: \`true\``,
  ].join("\n");

  const captures = parseQueryOutput(stdout, { text });
  assert.deepEqual(captures, [
    { pattern: 0, capture: "string", start: stringStart, end: stringEnd },
    { pattern: 1, capture: "constant.builtin", start: trueStart, end: trueEnd },
  ]);

  // Without `text`, the best-effort fallback path has no way to know the
  // decoy line is inside another capture's text field, and is fooled by
  // it — documenting exactly the risk `highlight()` avoids by always
  // supplying `text`, not asserting the fallback is safe.
  const withoutText = parseQueryOutput(stdout);
  assert.ok(
    withoutText.some((c) => c.capture === "keyword"),
    "the fallback (no text argument) is expected to be fooled by the embedded decoy line",
  );
});

// --- spansFromCaptures semantics -------------------------------------------

test("spansFromCaptures: exact-duplicate range resolves to the last-declared capture", () => {
  const text = "greet";
  const captures = [
    { pattern: 0, capture: "variable", start: { row: 0, col: 0 }, end: { row: 0, col: 5 } },
    { pattern: 5, capture: "function", start: { row: 0, col: 0 }, end: { row: 0, col: 5 } },
  ];
  const lines = spansFromCaptures({ text, captures, theme: GRUVBOX });
  assert.equal(lines[0].length, 1);
  assert.equal(lines[0][0].color, zedSyntaxStyle(GRUVBOX.zed, "function").color);
});

test("spansFromCaptures: a capture strictly inside another overrides it within its own sub-range", () => {
  const text = 'const s = "hi ${x}"';
  const captures = [
    { pattern: 0, capture: "string", ...byteRangeOf(text, '"hi ${x}"') },
    { pattern: 1, capture: "punctuation.special", ...byteRangeOf(text, "${") },
  ];
  const lines = spansFromCaptures({ text, captures, theme: GRUVBOX });
  coverageHolds(text, lines);
  const inner = findSpan(lines, "${");
  assert.equal(inner.color, zedSyntaxStyle(GRUVBOX.zed, "punctuation.special").color);
  const before = findSpan(lines, '"hi ');
  assert.equal(before.color, zedSyntaxStyle(GRUVBOX.zed, "string").color);
});

test("spansFromCaptures: adjacent spans with the same resolved style merge", () => {
  const text = "ab";
  const captures = [
    { pattern: 0, capture: "keyword", start: { row: 0, col: 0 }, end: { row: 0, col: 1 } },
    { pattern: 0, capture: "keyword.control", start: { row: 0, col: 1 }, end: { row: 0, col: 2 } },
  ];
  const lines = spansFromCaptures({ text, captures, theme: GRUVBOX });
  // keyword.control falls back to keyword's colour, so the two adjacent
  // differently-named captures still merge into one span.
  assert.deepEqual(
    lines[0].map((s) => s.text),
    ["ab"],
  );
});

test("spansFromCaptures: uncaptured text is a plain span in the editor foreground", () => {
  const text = "plain text";
  const lines = spansFromCaptures({ text, captures: [], theme: GRUVBOX });
  assert.deepEqual(lines, [[{ text: "plain text", color: GRUVBOX.zed.style.editorForeground, fontStyle: null, fontWeight: null }]]);
});

test("spansFromCaptures: a capture with no theme entry at all never paints — it never overrides an enclosing capture's colour", () => {
  const text = 'const s = "hi there"';
  const captures = [
    { pattern: 0, capture: "string", ...byteRangeOf(text, '"hi there"') },
    // Smaller range, nested inside the string above — but its name has no
    // entry anywhere in the theme's dotted-fallback chain, so per the
    // module header it must be treated as if it never fired at all.
    { pattern: 1, capture: "totally.bogus.capture.name", ...byteRangeOf(text, "there") },
  ];
  const lines = spansFromCaptures({ text, captures, theme: GRUVBOX });
  coverageHolds(text, lines);
  // The whole string stays one span in string's colour — "there" is not
  // carved out into a separate (wrongly plain-foreground) span.
  assert.deepEqual(
    lines[0].map((s) => s.text),
    ["const s = ", '"hi there"'],
  );
  assert.equal(findSpan(lines, '"hi there"').color, zedSyntaxStyle(GRUVBOX.zed, "string").color);
});

test("spansFromCaptures: coverage invariant holds with tabs and trailing whitespace preserved", () => {
  const text = "\tconst x = 1;   \n";
  const captures = [{ pattern: 0, capture: "keyword", start: { row: 0, col: 1 }, end: { row: 0, col: 6 } }];
  const lines = spansFromCaptures({ text, captures, theme: GRUVBOX });
  coverageHolds(text, lines);
  assert.ok(lines[0][0].text.startsWith("\t"));
});

test("spansFromCaptures: mixed line endings (a CRLF line) are preserved", () => {
  const text = "one\r\ntwo\n";
  const lines = spansFromCaptures({ text, captures: [], theme: GRUVBOX });
  assert.equal(lines.length, 3); // "one\r", "two", "" (trailing newline)
  assert.equal(lines[0][0].text, "one\r");
  assert.equal(lines[1][0].text, "two");
  assert.equal(lines[2][0].text, "");
});

test("spansFromCaptures: byte-to-char conversion is correct across multi-byte characters", () => {
  const text = 'const s = "café 😀"; const k = true;';
  const captures = [
    { pattern: 0, capture: "string", ...byteRangeOf(text, '"café 😀"') },
    { pattern: 1, capture: "constant.builtin", ...byteRangeOf(text, "true") },
  ];
  const lines = spansFromCaptures({ text, captures, theme: GRUVBOX });
  coverageHolds(text, lines);
  const str = findSpan(lines, '"café 😀"');
  assert.ok(str, "the string span should reconstruct exactly, emoji and all");
  assert.equal(str.color, zedSyntaxStyle(GRUVBOX.zed, "string").color);
});

// --- highlight(): per-language fixtures -------------------------------------

for (const fixture of FIXTURES) {
  test(`highlight(): ${fixture.language} — coverage and the four required tokens`, () => {
    const text = readFileSync(join(CODE, fixture.file), "utf8");
    const result = highlight({ text, language: fixture.language, theme: GRUVBOX });
    assert.deepEqual(result.warnings, []);
    coverageHolds(text, result.lines);

    for (const key of ["keyword", "string", "comment", "functionName"]) {
      const { text: tokenText, capture } = fixture[key];
      const span = findSpan(result.lines, tokenText);
      assert.ok(span, `${fixture.language}: could not find a span with text ${JSON.stringify(tokenText)} for ${key}`);
      const expected = zedSyntaxStyle(GRUVBOX.zed, capture);
      assert.equal(span.color, expected.color, `${fixture.language} ${key} (${tokenText}) colour`);
      assert.equal(span.fontStyle, expected.fontStyle, `${fixture.language} ${key} (${tokenText}) fontStyle`);
      assert.equal(span.fontWeight, expected.fontWeight, `${fixture.language} ${key} (${tokenText}) fontWeight`);
    }
  });
}

// Markdown has no keyword/string/comment/function concept at all, and this
// build implements no injections (see lib/highlight/zed.mjs's header) —
// there is deliberately no generic markdown entry in FIXTURES above.
// Instead this asserts what the *block* grammar's own highlights.scm
// actually captures: a heading, a list marker, a fenced code block's info
// string, and — importantly — that the fenced code block's *content* (no
// injection to colour it as JS) still falls back to a plain span rather
// than throwing or losing text.
test("highlight(): markdown — heading, list marker, code fence info string; fenced content is plain (no injections)", () => {
  const text = readFileSync(join(CODE, "sample.md"), "utf8");
  const result = highlight({ text, language: "markdown", theme: GRUVBOX });
  assert.deepEqual(result.warnings, []);
  coverageHolds(text, result.lines);

  // The heading's captured range runs to the start of the next row (no
  // trailing "\n" — lines are already split), so the span is the heading
  // text alone.
  const heading = findSpan(result.lines, "# Greets someone by name");
  assert.ok(heading, "heading span not found");
  assert.equal(heading.color, zedSyntaxStyle(GRUVBOX.zed, "title.markup").color);

  const marker = findSpan(result.lines, "- ");
  assert.ok(marker, "list marker span not found");
  assert.equal(marker.color, zedSyntaxStyle(GRUVBOX.zed, "punctuation.list_marker.markup").color);

  // The fence delimiter (```) and the info string (js) both resolve to
  // punctuation.embedded.markup, so the adjacent-same-style merge rule
  // joins them into one span.
  const info = findSpan(result.lines, "```js");
  assert.ok(info, "fenced code block delimiter + info string span not found");
  assert.equal(info.color, zedSyntaxStyle(GRUVBOX.zed, "punctuation.embedded.markup").color);

  // The line inside the fence ("function greet(name) {") gets no capture
  // at all from the block grammar's query — it still renders as a plain
  // span in the editor foreground, not dropped or thrown on.
  const fenced = findSpan(result.lines, "function greet(name) {");
  assert.ok(fenced, "fenced code content should still render as plain text");
  assert.equal(fenced.color, GRUVBOX.zed.style.editorForeground);
});

test("highlight(): byte-column/char conversion holds end to end for a unicode fixture", () => {
  const text = readFileSync(join(CODE, "unicode.js"), "utf8");
  const result = highlight({ text, language: "javascript", theme: GRUVBOX });
  coverageHolds(text, result.lines);
  const str = findSpan(result.lines, '"café 😀"');
  assert.ok(str);
  assert.equal(str.color, zedSyntaxStyle(GRUVBOX.zed, "string").color);
});

// --- highlight(): degenerate paths ------------------------------------------

test("highlight(): unknown/null language -> one plain span per line, no throw", () => {
  const text = readFileSync(join(CODE, "sample.txt"), "utf8");
  const result = highlight({ text, language: null, theme: GRUVBOX });
  assert.equal(result.language, null);
  coverageHolds(text, result.lines);
  for (const line of result.lines) {
    assert.equal(line.length, 1);
    assert.equal(line[0].color, GRUVBOX.zed.style.editorForeground);
  }
});

test("highlight(): a language id with no known config warns and degrades to plain spans", () => {
  const result = highlight({ text: "x = 1", language: "cobol", theme: GRUVBOX });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /unknown language/);
  assert.equal(result.lines[0][0].color, GRUVBOX.zed.style.editorForeground);
});

test("highlight(): a recognised language against a theme with no zed-theme.json warns and degrades to plain spans, never throws", () => {
  // Most Omarchy themes ship no zed-theme.json at all — only a handful of
  // hand-authored community themes do (docs/gallery/SOURCES.md). This must
  // degrade exactly like an unrecognised language, not dereference
  // theme.zed and throw.
  const themeWithoutZed = { ...GRUVBOX, zed: null };
  const result = highlight({ text: "const x = 1;\n", language: "javascript", theme: themeWithoutZed });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /no zed-theme\.json/);
  assert.equal(result.lines[0][0].color, GRUVBOX.colors.foreground);
});

test("highlight(): a missing grammar .so warns and degrades to plain spans, never throws", () => {
  const empty = mkdtempSync(join(tmpdir(), "omacodesnap-empty-root-"));
  try {
    const result = highlight({ text: "const x = 1;\n", language: "javascript", theme: GRUVBOX, root: empty });
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /grammar not built/);
    coverageHolds("const x = 1;\n", result.lines);
    assert.equal(result.lines[0][0].color, GRUVBOX.zed.style.editorForeground);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("highlight(): a non-zero tree-sitter exit warns and degrades to plain spans, never throws", () => {
  const result = highlight({
    text: "const x = 1;\n",
    language: "javascript",
    theme: GRUVBOX,
    runQuery: () => {
      throw new Error("tree-sitter exited 1: boom");
    },
  });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /tree-sitter query failed/);
});

test("highlight(): REPO_ROOT points at this checkout's vendor directory", () => {
  assert.equal(REPO_ROOT, ROOT);
});

// --- performance -------------------------------------------------------------

test("highlight(): the 57-line perf.js fixture highlights well under a second", () => {
  const text = readFileSync(join(CODE, "perf.js"), "utf8");
  const start = performance.now();
  const result = highlight({ text, language: "javascript", theme: GRUVBOX });
  const elapsed = performance.now() - start;
  console.log(`  (highlight() on perf.js: ${elapsed.toFixed(1)} ms — target under 200 ms)`);
  assert.deepEqual(result.warnings, []);
  assert.ok(elapsed < 1000, `highlight() took ${elapsed}ms, expected under 1000ms`);
});

// --- theme independence -------------------------------------------------------

test("highlight(): the same fixture under a different theme yields a different keyword colour", () => {
  const text = readFileSync(join(CODE, "sample.js"), "utf8");
  const gruvbox = highlight({ text, language: "javascript", theme: GRUVBOX });
  const flexoki = highlight({ text, language: "javascript", theme: FLEXOKI });
  const gruvboxKeyword = findSpan(gruvbox.lines, "function");
  const flexokiKeyword = findSpan(flexoki.lines, "function");
  assert.ok(gruvboxKeyword && flexokiKeyword);
  assert.notEqual(gruvboxKeyword.color, flexokiKeyword.color);
});
