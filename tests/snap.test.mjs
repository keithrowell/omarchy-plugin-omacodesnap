import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectEditor, filenameFromTitle, prepareSnap, MAX_LINES, EDITOR_CLASSES } from "../lib/snap.mjs";
import { validateFixture } from "../lib/input.mjs";
import { readTheme } from "../lib/theme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SNAP_CLI = join(ROOT, "lib", "snap.mjs");
const OMACODESNAP = join(ROOT, "bin", "omacodesnap");
const GRUVBOX_DIR = join(ROOT, "tests", "fixtures", "themes", "gruvbox-dark", "theme");
const GRUVBOX = readTheme(GRUVBOX_DIR);

function scratchDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function canned(text) {
  return { lines: text.split("\n").map((line) => [{ text: line, color: "#ffffff", fontStyle: null, fontWeight: null }]), warnings: [] };
}

// --- detectEditor ------------------------------------------------------------

test("detectEditor maps every recorded Zed class to zed", () => {
  for (const cls of EDITOR_CLASSES.zed) assert.equal(detectEditor(cls), "zed");
});

test("detectEditor maps every recorded VS Code class to vscode", () => {
  for (const cls of EDITOR_CLASSES.vscode) assert.equal(detectEditor(cls), "vscode");
});

test("detectEditor falls back to other for foot, empty, and undefined", () => {
  assert.equal(detectEditor("foot"), "other");
  assert.equal(detectEditor(""), "other");
  assert.equal(detectEditor(undefined), "other");
});

// --- filenameFromTitle -------------------------------------------------------

test("filenameFromTitle(zed): standalone file title, filename repeated", () => {
  assert.equal(filenameFromTitle("sample.js — sample.js", "zed"), "sample.js");
});

test("filenameFromTitle(zed): a real project-open title is <project> — <file>, file last", () => {
  assert.equal(filenameFromTitle("omarchy_pacman — Board.js", "zed"), "Board.js");
});

test("filenameFromTitle(zed): a dirty-buffer marker is stripped, project-open, path kept as-is", () => {
  assert.equal(filenameFromTitle("● omarchy_pacman — src/Board.js", "zed"), "src/Board.js");
});

test("filenameFromTitle(vscode): marker, filename, folder, app name", () => {
  assert.equal(filenameFromTitle("● index.ts - omacodesnap - Visual Studio Code", "vscode"), "index.ts");
});

test("filenameFromTitle(vscode): a hyphenated filename is kept whole, not truncated at its own hyphen", () => {
  assert.equal(filenameFromTitle("omacodesnap-demo.js - sakusei - Visual Studio Code", "vscode"), "omacodesnap-demo.js");
  assert.equal(filenameFromTitle("my-component.tsx - project - Visual Studio Code", "vscode"), "my-component.tsx");
});

test("filenameFromTitle(vscode): no folder open, a bare dotted filename is used whole", () => {
  assert.equal(filenameFromTitle("sample.js - Visual Studio Code", "vscode"), "sample.js");
});

test('filenameFromTitle("other") never guesses, even for an editor-shaped title', () => {
  assert.equal(filenameFromTitle("◐ Claude Code", "other"), null);
});

test("filenameFromTitle: empty title is null", () => {
  assert.equal(filenameFromTitle("", "zed"), null);
  assert.equal(filenameFromTitle(undefined, "zed"), null);
});

test("filenameFromTitle(zed): no em dash, a dotted bare filename is used whole", () => {
  assert.equal(filenameFromTitle("main.rs", "zed"), "main.rs");
});

// --- prepareSnap --------------------------------------------------------------

test("prepareSnap: Zed class + title resolves language from the filename and reports editor zed", async () => {
  const result = await prepareSnap({
    text: "const a = 1;\n",
    windowClass: "dev.zed.Zed",
    title: "sample.js — sample.js",
    theme: GRUVBOX,
    highlightFn: ({ text }) => canned(text),
    fontFn: () => ({ family: "monospace", size: 13 }),
  });
  assert.equal(result.snap.editor, "zed");
  assert.equal(result.detected.language, "javascript");
  assert.equal(result.snap.language, "javascript");
  assert.equal(result.snap.filename, "sample.js");
});

test('prepareSnap: "other" class with Python shebang text detects the language from content, and the title bar falls back to it', async () => {
  const result = await prepareSnap({
    text: "#!/usr/bin/env python3\nprint('hi')\n",
    windowClass: "foot",
    title: "some terminal — foot",
    theme: GRUVBOX,
    highlightFn: ({ text }) => canned(text),
    fontFn: () => ({ family: "monospace", size: 13 }),
  });
  assert.equal(result.snap.editor, "other");
  assert.equal(result.detected.language, "python");
  assert.equal(result.snap.filename, "python");
});

test("prepareSnap: unknown language falls back to snippet and plain (canned) spans", async () => {
  const result = await prepareSnap({
    text: "just some text\n",
    windowClass: "foot",
    title: "",
    theme: GRUVBOX,
    highlightFn: ({ text }) => canned(text),
    fontFn: () => ({ family: "monospace", size: 13 }),
  });
  assert.equal(result.detected.language, null);
  assert.equal(result.snap.filename, "snippet");
  assert.deepEqual(result.snap.lines[0], [{ text: "just some text", color: "#ffffff", fontStyle: null, fontWeight: null }]);
});

test("prepareSnap: an explicit null language forces plain (no detection), unlike an omitted language", async () => {
  const result = await prepareSnap({
    text: "const a = 1;\n",
    windowClass: "dev.zed.Zed",
    title: "sample.js — sample.js",
    language: null,
    theme: GRUVBOX,
    highlightFn: ({ language }) => ({ lines: canned("const a = 1;").lines, warnings: [], language }),
    fontFn: () => ({ family: "monospace", size: 13 }),
  });
  assert.equal(result.snap.language, null);
  assert.equal(result.detected.language, null);
});

