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
    "provider": "bin/omawordl-snap",
    "windowClass": "com.keithrowell.omawordl"
  }
}
```

- **`provider`** (required within the `omasnap` block, string): a command
  path *relative to the plugin's own directory*, resolved as
  `<pluginDir>/<provider>` and executed directly with no arguments —
  `execFile`, never `exec`/`shell: true`, so the command path is never
  interpolated through a shell (see `lib/providers.mjs`'s `runProvider`).
  This matches this codebase's existing selection-handling security posture
  (`bin/omasnap`'s own header comment: selection text and window info never
  pass through a shell invocation either).
- **`windowClass`** (optional string): the Hyprland window class this
  provider applies to. Defaults to the manifest's own top-level `id` when
  absent, because an app's GTK/window app-id equals its Omarchy manifest id
  in the overwhelming common case (OmaWordl's own manifest doesn't need to
  set it) — only a plugin whose window class genuinely differs from its
  manifest id needs to say so explicitly.
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
`omasnap.provider`. It is defensive by construction: a missing
`pluginsDir`, an unreadable or malformed sibling manifest, or an `omasnap`
block missing `provider` is silently skipped, never thrown — one broken
*other* plugin's manifest must never take down every Omasnap snap.
`pluginsDir` is a parameter, not hardcoded, the same way `lib/theme.mjs`'s
`DEFAULT_THEME_DIR` is a default rather than baked into `readTheme` — so
tests point discovery at a temp directory of fixture plugin folders instead
of the real desktop.

`runProvider` spawns one provider's command (resolved to an absolute path
under its own `pluginDir`) with a short timeout (2.5s default — a
synchronous, hotkey-triggered UI action can't wait long on a misbehaving
provider) and returns its stdout, parsed and passed through the *existing*
`validateFixture` (`lib/input.mjs`) — the very same schema and validator
every other fixture (a `tests/fixtures/render/*.json` file, or a live snap's
own internally-built fixture) is already required to satisfy, not a second
schema invented for this. Any failure whatsoever — a nonzero exit, the
timeout firing, unparseable stdout, or JSON that fails `validateFixture` —
resolves to `null`, logging one `console.error` line in this codebase's
existing `<module>: message` convention (see `bin/omasnap`, `lib/snap.mjs`)
and nothing else: `runProvider` never throws and never rejects.

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

A provider that *matches* but then fails (`runProvider` returning `null`)
with an empty selection falls through to the ordinary editor-detection
pipeline with empty text, same as any other no-provider empty-text case
would if this check didn't exist — this spec doesn't special-case that
combination further; it was never reachable before providers existed, and
"a registered provider that also happens to be broken, with also nothing
selected" is a narrow, self-correcting failure mode (the plugin author sees
their own provider not firing).

### Why an already-installed plugin's own manifest is not a new trust boundary

The obvious objection: doesn't running a command declared inside another
plugin's manifest hand that plugin a way to get Omasnap to execute
arbitrary code? No — because that plugin can *already* execute arbitrary
code, unconditionally, the moment it's installed. Per Omarchy's own
documented plugin-trust model (`omarchy plugin add`'s confirmation prompt,
and the shell-plugins manual): "plugins run as arbitrary, unsandboxed code
inside your long-lived shell process… A plugin isn't a config file — it's
code that runs for as long as your session does, with everything your user
account can reach." The user reads and explicitly confirms that before a
plugin is ever enabled. From that moment on, the plugin's own code is
already running, unsandboxed, inside `omarchy-shell`, with the user's full
account access — every second the shell is up, hotkey or not.

`runProvider` invoking `<pluginDir>/<provider>` changes *who triggers* that
already-trusted code (Omasnap's hotkey, instead of whatever the plugin
itself would otherwise do) and *what it's expected to print* (a fixture
JSON, validated the same way every other fixture is), not *whether* it's
trusted to run at all. It is the same code the user already vetted when
they ran `omarchy plugin add`, invoked from a different trigger — not a new
surface. The one thing Omasnap adds on its own side of that line is
defensive: `runProvider`'s timeout, JSON parsing, and `validateFixture`
check mean a provider can only ever fail to produce a snap (falling back to
default behaviour) or produce a well-formed fixture — it cannot, through
this path specifically, feed Omasnap anything that reaches `app/Snap.qml`
outside the exact shape every other snap's fixture already goes through.

## Consequences

- An app that wants a bespoke Omasnap render — OmaWordl today, potentially
  others later — needs zero changes to this repo: a `provider` (and,
  rarely, a `windowClass`) line in its own `manifest.json`, plus a small
  script that prints a fixture. No PR into `lib/editors/registry.mjs`'s
  `EDITORS` array, no Omasnap release, no coordination with this repo's
  maintainer required.
- Every existing snap path is provably unaffected: `prepareSnap()`'s
  provider check is skipped entirely when `windowClass` is falsy, and costs
  one directory scan (short-circuiting to `[]` when `pluginsDir` doesn't
  exist or has no matching entry) otherwise — `tests/snap.test.mjs`'s full
  existing Zed/VS Code/Neovim/`other` suite (282 tests) still passes
  unchanged, plus 18 new tests (13 in `tests/providers.test.mjs`, 5 more in
  `tests/snap.test.mjs`: 4 `prepareSnap` decision-logic tests and 1
  script-level `bin/omasnap` end-to-end test) — 300 total, 0 regressions.
- `lib/input.mjs`'s `validateFixture` now has a second caller beyond
  `buildInput`/the fixture CLI: a provider's fixture is validated in
  `runProvider`, *before* it reaches `prepareSnap`'s return value, so an
  invalid provider fixture degrades to "no provider matched" rather than
  ever reaching `app/Snap.qml` malformed.
- **The empty-selection gate now defers to the provider registry, so the
  live hotkey path actually reaches a text-free provider like OmaWordl.**
  This was flagged as a known limitation during this spec's first pass and
  is now resolved (see "A provider is a complete answer…" above): bash no
  longer decides "nothing selected" is fatal on its own, and
  `lib/snap.mjs`'s CLI only exits 3 when neither a selection nor a matching
  provider exists. `tests/snap.test.mjs`'s script-level suite carries both
  halves of the regression guard this required: "an empty selection
  notifies 'Nothing selected'… when no provider matches" (renamed from its
  original title to say so explicitly) proves the pre-existing
  no-provider/no-selection case is unchanged, and a new "an empty selection
  with a matching provider renders the provider's fixture instead of
  bailing…" test drives the real `bin/omasnap` script — faked
  `wl-paste`/`hyprctl`/`omarchy-shell`, a real fixture plugin directory
  under the scratch `$HOME`'s own `~/.config/omarchy/plugins/` — end to
  end, and inspects the actual JSON `bin/omasnap` left behind to confirm
  the provider's fixture (not a blank/failed snap) is what reached the
  handoff to the Omasnap shell service.
- One cost accepted on the now-rare "nothing selected" path specifically:
  `hyprctl activewindow -j` is now always called before `node lib/snap.mjs`
  runs, even when the selection turns out to be empty (previously that
  bash-level bail skipped it entirely). This is a cheap, already-used
  Hyprland IPC call (see `lib/hypr.mjs`'s own use of `hyprctl getoption`,
  same posture), not a new subprocess kind, and nothing heavier — `qs`, the
  Omasnap shell-service IPC call that actually shows a preview — is paid
  any more often than before: those still only run once `node lib/snap.mjs`
  has produced a real snap (provider-rendered or not).
- If a plugin's `omasnap.provider` command changes behaviour (a bad
  release, say), the blast radius is exactly that plugin's own snap
  failing closed to today's editor-detection/highlighting pipeline — never
  an exception on the hotkey path, never a broken snap for an unrelated
  window.
