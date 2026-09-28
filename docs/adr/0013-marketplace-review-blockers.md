---
number: 0013
title: Close the marketplace review blockers — id-only IPC, data-only requests, no setup on load
status: accepted
date: 2026-09-28
---

# ADR-0013: Close the marketplace review blockers

## Status

Accepted. Supersedes ADR-0004. Narrows ADR-0003's IPC contract.

## Context

A pre-submission audit against the marketplace's review history (the
`omarchy-plugin-security` guide, three independent reviewers and the
marketplace's own baseline scanner) found five things reviewers block on:

1. The shell service's IPC, `show(input, request, root, previewPng, auto,
   shotPath)`, took six caller-supplied strings. Any same-user process could
   call it and make the shell run `node <any dir>/lib/snap.mjs`, overwrite any
   file with a PNG (`auto=shot`, `shotPath`), `rm -f` any three files when the
   preview closed, or hang the shell on a FIFO.
2. The re-highlight path took its code root from `request.json`
   (`request.root`), which picks the JavaScript it imports and the grammar
   `.so` that `tree-sitter` loads — state used as code. It also fell back to
   reading whatever `selection`/`window` paths a request named.
3. Enabling the plugin ran `bin/install` on every shell load (ADR-0004):
   compiling C, writing a desktop file and a `~/.local/bin` link, with output
   collected whole and no deadline. Reviewers require ordinary activation to
   be read-only.
4. `CLAUDE.md` sat at the repository root, and `omarchy plugin add` copies
   the repository verbatim into a directory coding agents search for
   instruction files: a prompt-injection surface whatever its content.
5. `tools/vendor-grammars.sh` fetched grammar sources by tag and Zed queries
   by tag or branch (`remote-git-execution-unpinned` in the baseline scan).

## Decision

1. **The IPC carries a run id, nothing else.** `bin/omacodesnap` makes one
   fresh directory per snap with `mktemp -d
   $XDG_RUNTIME_DIR/omacodesnap/run-XXXXXXXXXX` and calls `omarchy-shell
   omacodesnap show <id>`. The service accepts only `^[A-Za-z0-9]{10}$`,
   builds the run directory from its own `XDG_RUNTIME_DIR`, uses fixed file
   names inside it, and takes the code root from its own manifest
   (`__sourceDir`). On close it removes those named files and `rmdir`s the
   directory, so anything unexpected in it is left alone. Cleanups are
   queued so a second close cannot drop the first. The unattended-testing
   hooks (`auto`, `shotPath`) stay in the standalone `qs -p app/Main.qml`
   entry point, driven by environment variables, and are gone from the IPC.
2. **The request is data.** The re-highlight always uses the checkout's own
   `REPO_ROOT`; the first run no longer records a `root`; a request without
   inline `text` and `windowInfo` is refused rather than followed.
3. **No setup on load.** The service runs only `bin/build-grammars --check`
   (mtime comparison, read-only, output discarded) and, when that fails,
   sends one notification with a fixed body saying to run `bin/install`. The
   README's install step now includes running `bin/install`, and it gained a
   Removing section. The listing will carry `manual-setup`.
4. **No agent instruction files in the tree.** `CLAUDE.md` becomes
   `docs/DEVELOPING.md`. A development checkout gets it back through a
   git-ignored `CLAUDE.local.md` containing `@docs/DEVELOPING.md`;
   `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` and `.claude/` are ignored.
5. **Full commit SHAs only.** Every grammar and query pin in
   `tools/vendor-grammars.sh` is a 40-character SHA (the release tag it came
   from kept as a comment). A grammar is fetched into an empty, hook-free
   repository, `FETCH_HEAD^{commit}` is checked against the pin, and it is
   checked out detached. The script refuses anything that is not a SHA.

## Consequences

- A fresh install is two steps, not one, and the notification covers the
  case where the second is skipped.
- Anything that called the old six-argument IPC breaks; only
  `bin/omacodesnap` did.
- `.agentile/` stays in the tree: it is read by the Agentile plugin when a
  developer runs it, not auto-loaded by agents, and the guide's list does
  not name it. Revisit if a reviewer does.
- Hardening items from the same audit (byte caps on the selection and on
  provider fixtures, timeouts on every child process, the remaining `/tmp`
  fallbacks in `lib/`, provider process-group teardown, descriptor-bound
  reads, `bin/install`'s desktop-file write) are not blockers and are left
  for a follow-up.
