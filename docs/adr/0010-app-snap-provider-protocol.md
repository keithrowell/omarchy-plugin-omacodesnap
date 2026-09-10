---
number: 0010
title: App snap provider protocol
status: accepted
date: 2026-09-11
---

# ADR-0010: App snap provider protocol

## Status

Accepted.

## Context

ADR-0009 let OmaWordl, a sibling Omarchy plugin, reuse Omasnap's themed
rendering pipeline for its own share image by passing a hand-built fixture
through `bin/omasnap --fixture`. That covers a *static* render — OmaWordl
still has to build its own fixture JSON out-of-band and invoke the fixture
CLI itself, entirely separate from Omasnap's live hotkey flow. It says
nothing about the case this spec is for: a user focuses OmaWordl's window
and presses the *same* Omasnap hotkey they use everywhere else, expecting
Omasnap to render OmaWordl's current on-screen state, not a code selection.

Nothing about OmaWordl's content fits Omasnap's live pipeline as it stands.
`prepareSnap()` (`lib/snap.mjs`) assumes there is a text selection to clean
and highlight, and dispatches on window class through a hardcoded array of
editor adapters (`lib/editors/registry.mjs`'s `EDITORS`: zed, vscode,
neovim, other) that each know how to pull a selection and colour it. Making
OmaWordl's share image work through that pipeline would mean either
teaching Omasnap about OmaWordl specifically (a foreign, single-purpose
special case baked into a generic tool) or asking every app that wants a
bespoke Omasnap render to get a PR merged into this repo's own adapter
registry — neither scales past one app, and neither belongs to Omasnap:
OmaWordl's content and its rendering logic are OmaWordl's business, not
ours.

What every one of these apps already has, though, is a `manifest.json` —
because they're all installed Omarchy plugins to begin with. The manifest
is the one place an app already declares itself to Omarchy; it's also
already read at a point in the flow (window-focus time) where we know
exactly which app is asking.

## Decision

Any installed Omarchy plugin's `manifest.json` may declare itself an
Omasnap snap provider via a new, optional, Omasnap-namespaced section:

```json
{
  "id": "com.keithrowell.omawordl",
  "omasnap": {
    "provider": "bin/omawordl-snap"
  }
}
```

- **`provider`** (required within the `omasnap` block, string): a command
  path *relative to the plugin's own directory*, resolved to an absolute
  path and **verified to still be inside `<pluginDir>`** before anything is
  spawned (`lib/providers.mjs`'s `runProvider` — see "Path containment" in
  Consequences; this was not true of the first version of this spec and was
  fixed after review, see below), then executed directly with no arguments
  — `execFile`, never `exec`/`shell: true`, so the command path is never
  interpolated through a shell. This matches this codebase's existing
  selection-handling security posture (`bin/omasnap`'s own header comment:
  selection text and window info never pass through a shell invocation
  either).
- **The provider's window class is always its manifest's own top-level
  `id`.** There is no override field — an earlier draft of this spec had
  one (`omasnap.windowClass`), and a review caught that it let a provider
  claim any window class at all, including a real editor's own (see
  "Window-class hijacking" in Consequences). Omarchy's plugin installer
  already refuses two plugins claiming the same `id`, so deriving
  `windowClass` from `id` is the one thing a plugin cannot spoof by simply
  writing a different value somewhere in its own manifest — this is why the
  fix was to remove the field outright rather than validate it more
  strictly. OmaWordl's own manifest `id` already *is* its window class, so
  this needed no change on its side.
- A manifest with no `omasnap` key at all — every plugin today, and most
  plugins going forward — is completely unaffected: `lib/providers.mjs`'s
  `scanProviders` skips it, at the cost of one `JSON.parse` per sibling
  plugin per snap.

**Discovery and invocation** live in a new module, `lib/providers.mjs`,
split into two independently-testable functions:

```js
export function scanProviders(pluginsDir = DEFAULT_PLUGINS_DIR) { … }
export function runProvider(provider, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) { … }
```

