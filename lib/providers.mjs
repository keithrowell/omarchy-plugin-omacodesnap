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
//   no argv built from anything but the plugin's own manifest) and return
//   its validated fixture, or `null` on any failure whatsoever.
//
// Pure ES module: no Qt. `runProvider` is the only part of this file that
// spawns a subprocess, and does so via `execFile` (array argv, `shell`
// left at its default `false`) — never `exec`/`shell: true` — matching
// this codebase's existing selection-handling security posture (see
// `bin/omasnap`'s header comment on how live selection text is handled).

import { readFileSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { validateFixture } from "./input.mjs";

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
 * Read every `<pluginsDir>/*\/manifest.json` and return `{ windowClass,
 * command, pluginDir }` for each manifest that declares a valid
 * `omasnap.provider`. `windowClass` is the manifest's own
 * `omasnap.windowClass` when given, else its top-level `id` (the common
 * case — see ADR-0010).
 *
 * Defensive by design: a missing `pluginsDir`, a plugin subdirectory with
 * no manifest, an unreadable/malformed `manifest.json`, or one whose
 * `omasnap` block is missing/malformed/lacks `provider` is silently
 * skipped, never thrown — this runs across every *other* installed
 * plugin's manifest, none of which this plugin controls.
 */
export function scanProviders(pluginsDir = DEFAULT_PLUGINS_DIR) {
  const providers = [];

  let entries;
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return providers;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
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

    const windowClass =
      typeof omasnap.windowClass === "string" && omasnap.windowClass !== "" ? omasnap.windowClass : manifest.id;
    if (typeof windowClass !== "string" || windowClass === "") continue;

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
 * Run one `scanProviders` entry's command — resolved to an absolute path
 * *under its own `pluginDir`* and executed directly with no arguments, no
 * shell (`execFile`, never `exec`) — and return its stdout as a validated
 * fixture object.
 *
 * Returns `null`, and only ever `null` (never throws, never rejects), on
 * ANY failure: the command can't be spawned/found, a nonzero exit, the
 * timeout is exceeded, stdout isn't valid JSON, or the parsed JSON fails
 * `validateFixture` — the caller always gets back either a fixture that
 * `app/Snap.qml` can render as-is, or a plain signal to fall back to
 * today's default behaviour. Each failure is logged once as a warning
 * (matching this codebase's `<module>: message` convention — see
 * `bin/omasnap`/`lib/snap.mjs`) so a misbehaving provider leaves a trace
 * without ever surfacing as an exception on the hotkey path.
 */
export function runProvider(provider, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const commandPath = resolve(provider.pluginDir, provider.command);

  return new Promise((settle) => {
    execFile(commandPath, [], { timeout: timeoutMs, encoding: "utf8" }, (err, stdout) => {
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
