import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProviders, findProvider, runProvider } from "../lib/providers.mjs";
import { EDITOR_CLASSES, TRANSIENT_CLASSES } from "../lib/title.mjs";
import { TERMINAL_CLASSES } from "../lib/nvim-rpc.mjs";

function scratchDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A `<pluginsDir>/<id>/manifest.json` fixture plugin directory. `manifestText`, when given, is written verbatim instead of JSON-encoding `manifest` (for the malformed-JSON case). `dirName` lets a test give the plugin directory a different name than its manifest `id` (scanProviders never reads the directory name itself — only `id` matters). */
function addPlugin(pluginsDir, id, manifest, { manifestText, dirName } = {}) {
  const dir = join(pluginsDir, dirName ?? id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), manifestText ?? JSON.stringify(manifest));
  return dir;
}

/** A tiny executable Node script fixture — `runProvider` spawns it directly (no shell, no interpreter argv), so it needs its own shebang and the executable bit. */
function addScript(pluginDir, name, body) {
  const path = join(pluginDir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const VALID_FIXTURE = {
  filename: "share.png",
  language: null,
  editor: "other",
  font: { family: "monospace", size: 13 },
  lines: [[{ text: "hi" }]],
};

// --- scanProviders -----------------------------------------------------------

test("scanProviders: a nonexistent pluginsDir returns an empty array, never throws", () => {
  const dir = scratchDir("omasnap-providers-missing-");
  rmSync(dir, { recursive: true, force: true }); // never created
  assert.deepEqual(scanProviders(dir), []);
});

test("scanProviders: collects exactly the manifests with a valid omasnap.provider, skipping every malformed/absent sibling; windowClass is always the manifest's own id", () => {
  const pluginsDir = scratchDir("omasnap-providers-scan-");
  try {
    addPlugin(pluginsDir, "com.keithrowell.omawordl", {
      schemaVersion: 1,
      id: "com.keithrowell.omawordl",
      name: "OmaWordl",
      version: "1.0.0",
      omasnap: { provider: "bin/omawordl-snap" },
    });

    addPlugin(pluginsDir, "org.example.otherapp", {
      schemaVersion: 1,
      id: "org.example.otherapp",
      name: "Other App",
      version: "1.0.0",
      omasnap: { provider: "snap.sh" },
    });

    // No omasnap key at all: unaffected, must not appear.
    addPlugin(pluginsDir, "omarchy.clock", {
      schemaVersion: 1,
      id: "omarchy.clock",
      name: "Clock",
      version: "1.0.0",
    });

    // Malformed manifest.json: must not throw, must be skipped.
    addPlugin(pluginsDir, "broken.manifest", null, { manifestText: "{ this is not json" });

    // omasnap present but missing the required provider field: skipped.
    addPlugin(pluginsDir, "no.provider.field", {
      schemaVersion: 1,
      id: "no.provider.field",
      name: "No Provider",
      version: "1.0.0",
      omasnap: {},
    });

    // A stray (ignored) omasnap.windowClass field, now that the field no
    // longer exists in the schema: windowClass must still come from `id`,
    // never from this leftover/foreign key.
    addPlugin(pluginsDir, "org.example.spoofattempt", {
      schemaVersion: 1,
      id: "org.example.spoofattempt",
      name: "Spoof Attempt",
      version: "1.0.0",
      omasnap: { provider: "snap.sh", windowClass: "org.example.somethingelse" },
    });

    const providers = scanProviders(pluginsDir);
    assert.equal(providers.length, 3);

    const omawordl = providers.find((p) => p.windowClass === "com.keithrowell.omawordl");
    assert.ok(omawordl, "windowClass defaults to (is always) the manifest's own id");
    assert.equal(omawordl.command, "bin/omawordl-snap");
    assert.equal(omawordl.pluginDir, join(pluginsDir, "com.keithrowell.omawordl"));

    const otherapp = providers.find((p) => p.windowClass === "org.example.otherapp");
    assert.ok(otherapp);
    assert.equal(otherapp.command, "snap.sh");
    assert.equal(otherapp.pluginDir, join(pluginsDir, "org.example.otherapp"));

    const spoofAttempt = providers.find((p) => p.pluginDir.endsWith("org.example.spoofattempt"));
    assert.ok(spoofAttempt, "a stray omasnap.windowClass key is present but ignored");
    assert.equal(spoofAttempt.windowClass, "org.example.spoofattempt", "windowClass is the manifest's own id, not the stray key's value");

    assert.ok(!providers.some((p) => p.pluginDir.endsWith("omarchy.clock")), "no omasnap key: skipped");
    assert.ok(!providers.some((p) => p.pluginDir.endsWith("broken.manifest")), "malformed manifest.json: skipped");
    assert.ok(!providers.some((p) => p.pluginDir.endsWith("no.provider.field")), "omasnap present but no provider field: skipped");
  } finally {
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});

test("scanProviders: a manifest.json that parses to a non-object (array/string/number) is skipped, not thrown", () => {
  const pluginsDir = scratchDir("omasnap-providers-nonobject-");
  try {
    addPlugin(pluginsDir, "weird.array", null, { manifestText: "[1,2,3]" });
    addPlugin(pluginsDir, "weird.string", null, { manifestText: '"just a string"' });
    assert.deepEqual(scanProviders(pluginsDir), []);
  } finally {
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});

test("scanProviders: a non-directory, non-symlink entry inside pluginsDir (a stray file) is ignored", () => {
  const pluginsDir = scratchDir("omasnap-providers-strayfile-");
  try {
    writeFileSync(join(pluginsDir, "README.txt"), "not a plugin");
    assert.deepEqual(scanProviders(pluginsDir), []);
  } finally {
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});

// Real Omarchy plugin installs are commonly symlinks (a `bin/install`-style
// dev checkout, or `omarchy plugin clone`) — `readdirSync`'s `Dirent`
// reflects `lstat`, which reports `isDirectory() === false` for a symlink
// even when it points at a real directory. 4 of 16 real plugins on the
// machine this was built on, including Omasnap's own install, are
// symlinks — this must not silently exclude them.
test("scanProviders: a symlinked plugin directory is scanned exactly like a real one", () => {
  const pluginsDir = scratchDir("omasnap-providers-symlink-");
  const realDir = scratchDir("omasnap-providers-symlink-target-");
  try {
    writeFileSync(
      join(realDir, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, id: "com.keithrowell.symlinked", name: "Symlinked", version: "1.0.0", omasnap: { provider: "snap.sh" } }),
    );
    symlinkSync(realDir, join(pluginsDir, "com.keithrowell.symlinked"));

    const providers = scanProviders(pluginsDir);
    assert.equal(providers.length, 1);
    assert.equal(providers[0].windowClass, "com.keithrowell.symlinked");
    assert.equal(providers[0].pluginDir, join(pluginsDir, "com.keithrowell.symlinked"));
  } finally {
    rmSync(pluginsDir, { recursive: true, force: true });
    rmSync(realDir, { recursive: true, force: true });
  }
});

test("scanProviders: a manifest id matching a real editor's own window class is refused, not registered", () => {
  const pluginsDir = scratchDir("omasnap-providers-hijack-");
  try {
    const zedClass = EDITOR_CLASSES.zed[0];
    addPlugin(
      pluginsDir,
      zedClass,
      { schemaVersion: 1, id: zedClass, name: "Fake Zed", version: "1.0.0", omasnap: { provider: "snap.sh" } },
      { dirName: "fake-zed-plugin" },
    );
    assert.deepEqual(scanProviders(pluginsDir), []);
  } finally {
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});

test("scanProviders: every EDITOR_CLASSES entry is refused as a provider id", () => {
  const pluginsDir = scratchDir("omasnap-providers-hijack-all-");
  try {
    const allClasses = Object.values(EDITOR_CLASSES).flat();
    allClasses.forEach((cls, i) => {
      addPlugin(pluginsDir, cls, { schemaVersion: 1, id: cls, name: "Fake", version: "1.0.0", omasnap: { provider: "snap.sh" } }, { dirName: `fake-${i}` });
    });
    assert.deepEqual(scanProviders(pluginsDir), []);
  } finally {
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});

// Neovim isn't detected by its own window class at all — it runs *inside*
// a terminal, so the window class Hyprland reports is the terminal's own
// (`lib/nvim-rpc.mjs`'s `TERMINAL_CLASSES`), not something Neovim-specific.
// A provider declaring `id: "foot"` (or any other terminal class) would
// otherwise register cleanly and intercept every snap taken from that
// terminal, live Neovim sessions included — the same hijack shape as the
// Zed/VS Code case, just a different (pid-based, not class-based)
// detection mechanism underneath, which the EDITOR_CLASSES-only refusal
// list didn't cover.
test('scanProviders: a manifest id matching a terminal class Neovim detection relies on (e.g. "foot") is refused, not registered', () => {
  const pluginsDir = scratchDir("omasnap-providers-hijack-terminal-");
  try {
    addPlugin(pluginsDir, "foot", { schemaVersion: 1, id: "foot", name: "Fake Foot Hijacker", version: "1.0.0", omasnap: { provider: "hijack.sh" } }, { dirName: "fake-foot-plugin" });
    assert.deepEqual(scanProviders(pluginsDir), []);
  } finally {
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});

test("scanProviders: every TERMINAL_CLASSES entry is refused as a provider id", () => {
  const pluginsDir = scratchDir("omasnap-providers-hijack-terminal-all-");
  try {
    TERMINAL_CLASSES.forEach((cls, i) => {
      addPlugin(pluginsDir, cls, { schemaVersion: 1, id: cls, name: "Fake", version: "1.0.0", omasnap: { provider: "snap.sh" } }, { dirName: `fake-term-${i}` });
    });
    assert.deepEqual(scanProviders(pluginsDir), []);
  } finally {
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});

test("scanProviders: every TRANSIENT_CLASSES entry (keyring prompt, lock screen, Omarchy shell surfaces) is refused as a provider id", () => {
  const pluginsDir = scratchDir("omasnap-providers-hijack-transient-");
  try {
    TRANSIENT_CLASSES.forEach((cls, i) => {
      addPlugin(pluginsDir, cls, { schemaVersion: 1, id: cls, name: "Fake", version: "1.0.0", omasnap: { provider: "snap.sh" } }, { dirName: `fake-transient-${i}` });
    });
    assert.deepEqual(scanProviders(pluginsDir), []);
  } finally {
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});

test("scanProviders: two different plugin directories resolving to the same windowClass keep the first, log a warning, and never register both", () => {
  const pluginsDir = scratchDir("omasnap-providers-collision-");
  try {
    // Directory names sort before/after each other predictably so the
    // "first" one is deterministic regardless of filesystem readdir order
    // quirks on any given machine.
    addPlugin(
      pluginsDir,
      "org.example.collide",
      { schemaVersion: 1, id: "org.example.collide", name: "First", version: "1.0.0", omasnap: { provider: "first.sh" } },
      { dirName: "aaa-first" },
    );
    addPlugin(
      pluginsDir,
      "org.example.collide",
      { schemaVersion: 1, id: "org.example.collide", name: "Second", version: "1.0.0", omasnap: { provider: "second.sh" } },
      { dirName: "zzz-second" },
    );

    const providers = scanProviders(pluginsDir);
    assert.equal(providers.length, 1, "only one of the two colliding manifests is ever registered");
    assert.equal(providers[0].pluginDir, join(pluginsDir, "aaa-first"), "the first one found (readdir order) wins");
  } finally {
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});

// --- findProvider --------------------------------------------------------------

test("findProvider: matches by windowClass, first entry wins on a duplicate", () => {
  const providers = [
    { windowClass: "a", command: "one", pluginDir: "/one" },
    { windowClass: "b", command: "two", pluginDir: "/two" },
    { windowClass: "a", command: "three", pluginDir: "/three" },
  ];
  assert.equal(findProvider(providers, "b").command, "two");
  assert.equal(findProvider(providers, "a").command, "one");
});

test("findProvider: no match, or a falsy/non-string windowClass, returns null", () => {
  const providers = [{ windowClass: "a", command: "one", pluginDir: "/one" }];
  assert.equal(findProvider(providers, "nope"), null);
  assert.equal(findProvider(providers, undefined), null);
  assert.equal(findProvider(providers, ""), null);
  assert.equal(findProvider([], "a"), null);
});

// --- runProvider: containment (Critical 1) --------------------------------------

test("runProvider: an absolute command path outside pluginDir is refused, never executed", async () => {
  const pluginDir = scratchDir("omasnap-providers-escape-abs-");
  const probeDir = scratchDir("omasnap-providers-escape-abs-probe-");
  const probeFile = join(probeDir, "evidence.txt");
  try {
    const outsideScript = join(probeDir, "evil.mjs");
    writeFileSync(
      outsideScript,
      `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(probeFile)}, "ran");\nconsole.log(JSON.stringify(${JSON.stringify(VALID_FIXTURE)}));\n`,
    );
    chmodSync(outsideScript, 0o755);

    const fixture = await runProvider({ windowClass: "test.escape.abs", command: outsideScript, pluginDir });
    assert.equal(fixture, null, "an absolute path outside pluginDir must be refused");
    assert.ok(!existsSync(probeFile), "the outside script must never actually run");
  } finally {
    rmSync(pluginDir, { recursive: true, force: true });
    rmSync(probeDir, { recursive: true, force: true });
  }
});

test("runProvider: a ../ escape out of pluginDir is refused, never executed", async () => {
  const parentDir = scratchDir("omasnap-providers-escape-rel-");
  const pluginDir = join(parentDir, "plugin");
  mkdirSync(pluginDir, { recursive: true });
  const probeFile = join(parentDir, "evidence.txt");
  try {
    const outsideScript = join(parentDir, "evil.mjs");
    writeFileSync(
      outsideScript,
      `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(probeFile)}, "ran");\nconsole.log(JSON.stringify(${JSON.stringify(VALID_FIXTURE)}));\n`,
    );
    chmodSync(outsideScript, 0o755);

    // "../../../etc/hostname"-shaped escape: enough ".."s to leave pluginDir
    // and land on the sibling script placed one level up.
    const fixture = await runProvider({ windowClass: "test.escape.rel", command: "../evil.mjs", pluginDir });
    assert.equal(fixture, null, "a ../ escape out of pluginDir must be refused");
    assert.ok(!existsSync(probeFile), "the outside script must never actually run");
  } finally {
    rmSync(parentDir, { recursive: true, force: true });
  }
});

test("runProvider: a command that resolves inside pluginDir (including via a harmless ./ or nested path) still runs normally", async () => {
  const pluginDir = scratchDir("omasnap-providers-contained-");
  try {
    mkdirSync(join(pluginDir, "bin"), { recursive: true });
    addScript(pluginDir, "bin/snap.mjs", `console.log(JSON.stringify(${JSON.stringify(VALID_FIXTURE)}));`);
    const fixture = await runProvider({ windowClass: "test.contained", command: "./bin/snap.mjs", pluginDir });
    assert.deepEqual(fixture, VALID_FIXTURE);
  } finally {
    rmSync(pluginDir, { recursive: true, force: true });
  }
});

// --- runProvider: other failure modes -------------------------------------------

test("runProvider: a clean exit with a valid fixture on stdout resolves to that fixture", async () => {
  const pluginDir = scratchDir("omasnap-providers-run-ok-");
  try {
    addScript(pluginDir, "snap.mjs", `console.log(JSON.stringify(${JSON.stringify(VALID_FIXTURE)}));`);
    const fixture = await runProvider({ windowClass: "test.ok", command: "snap.mjs", pluginDir });
    assert.deepEqual(fixture, VALID_FIXTURE);
  } finally {
    rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("runProvider: a nonzero exit resolves to null, never throws/rejects", async () => {
  const pluginDir = scratchDir("omasnap-providers-run-nonzero-");
  try {
    addScript(pluginDir, "snap.mjs", `console.error("boom"); process.exit(1);`);
    const fixture = await runProvider({ windowClass: "test.nonzero", command: "snap.mjs", pluginDir });
    assert.equal(fixture, null);
  } finally {
    rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("runProvider: invalid JSON on stdout resolves to null", async () => {
  const pluginDir = scratchDir("omasnap-providers-run-badjson-");
  try {
    addScript(pluginDir, "snap.mjs", `console.log("not json at all {");`);
    const fixture = await runProvider({ windowClass: "test.badjson", command: "snap.mjs", pluginDir });
    assert.equal(fixture, null);
  } finally {
    rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("runProvider: valid JSON that fails validateFixture (missing required fields) resolves to null", async () => {
  const pluginDir = scratchDir("omasnap-providers-run-invalidfixture-");
  try {
    addScript(pluginDir, "snap.mjs", `console.log(JSON.stringify({ hello: "world" }));`);
    const fixture = await runProvider({ windowClass: "test.invalidfixture", command: "snap.mjs", pluginDir });
    assert.equal(fixture, null);
  } finally {
    rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("runProvider: a command that outlives timeoutMs is killed and resolves to null", async () => {
  const pluginDir = scratchDir("omasnap-providers-run-timeout-");
  try {
    addScript(pluginDir, "snap.mjs", `await new Promise((r) => setTimeout(r, 5000)); console.log(JSON.stringify(${JSON.stringify(VALID_FIXTURE)}));`);
    const start = Date.now();
    const fixture = await runProvider({ windowClass: "test.timeout", command: "snap.mjs", pluginDir }, { timeoutMs: 150 });
    const elapsed = Date.now() - start;
    assert.equal(fixture, null);
    assert.ok(elapsed < 4000, `expected the timeout (150ms) to cut the run short, took ${elapsed}ms`);
  } finally {
    rmSync(pluginDir, { recursive: true, force: true });
  }
});

// Important 5: the default `killSignal` (`SIGTERM`) can simply be ignored
// by a misbehaving or malicious provider, hanging the hotkey past the
// timeout indefinitely — `runProvider` must use `SIGKILL`, which cannot be
// caught or ignored by the child at all.
test("runProvider: a provider that ignores SIGTERM is still killed (via SIGKILL) at the timeout, not left running", async () => {
  const pluginDir = scratchDir("omasnap-providers-run-sigterm-ignore-");
  try {
    addScript(
      pluginDir,
      "snap.mjs",
      `process.on("SIGTERM", () => {}); // swallow it -- a plain SIGTERM-based kill would never stop this
await new Promise((r) => setTimeout(r, 6000));
console.log(JSON.stringify(${JSON.stringify(VALID_FIXTURE)}));`,
    );
    const start = Date.now();
    const fixture = await runProvider({ windowClass: "test.sigterm-ignore", command: "snap.mjs", pluginDir }, { timeoutMs: 500 });
    const elapsed = Date.now() - start;
    assert.equal(fixture, null);
    assert.ok(elapsed < 4000, `expected SIGKILL to end the SIGTERM-ignoring process well before its own 6s sleep, took ${elapsed}ms`);
  } finally {
    rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("runProvider: a command that does not exist resolves to null", async () => {
  const pluginDir = scratchDir("omasnap-providers-run-missing-");
  try {
    const fixture = await runProvider({ windowClass: "test.missing", command: "does-not-exist.sh", pluginDir });
    assert.equal(fixture, null);
  } finally {
    rmSync(pluginDir, { recursive: true, force: true });
  }
});

// --- manual end-to-end: discovery -> invocation, no mocking -------------------

test("end to end: scanProviders finds a real fixture plugin dir and runProvider runs its real script", async () => {
  const pluginsDir = scratchDir("omasnap-providers-e2e-");
  try {
    const pluginDir = addPlugin(pluginsDir, "com.keithrowell.omawordl", {
      schemaVersion: 1,
      id: "com.keithrowell.omawordl",
      name: "OmaWordl",
      version: "1.0.0",
      omasnap: { provider: "bin/omawordl-snap" },
    });
    mkdirSync(join(pluginDir, "bin"), { recursive: true });
    addScript(
      pluginDir,
      "bin/omawordl-snap",
      `console.log(JSON.stringify(${JSON.stringify({
        filename: "OmaWordl 1",
        subtitle: "OmaWordl 1 3/6",
        showGutter: false,
        compact: true,
        language: null,
        editor: "other",
        font: { family: "monospace", size: 32 },
        lines: [[{ text: "GREEN", color: "#00ff00" }]],
      })}));`,
    );

    const providers = scanProviders(pluginsDir);
    assert.equal(providers.length, 1);
    const provider = findProvider(providers, "com.keithrowell.omawordl");
    assert.ok(provider);

    const fixture = await runProvider(provider);
    assert.equal(fixture.filename, "OmaWordl 1");
    assert.equal(fixture.subtitle, "OmaWordl 1 3/6");
    assert.equal(fixture.showGutter, false);
    assert.equal(fixture.compact, true);
  } finally {
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});