test("prepareSnap: an explicit language override wins over detection", async () => {
  const result = await prepareSnap({
    text: "const a = 1;\n",
    windowClass: "dev.zed.Zed",
    title: "sample.js — sample.js",
    language: "python",
    theme: GRUVBOX,
    highlightFn: ({ language }) => ({ lines: [[{ text: "x", color: "#000000", fontStyle: null, fontWeight: null }]], warnings: [], language }),
    fontFn: () => ({ family: "monospace", size: 13 }),
  });
  assert.equal(result.snap.language, "python");
  assert.equal(result.detected.language, "python");
});

test(`prepareSnap: a selection over ${MAX_LINES} lines truncates to exactly ${MAX_LINES} with the exact warning`, async () => {
  const lines = Array.from({ length: 201 }, (_, i) => `line ${i}`);
  const result = await prepareSnap({
    text: lines.join("\n"),
    windowClass: "foot",
    title: "",
    theme: GRUVBOX,
    highlightFn: ({ text }) => canned(text),
    fontFn: () => ({ family: "monospace", size: 13 }),
  });
  assert.equal(result.snap.lines.length, MAX_LINES);
  assert.ok(result.warnings.includes("snapping first 200 lines"));
});

test("prepareSnap: a NUL byte in the selection is stripped and warned about", async () => {
  const result = await prepareSnap({
    text: "abc\0def",
    windowClass: "foot",
    title: "",
    theme: GRUVBOX,
    highlightFn: ({ text }) => canned(text),
    fontFn: () => ({ family: "monospace", size: 13 }),
  });
  assert.ok(result.warnings.includes("selection contains binary data"));
  assert.ok(!result.snap.lines.flat().some((span) => span.text.includes("\0")));
});

test("prepareSnap: a transient window class is treated as other, with no filename guessed", async () => {
  const result = await prepareSnap({
    text: "x = 1\n",
    windowClass: "gcr-prompter",
    title: "sample.js — sample.js",
    theme: GRUVBOX,
    highlightFn: ({ text }) => canned(text),
    fontFn: () => ({ family: "monospace", size: 13 }),
  });
  assert.equal(result.snap.editor, "other");
  assert.equal(result.detected.filename, null);
});

test("prepareSnap: a six-tab-indented selection is dedented before highlighting, and the removed indent is reported", async () => {
  let recordedText = null;
  const result = await prepareSnap({
    text: "\t\t\t\t\t\tfoo\n\t\t\t\t\t\t\tbar",
    windowClass: "foot",
    title: "",
    theme: GRUVBOX,
    highlightFn: ({ text }) => {
      recordedText = text;
      return canned(text);
    },
    fontFn: () => ({ family: "monospace", size: 13 }),
  });
  assert.equal(recordedText, "foo\n\tbar");
  assert.equal(result.snap.lines[0][0].text, "foo");
  assert.equal(result.snap.lines[1][0].text, "\tbar");
  assert.equal(result.detected.removedIndent, "\t".repeat(6));
});

// A minimal stand-in editor adapter (see lib/editors/registry.mjs for the
// real interface) for exercising prepareSnap's dispatch logic without a
// real editor's highlighter/RPC/theme requirements.
function stubEditor(id, overrides = {}) {
  return {
    id,
    async detect() {
      return {};
    },
    async resolveSelection() {
      return null;
    },
    async highlight() {
      return null;
    },
    font() {
      return { family: "monospace", size: 13 };
    },
    filenameFromTitle() {
      return null;
    },
    ...overrides,
  };
}

function stubDetect(editor, context = {}) {
  return async () => ({ editor, context });
}

test("prepareSnap: the matched adapter's highlight() wins outright — the universal fallback never runs when it resolves", async () => {
  const editor = stubEditor("vscode", { highlight: async ({ text }) => canned(text) });
  const result = await prepareSnap({
    text: "const a = 1;\n",
    theme: GRUVBOX,
    detectContext: stubDetect(editor),
    highlightFn: () => {
      throw new Error("the universal fallback should not run when the adapter's own highlighter succeeds");
    },
  });
  assert.equal(result.snap.editor, "vscode");
  assert.equal(result.snap.lines[0][0].color, "#ffffff");
});

test("prepareSnap: the matched adapter's highlight() returning null falls back to the universal highlighter", async () => {
  const editor = stubEditor("vscode", { highlight: async () => null });
  const result = await prepareSnap({
    text: "fn main() {}\n",
    theme: GRUVBOX,
    detectContext: stubDetect(editor),
    highlightFn: ({ text }) => canned(text),
  });
  assert.equal(result.snap.editor, "vscode");
  assert.equal(result.snap.lines[0][0].color, "#ffffff");
});

test("prepareSnap: resolveSelection's overridden text/filename replace the primary selection and title parsing", async () => {
  const editor = stubEditor("neovim", {
    resolveSelection: async () => ({ text: "print('from rpc')\n" }),
    filenameFromTitle: () => "should-not-be-used.txt",
  });
  const result = await prepareSnap({
    text: "ignored primary selection\n",
    title: "ignored title",
    theme: GRUVBOX,
    detectContext: stubDetect(editor),
    highlightFn: ({ text }) => canned(text),
  });
  assert.equal(result.snap.lines[0][0].text, "print('from rpc')");
});

test("prepareSnap: resolveSelection's own pre-highlighted lines are used as-is, and highlight() is never called", async () => {
  const preHighlighted = [[{ text: "x", color: "#123456", fontStyle: null, fontWeight: null }]];
  const editor = stubEditor("neovim", {
    resolveSelection: async () => ({ text: "x", lines: preHighlighted }),
    highlight: async () => {
      throw new Error("highlight() should never run when resolveSelection already supplied lines");
    },
  });
  const result = await prepareSnap({
    text: "ignored\n",
    theme: GRUVBOX,
    detectContext: stubDetect(editor),
    highlightFn: () => {
      throw new Error("the universal fallback should not run either");
    },
  });
  assert.deepEqual(result.snap.lines, preHighlighted);
});