`scanProviders` reads every `<pluginsDir>/*/manifest.json`, returning
`{ windowClass, command, pluginDir }` for each manifest with a valid
`omasnap.provider` (`windowClass` always the manifest's own `id`). It is
defensive by construction: a missing `pluginsDir`, an unreadable or
malformed sibling manifest, or an `omasnap` block missing `provider` is
silently skipped, never thrown — one broken *other* plugin's manifest must
never take down every Omasnap snap. `pluginsDir` is a parameter, not
hardcoded, the same way `lib/theme.mjs`'s `DEFAULT_THEME_DIR` is a default
rather than baked into `readTheme` — so tests point discovery at a temp
directory of fixture plugin folders instead of the real desktop. A plugin
subdirectory entry is accepted whether it's a real directory or a symlink
to one (see "Symlinked plugin directories" in Consequences). Two more
refusals, both logged: a manifest `id` matching a real, built-in editor's
own window class — `lib/title.mjs`'s `EDITOR_CLASSES` (Zed/VS Code's own
classes) *and* `lib/nvim-rpc.mjs`'s `TERMINAL_CLASSES` (the terminal
classes Neovim detection watches, since Neovim has no window class of its
own) *and* `lib/title.mjs`'s `TRANSIENT_CLASSES` (keyring prompt, lock
screen, Omarchy's own shell surfaces) — is refused outright (see
"Window-class hijacking" below), and if two different plugin directories
somehow resolve to the same `windowClass`, the first found wins and the
collision is logged rather than silently resolved by filesystem order.

