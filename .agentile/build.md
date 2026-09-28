---
# No human_checkpoint: the loop runs unattended (see loop.md).
---

# Build — how this project executes ready work

- **Branch per spec, worktree isolated.** The `ag-builder` works on a
  short-lived branch `spec/<slug>` in its own worktree; never commit to
  `master` directly (protected in `gates.json`).
- **Logic in `lib/`, drawing in `app/`.** Tokenising, theme parsing, language
  detection, layout decisions and output naming are pure ES modules in `lib/`
  with no Qt imports; every module ships with a `tests/<name>.test.mjs`. QML in
  `app/` only renders and wires input/output.
- **Colours come from the theme.** Read `~/.local/state/omarchy/current/theme/`
  on each run. The only hex literals allowed outside `tests/` are in fixtures
  or in code that *parses* theme files. Never a hard-coded colour in QML.
- **Dependencies are vendored.** Grammars, tree-sitter WASM/native builds and
  shiki live in the repo (or are pacman packages). No `npm install` at runtime,
  no network at runtime.
- **Run the gates yourself** before reporting done: `node --test tests/*.test.mjs`.
  If the change touches rendering, launch `bin/omacodesnap` against a fixture
  (`tests/fixtures/`) and save the PNG beside the spec so the reviewer can see it.
- **Commit granularity.** Small commits with the spec slug in the message; the
  ship step merges the branch as one unit.
- **Performance.** Keep the binding-to-preview path lean: no heavy work on the
  QML thread, tokenise once, cache nothing across runs (theme may change).
