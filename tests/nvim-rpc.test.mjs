import { test } from "node:test";
import { spawnSync, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findNvimDescendants,
  candidateSockets,
  verifySocket,
  discoverNvimAddress,
  queryNvim,
  TERMINAL_CLASSES,
  PROBE_PATH,
} from "../lib/nvim-rpc.mjs";

const HAS_NVIM = spawnSync("nvim", ["--version"], { stdio: "ignore" }).status === 0;

// --- hermetic unit tests (fake /proc and fake nvim CLI) ---------------------

function fakeProcTree(tree) {
  // tree: { pid: { comm, children: [pid, ...] } }
  return (path) => {
    const m = /^\/proc\/(\d+)\/comm$/.exec(path);
    if (m) {
      const node = tree[Number(m[1])];
      if (!node) throw new Error("ENOENT");
      return `${node.comm}\n`;
    }
    const c = /^\/proc\/(\d+)\/task\/\d+\/children$/.exec(path);
    if (c) {
      const node = tree[Number(c[1])];
      if (!node) throw new Error("ENOENT");
      return (node.children ?? []).join(" ");
    }
    throw new Error("ENOENT");
  };
}

test("findNvimDescendants: finds a nested nvim (TUI + embedded core), shallowest first", () => {
  const tree = {
    100: { comm: "foot", children: [101] },
    101: { comm: "nvim", children: [102] },
    102: { comm: "nvim", children: [] },
  };
  const found = findNvimDescendants(100, { readFile: fakeProcTree(tree) });
  assert.deepEqual(found, [101, 102]);
});

test("findNvimDescendants: a terminal running something else finds nothing", () => {
  const tree = { 100: { comm: "foot", children: [101] }, 101: { comm: "bash", children: [] } };
  assert.deepEqual(findNvimDescendants(100, { readFile: fakeProcTree(tree) }), []);
});

test("findNvimDescendants: an unreadable /proc entry degrades to no match, never throws", () => {
  assert.deepEqual(
    findNvimDescendants(999, {
      readFile: () => {
        throw new Error("EACCES");
      },
    }),
    [],
  );
});

test("candidateSockets: matches the nvim.<pid>.* naming convention, ignoring unrelated files", () => {
  const readDir = () => ["nvim.101.0", "nvim.1015.0", "nvim.102.0", "other-file"];
  assert.deepEqual(candidateSockets(102, { runtimeDir: "/run/user/1000", readDir }), ["/run/user/1000/nvim.102.0"]);
});

test("candidateSockets: a missing runtime dir yields no candidates, never throws", () => {
  assert.deepEqual(
    candidateSockets(1, {
      readDir: () => {
        throw new Error("ENOENT");
      },
    }),
    [],
  );
});

test("verifySocket: true only when the socket's own getpid() matches the expected pid", () => {
  const execFile = (cmd, args) => (args.includes("getpid()") ? "12345" : "");
  assert.equal(verifySocket("/sock", 12345, { execFile }), true);
  assert.equal(verifySocket("/sock", 999, { execFile }), false);
});

test("verifySocket: a dead/unreachable socket (nvim exits non-zero) is false, never throws", () => {
  const execFile = () => {
    throw new Error("E247: connection refused");
  };
  assert.equal(verifySocket("/sock", 1, { execFile }), false);
});

test("discoverNvimAddress: tries every nvim descendant's every socket, returns the first that verifies", () => {
  const tree = { 100: { comm: "foot", children: [101, 105] }, 101: { comm: "nvim", children: [] }, 105: { comm: "nvim", children: [] } };
  const readDir = () => ["nvim.101.0", "nvim.105.0"];
  // Only the second nvim's socket actually verifies (simulates the outer
  // TUI process's own socket, if it even has one, being stale/mismatched —
  // "999" never equals either candidate's own pid, so it never verifies).
  const execFile = (cmd, args) => (args[1] === "/run/user/1000/nvim.105.0" ? "105" : "999");
  const address = discoverNvimAddress(100, { readFile: fakeProcTree(tree), runtimeDir: "/run/user/1000", readDir, execFile });
  assert.equal(address, "/run/user/1000/nvim.105.0");
});

test("discoverNvimAddress: no nvim in the tree at all -> null", () => {
  const tree = { 100: { comm: "foot", children: [] } };
  assert.equal(discoverNvimAddress(100, { readFile: fakeProcTree(tree) }), null);
});

test("queryNvim: decodes the probe's JSON stdout", () => {
  const execFile = () => '{"hasSelection":false,"filetype":"lua"}';
  assert.deepEqual(queryNvim("/sock", { execFile }), { hasSelection: false, filetype: "lua" });
});

test("queryNvim: malformed JSON or a failed call both degrade to null", () => {
  assert.equal(queryNvim("/sock", { execFile: () => "not json" }), null);
  assert.equal(
    queryNvim("/sock", {
      execFile: () => {
        throw new Error("boom");
      },
    }),
    null,
  );
});

test("TERMINAL_CLASSES includes Omarchy's four themed terminals", () => {
  for (const cls of ["foot", "Alacritty", "kitty", "com.mitchellh.ghostty"]) {
    assert.ok(TERMINAL_CLASSES.includes(cls));
  }
});

// --- live integration test (real nvim, skipped if not installed) -----------

test("live: discoverNvimAddress + queryNvim against a real headless Neovim", { skip: !HAS_NVIM }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "omacodesnap-nvim-"));
  const file = join(dir, "sample.js");
  writeFileSync(file, "const x = 1;\n");

  const child = spawn("nvim", ["--headless", "-u", "NONE", "-c", "set filetype=javascript", file], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 500)); // let the embedded core start and bind its socket

    const address = discoverNvimAddress(child.pid);
    assert.ok(address, "expected to discover a real RPC socket");

    const probe = queryNvim(address, { probePath: PROBE_PATH });
    assert.ok(probe, "expected a real probe response");
    assert.equal(probe.hasSelection, false); // headless, nothing selected
    assert.equal(probe.filetype, "javascript");
    assert.ok(probe.filename.endsWith("sample.js"));
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