test("prepareSnap: dedent trims an override's pre-highlighted spans in step with the text", async () => {
  const preHighlighted = [
    [{ text: "    foo", color: "#111111", fontStyle: null, fontWeight: null }],
    [{ text: "      bar", color: "#222222", fontStyle: null, fontWeight: null }],
  ];
  const editor = stubEditor("neovim", {
    resolveSelection: async () => ({ text: "    foo\n      bar", lines: preHighlighted }),
  });
  const result = await prepareSnap({
    text: "ignored",
    theme: GRUVBOX,
    detectContext: stubDetect(editor),
  });
  assert.equal(result.snap.lines[0][0].text, "foo");
  assert.equal(result.snap.lines[0][0].color, "#111111");
  assert.equal(result.snap.lines[1][0].text, "  bar");
  assert.equal(result.snap.lines[1][0].color, "#222222");
  assert.equal(result.detected.removedIndent, "    ");
});

test("prepareSnap: font() comes from the matched adapter unless fontFn overrides it", async () => {
  const editor = stubEditor("vscode", { font: () => ({ family: "Adapter Font", size: 42 }) });
  const result = await prepareSnap({
    text: "x\n",
    theme: GRUVBOX,
    detectContext: stubDetect(editor),
  });
  assert.deepEqual(result.snap.font, { family: "Adapter Font", size: 42 });
});

test("prepareSnap: a real VS Code window, end to end through the registry, reports editor vscode", async () => {
  const result = await prepareSnap({
    text: "const a = 1;\n",
    windowClass: "code",
    title: "sample.js - myproject - Visual Studio Code",
    theme: GRUVBOX,
    fontFn: () => ({ family: "monospace", size: 13 }),
  });
  assert.equal(result.snap.editor, "vscode");
  assert.equal(result.snap.language, "javascript");
  assert.equal(result.snap.filename, "sample.js");
});

// --- snap providers (ADR-0010) -------------------------------------------
//
// Unit-tests prepareSnap's "find a matching provider, else fall through"
// decision logic in isolation, via injected scanProvidersFn/runProviderFn
// fakes — the same dependency-injection pattern already used above for
// detectContext/highlightFn/fontFn. This is the regression guard for the
// "must not change behaviour for Zed/VS Code/Neovim/other" requirement: a
// non-matching or absent provider must reach detectContext exactly as
// before, and a matching one must never reach it at all. A true end-to-end
// test (a real installed plugin directory, a real focused Hyprland window,
// the live hotkey script) isn't practical from this unit-test suite — there
// is no live Hyprland/quickshell session in CI — so the manual verification
// in the ADR/PR description covers scanProviders+runProvider's real
// discovery-and-invocation path outside of any mocking instead.

test("prepareSnap: a matching provider's fixture is used directly — detectContext, resolveSelection and highlighting never run", async () => {
  const fixture = {
    filename: "OmaWordl 1",
    subtitle: "OmaWordl 1 3/6",
    showGutter: false,
    compact: true,
    language: null,
    editor: "other",
    font: { family: "monospace", size: 32 },
    lines: [[{ text: "GREEN", color: "#00ff00" }]],
  };
  const result = await prepareSnap({
    text: "ignored — providers don't need a selection at all",
    windowClass: "com.keithrowell.omawordl",
    title: "ignored",
    theme: GRUVBOX,
    scanProvidersFn: () => [{ windowClass: "com.keithrowell.omawordl", command: "bin/omawordl-snap", pluginDir: "/fake/omawordl" }],
    runProviderFn: async () => fixture,
    detectContext: () => {
      throw new Error("detectEditorContext must not run when a provider matches");
    },
    highlightFn: () => {
      throw new Error("the universal highlighter must not run when a provider matches");
    },
  });
  assert.deepEqual(result.snap, fixture);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.detected.editor, "other");
  assert.equal(result.detected.filename, "OmaWordl 1");
  assert.equal(result.providerMatched, true);
  assert.equal(result.providerSucceeded, true);
});

test("prepareSnap: no matching provider (windowClass not registered) falls straight through to today's editor-detection behaviour", async () => {
  const result = await prepareSnap({
    text: "const a = 1;\n",
    windowClass: "dev.zed.Zed",
    title: "sample.js — sample.js",
    theme: GRUVBOX,
    scanProvidersFn: () => [{ windowClass: "com.keithrowell.omawordl", command: "bin/omawordl-snap", pluginDir: "/fake/omawordl" }],
    runProviderFn: async () => {
      throw new Error("runProviderFn must not run when no provider's windowClass matches");
    },
    highlightFn: ({ text }) => canned(text),
    fontFn: () => ({ family: "monospace", size: 13 }),
  });
  assert.equal(result.snap.editor, "zed");
  assert.equal(result.snap.language, "javascript");
  assert.equal(result.snap.filename, "sample.js");
  assert.equal(result.providerMatched, false, "no provider was ever in the picture for this windowClass");
  assert.equal(result.providerSucceeded, false);
});

test("prepareSnap: a matching provider whose runProviderFn returns null (any failure) falls straight through to today's editor-detection behaviour, but reports providerMatched so a caller can tell it apart from no-match-at-all", async () => {
  const result = await prepareSnap({
    text: "const a = 1;\n",
    windowClass: "dev.zed.Zed",
    title: "sample.js — sample.js",
    theme: GRUVBOX,
    scanProvidersFn: () => [{ windowClass: "dev.zed.Zed", command: "bin/broken-provider", pluginDir: "/fake/broken" }],
    runProviderFn: async () => null,
    highlightFn: ({ text }) => canned(text),
    fontFn: () => ({ family: "monospace", size: 13 }),
  });
  assert.equal(result.snap.editor, "zed");
  assert.equal(result.snap.language, "javascript");
  assert.equal(result.snap.filename, "sample.js");
  assert.equal(result.providerMatched, true, "a provider DID match this windowClass, even though it then failed");
  assert.equal(result.providerSucceeded, false);
});

test("prepareSnap: no scanProviders result at all (no windowClass given) skips the provider check without erroring", async () => {
  const result = await prepareSnap({
    text: "x = 1\n",
    title: "",
    theme: GRUVBOX,
    scanProvidersFn: () => {
      throw new Error("scanProvidersFn must not run when windowClass is falsy — nothing to match against");
    },
    highlightFn: ({ text }) => canned(text),
    fontFn: () => ({ family: "monospace", size: 13 }),
  });
  assert.equal(result.snap.editor, "other");
  assert.equal(result.providerMatched, false);
  assert.equal(result.providerSucceeded, false);
});

