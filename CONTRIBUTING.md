# Contributing to OmaCodeSnap

Thanks for considering a contribution. OmaCodeSnap is a small, opinionated
Omarchy plugin — please open an issue before starting anything non-trivial
(a new editor, a new language, a behaviour change) so we can agree on the
approach before you invest time in it. Small fixes and clear bugs can go
straight to a pull request.

## Before you start

OmaCodeSnap only runs on [Omarchy](https://omarchy.org) (Arch Linux + Hyprland +
quickshell). You'll need a real Omarchy machine, or something close enough
to it, to develop and test against — this isn't something you can build or
run on macOS/Windows/generic Linux.

Install the runtime dependencies listed in the README (`bin/install`
names any that are missing):

```
quickshell wl-clipboard qt6-5compat tree-sitter-cli gcc nodejs
```

## Development loop

```bash
bin/omacodesnap                        # run from the checkout: snap the current selection and preview it
node --test tests/*.test.mjs       # every test in the project
bin/build-grammars                 # compile vendored grammars (first run only; node --test does this too)
```

A few more tools:

```bash
bin/omacodesnap --benchmark            # time the non-window steps of a live snap (no window opens)
bin/omacodesnap --fixture F --out P    # render a fixture JSON (tests/fixtures/render/*.json) to a PNG, headless
bin/build-grammars --check         # report missing/stale grammars without building
```

`--fixture` renders the same frame the live window uses, against the
current theme by default; `--theme-dir` and `--wallpaper` pick another.
The standalone entry point drives the preview unattended, for testing
Copy/Save/the language selector without a human. Build the two files with
`node lib/snap.mjs --selection F --window F --request R --out I`, then run
`OMACODESNAP_INPUT=I OMACODESNAP_REQUEST=R OMACODESNAP_ROOT=$PWD
OMACODESNAP_PREVIEW_PNG=… OMACODESNAP_AUTO=copy|save|shot|lang:<id>
OMACODESNAP_MODE=preview qs -p app/Main.qml`. These hooks exist only there;
the shell service's IPC takes a run id and nothing else (ADR-0013).

**After changing anything under `app/`, run `omarchy-restart-shell`.** The
Omarchy shell loads `Service.qml`/`Overlay.qml`/`Snap.qml` once and never
re-reads them (it runs with `QS_DISABLE_FILE_WATCHER=1`), and `omarchy
plugin disable`/`enable` does not reload them either. Skipping the restart
makes a real fix look unfixed. `--fixture` always runs fresh QML.

Developing from a checkout elsewhere: clone it, run `bin/install` once to
symlink it into `~/.config/omarchy/plugins/`, then `omarchy plugin enable
com.keithrowell.omacodesnap`. `bin/install --dry-run` shows what it would do,
`--uninstall` reverses it.

`docs/agentile/` and `docs/adr/` carry the backlog and the decision records
this project is built from (see `docs/DEVELOPING.md`).

## Ground rules

- **Every colour comes from the live Omarchy theme files.** Never hard-code
  a colour, in QML or JS.
- **No non-Omarchy chrome.** No macOS traffic lights, no theme picker, no
  styling that isn't driven by the current theme.
- **Runtime dependencies must be pacman-installable or already shipped by
  Omarchy.** No global npm installs at runtime — vendored JS is fine.
- **Logic lives in `lib/` as plain ES modules with no Qt imports.** QML
  under `app/` only renders; keep it thin and testable logic out of it.
- Keep the binding-to-preview path fast — the target is under about a
  second.

## Tests

`node --test tests/*.test.mjs` is the whole suite and is what CI runs on
every pull request. Please add or update tests for any behaviour change —
most of the codebase (everything under `lib/`) is plain JS and easy to unit
test without a live Hyprland/quickshell session.

## Submitting a pull request

1. Fork the repo and branch off `master`.
2. Make your change, with tests.
3. Make sure `node --test tests/*.test.mjs` passes locally.
4. Open a pull request describing what changed and why. Link the issue it
   resolves, if any.

`master` is protected: pull requests need CI passing before they can merge.

## Reporting bugs / requesting features

Use the issue templates — they ask for the bits that are actually useful
here (Omarchy/theme/editor details for bugs). See
[SECURITY.md](SECURITY.md) instead for anything that looks like a security
issue.

## Project structure and internal workflow

This repo runs its own development process (the "Agentile" loop — capture →
shape → spec → plan → build → verify → ship) documented in `docs/DEVELOPING.md` and
`docs/agentile/`. That's the maintainer's internal workflow, not a
requirement for contributors — you don't need it to submit a PR, but the
specs under `docs/agentile/specs/` and the ADRs under `docs/adr/` are useful
background reading if you want to understand why something was built the
way it was.

## Releasing

The version lives in exactly one place: the `version` field in
`manifest.json`. Omarchy's updater fast-forwards to the default branch, so
every merge to `master` is what people install — bump the version in the
same PR as any user-visible change (patch for a fix, minor for a feature),
not for docs or refactors. After the merge, tag it:

```
git tag -a v<version> -m "v<version>" && git push origin v<version>
```

The README deliberately carries no version number (a test enforces it), so a
bump is that one edit plus the tag.

## Licence

By contributing, you agree your contribution is licensed under this
project's [MIT licence](LICENSE).
