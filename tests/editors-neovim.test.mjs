import { test } from "node:test";
import { spawnSync, spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { neovim } from "../lib/editors/neovim.mjs";

const HAS_NVIM = spawnSync("nvim", ["--version"], { stdio: "ignore" }).status === 0;

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
