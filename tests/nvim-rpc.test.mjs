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
  discoverNvimAddresses,
  probeSelectedNvim,
  tmuxPanePids,
  herdrPanePids,
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
    const c = /^\/proc\/(\d+)\/task\/(\d+)\/children$/.exec(path);
    if (c) {
      const node = tree[Number(c[1])];
      if (!node) throw new Error("ENOENT");
      const tid = Number(c[2]);
      // `threads` models a process whose children were forked by threads
      // other than the main one; without it, every child hangs off the main
      // thread (tid === pid), which is what single-threaded programs do.
      const children = node.threads ? node.threads[tid] : tid === Number(c[1]) ? node.children : undefined;
      if (children === undefined) throw new Error("ENOENT");
      return children.join(" ");
    }
    throw new Error("ENOENT");
  };
}

function fakeTaskList(tree) {
  // The thread ids under /proc/<pid>/task for each fake process.
  return (pid) => {
    const node = tree[pid];
    if (!node) throw new Error("ENOENT");
    return node.threads ? Object.keys(node.threads).map(Number) : [pid];
  };
}

function fakeProc(tree) {
  return { readFile: fakeProcTree(tree), listTasks: fakeTaskList(tree) };
}

test("findNvimDescendants: finds a nested nvim (TUI + embedded core), shallowest first", () => {
  const tree = {
    100: { comm: "foot", children: [101] },
    101: { comm: "nvim", children: [102] },
    102: { comm: "nvim", children: [] },
  };
  const found = findNvimDescendants(100, fakeProc(tree));
  assert.deepEqual(found, [101, 102]);
});

test("findNvimDescendants: follows children forked by any thread, not just the main one (Ghostty)", () => {
  // Ghostty forks each shell from a per-surface thread, so the shell is
  // listed in /proc/<ghostty>/task/<that thread>/children and never in the
  // main thread's own children file.
  const tree = {
    100: { comm: "ghostty", threads: { 100: [120], 150: [101] } },
    120: { comm: "ghostty", children: [] },
    101: { comm: "fish", children: [102] },
    102: { comm: "nvim", children: [103] },
    103: { comm: "nvim", children: [] },
  };
  assert.deepEqual(findNvimDescendants(100, fakeProc(tree)), [102, 103]);
});

test("findNvimDescendants: an unlistable task directory still falls back to the main thread", () => {
  const tree = { 100: { comm: "foot", children: [101] }, 101: { comm: "nvim", children: [] } };
  const listTasks = () => {
    throw new Error("EACCES");
  };
  assert.deepEqual(findNvimDescendants(100, { readFile: fakeProcTree(tree), listTasks }), [101]);
});

test("findNvimDescendants: an empty task listing also falls back to the main thread", () => {
  const tree = { 100: { comm: "foot", children: [101] }, 101: { comm: "nvim", children: [] } };
  assert.deepEqual(findNvimDescendants(100, { readFile: fakeProcTree(tree), listTasks: () => [] }), [101]);
});

test("findNvimDescendants: a terminal running something else finds nothing", () => {
  const tree = { 100: { comm: "foot", children: [101] }, 101: { comm: "bash", children: [] } };
  assert.deepEqual(findNvimDescendants(100, fakeProc(tree)), []);
});

