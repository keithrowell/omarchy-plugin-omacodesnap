# OmaCodeSnap

Turn selected code into a beautiful, unmistakably Omarchy image for a social
post, a doc, or a chat — like codesnap.dev without the macOS traffic lights,
wearing the live Omarchy theme, and coloured exactly the way the editor it was
snapped from shows the code. Read `docs/agentile/brief.md` (imported below) and
`docs/adr/` before working.

## Stack

- Runtime: quickshell/QML app launched with `qs -p app/Main.qml`; Node for logic and tests.
- Logic: pure JavaScript ES modules in `lib/` — no Qt imports there. QML only renders.
- Highlighting: tree-sitter + Zed highlight queries for Zed; `vscode-textmate`/`vscode-oniguruma` for VS Code, against a grammar read live off the installed VS Code and its actual active theme (not vendored — see `docs/adr/0005`/`0006`); live RPC to the running instance for Neovim, which runs in a terminal, not its own window (see `docs/adr/0007`); generic Omarchy-palette highlight for anything else. One small adapter per editor under `lib/editors/` (see `lib/editors/registry.mjs`). Everything else vendored, no runtime npm.
- Input: Wayland primary selection (`wl-paste --primary`), clipboard fallback; focused editor via `hyprctl activewindow`.
- Theme: `~/.local/state/omarchy/current/theme/` (`colors.toml`, `zed-theme.json`, `vscode.json`), read on every snap.
- Output: PNG via QML `grabToImage` to the clipboard (`wl-copy`) and `~/Pictures`.
- Packaging: Omarchy plugin (`manifest.json`, `bin/omacodesnap`, `bin/install`).

## Commands

- Test: `node --test tests/*.test.mjs` (Node 26 needs the glob; a bare directory fails)
- Deploy: `bin/install` (symlinks the plugin into `~/.config/omarchy/plugins/`)
- Run: `bin/omacodesnap` with something selected, to eyeball it

## Conventions

- Every colour comes from the theme files. Never hard-code one.
- No macOS traffic lights or any non-Omarchy chrome.
- Runtime dependencies must be pacman-installable or shipped by Omarchy.
- Keep binding-to-preview under about a second.

## Agentile

This project runs the **Agentile loop** (via Agentile for Claude): capture → shape → spec → plan → build → verify → ship → learn. Work builds from a written, shaped spec — never from a prompt typed from memory.

### Where things live

The backlog lives under one configurable **Agentile directory** (`docs/agentile/` by default, set in `.agentile/config.md`); the layout under it is fixed:

- **Brief** (`docs/agentile/brief.md`) — the living project context: who it's for, the prioritised outcomes, constraints, non-goals. Business Value in triage is scored against it. Imported below so it loads every session.
- **Inbox** (`docs/agentile/inbox.md`) — one-line stubs awaiting shaping. Capture freely with `/ag-capture`.
- **Specs** (`docs/agentile/specs/`) — shaped, Ready-to-build specs (`ready` / `in_progress`). A spec is a flat `NNNN-<slug>.md` until planning, then a directory `NNNN-<slug>/` holding `SPEC.md`, `plan.md`, and supporting files. The Definition of Ready is `.agentile/shape.md`.
  - `specs/done/` — shipped specs.
  - `specs/abandoned/` — specs that were dropped (via `/ag-abandon`), each with the reason recorded.
- **ADRs** (`docs/adr/`) — the *why* behind significant decisions.
- **Config** (`.agentile/`) — this project's tailoring: `config.md` (paths + triage), `shape.md` (what Ready means), `gates.json` (deterministic build/test/lint/deploy commands), and the spec/ADR templates. Any loop stage can be further customised via `.agentile/<stage>.md` (playbook frontmatter: `delegate_to`, `also_run`, `human_checkpoint`).

### How to work

- An idea arrives → `/ag-capture <one line>`. Never lose an idea for lack of a place to put it.
- Ready to develop something → `/ag-shape` to interview it into a spec, then `/ag-plan` before any code — it writes `plan.md` beside the spec; review or amend that file, it is the approved plan. Shaping asks about `depends_on` by default — list any specs (by slug) that must ship before this one can be claimed.
- Order the ready queue with `/ag-prioritise` — an interactive session that proposes a rank (Business Value × Technical Certainty, dependencies respected), you adjust it, and it renames ready specs to `specs/NNNN-<slug>.md`. An unprefixed spec is not claimable. Shipped specs move to `specs/done/`. Pull the top item with `/ag-next` — safe for concurrent loops; the claim is atomic and session-stamped so it can be resumed with `claude --resume <id>`. If the queue is blocked on dependencies or has no prefixed specs, `/ag-next` tells you which. Check what's in flight with `/ag-wip`.
- Drop work that won't ship with `/ag-abandon <slug>` — it records why, walks the dependency chain, and offers to cascade-abandon (or unblock) anything that depended on it. Abandoned specs move to `specs/abandoned/`.
- Run the loop with **`/ag-loop`** — it works through the ready queue once, then stops (a single command can't sit and wait; Claude Code is turn-based). To keep it running continuously — waiting and starting on new work as it appears — use **`/loop /ag-loop`**. It pauses at plan for `foreground`/`spike` specs (review `plan.md`, reply approved) and for your sign-off before each ship.
- Build on a short-lived branch/worktree; run the gates in `.agentile/gates.json`; a fresh-context reviewer critiques the diff before merge.
- Integrate to trunk in small, reversible, flagged batches. Close the loop with `/ag-retro`.

### Rules

- Determinism over instruction: repeatable steps (build, test, lint, deploy) are commands in `.agentile/gates.json`, not hopeful sentences.
- Trust but verify: no agent output merges until it passes tests, static analysis, a security skim, and a human read of the diff.
- Measure flow, not output: if lead time does not drop, the constraint is upstream — fix that, not the agents.

@docs/agentile/brief.md
