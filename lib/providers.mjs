// Snap providers (ADR-0010): discovery and invocation for the optional,
// OmaSnap-specific `omasnap` block any installed Omarchy plugin's own
// `manifest.json` may carry, declaring a command that renders a complete,
// final fixture for that plugin's own window — bypassing OmaSnap's normal
// editor-detection/selection/highlighting pipeline entirely for that snap.
//
// Two responsibilities, kept separate and independently testable:
//
//   scanProviders(pluginsDir) — read every sibling plugin's manifest.json
//   and return the ones that declare a provider. Purely synchronous file
//   I/O; never throws, no matter how malformed a *sibling* plugin's
//   manifest is — one broken plugin must never break every OmaSnap snap.
//
//   runProvider(provider, opts) — spawn one provider's command (no shell,
//   no argv built from anything but the plugin's own manifest, and
//   contained to the plugin's own directory — see below) and return its
//   validated fixture, or `null` on any failure whatsoever.
//
// Pure ES module: no Qt. `runProvider` is the only part of this file that
// spawns a subprocess, and does so via `execFile` (array argv, `shell`
// left at its default `false`) — never `exec`/`shell: true` — matching
// this codebase's existing selection-handling security posture (see
// `bin/omasnap`'s header comment on how live selection text is handled).

import { readFileSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { validateFixture } from "./input.mjs";
import { EDITOR_CLASSES, TRANSIENT_CLASSES } from "./title.mjs";
import { TERMINAL_CLASSES } from "./nvim-rpc.mjs";

/**
 * Where real Omarchy plugins live. A default/caller concern, not baked into
 * `scanProviders` itself — same pattern as `lib/theme.mjs`'s
 * `DEFAULT_THEME_DIR` — so tests can point discovery at a temp directory of
 * fixture plugin folders instead of the real desktop's plugin directory.
 */
export const DEFAULT_PLUGINS_DIR = join(homedir(), ".config", "omarchy", "plugins");

/** A synchronous hotkey-triggered UI action can't wait long on a misbehaving provider; see ADR-0010. */
export const DEFAULT_TIMEOUT_MS = 2500;

/**
 * Every window class a real, built-in editor adapter is known to answer to
 * — not just Zed/VS Code's own classes (`lib/title.mjs`'s `EDITOR_CLASSES`),
 * but also every terminal class Neovim detection watches
 * (`lib/nvim-rpc.mjs`'s `TERMINAL_CLASSES`: Neovim runs *inside* a terminal
 * window, so its own "window class" is whichever terminal hosts it — `foot`,
 * `Alacritty`, `kitty`, etc. — not a Neovim-specific class of its own) and
 * every known-transient shell/overlay surface (`lib/title.mjs`'s
 * `TRANSIENT_CLASSES`: a keyring prompt, the lock screen, Omarchy's own
 * shell/quickshell surfaces — never a real editor, but never a legitimate
 * app window for a provider to claim either). A provider is refused if it
 * would register under any of these (see `scanProviders`) —
 * belt-and-suspenders against a plugin literally declaring `id:
 * "dev.zed.Zed"` (or `id: "foot"`, intercepting every terminal-hosted
 * Neovim snap on the machine — the same hijack shape, just a different
 * detection mechanism) and intercepting real snaps, which Omarchy's own
 * plugin-id-uniqueness rule doesn't prevent, since none of Zed, VS Code, a
 * terminal emulator, or the Omarchy shell itself is an Omarchy plugin with
 * a manifest of its own to collide against.
 */
const BUILT_IN_EDITOR_CLASSES = new Set([...Object.values(EDITOR_CLASSES).flat(), ...TERMINAL_CLASSES, ...TRANSIENT_CLASSES]);

/**
 * Read every `<pluginsDir>/*\/manifest.json` and return `{ windowClass,
 * command, pluginDir }` for each manifest that declares a valid
 * `omasnap.provider`. `windowClass` is always the manifest's own top-level
 * `id` — there is no override field. This is deliberate (ADR-0010): a
 * provider claiming a `windowClass` other than its own `id` could intercept
 * another app's (or another *real* editor's) snaps, and Omarchy's plugin
 * installer already guarantees `id` is unique across installed plugins, so
 * deriving `windowClass` from it is the one thing a plugin cannot spoof by
 * simply writing a different value into its own manifest.
 *
 * Defensive by design: a missing `pluginsDir`, a plugin subdirectory with
 * no manifest, an unreadable/malformed `manifest.json`, or one whose
 * `omasnap` block is missing/malformed/lacks `provider` is silently
 * skipped, never thrown — this runs across every *other* installed
 * plugin's manifest, none of which this plugin controls. A plugin
 * subdirectory entry is accepted whether it's a real directory or a
 * symlink to one (`readdirSync`'s `Dirent.isDirectory()` reflects `lstat`,
 * which reports `false` for a symlink — and a real, symlinked Omarchy
 * install, including OmaSnap's own, is the common case, not the
 * exception).
 *
 * Two more refusals, both logged (never thrown): a manifest `id` that
 * collides with a real, built-in editor's own window class
 * (`BUILT_IN_EDITOR_CLASSES`) is refused outright, and if two *different*
 * plugin directories somehow resolve to the same `windowClass` (should
 * never happen once matching is `id`-only and ids are unique, but cheap
 * insurance against a future regression), the first one found wins and the
 * collision is logged rather than silently resolved by filesystem order.
 */
export function scanProviders(pluginsDir = DEFAULT_PLUGINS_DIR) {
  const providers = [];
  const claimedBy = new Map(); // windowClass -> pluginDir of the first plugin that claimed it

  let entries;
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return providers;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const pluginDir = join(pluginsDir, entry.name);

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));
    } catch {
      continue;
    }
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) continue;

    const omasnap = manifest.omasnap;
    if (typeof omasnap !== "object" || omasnap === null || Array.isArray(omasnap)) continue;
    if (typeof omasnap.provider !== "string" || omasnap.provider === "") continue;

    const windowClass = manifest.id;
    if (typeof windowClass !== "string" || windowClass === "") continue;

    if (BUILT_IN_EDITOR_CLASSES.has(windowClass)) {
      console.error(`omasnap: provider at ${pluginDir} declares id "${windowClass}", a built-in editor's own window class; refusing to register it`);
      continue;
    }

    if (claimedBy.has(windowClass)) {
      console.error(
        `omasnap: two plugins resolve to the same windowClass "${windowClass}" (${claimedBy.get(windowClass)} and ${pluginDir}); keeping the first, ignoring ${pluginDir}`,
      );
      continue;
    }
    claimedBy.set(windowClass, pluginDir);

    providers.push({ windowClass, command: omasnap.provider, pluginDir });
  }

  return providers;
}