`runProvider` spawns one provider's command (resolved to an absolute path,
*verified* to still be inside its own `pluginDir` — see "Path containment"
below) with a short timeout (2.5s default — a synchronous,
hotkey-triggered UI action can't wait long on a misbehaving provider),
killed with `SIGKILL` if it runs over (see "Unkillable timeout" below), and
returns its stdout, parsed and passed through the *existing*
`validateFixture` (`lib/input.mjs`) — the very same schema and validator
every other fixture (a `tests/fixtures/render/*.json` file, or a live snap's
own internally-built fixture) is already required to satisfy, not a second
schema invented for this. Any failure whatsoever — the command escaping its
plugin directory, a nonzero exit, the timeout firing, unparseable stdout,
or JSON that fails `validateFixture` — resolves to `null`, logging one
`console.error` line in this codebase's existing `<module>: message`
convention (see `bin/omasnap`, `lib/snap.mjs`) and nothing else:
`runProvider` never throws and never rejects.

**Wiring into the live flow**: `lib/snap.mjs`'s `prepareSnap()` — the
existing entry point every live snap and the fixture-driven CLI both call
already — checks for a matching provider *first*, before
`detectEditorContext`/any editor-adapter hook runs, using the exact
`windowClass` already passed into `prepareSnap()` (no second Hyprland
lookup is introduced). When `scanProviders` + `findProvider` find an entry
whose `windowClass` matches and `runProvider` returns a fixture, that
fixture becomes `snap` directly — no `detectEditorContext`, no
`resolveSelection`, no highlighting, no font resolution runs for that snap,
because the provider is asserting a complete, final answer. No match, or a
matching provider whose `runProvider` call returns `null`, falls straight
through to exactly today's pipeline, unmodified. `scanProvidersFn`,
`runProviderFn` and `pluginsDir` are all injectable `prepareSnap` options
(matching the existing `detectContext`/`highlightFn`/`fontFn`/`dedentFn`
pattern already there), so this is unit-testable with fakes, with no real
filesystem or subprocess dependency required in most tests.

**A provider is a complete answer regardless of what's selected — so the
live hotkey path no longer treats an empty selection as fatal on its own.**
Before this spec, `bin/omasnap` (bash) exited early with "Nothing selected"
the moment `wl-paste --primary`/`wl-paste` both came up empty, *before*
`node lib/snap.mjs` — and therefore `prepareSnap()`, and therefore the
provider check — ever ran. That made the whole protocol unreachable for
its actual motivating case: OmaWordl is a word game, not an editor, and has
no text selection to speak of. Two things changed together to fix this,
without touching how selection text is captured at all (still never in a
shell variable, argv, or shell invocation — `wl-paste` still writes
straight to a 0600 file under `umask 077`, exactly as before):

- `bin/omasnap` no longer bails on an empty `$SELECTION`. It always
  captures the window info and hands off to `node lib/snap.mjs`, passing
  the (possibly empty) selection file exactly as it would a non-empty one.
- `lib/snap.mjs`'s CLI `main()` moved the "is an empty selection fatal"
  decision to *after* reading the window info, and now asks the provider
  registry first: `text.trim() === "" && !findProvider(scanProviders(),
  windowInfo.class)` — only exits 3 (still bash's cue to notify "Nothing
  selected" and exit 0, unchanged) when *both* nothing is selected *and* no
  provider is registered for the focused window's class. This is a plain
  synchronous match check (no subprocess), short-circuited by `&&` so it
  costs nothing extra on the overwhelmingly common "there is a selection"
  path; the actual provider invocation, if any, still happens exactly once,
  inside `prepareSnap()`.

**A provider that matches but then fails must fall back to "Nothing
selected", not a blank render.** The first version of this fix (above) got
the *shape* right but not the *decision*: `text.trim() === "" &&
!findProvider(scanProviders(), windowInfo.class)` only asks whether a
provider *matched* — not whether it actually produced a fixture — so a
provider that matched and then failed (bad exit, invalid JSON, a spawn
failure) fell through to the ordinary editor-detection pipeline with
`text: ""`, which happily renders a mostly-empty `{"filename":"snippet",…}`
frame instead of ever telling the user nothing happened. That is worse than
either the pre-feature behaviour (a clear "Nothing selected" toast) or the
intended new behaviour (the provider's real fixture): a silent, wrong
render. Caught in review and fixed by moving the decision from a
*pre*-check to a *post*-check: `prepareSnap()` now reports
`providerMatched`/`providerSucceeded` on every return path (not just a
successful match), and `main()` calls `prepareSnap()` first, then only
exits 3 when `text.trim() === "" && !result.providerSucceeded` — i.e. when
either no provider ever matched, *or* one did but failed. A provider that
matches and succeeds is unaffected (the selection state never mattered for
it in the first place); a provider that matches and fails now degrades to
exactly the same "Nothing selected" outcome an unmatched empty selection
has always produced, never a blank/failed render written out as if it were
real.

### Why this is ambient registration under an existing trust grant, not a new trust boundary

The obvious objection: doesn't running a command declared inside another
plugin's manifest hand that plugin a way to get Omasnap to execute
arbitrary code? The code itself, no — that plugin can *already* execute
arbitrary code, unconditionally, the moment it's installed. Per Omarchy's
own documented plugin-trust model (`omarchy plugin add`'s confirmation
prompt, and the shell-plugins manual): "plugins run as arbitrary,
unsandboxed code inside your long-lived shell process… A plugin isn't a
config file — it's code that runs for as long as your session does, with
everything your user account can reach." The user reads and explicitly
confirms that before a plugin is ever enabled. From that moment on, the
plugin's own code is already running, unsandboxed, inside `omarchy-shell`,
with the user's full account access — every second the shell is up,
hotkey or not.

The more precise way to state the conclusion — a distinction a reviewer of
this spec pushed on, correctly — is not "this introduces no new boundary
at all," but that **this is ambient registration under a trust grant that
already exists**: `omasnap.provider` lets an already-trusted plugin opt
itself into a *new trigger* (Omasnap's hotkey) for code the user already
approved running unconditionally, without any further confirmation at
registration time. That is a real, if narrow, expansion of *when* that
code runs and *what a user reasonably expects it to be doing* at that
moment (rendering a snap, specifically) — it is not the introduction of a
new *actor* who can now run code that couldn't before. `runProvider`
invoking `<pluginDir>/<provider>` changes *who triggers* that
already-trusted code and *what it's expected to print* (a fixture JSON,
validated the same way every other fixture is), not *whether* it's trusted
to run at all.

Two things follow from taking that distinction seriously, both addressed
in this round of fixes rather than left as a hand-wave: first, "ambient"
registration must not let a plugin *impersonate* another identity it
wasn't granted — see "Window-class hijacking" below, where an earlier
draft of this spec let exactly that happen via a `windowClass` override.
Second, the *mechanics* of invocation (where the command is allowed to
live, what happens if it never returns) are entirely this repo's own
responsibility, since the plugin's manifest is the one thing an untrusted
context (this repo, integrating with a plugin it didn't write) reads
before any of that plugin's own trusted code runs — see "Path containment"
and "Unkillable timeout" below, both gaps in the manifest-to-invocation
mechanics this round closed. `runProvider`'s containment check, timeout
(now `SIGKILL`-enforced), JSON parsing, and `validateFixture` check
together mean a provider can only ever fail to produce a snap (falling
back to default behaviour) or produce a well-formed fixture for its own,
correctly-scoped window class — it cannot, through this path specifically,
feed Omasnap anything that reaches `app/Snap.qml` outside the exact shape
every other snap's fixture already goes through, and it cannot claim to
be a window it isn't.

## Consequences

- An app that wants a bespoke Omasnap render — OmaWordl today, potentially
  others later — needs zero changes to this repo: a `provider` line in its
  own `manifest.json`, plus a small script that prints a fixture. No PR
  into `lib/editors/registry.mjs`'s `EDITORS` array, no Omasnap release, no
  coordination with this repo's maintainer required.
- Every existing snap path is provably unaffected: `prepareSnap()`'s
  provider check is skipped entirely when `windowClass` is falsy, and costs
  one directory scan (short-circuiting to `[]` when `pluginsDir` doesn't
  exist or has no matching entry) otherwise — `tests/snap.test.mjs`'s full
  existing Zed/VS Code/Neovim/`other` suite (282 tests) still passes
  unchanged, plus 32 new tests across three rounds (24 in
  `tests/providers.test.mjs`, 8 more in `tests/snap.test.mjs`: 6
  `prepareSnap`/CLI decision-logic tests and 2 script-level `bin/omasnap`
  end-to-end tests, plus a further CLI re-highlight-path test) — 314
  total, 0 regressions.
- `lib/input.mjs`'s `validateFixture` now has a second caller beyond
  `buildInput`/the fixture CLI: a provider's fixture is validated in
  `runProvider`, *before* it reaches `prepareSnap`'s return value, so an
  invalid provider fixture degrades to "no provider matched" rather than
  ever reaching `app/Snap.qml` malformed.
- **The empty-selection gate now defers to the provider registry, so the
  live hotkey path actually reaches a text-free provider like OmaWordl,**
  and a matched-but-failed provider degrades to the same "Nothing
  selected" outcome an unmatched one always got rather than a blank render
  — see "A provider is a complete answer…" and "A provider that matches but
  then fails…" above. `tests/snap.test.mjs`'s script-level suite carries
  three-way regression coverage for this: no provider matches (unchanged
  "Nothing selected"), a provider matches and succeeds (its fixture reaches
  the shell-service handoff), and a provider matches but fails (still
  "Nothing selected", never a blank render) — each driving the real
  `bin/omasnap` script end to end (faked `wl-paste`/`hyprctl`/
  `omarchy-shell`, a real fixture plugin directory under the scratch
  `$HOME`'s own `~/.config/omarchy/plugins/`), inspecting either the actual
  notification calls or the actual JSON `bin/omasnap` left behind.
- **Path containment.** The first version of `runProvider` resolved
  `<pluginDir>/<provider>` with plain `resolve()` and claimed (in code
  comments and this ADR) that this "contained" the command to its plugin's
  own directory — it did not. `resolve()` does not enforce containment: an
  absolute `provider` value, or a `../` escape, resolves happily to a path
  outside the plugin's directory and ran regardless. Caught by review, with
  both variants (`"provider": "../../outside/evil"` and an absolute
  `/tmp/...` path) verified to execute against the pre-fix code. Fixed by
  verifying the resolved path is still under `pluginDir` before spawning
  anything: either strictly inside it (`startsWith(pluginDir + sep)`, `sep`
  imported from `node:path`) or equal to `pluginDir` itself
  (`commandPath === pluginDir` — an edge case, not a hole: `provider.command`
  resolving to the directory itself just fails at `execFile` with
  `EACCES`/`EISDIR`, caught the same as any other spawn failure, so it's
  allowed explicitly rather than left as an accident of the check's
  shape). A path failing both is refused (logging, returning `null`, never
  executing). Verified fixed the same way, plus new tests
  (`tests/providers.test.mjs`'s "an absolute command path outside pluginDir
  is refused" / "a ../ escape … is refused").
- **Window-class hijacking.** The first version's optional
  `omasnap.windowClass` override took any declared value at face value —
  a plugin could declare `"windowClass": "dev.zed.Zed"` and its provider
  would run (and its fixture would render) for every real Zed snap on the
  machine instead of Zed's own detection, verified end to end by review.
  Fixed by removing the override field entirely (`windowClass` is always
  the manifest's own `id`, which Omarchy's installer already guarantees
  unique across installed plugins) plus a second, independent layer:
  `scanProviders` refuses any manifest `id` matching a real, built-in
  editor's own window class, so even a plugin whose own `id` literally
  *is* `"dev.zed.Zed"` cannot register — belt-and-suspenders against
  exactly the case the id-uniqueness rule doesn't cover, since none of
  these are Omarchy plugins with a manifest of their own to collide
  against. **This refusal list was initially incomplete** — a second
  review round caught that it only covered `lib/title.mjs`'s
  `EDITOR_CLASSES` (Zed/VS Code's own classes), missing that Neovim isn't
  detected by *any* class of its own at all: it runs inside a terminal, so
  Hyprland reports the terminal's class (`lib/nvim-rpc.mjs`'s
  `TERMINAL_CLASSES`: `foot`, `Alacritty`, `kitty`, etc.), and a plugin
  declaring `id: "foot"` registered cleanly and intercepted every snap
  taken from a foot-hosted Neovim session — verified end to end the same
  way as the original Zed exploit. Closed by folding `TERMINAL_CLASSES`,
  plus `lib/title.mjs`'s `TRANSIENT_CLASSES` (the keyring prompt, lock
  screen, Omarchy's own shell/quickshell surfaces — never a real editor,
  but never a legitimate app window for a provider to claim either) into
  the same refusal set. A third, purely defensive check logs (rather than
  silently resolves by filesystem order) the case of two *different*
  plugin directories somehow resolving to the same `windowClass` —
  should be unreachable now that matching is `id`-only and ids are
  unique, but costs nothing to guard.
- **Symlinked plugin directories.** `scanProviders`'s original directory
  filter (`entry.isDirectory()`) trusted `readdirSync`'s `Dirent` flags,
  which reflect `lstat` semantics — a symlink pointing at a real directory
  reports `isDirectory() === false` and was silently skipped. Verified
  against this machine's real `~/.config/omarchy/plugins/`: 4 of the
  installed plugins, including Omasnap's own install, are symlinks (a
  `bin/install`-style dev checkout, or `omarchy plugin clone`, are both
  symlinks by convention) — and OmaWordl's own install would be too. Fixed
  by accepting `entry.isDirectory() || entry.isSymbolicLink()`.
- **Unkillable timeout.** `execFile`'s default `killSignal` is `SIGTERM`,
  which a misbehaving or malicious provider can simply ignore
  (`process.on("SIGTERM", () => {})`), hanging the hotkey past the timeout
  indefinitely — verified: such a provider was still running 6 seconds
  after a 500ms timeout against the pre-fix code. Fixed by setting
  `killSignal: "SIGKILL"`, which cannot be caught or ignored by the child
  at all. Verified fixed with a TDD round-trip (the new
  SIGTERM-ignoring-provider test fails at ~6050ms against the reverted
  fix, passes at ~509ms with it restored) in addition to the exploit
  scenario re-run directly.
- Two costs accepted on the now-rare "nothing selected, no provider"
  path specifically, both a direct consequence of moving the fatal-or-not
  decision from *before* any real work (the old bash-level fast exit) to
  *after* `prepareSnap()` has already run (needed so the decision can see
  `providerSucceeded` — see "A provider that matches but then fails…"
  above): first, `hyprctl activewindow -j` is now always called before
  `node lib/snap.mjs` runs, even when the selection turns out to be empty
  (previously that bash-level bail skipped it entirely) — a cheap,
  already-used Hyprland IPC call (see `lib/hypr.mjs`'s own use of `hyprctl
  getoption`, same posture), not a new subprocess kind. Second, and more
  substantial: an empty-selection-no-provider snap now always runs full
  editor detection before exiting, including — when the focused window is
  a terminal class — a live Neovim RPC probe (`lib/nvim-rpc.mjs`'s
  `discoverNvimAddress`/`queryNvim`, walking `/proc` and probing a Unix
  socket), where previously it exited immediately with zero work. This is
  a correctness-neutral cost (the outcome is identical — "Nothing
  selected" either way — just reached after strictly more work than
  before) rather than a behaviour change, and is bounded by the same
  degrade-to-`null`-never-throws guarantees `lib/nvim-rpc.mjs` already
  gives every other caller; it has not been benchmarked against the "keep
  under about a second" target in `CONTRIBUTING.md`'s ground rules, which
  is worth doing if this path's latency is ever reported as noticeable.
  Neither cost applies to any snap that either has a real selection or
  matches a provider — nothing heavier (`qs`, the Omasnap shell-service IPC
  call that actually shows a preview) is paid any more often than before:
  those still only run once `node lib/snap.mjs` has produced a real snap
  (provider-rendered or not).
- The `--request` re-highlight CLI path (the preview's language selector)
  had its own, separate copy of the Important-3 bug: it called
  `prepareSnap()` and wrote `--out` unconditionally, with no
  `providerSucceeded` guard at all, so a provider that succeeded on the
  first run (writing an originally-empty `text` into `request.json`) but
  then started failing (a bad release) would have a re-highlight silently
  overwrite the last real render with a blank card. Fixed with the
  identical `text.trim() === "" && !result.providerSucceeded` guard,
  verified against a from-scratch reproduction (a provider that succeeds
  once, is then made to fail, re-highlighted) both via the automated test
  and by re-running the CLI directly outside the test suite.
- If a plugin's `omasnap.provider` command changes behaviour (a bad
  release, say), the blast radius is exactly that plugin's own snap
  failing closed to today's editor-detection/highlighting pipeline — never
  an exception on the hotkey path, never a broken snap for an unrelated
  window.

### Known follow-ups (not fixed in this round)

Raised by review as Minor items, deliberately left for later rather than
expanding this round's scope further:

- The preview's language-reselector re-invokes `prepareSnap()` (and
  therefore, if one matched, the provider) redundantly on every language
  change, even though a provider's fixture is not affected by the language
  selector at all.
- `runProvider`'s stderr diagnostics are plain one-line `console.error`
  messages — no structured detail (stdout snippet, stack, etc.) to help a
  plugin author debug a failing provider beyond what's logged.
- The `--benchmark` path's timing/behaviour under this feature (an empty
  selection with a matching provider, specifically) has no dedicated test,
  unlike the live path.
- A provider's working directory is whatever `execFile` defaults to
  (this process's own cwd), not `pluginDir` — a provider that assumes it
  can read a sibling file by relative path without resolving it against
  its own directory first would break.
- Neither `README.md` nor `SECURITY.md` documents the provider protocol
  yet (the ADR and `lib/providers.mjs`'s own doc comments are the only
  written record so far).
- `runProvider`'s failure message for a timeout-vs-signal-death
  (`err.killed || err.signal`) is imprecise — it can't currently
  distinguish "we killed it because it was slow" from "it died to some
  other signal for an unrelated reason," both logged as "timed out after
  Nms".
