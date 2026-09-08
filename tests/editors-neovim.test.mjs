import { test } from "node:test";
import { spawnSync, spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { neovim, sanitizeSpans } from "../lib/editors/neovim.mjs";

const HAS_NVIM = spawnSync("nvim", ["--version"], { stdio: "ignore" }).status === 0;

// --- sanitizeSpans -----------------------------------------------------------

test("sanitizeSpans: a genuinely empty line's sole span is kept as-is", () => {
  const spans = [{ text: "", color: "#fff", bold: false, italic: false }];
  assert.deepEqual(sanitizeSpans(spans), spans);
});

test("sanitizeSpans: a real span with no empty ones is unchanged", () => {
  const spans = [{ text: "abc", color: "#fff", bold: false, italic: false }];
  assert.deepEqual(sanitizeSpans(spans), spans);
});

test("sanitizeSpans: an empty-text span trailing real content is dropped (probe.lua's v$-on-a-short-line quirk)", () => {
  const spans = [
    { text: "}", color: "#838781", bold: false, italic: false },
    { text: "", color: "#f1e9d2", bold: false, italic: false },
  ];
  assert.deepEqual(sanitizeSpans(spans), [spans[0]]);
});

test("sanitizeSpans: an empty-text span leading real content is dropped too", () => {
  const spans = [
    { text: "", color: "#f1e9d2", bold: false, italic: false },
    { text: "}", color: "#838781", bold: false, italic: false },
  ];
  assert.deepEqual(sanitizeSpans(spans), [spans[1]]);
});

test("neovim.detect: not a terminal class -> null, no /proc walk attempted", async () => {
  assert.equal(await neovim.detect({ windowClass: "dev.zed.Zed", pid: process.pid }), null);
});

test("neovim.detect: a terminal class with no pid -> null", async () => {
  assert.equal(await neovim.detect({ windowClass: "foot", pid: undefined }), null);
});

test("neovim.font/filenameFromTitle: always defer (system font, no title parsing)", () => {
  assert.equal(neovim.font({ context: {} }), null);
  assert.equal(neovim.filenameFromTitle("anything"), null);
});

test("neovim.highlight: unreachable in the real pipeline, always null", async () => {
  assert.equal(await neovim.highlight({}), null);
});

// --- live integration (real nvim, spawned as this test's own child so its
// pid plays the role of the "terminal" neovim.detect walks) ----------------

test("live: neovim.detect finds a real Neovim, then resolveSelection reports the live visual selection with real colours", { skip: !HAS_NVIM }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "omacodesnap-nvim-adapter-"));
  const file = join(dir, "sample.js");
  writeFileSync(file, "const x = 1;\n");

  const child = spawn("nvim", ["--headless", "-u", "NONE", file], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 500));

    const context = await neovim.detect({ windowClass: "foot", pid: process.pid });
    assert.ok(context?.address, "expected to find the spawned Neovim");

    // No selection yet: resolveSelection defers (null), so the normal
    // primary-selection/generic-highlighter path can take over.
    assert.equal(await neovim.resolveSelection({ context }), null);

    // Select the whole buffer, then query again.
    execFileSync("nvim", ["--server", context.address, "--remote-send", "gg0VG"]);
    await new Promise((r) => setTimeout(r, 200));

    const override = await neovim.resolveSelection({ context });
    assert.ok(override, "expected an active-selection override");
    assert.equal(override.text, "const x = 1;");
    assert.ok(override.filename.endsWith("sample.js"));
    assert.ok(override.lines[0].some((s) => s.color && s.color.startsWith("#")));
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Found live (2026-09-08): a real snap attempt against a running Neovim
// crashed the whole render with "lines[7][1].text: empty text is only
// allowed as a line's sole span". `v$` in charwise visual mode reports the
// cursor's column one past a short last line's actual length (confirmed
// against real Neovim, not just inferred) — `probe.lua`'s old `line_spans`
// then read past the line's end, got "" back from `string.sub`, and
// recorded it as a second, empty-text span alongside the line's real
// content. This reproduces that exact selection shape end to end, through
// `neovim.resolveSelection` (which is what `lib/snap.mjs` actually calls),
// and would have failed before the `probe.lua`/`sanitizeSpans` fix.
test("live: a v$ selection ending on a short last line never emits an empty-text span next to real content", { skip: !HAS_NVIM }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "omasnap-nvim-adapter-"));
  const file = join(dir, "sample.js");
  writeFileSync(file, "function greet(name) {\n  return name;\n}\n");

  const child = spawn("nvim", ["--headless", "-u", "NONE", file], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 500));

    const context = await neovim.detect({ windowClass: "foot", pid: process.pid });
    assert.ok(context?.address, "expected to find the spawned Neovim");

    execFileSync("nvim", ["--server", context.address, "--remote-send", "gg0v"]);
    execFileSync("nvim", ["--server", context.address, "--remote-send", "G$"]);
    await new Promise((r) => setTimeout(r, 200));

    const override = await neovim.resolveSelection({ context });
    assert.ok(override, "expected an active-selection override");
    assert.equal(override.text, "function greet(name) {\n  return name;\n}");
    for (const line of override.lines) {
      if (line.length > 1) assert.ok(line.every((s) => s.text !== ""), "no empty-text span alongside real content");
    }
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