/**
 * The first provider (in `scanProviders`'s own order) whose `windowClass`
 * matches the focused window's class, or `null` when there is none or
 * `windowClass` itself is falsy/not a string.
 */
export function findProvider(providers, windowClass) {
  if (typeof windowClass !== "string" || windowClass === "") return null;
  return providers.find((provider) => provider.windowClass === windowClass) ?? null;
}

/**
 * Run one `scanProviders` entry's command and return its stdout as a
 * validated fixture object.
 *
 * The command is resolved to an absolute path and *verified to still be
 * inside `provider.pluginDir`* before anything is spawned — `resolve()`
 * alone does not enforce containment (an absolute `command`, or a `../`
 * escape, resolves happily to a path outside the plugin's own directory).
 * "Still inside" allows two shapes: the resolved path sits *under*
 * `pluginDir` (`startsWith(pluginDir + sep)`), or it resolves to
 * `pluginDir` itself exactly (`provider.command` being empty or `"."`,
 * say) — harmless in practice, since `execFile`-ing a directory just fails
 * with `EACCES`/`EISDIR`, caught the same as any other spawn failure below,
 * but kept as an explicit allowed case rather than an accidental one. A
 * provider whose resolved command escapes `pluginDir` under neither shape
 * is refused outright (logged, never executed). Once contained, it is
 * executed directly with no arguments, no shell (`execFile`, never `exec`)
 * — matching this codebase's existing selection-handling security posture.
 *
 * Returns `null`, and only ever `null` (never throws, never rejects), on
 * ANY failure: the command escapes its plugin directory, can't be
 * spawned/found, exits nonzero, exceeds the timeout (killed with `SIGKILL`
 * — the default `SIGTERM` can simply be ignored by a misbehaving or
 * malicious provider, which would otherwise hang the hotkey past the
 * timeout entirely), prints stdout that isn't valid JSON, or fails
 * `validateFixture` — the caller always gets back either a fixture that
 * `app/Snap.qml` can render as-is, or a plain signal to fall back to
 * today's default behaviour. Each failure is logged once as a warning
 * (matching this codebase's `<module>: message` convention — see
 * `bin/omasnap`/`lib/snap.mjs`) so a misbehaving provider leaves a trace
 * without ever surfacing as an exception on the hotkey path.
 */
export function runProvider(provider, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const pluginDir = resolve(provider.pluginDir);
  const commandPath = resolve(pluginDir, provider.command);
  if (commandPath !== pluginDir && !commandPath.startsWith(pluginDir + sep)) {
    console.error(`omasnap: provider for ${provider.windowClass} (${provider.command}) escapes its plugin directory, refusing to run it`);
    return Promise.resolve(null);
  }

  return new Promise((settle) => {
    execFile(commandPath, [], { timeout: timeoutMs, encoding: "utf8", killSignal: "SIGKILL" }, (err, stdout) => {
      if (err) {
        const reason = err.killed || err.signal ? `timed out after ${timeoutMs}ms` : err.message;
        console.error(`omasnap: provider for ${provider.windowClass} (${commandPath}) failed: ${reason}`);
        settle(null);
        return;
      }

      let fixture;
      try {
        fixture = JSON.parse(stdout);
      } catch (parseErr) {
        console.error(`omasnap: provider for ${provider.windowClass} did not print valid JSON: ${parseErr.message}`);
        settle(null);
        return;
      }

      try {
        validateFixture(fixture);
      } catch (validateErr) {
        console.error(`omasnap: provider for ${provider.windowClass}'s fixture is invalid: ${validateErr.message}`);
        settle(null);
        return;
      }

      settle(fixture);
    });
  });
}
