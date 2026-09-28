---
number: 0004
title: Service.qml runs bin/install on load — there is no Omarchy plugin lifecycle hook
status: superseded
date: 2026-09-07
---

# ADR-0004: Service.qml runs bin/install on load — there is no Omarchy plugin lifecycle hook

## Status

Superseded by ADR-0013 (2026-09-28): loading the plugin now only checks,
read-only, whether setup has run; `bin/install` is run by the user.

## Context

A fresh `omarchy plugin add --enable com.keithrowell.omasnap` correctly
detects the plugin and shows a preview — but silently in plain, uncoloured
text, because nothing had run `bin/build-grammars` yet. The universal
fallback highlighter (`lib/highlight/zed.mjs`, used for Zed, for every
"other" app via `synthesizeZedTheme`, for VS Code whenever the language
can't be resolved, and for Neovim whenever there's no live RPC selection —
see `docs/adr/0005`/`0007`) depends on the vendored tree-sitter grammars
being compiled, and nothing did that automatically.

Checked whether Omarchy's plugin system has a lifecycle hook for this
(a `postInstall`/`setup` manifest field, run once after `git clone`): it
doesn't. Reading `omarchy-plugin-validate`'s actual schema check confirms
the manifest is closed to `schemaVersion`/`id`/`name`/`version`/`kinds`/
`entryPoints`/`barWidget`/`keepLoaded`/plain metadata — nothing that
executes anything. This is almost certainly deliberate: `omarchy plugin
add` already warns "plugins run as arbitrary, unsandboxed code inside your
long-lived shell process" the moment they're *enabled* — a second, separate
auto-run-a-script-on-*clone* mechanism, before a human has even decided to
enable anything, would be a bigger and stranger attack surface for no real
gain.

What the ecosystem uses instead, in practice: a service's own QML runs the
moment it's enabled (`shell.qml`'s `ensureService()`), and nothing stops it
shelling out for its own setup then. `com.keithrowell.doorman` (a plugin
already installed and enabled on the reference machine) does exactly this
in its own `Service.qml` — a `Process` running `mkdir -p` for its state
directories on load. That's the real, established idiom here.

## Decision

`app/Service.qml` runs `<sourceDir>/bin/install` (no flags) once,
in `Component.onCompleted`, via a `Quickshell.Io` `Process`.
`manifest.__sourceDir` (set on every plugin's manifest object by the
shell's own `PluginRegistry.qml`) is used for the path, not a hardcoded one
— a user's dev-clone checkout can live anywhere, and this runs identically
either way.

This is safe to run on *every* load (not just the first), because every
step `bin/install` takes is already idempotent: the grammar build is
mtime-checked (`bin/build-grammars`'s existing `--check` logic), the
desktop file is written only if its content actually changed (`cmp`), the
launcher symlink and plugin symlink are both no-ops once correct, and the
package check is a read-only `pacman -Q`. A normal shell restart or
re-enable does a few fast existence/cmp checks and nothing else.

Its captured stdout decides one of three outcomes:

- Any `bin/install` line matching `missing`/`failed` (a genuinely
  actionable problem — a missing package, a failed grammar build) is both
  `console.warn`ed and sent as a `notify-send` — the existing "never fail
  the install over this, but report it" policy `bin/install` already had,
  now actually reaching the user instead of a terminal nobody's watching.
- No problems, but a `grammar: built ...` line appeared (grammars were
  actually (re)compiled just now): a single "ready to snap" `notify-send`.
- Neither (the common case, everything already set up): silent — no
  notification on every ordinary shell restart.

## Consequences

- Easier: `omarchy plugin add --enable` alone is now a complete, working
  install — no separate `bin/install` a user has no reason to know about,
  and no silent "why is my code plain text" failure mode.
- Harder: the service now shells out on every load, and its setup process
  briefly overlaps with the shell's own startup — bounded by `bin/install`
  itself already being fast when idempotent (a handful of file checks) and
  slow only the first time a real grammar build is needed (~19s on the
  reference machine, entirely backgrounded — nothing blocks on it).
- `bin/install` itself is unchanged and still directly useful: for a
  dev-clone checkout (creating the plugin symlink in the first place,
  which `Service.qml` can't do — it isn't loaded until something is
  already at that path) and for a human who wants to see the same report
  synchronously in a terminal.
- Reversible: this is additive to `Service.qml`; removing the
  `Component.onCompleted` block returns to "a fresh install needs a manual
  `bin/install`," exactly the prior behaviour.