// --- CLI -----------------------------------------------------------------

function writeWindow(dir, obj) {
  const path = join(dir, "window.json");
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

before(() => {
  execFileSync(join(ROOT, "bin", "build-grammars"), { stdio: "inherit" });
});

test("CLI: produces an input JSON whose .snap passes validateFixture, plus languages/detected/warnings; the request JSON records pictures", () => {
  const dir = scratchDir("omacodesnap-snap-cli-");
  try {
    const selection = join(dir, "selection.txt");
    writeFileSync(selection, "const a = 1;\n");
    const window = writeWindow(dir, { class: "dev.zed.Zed", title: "sample.js — sample.js" });
    const request = join(dir, "request.json");
    const out = join(dir, "input.json");

    execFileSync(process.execPath, [SNAP_CLI, "--selection", selection, "--window", window, "--request", request, "--out", out, "--theme-dir", GRUVBOX_DIR], {
      encoding: "utf8",
    });

    const input = JSON.parse(readFileSync(out, "utf8"));
    assert.doesNotThrow(() => validateFixture(input.snap));
    assert.deepEqual(input.languages.slice(0, 1).length > 0, true);
    assert.equal(input.detected.editor, "zed");
    assert.equal(input.detected.language, "javascript");
    assert.ok(Array.isArray(input.warnings));

    const req = JSON.parse(readFileSync(request, "utf8"));
    assert.ok(req.pictures && typeof req.pictures === "string");
    assert.equal(req.text, readFileSync(selection, "utf8"), "the selection text is carried inline, not as a path the launcher will delete");
    assert.equal(req.windowInfo.class, "dev.zed.Zed", "the window info is carried inline too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: a project-open Zed title (<project> — <file>) detects the language from the file half, not the project half", () => {
  const dir = scratchDir("omacodesnap-snap-cli-project-");
  try {
    const selection = join(dir, "selection.txt");
    writeFileSync(selection, "const a = 1;\n");
    const window = writeWindow(dir, { class: "dev.zed.Zed", title: "omarchy_pacman — src/Board.js" });
    const request = join(dir, "request.json");
    const out = join(dir, "input.json");

    execFileSync(process.execPath, [SNAP_CLI, "--selection", selection, "--window", window, "--request", request, "--out", out, "--theme-dir", GRUVBOX_DIR], {
      encoding: "utf8",
    });

    const input = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(input.detected.language, "javascript");
    assert.equal(input.detected.filename, "src/Board.js");
    assert.equal(input.snap.filename, "src/Board.js");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: an empty (whitespace-only) selection exits 3", () => {
  const dir = scratchDir("omacodesnap-snap-cli-empty-");
  try {
    const selection = join(dir, "selection.txt");
    writeFileSync(selection, "   \n\n");
    const window = writeWindow(dir, { class: "dev.zed.Zed", title: "sample.js — sample.js" });
    const request = join(dir, "request.json");
    const out = join(dir, "input.json");

    assert.throws(
      () => {
        execFileSync(process.execPath, [SNAP_CLI, "--selection", selection, "--window", window, "--request", request, "--out", out, "--theme-dir", GRUVBOX_DIR], {
          encoding: "utf8",
          stdio: "pipe",
        });
      },
      (err) => err.status === 3,
    );
    assert.ok(!existsSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Important 3 (post-review fix): a provider that *matches* the focused
// window's class but then fails (nonzero exit, here) must not let an empty
// selection fall through to a blank/failed render — it must still exit 3,
// exactly as an unmatched empty selection always has.
test("CLI: an empty selection with a matching-but-failing provider still exits 3, not a blank render", () => {
  const dir = scratchDir("omacodesnap-snap-cli-provider-fail-");
  const home = scratchDir("omacodesnap-snap-cli-provider-fail-home-");
  try {
    const windowClass = "com.keithrowell.testprovider";
    const pluginDir = join(home, ".config", "omarchy", "plugins", windowClass);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, id: windowClass, name: "Test Provider", version: "1.0.0", omacodesnap: { provider: "snap.sh" } }),
    );
    writeFileSync(join(pluginDir, "snap.sh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });

    const selection = join(dir, "selection.txt");
    writeFileSync(selection, "   \n\n"); // whitespace-only -> empty after trim
    const window = writeWindow(dir, { class: windowClass, title: "Test Provider" });
    const request = join(dir, "request.json");
    const out = join(dir, "input.json");

    assert.throws(
      () => {
        execFileSync(process.execPath, [SNAP_CLI, "--selection", selection, "--window", window, "--request", request, "--out", out, "--theme-dir", GRUVBOX_DIR], {
          encoding: "utf8",
          stdio: "pipe",
          env: { ...process.env, HOME: home },
        });
      },
      (err) => err.status === 3,
    );
    assert.ok(!existsSync(out), "no blank/failed render should be written when the matching provider fails and the selection is empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI: re-highlighting from --request with --language changes snap.language", () => {
  const dir = scratchDir("omacodesnap-snap-cli-rehl-");
  try {
    const selection = join(dir, "selection.txt");
    writeFileSync(selection, "const a = 1;\n");
    const window = writeWindow(dir, { class: "dev.zed.Zed", title: "sample.js — sample.js" });
    const request = join(dir, "request.json");
    const out = join(dir, "input.json");

    execFileSync(process.execPath, [SNAP_CLI, "--selection", selection, "--window", window, "--request", request, "--out", out, "--theme-dir", GRUVBOX_DIR], {
      encoding: "utf8",
    });
    const before = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(before.snap.language, "javascript");

    execFileSync(process.execPath, [SNAP_CLI, "--request", request, "--language", "python", "--out", out, "--theme-dir", GRUVBOX_DIR], { encoding: "utf8" });
    const after = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(after.snap.language, "python");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: re-highlighting from --request works after the selection and window files are gone (bin/omacodesnap's trap deletes them at exit)", () => {
  const dir = scratchDir("omacodesnap-snap-cli-rehl-gone-");
  try {
    const selection = join(dir, "selection.txt");
    writeFileSync(selection, "const a = 1;\n");
    const window = writeWindow(dir, { class: "dev.zed.Zed", title: "sample.js — sample.js" });
    const request = join(dir, "request.json");
    const out = join(dir, "input.json");

    execFileSync(process.execPath, [SNAP_CLI, "--selection", selection, "--window", window, "--request", request, "--out", out, "--theme-dir", GRUVBOX_DIR], {
      encoding: "utf8",
    });
    rmSync(selection);
    rmSync(window);

    execFileSync(process.execPath, [SNAP_CLI, "--request", request, "--language", "python", "--out", out, "--theme-dir", GRUVBOX_DIR], { encoding: "utf8" });
    const after = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(after.snap.language, "python");
    assert.equal(after.detected.editor, "zed", "window info survives in the request, not just the selection text");
    assert.equal(after.detected.filename, "sample.js");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ADR-0013: the request file is data, never a pointer to code or to other
// files. Whatever can write it must not be able to choose the directory the
// re-highlight imports JavaScript and loads grammar libraries from, or make
// it read a file the request names.
test("CLI: the request JSON carries no code root, and a re-highlight ignores one planted in it", () => {
  const dir = scratchDir("omacodesnap-snap-cli-noroot-");
  try {
    const selection = join(dir, "selection.txt");
    writeFileSync(selection, "const a = 1;\n");
    const window = writeWindow(dir, { class: "dev.zed.Zed", title: "sample.js — sample.js" });
    const request = join(dir, "request.json");
    const out = join(dir, "input.json");

    execFileSync(process.execPath, [SNAP_CLI, "--selection", selection, "--window", window, "--request", request, "--out", out, "--theme-dir", GRUVBOX_DIR], {
      encoding: "utf8",
    });
    const recorded = JSON.parse(readFileSync(request, "utf8"));
    assert.equal(Object.hasOwn(recorded, "root"), false, "the first run must not record a code root");

    writeFileSync(request, JSON.stringify({ ...recorded, root: join(dir, "does-not-exist") }));
    execFileSync(process.execPath, [SNAP_CLI, "--request", request, "--language", "python", "--out", out, "--theme-dir", GRUVBOX_DIR], { encoding: "utf8" });
    assert.equal(JSON.parse(readFileSync(out, "utf8")).snap.language, "python");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The shell service passes its own manifest.__sourceDir as the code root,
// and a development install is a symlink to the checkout. Node resolves
// that symlink for import.meta.url but not for argv[1], which used to make
// the entry-point check false: the re-highlight exited 0 having done nothing.
test("CLI: runs when invoked through a symlinked plugin directory", () => {
  const dir = scratchDir("omacodesnap-snap-cli-symlink-");
  try {
    const link = join(dir, "plugin");
    symlinkSync(ROOT, link);
    const selection = join(dir, "selection.txt");
    writeFileSync(selection, "const a = 1;\n");
    const window = writeWindow(dir, { class: "dev.zed.Zed", title: "sample.js — sample.js" });
    const request = join(dir, "request.json");
    const out = join(dir, "input.json");

    execFileSync(process.execPath, [join(link, "lib", "snap.mjs"), "--selection", selection, "--window", window, "--request", request, "--out", out, "--theme-dir", GRUVBOX_DIR], { encoding: "utf8" });
    execFileSync(process.execPath, [join(link, "lib", "snap.mjs"), "--request", request, "--language", "python", "--out", out, "--theme-dir", GRUVBOX_DIR], { encoding: "utf8" });
    assert.equal(JSON.parse(readFileSync(out, "utf8")).snap.language, "python");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: a re-highlight request without inline text/windowInfo is refused, not followed to the paths it names", () => {
  const dir = scratchDir("omacodesnap-snap-cli-legacy-");
  try {
    const secret = join(dir, "secret.txt");
    writeFileSync(secret, "not for the snap\n");
    const window = writeWindow(dir, { class: "dev.zed.Zed", title: "sample.js — sample.js" });
    const request = join(dir, "request.json");
    const out = join(dir, "input.json");
    writeFileSync(request, JSON.stringify({ selection: secret, window }));

    const result = spawnSync(process.execPath, [SNAP_CLI, "--request", request, "--language", "python", "--out", out, "--theme-dir", GRUVBOX_DIR], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /inline text\/windowInfo/);
    assert.ok(!existsSync(out), "nothing rendered from a file the request pointed at");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Important 3, re-highlight path (post-review fix): the --request
// re-highlight branch had its own copy of the empty-selection problem —
// it called prepareSnap and wrote --out unconditionally, with no
// providerSucceeded guard at all. A first run with an empty selection and
// a then-successful provider carries `text: ""` into request.json (see
// main()'s `const request = { text, ... }` below); if that same provider
// later fails (a bad release, say) and the user re-highlights via the
// preview's language selector, the old code would silently overwrite a
// real rendered snap with a blank `{"filename":"python",...}` card.
test("CLI: re-highlighting from --request with an empty original selection and a now-failing provider exits 3, never overwriting --out with a blank render", () => {
  const dir = scratchDir("omacodesnap-snap-cli-rehl-provider-fail-");
  const home = scratchDir("omacodesnap-snap-cli-rehl-provider-fail-home-");
  try {
    const windowClass = "com.keithrowell.testprovider";
    const pluginDir = join(home, ".config", "omarchy", "plugins", windowClass);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, id: windowClass, name: "Test Provider", version: "1.0.0", omacodesnap: { provider: "snap.sh" } }),
    );
    const scriptPath = join(pluginDir, "snap.sh");
    // First: a provider that succeeds, so the first run's request.json
    // carries an originally-empty `text` alongside a real rendered snap.
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash\necho '{"filename":"Test Provider","language":null,"editor":"other","font":{"family":"monospace","size":13},"lines":[[{"text":"hi"}]]}'\n`,
      { mode: 0o755 },
    );

    const selection = join(dir, "selection.txt");
    writeFileSync(selection, "   \n\n"); // whitespace-only -> empty after trim
    const window = writeWindow(dir, { class: windowClass, title: "Test Provider" });
    const request = join(dir, "request.json");
    const out = join(dir, "input.json");

    execFileSync(
      process.execPath,
      [SNAP_CLI, "--selection", selection, "--window", window, "--request", request, "--out", out, "--theme-dir", GRUVBOX_DIR],
      { encoding: "utf8", env: { ...process.env, HOME: home } },
    );
    const before = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(before.snap.filename, "Test Provider", "the first run's provider fixture is what's on disk before the re-highlight");

    // Now the same provider starts failing (a bad release, an update gone
    // wrong) — the re-highlight must not paper over that with a blank card.
    writeFileSync(scriptPath, "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });

    assert.throws(
      () => {
        execFileSync(process.execPath, [SNAP_CLI, "--request", request, "--language", "python", "--out", out, "--theme-dir", GRUVBOX_DIR], {
          encoding: "utf8",
          stdio: "pipe",
          env: { ...process.env, HOME: home },
        });
      },
      (err) => err.status === 3,
    );

    const after = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(after, before, "--out must be left exactly as the last successful render, never overwritten with a blank/failed one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: re-highlighting with --language plain forces no language (the preview\'s "plain" entry)', () => {
  const dir = scratchDir("omacodesnap-snap-cli-plain-");
  try {
    const selection = join(dir, "selection.txt");
    writeFileSync(selection, "const a = 1;\n");
    const window = writeWindow(dir, { class: "dev.zed.Zed", title: "sample.js — sample.js" });
    const request = join(dir, "request.json");
    const out = join(dir, "input.json");

    execFileSync(process.execPath, [SNAP_CLI, "--selection", selection, "--window", window, "--request", request, "--out", out, "--theme-dir", GRUVBOX_DIR], {
      encoding: "utf8",
    });
    execFileSync(process.execPath, [SNAP_CLI, "--request", request, "--language", "plain", "--out", out, "--theme-dir", GRUVBOX_DIR], { encoding: "utf8" });
    const after = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(after.snap.language, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: wraps at the default 80 characters on the initial run, no --wrap flags needed", () => {
  const dir = scratchDir("omacodesnap-snap-cli-wrap-default-");
  try {
    const selection = join(dir, "selection.txt");
    writeFileSync(selection, "x".repeat(200) + "\n");
    const window = writeWindow(dir, { class: "foot", title: "" });
    const request = join(dir, "request.json");
    const out = join(dir, "input.json");

    execFileSync(process.execPath, [SNAP_CLI, "--selection", selection, "--window", window, "--request", request, "--out", out, "--theme-dir", GRUVBOX_DIR], {
      encoding: "utf8",
    });
    const input = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(input.snap.wrap, true);
    assert.equal(input.snap.wrapWidth, 80);
    assert.ok(input.snap.lines.length > 1, "expected the 200-char line to have wrapped into multiple rows");
    assert.ok(input.snap.lines.every((line) => line.map((s) => s.text).join("").length <= 80));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --no-wrap and --wrap-width both work on the initial run", () => {
  const dir = scratchDir("omacodesnap-snap-cli-wrap-initial-");
  try {
    const selection = join(dir, "selection.txt");
    writeFileSync(selection, "x".repeat(50) + "\n");
    const window = writeWindow(dir, { class: "foot", title: "" });
    const out = join(dir, "input.json");

    execFileSync(
      process.execPath,
      [SNAP_CLI, "--selection", selection, "--window", window, "--request", join(dir, "r1.json"), "--out", out, "--theme-dir", GRUVBOX_DIR, "--no-wrap"],
      { encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")).snap.wrap, false);

    execFileSync(
      process.execPath,
      [SNAP_CLI, "--selection", selection, "--window", window, "--request", join(dir, "r2.json"), "--out", out, "--theme-dir", GRUVBOX_DIR, "--wrap-width", "20"],
      { encoding: "utf8" },
    );
    const input = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(input.snap.wrapWidth, 20);
    assert.ok(input.snap.lines.length > 1, "expected the 50-char line to wrap at width 20");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: re-highlighting from --request carries --wrap/--wrap-width through, same as --language", () => {
  const dir = scratchDir("omacodesnap-snap-cli-wrap-rehl-");
  try {
    const selection = join(dir, "selection.txt");
    writeFileSync(selection, "x".repeat(50)); // no trailing newline: exactly one source line
    const window = writeWindow(dir, { class: "foot", title: "" });
    const request = join(dir, "request.json");
    const out = join(dir, "input.json");

    execFileSync(process.execPath, [SNAP_CLI, "--selection", selection, "--window", window, "--request", request, "--out", out, "--theme-dir", GRUVBOX_DIR], {
      encoding: "utf8",
    });

    execFileSync(process.execPath, [SNAP_CLI, "--request", request, "--language", "plain", "--wrap-width", "10", "--out", out, "--theme-dir", GRUVBOX_DIR], {
      encoding: "utf8",
    });
    const wrapped = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(wrapped.snap.wrapWidth, 10);
    assert.ok(wrapped.snap.lines.length > 1);

    execFileSync(process.execPath, [SNAP_CLI, "--request", request, "--language", "plain", "--no-wrap", "--out", out, "--theme-dir", GRUVBOX_DIR], {
      encoding: "utf8",
    });
    const unwrapped = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(unwrapped.snap.wrap, false);
    assert.equal(unwrapped.snap.lines.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- bin/omacodesnap (script level, live/benchmark path) ------------------------

// A scratch HOME/XDG_RUNTIME_DIR and a PATH built only from the coreutils
// bin/omacodesnap actually shells out to, plus fakes for wl-paste/hyprctl/
// notify-send/qs (and a real `node`, symlinked under the plain name the
// script invokes it by) — so these tests never depend on, or affect, the
// real desktop, clipboard, or Pictures folder. Pattern matches
// tests/install.test.mjs's basePath()/addStub().
function scratchScriptEnv(prefix) {
  const home = scratchDir(prefix);
  const runtimeDir = join(home, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const pictures = join(home, "Pictures");
  const pathDir = join(home, "path");
  mkdirSync(pathDir, { recursive: true });
  // lib/snap.mjs's CLI always reads the *live* theme (no --theme-dir in the
  // live/benchmark path) — bin/omacodesnap gives it no way to point elsewhere —
  // so HOME needs a real ~/.local/state/omarchy/current/{theme.name,
  // background,theme/} for readTheme() to find, or "prepare" fails outright.
  cpSync(join(ROOT, "tests", "fixtures", "themes", "gruvbox-dark"), join(home, ".local", "state", "omarchy", "current"), { recursive: true });
  for (const tool of ["bash", "readlink", "dirname", "mkdir", "rm", "rmdir", "head", "date", "cat", "mktemp", "stat", "id"]) {
    const real = join("/usr/bin", tool);
    if (existsSync(real)) symlinkSync(real, join(pathDir, tool));
  }
  symlinkSync(process.execPath, join(pathDir, "node"));
  return { home, runtimeDir, pictures, pathDir };
}

function writeFakeTool(pathDir, name, body) {
  writeFileSync(join(pathDir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

// A `qs` that records that it ran (and its args) instead of ever actually
// starting Quickshell — every script-level test below asserts this file was
// never created, i.e. bin/omacodesnap never got as far as launching a window.
function writeQsSpy(pathDir, home) {
  writeFakeTool(pathDir, "qs", `echo "$@" >> "${join(home, "qs-invocations.txt")}"\nexit 0`);
}

function runOmaCodeSnap(args, { pathDir, home, runtimeDir }) {
  return spawnSync(OMACODESNAP, args, {
    encoding: "utf8",
    cwd: home,
    env: { HOME: home, XDG_RUNTIME_DIR: runtimeDir, PATH: pathDir },
  });
}

test("bin/omacodesnap --benchmark: times a 60-line selection, prints the four timing lines, leaves no runtime files or Pictures writes, and never launches qs", () => {
  const { home, runtimeDir, pictures, pathDir } = scratchScriptEnv("omacodesnap-bin-benchmark-");
  try {
    const lines = ["function fib(n) {"];
    for (let i = 0; i < 58; i++) lines.push(`  const x${i} = ${i} * 2 + 1;`);
    lines.push("  return n;", "}");
    const selectionPath = join(home, "selection-src.txt");
    writeFileSync(selectionPath, lines.join("\n") + "\n");

    writeFakeTool(pathDir, "wl-paste", `cat "${selectionPath}"`);
    writeFakeTool(pathDir, "hyprctl", 'if [ "$1" = "activewindow" ]; then echo \'{"class":"dev.zed.Zed","title":"sample.js — sample.js"}\'; exit 0; fi\nexit 1');
    writeFakeTool(pathDir, "notify-send", "exit 0");
    writeFakeTool(pathDir, "xdg-user-dir", `echo "${pictures}"`);
    writeQsSpy(pathDir, home);

    const result = runOmaCodeSnap(["--benchmark"], { pathDir, home, runtimeDir });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^selection: \d+ ms$/m);
    assert.match(result.stdout, /^window: \d+ ms$/m);
    assert.match(result.stdout, /^prepare: \d+ ms$/m);
    assert.match(result.stdout, /^total: \d+ ms$/m);

    const runtimeContents = existsSync(join(runtimeDir, "omacodesnap")) ? readdirSync(join(runtimeDir, "omacodesnap")) : [];
    assert.deepEqual(runtimeContents, [], "no files left in the runtime dir");
    assert.ok(!existsSync(pictures), "nothing written under Pictures");
    assert.ok(!existsSync(join(home, "qs-invocations.txt")), "qs must never be launched by --benchmark");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Regression guard (ADR-0010): with no snap provider registered for the
// focused window's class — the overwhelming common case, and every case
// before this spec existed — an empty selection must still bail exactly as
// before: bash hands off to `node lib/snap.mjs` unconditionally now (see
// bin/omacodesnap), but that CLI's own provider-aware check finds nothing
// registered under this scratch HOME's (nonexistent)
// ~/.config/omarchy/plugins, so it still exits 3 and this script still
// notifies "Nothing selected" and exits 0 without ever reaching the
// omarchy-shell IPC call.
test("bin/omacodesnap: an empty selection notifies \"Nothing selected\" and exits 0 without ever launching qs, when no provider matches", () => {
  const { home, runtimeDir, pictures, pathDir } = scratchScriptEnv("omacodesnap-bin-empty-");
  try {
    writeFakeTool(pathDir, "wl-paste", "exit 1"); // both --primary and the clipboard fallback come up empty
    writeFakeTool(pathDir, "hyprctl", "exit 1");
    writeFakeTool(pathDir, "xdg-user-dir", `echo "${pictures}"`);
    writeFakeTool(pathDir, "notify-send", `printf '%s\\n' "$@" >> "${join(home, "notify-calls.txt")}"`);
    writeQsSpy(pathDir, home);

    const result = runOmaCodeSnap([], { pathDir, home, runtimeDir });

    assert.equal(result.status, 0, result.stderr);
    const notifyCalls = readFileSync(join(home, "notify-calls.txt"), "utf8");
    assert.match(notifyCalls, /^OmaCodeSnap$/m);
    assert.match(notifyCalls, /^Nothing selected$/m);
    assert.ok(!existsSync(join(home, "qs-invocations.txt")), "qs must never be launched for an empty selection");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// A `omarchy-shell` that records its invocation (and args — notably the
// `$INPUT` path) instead of ever actually reaching a real Omarchy shell
// process. Only reached once `node lib/snap.mjs` has succeeded (status 0),
// i.e. once a snap — provider-rendered or not — actually exists.
function writeOmarchyShellSpy(pathDir, home) {
  writeFakeTool(pathDir, "omarchy-shell", `echo "$@" >> "${join(home, "omarchy-shell-invocations.txt")}"\nexit 0`);
}

// A real `<pluginsDir>/<id>/manifest.json` + provider script fixture,
// written straight under the scratch HOME's own
// `~/.config/omarchy/plugins/` — `lib/providers.mjs`'s `DEFAULT_PLUGINS_DIR`
// resolves from `$HOME`, so this is picked up by `node lib/snap.mjs`
// exactly as a real installed sibling plugin would be, no `pluginsDir`
// override required — the closest this script-level suite gets to the true
// live path.
// `windowClass` is always the manifest's own `id` (ADR-0010, Critical-2
// fix: the override field was removed) — so this helper's `id` argument
// doubles as the window class the fake provider is registered for. Passing
// `scriptBody` instead of `fixture` writes that literal shell/node script
// body (unwrapped) instead of the usual "print this JSON fixture" script,
// for tests that need the provider to fail in a specific way.
function installFakeProvider(home, { id, fixture, scriptBody }) {
  const pluginDir = join(home, ".config", "omarchy", "plugins", id);
  mkdirSync(join(pluginDir, "bin"), { recursive: true });
  writeFileSync(join(pluginDir, "manifest.json"), JSON.stringify({ schemaVersion: 1, id, name: id, version: "1.0.0", omacodesnap: { provider: "bin/provider-snap" } }));
  const script = join(pluginDir, "bin", "provider-snap");
  const body = scriptBody ?? `#!/usr/bin/env node\nconsole.log(JSON.stringify(${JSON.stringify(fixture)}));\n`;
  writeFileSync(script, body, { mode: 0o755 });
  return pluginDir;
}

test("bin/omacodesnap: an empty selection with a matching provider renders the provider's fixture instead of bailing with \"Nothing selected\"", () => {
  const { home, runtimeDir, pictures, pathDir } = scratchScriptEnv("omacodesnap-bin-provider-");
  try {
    const windowClass = "com.keithrowell.testprovider";
    const fixture = {
      filename: "Test Provider",
      subtitle: "Test Provider 1 3/6",
      showGutter: false,
      compact: true,
      language: null,
      editor: "other",
      font: { family: "monospace", size: 32 },
      lines: [[{ text: "hi", color: "#00ff00" }]],
    };
    installFakeProvider(home, { id: windowClass, fixture });

    writeFakeTool(pathDir, "wl-paste", "exit 1"); // both --primary and the clipboard fallback come up empty — no selection at all
    writeFakeTool(pathDir, "hyprctl", `if [ "$1" = "activewindow" ]; then echo '{"class":"${windowClass}","title":"Test Provider"}'; exit 0; fi\nexit 1`);
    writeFakeTool(pathDir, "xdg-user-dir", `echo "${pictures}"`);
    writeFakeTool(pathDir, "notify-send", `printf '%s\\n' "$@" >> "${join(home, "notify-calls.txt")}"`);
    writeQsSpy(pathDir, home);
    writeOmarchyShellSpy(pathDir, home);

    const result = runOmaCodeSnap([], { pathDir, home, runtimeDir });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(join(home, "notify-calls.txt")), '"Nothing selected" must not be notified when a provider matches');
    assert.ok(!existsSync(join(home, "qs-invocations.txt")), "qs (the fixture renderer) is never launched by the live path");

    // ADR-0013: the IPC carries nothing but the run directory's random
    // suffix; the service derives every path (and the code root) itself.
    const shellInvocations = readFileSync(join(home, "omarchy-shell-invocations.txt"), "utf8");
    const call = shellInvocations.match(/^omacodesnap show ([A-Za-z0-9]{10})$/m);
    assert.ok(call, `expected exactly "omacodesnap show <run-id>"; got ${JSON.stringify(shellInvocations)}`);

    // bin/omacodesnap's exit trap only removes SELECTION/WINDOW once the
    // handoff succeeds; the run directory and its input.json are left for
    // the (here, faked) shell service to clean up.
    const runDir = join(runtimeDir, "omacodesnap", `run-${call[1]}`);
    assert.deepEqual(readdirSync(join(runtimeDir, "omacodesnap")), [`run-${call[1]}`]);
    assert.ok(!existsSync(join(runDir, "selection.txt")) && !existsSync(join(runDir, "window.json")), "selection and window files are removed at exit");
    const input = JSON.parse(readFileSync(join(runDir, "input.json"), "utf8"));
    assert.equal(input.snap.filename, "Test Provider");
    assert.equal(input.snap.editor, "other");
    assert.equal(input.detected.editor, "other");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Important 3 (post-review fix), script-level: a provider that *matches*
// but then fails (nonzero exit) must not turn an empty selection into a
// blank/failed render reaching the shell service — it must still notify
// "Nothing selected" and never hand off to omarchy-shell at all, exactly
// as the no-provider-at-all case does.
test("bin/omacodesnap: an empty selection with a matching but failing provider still notifies \"Nothing selected\", never hands off to the shell service", () => {
  const { home, runtimeDir, pictures, pathDir } = scratchScriptEnv("omacodesnap-bin-provider-fail-");
  try {
    const windowClass = "com.keithrowell.testproviderfail";
    installFakeProvider(home, { id: windowClass, scriptBody: "#!/usr/bin/env bash\nexit 1\n" });

    writeFakeTool(pathDir, "wl-paste", "exit 1"); // no selection at all
    writeFakeTool(pathDir, "hyprctl", `if [ "$1" = "activewindow" ]; then echo '{"class":"${windowClass}","title":"Test Provider"}'; exit 0; fi\nexit 1`);
    writeFakeTool(pathDir, "xdg-user-dir", `echo "${pictures}"`);
    writeFakeTool(pathDir, "notify-send", `printf '%s\\n' "$@" >> "${join(home, "notify-calls.txt")}"`);
    writeQsSpy(pathDir, home);
    writeOmarchyShellSpy(pathDir, home);

    const result = runOmaCodeSnap([], { pathDir, home, runtimeDir });

    assert.equal(result.status, 0, result.stderr);
    const notifyCalls = readFileSync(join(home, "notify-calls.txt"), "utf8");
    assert.match(notifyCalls, /^Nothing selected$/m, "a matched-but-failed provider with no selection must still fall back to \"Nothing selected\"");
    assert.ok(!existsSync(join(home, "qs-invocations.txt")), "qs must never be launched");
    assert.ok(!existsSync(join(home, "omarchy-shell-invocations.txt")), "the shell service must never be handed a blank/failed render");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
