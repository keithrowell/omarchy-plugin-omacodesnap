// Low-level Neovim RPC client: finds a running Neovim inside a terminal's
// process tree, discovers and verifies its auto-created RPC socket, and
// runs `lib/nvim/probe.lua` inside it to ask Neovim itself for its current
// visual selection and the exact colours it is already rendering for it.
//
// Mechanism (confirmed against a real `foot`-hosted Neovim on this
// machine, not just docs): every interactive Neovim spawns a nested
// "embedded core" process — a *second* process also named `nvim`, a child
// of the one the terminal itself launched — and that inner process
// auto-listens on `$XDG_RUNTIME_DIR/nvim.<its-own-pid>.0`, with no
// `--listen`/config needed. This module doesn't guess which nested `nvim`
// is the listening one: it collects every `nvim`-named descendant and
// tries each one's candidate socket(s), confirming a match by asking the
// socket's own `getpid()` and checking it against the PID whose socket
// this is supposed to be — so a stale or unrelated socket left behind by
// another Neovim instance is never mistaken for this window's.
//
// Every call here degrades to `null`/`[]` rather than throwing: a missing
// `nvim` binary, a dead socket, a malformed response, or `/proc` being
// unreadable (a permissions edge case, a process that exited mid-lookup)
// all mean "no Neovim found here" to the caller, exactly like Zed's
// missing-grammar and VS Code's missing-installed-extension cases degrade
// elsewhere in this codebase — never a reason to fail the snap.
//
// Pure ES module except for the `nvim` CLI itself: reusing it (as the Zed
// highlighter reuses the `tree-sitter` CLI, per `docs/adr/0002`) avoids
// implementing the msgpack-RPC wire protocol from scratch — `nvim --server
// <addr> --remote-expr <expr>` is itself a thin, official wrapper around
// exactly that protocol.

import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const PROBE_PATH = join(MODULE_DIR, "nvim", "probe.lua");

/**
 * Terminal emulator window classes OmaCodeSnap will look inside for a running
 * Neovim: Omarchy's four themed terminals (`colors.toml`'s theme directory
 * ships a config for each of these — see `docs/adr/0007-neovim-rpc-highlighting.md`)
 * plus a couple of other common ones. Anything not in this list is left
 * alone entirely — no `/proc` walk, no subprocess — so a random non-terminal
 * "other" app never pays this module's cost.
 */
export const TERMINAL_CLASSES = ["foot", "Alacritty", "kitty", "com.mitchellh.ghostty", "org.wezfurlong.wezterm", "xterm", "XTerm", "footclient"];

/** `/proc/<pid>/comm` (the process's own name, e.g. "nvim"), or `null` if `pid` doesn't exist or `/proc` isn't readable. */
function commOf(pid, { readFile = readFileSync } = {}) {
  try {
    return readFile(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return null;
  }
}

/** `pid`'s thread ids, from `/proc/<pid>/task` — or just `[pid]` (the main thread) when that directory can't be listed. */
function tasksOf(pid, { listTasks = (p) => readdirSync(`/proc/${p}/task`).map(Number) } = {}) {
  try {
    const tids = listTasks(pid);
    return tids.length > 0 ? tids : [pid];
  } catch {
    return [pid];
  }
}

/**
 * `pid`'s direct child PIDs (Linux-only; empty array anywhere else or on any
 * read failure). `/proc/<pid>/task/<tid>/children` lists only the children
 * that thread forked, so every thread's file is read: a multi-threaded
 * terminal such as Ghostty forks each shell from a per-surface thread, never
 * from its main one.
 */
function childrenOf(pid, { readFile = readFileSync, listTasks } = {}) {
  const children = new Set();
  for (const tid of tasksOf(pid, listTasks ? { listTasks } : {})) {
    try {
      readFile(`/proc/${pid}/task/${tid}/children`, "utf8")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .forEach((child) => children.add(Number(child)));
    } catch {
      // A thread that exited mid-walk, or an unreadable entry: skip it.
    }
  }
  return [...children];
}

/**
 * Every descendant of `pid` (any depth, breadth-first, capped at
 * `maxDepth`) whose `comm` is exactly `"nvim"`. Returns them in discovery
 * order — shallowest first — but see the module header: the *first* match
 * is the outer TUI process, not the listening core, so callers must try
 * every result, not just the first. `readFile` and `listTasks` are injectable for hermetic
 * tests.
 */
export function findNvimDescendants(pid, { readFile = readFileSync, listTasks, maxDepth = 8 } = {}) {
  const found = [];
  let frontier = [pid];
  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
    const next = [];
    for (const candidate of frontier) {
      if (commOf(candidate, { readFile }) === "nvim") found.push(candidate);
      next.push(...childrenOf(candidate, { readFile, listTasks }));
    }
    frontier = next;
  }
  return found;
}

/** Every `$runtimeDir/nvim.<nvimPid>.*` path that currently exists (Neovim's own auto-listen naming convention), in no particular order. */
export function candidateSockets(nvimPid, { runtimeDir = process.env.XDG_RUNTIME_DIR ?? "/tmp", readDir = readdirSync } = {}) {
  const prefix = `nvim.${nvimPid}.`;
  try {
    return readDir(runtimeDir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(runtimeDir, name));
  } catch {
    return [];
  }
}

/** Run `nvim --server <address> --remote-expr <expr>`, returning its trimmed stdout, or `null` on any failure (no `nvim` binary, dead socket, timeout). */
function remoteExpr(address, expr, { execFile = execFileSync, timeoutMs = 1500 } = {}) {
  try {
    return execFile("nvim", ["--server", address, "--remote-expr", expr], {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/** Does `address` respond, and does its `getpid()` actually equal `expectedPid`? (Guards against a stale socket left by an exited, unrelated Neovim reusing a recycled PID.) */
export function verifySocket(address, expectedPid, { execFile = execFileSync } = {}) {
  const out = remoteExpr(address, "getpid()", { execFile });
  return out !== null && out === String(expectedPid);
}

/**
 * Find the RPC address of the Neovim actually running inside `terminalPid`'s
 * process tree, or `null` if none is found/reachable. Tries every
 * `nvim`-named descendant's every candidate socket, in order, returning the
 * first that verifies.
 */
export function discoverNvimAddress(terminalPid, opts = {}) {
  for (const nvimPid of findNvimDescendants(terminalPid, opts)) {
    for (const address of candidateSockets(nvimPid, opts)) {
      if (verifySocket(address, nvimPid, opts)) return address;
    }
  }
  return null;
}

/**
 * Run `lib/nvim/probe.lua` inside the Neovim listening on `address` and
 * return its decoded JSON result (see the probe's own header for the exact
 * shape), or `null` on any failure. `probePath` is injectable for tests
 * that exercise a trimmed-down probe script.
 */
export function queryNvim(address, { probePath = PROBE_PATH, execFile = execFileSync } = {}) {
  // A Vimscript single-quoted string wraps a Lua double-quoted one
  // (`JSON.stringify` produces the latter, escaping the same characters
  // Lua does) — safe for any real filesystem path, which is all this ever
  // embeds; never user/selection text.
  const expr = `luaeval('dofile(${JSON.stringify(probePath)})')`;
  const out = remoteExpr(address, expr, { execFile });
  if (out === null) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}