test("findNvimDescendants: an unreadable /proc entry degrades to no match, never throws", () => {
  assert.deepEqual(
    findNvimDescendants(999, {
      readFile: () => {
        throw new Error("EACCES");
      },
      listTasks: () => [999],
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
  const address = discoverNvimAddress(100, { ...fakeProc(tree), runtimeDir: "/run/user/1000", readDir, execFile });
  assert.equal(address, "/run/user/1000/nvim.105.0");
});

test("discoverNvimAddress: no nvim in the tree at all -> null", () => {
  const tree = { 100: { comm: "foot", children: [] } };
  assert.equal(discoverNvimAddress(100, fakeProc(tree)), null);
});

test("discoverNvimAddresses: a single-instance terminal yields every surface's Neovim, not just the first", () => {
  // One Ghostty process serves every window, so two windows running Neovim
  // are both descendants of the same terminal pid.
  const tree = {
    100: { comm: "ghostty", threads: { 100: [], 150: [101], 160: [105] } },
    101: { comm: "fish", children: [102] },
    102: { comm: "nvim", children: [] },
    105: { comm: "fish", children: [106] },
    106: { comm: "nvim", children: [] },
  };
  const readDir = () => ["nvim.102.0", "nvim.106.0"];
  const execFile = (cmd, args) => args[1].match(/nvim\.(\d+)\./)[1];
  assert.deepEqual(discoverNvimAddresses(100, { ...fakeProc(tree), runtimeDir: "/run/user/1000", readDir, execFile }), [
    "/run/user/1000/nvim.102.0",
    "/run/user/1000/nvim.106.0",
  ]);
});

test("probeSelectedNvim: picks the Neovim that actually holds a visual selection", () => {
  const probes = {
    "/a": { hasSelection: false, filename: "other-window.js" },
    "/b": { hasSelection: true, filename: "focused-window.js" },
  };
  const found = probeSelectedNvim(["/a", "/b"], { queryFn: (address) => probes[address] });
  assert.equal(found.filename, "focused-window.js");
});

test("probeSelectedNvim: no Neovim with a selection, or unreachable ones, yields null", () => {
  const queryFn = (address) => (address === "/a" ? null : { hasSelection: false });
  assert.equal(probeSelectedNvim(["/a", "/b"], { queryFn }), null);
  assert.equal(probeSelectedNvim([], { queryFn }), null);
});

// Under tmux the terminal's own tree ends at the tmux client; Neovim lives
// under the tmux server, a separate tree reached through the client's active
// pane.
const TMUX_TREE = {
  100: { comm: "ghostty", threads: { 100: [], 150: [110] } },
  110: { comm: "tmux: client", children: [] },
  200: { comm: "tmux: server", children: [210, 220] },
  210: { comm: "fish", children: [211] },
  211: { comm: "nvim", children: [212] },
  212: { comm: "nvim", children: [] },
  220: { comm: "fish", children: [] },
};

function fakeTmux(listing, { onCall } = {}) {
  return (cmd, args, options) => {
    if (cmd === "tmux") {
      onCall?.(args, options);
      if (listing instanceof Error) throw listing;
      return listing;
    }
    // nvim --server <address> --remote-expr getpid()
    return args[1] === "/run/user/1000/nvim.212.0" ? "212" : "999";
  };
}

test("tmuxPanePids: maps the terminal's tmux client to the pane it is showing", () => {
  const calls = [];
  const execFile = fakeTmux("110 210\n999 220\n", { onCall: (args) => calls.push(args) });
  assert.deepEqual(tmuxPanePids(100, { ...fakeProc(TMUX_TREE), execFile }), [210]);
  assert.deepEqual(calls, [["list-clients", "-F", "#{client_pid} #{pane_pid}"]]);
});

test("tmuxPanePids: bounds the tmux call with a timeout, so a hung server can't stall the snap", () => {
  let received;
  const execFile = fakeTmux("110 210\n", { onCall: (args, options) => (received = options) });
  tmuxPanePids(100, { ...fakeProc(TMUX_TREE), execFile, timeoutMs: 250 });
  assert.equal(received.timeout, 250);
  assert.deepEqual(received.stdio, ["ignore", "pipe", "pipe"]);
});

test("tmuxPanePids: no tmux client in the terminal's tree never runs tmux", () => {
  const tree = { 100: { comm: "foot", children: [101] }, 101: { comm: "fish", children: [] } };
  const execFile = () => {
    throw new Error("tmux must not run without a tmux client in the tree");
  };
  assert.deepEqual(tmuxPanePids(100, { ...fakeProc(tree), execFile }), []);
});

test("tmuxPanePids: a failing tmux call degrades to no panes, never throws", () => {
  const execFile = fakeTmux(new Error("no server running"));
  assert.deepEqual(tmuxPanePids(100, { ...fakeProc(TMUX_TREE), execFile }), []);
});

test("discoverNvimAddress: finds Neovim inside tmux through the client's active pane", () => {
  const readDir = () => ["nvim.211.0", "nvim.212.0"];
  const execFile = fakeTmux("110 210\n");
  const address = discoverNvimAddress(100, { ...fakeProc(TMUX_TREE), runtimeDir: "/run/user/1000", readDir, execFile });
  assert.equal(address, "/run/user/1000/nvim.212.0");
});

test("discoverNvimAddress: another pane's Neovim is never picked for this client", () => {
  // The client is showing pane 220 (a bare shell); the Neovim under pane 210
  // belongs to a different window and must not be snapped.
  const readDir = () => ["nvim.211.0", "nvim.212.0"];
  const execFile = fakeTmux("110 220\n");
  assert.equal(discoverNvimAddress(100, { ...fakeProc(TMUX_TREE), runtimeDir: "/run/user/1000", readDir, execFile }), null);
});

test("discoverNvimAddresses: a Neovim in another window doesn't hide the one inside tmux", () => {
  // Same Ghostty process: one window runs Neovim directly, the focused one
  // runs tmux. Both must be candidates; the selection decides which is snapped.
  const tree = {
    ...TMUX_TREE,
    100: { comm: "ghostty", threads: { 100: [], 150: [110], 160: [300] } },
    300: { comm: "nvim", children: [] },
  };
  const readDir = () => ["nvim.212.0", "nvim.300.0"];
  const execFile = (cmd, args) => (cmd === "tmux" ? "110 210\n" : args[1].match(/nvim\.(\d+)\./)[1]);
  assert.deepEqual(discoverNvimAddresses(100, { ...fakeProc(tree), runtimeDir: "/run/user/1000", readDir, execFile }), [
    "/run/user/1000/nvim.300.0",
    "/run/user/1000/nvim.212.0",
  ]);
});

// herdr is client/server like tmux: the terminal's tree ends at the herdr
// client, and the panes run under the herdr server.
const HERDR_TREE = {
  100: { comm: "ghostty", threads: { 100: [], 150: [110] } },
  110: { comm: "herdr", children: [] },
  200: { comm: "herdr", children: [210] },
  210: { comm: "fish", children: [211] },
  211: { comm: "nvim", children: [212] },
  212: { comm: "nvim", children: [] },
};

function herdrReply(shellPid) {
  return JSON.stringify({ id: "cli:pane:process_info", result: { process_info: { pane_id: "w1:p1", shell_pid: shellPid }, type: "pane_process_info" } });
}

function fakeHerdr(reply, { onCall, cmdline = "herdr" } = {}) {
  return {
    readCmdline: () => cmdline,
    execFile: (cmd, args, options) => {
      if (cmd === "herdr") {
        onCall?.(args, options);
        if (reply instanceof Error) throw reply;
        return reply;
      }
      if (cmd === "tmux") throw new Error("no tmux here");
      return args[1] === "/run/user/1000/nvim.212.0" ? "212" : "999";
    },
  };
}

test("herdrPanePids: maps the terminal's herdr client to the focused pane's shell", () => {
  const calls = [];
  const fake = fakeHerdr(herdrReply(210), { onCall: (args, options) => calls.push({ args, options }) });
  assert.deepEqual(herdrPanePids(100, { ...fakeProc(HERDR_TREE), ...fake, timeoutMs: 250 }), [210]);
  assert.deepEqual(calls[0].args, ["pane", "process-info", "--current"]);
  assert.equal(calls[0].options.timeout, 250);
});

test("herdrPanePids: a named session is queried on that session", () => {
  const calls = [];
  for (const cmdline of ["herdr\0--session\0work\0", "herdr\0session\0attach\0work\0"]) {
    const fake = fakeHerdr(herdrReply(210), { cmdline, onCall: (args) => calls.push(args) });
    herdrPanePids(100, { ...fakeProc(HERDR_TREE), ...fake });
  }
  assert.deepEqual(calls, [
    ["--session", "work", "pane", "process-info", "--current"],
    ["--session", "work", "pane", "process-info", "--current"],
  ]);
});

test("herdrPanePids: no herdr client in the tree never runs herdr", () => {
  const tree = { 100: { comm: "foot", children: [101] }, 101: { comm: "fish", children: [] } };
  const fake = fakeHerdr(new Error("herdr must not run without a herdr client in the tree"));
  assert.deepEqual(herdrPanePids(100, { ...fakeProc(tree), ...fake }), []);
});

test("herdrPanePids: a failing call or an unexpected reply degrades to no panes", () => {
  for (const reply of [new Error("server not running"), "not json", JSON.stringify({ result: {} })]) {
    assert.deepEqual(herdrPanePids(100, { ...fakeProc(HERDR_TREE), ...fakeHerdr(reply) }), []);
  }
});

test("discoverNvimAddress: finds Neovim inside herdr through the focused pane", () => {
  const readDir = () => ["nvim.211.0", "nvim.212.0"];
  const address = discoverNvimAddress(100, { ...fakeProc(HERDR_TREE), ...fakeHerdr(herdrReply(210)), runtimeDir: "/run/user/1000", readDir });
  assert.equal(address, "/run/user/1000/nvim.212.0");
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
