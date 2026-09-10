import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProviders, findProvider, runProvider } from "../lib/providers.mjs";

function scratchDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A `<pluginsDir>/<id>/manifest.json` fixture plugin directory. `manifestText`, when given, is written verbatim instead of JSON-encoding `manifest` (for the malformed-JSON case). */
function addPlugin(pluginsDir, id, manifest, { manifestText } = {}) {
  const dir = join(pluginsDir, id);
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

test("scanProviders: collects exactly the manifests with a valid omasnap.provider, skipping every malformed/absent sibling", () => {
  const pluginsDir = scratchDir("omasnap-providers-scan-");
  try {
    // Full: explicit provider + windowClass.
    addPlugin(pluginsDir, "com.keithrowell.omawordl", {
      schemaVersion: 1,
      id: "com.keithrowell.omawordl",
      name: "OmaWordl",
      version: "1.0.0",
      omasnap: { provider: "bin/omawordl-snap", windowClass: "com.keithrowell.omawordl.window" },
    });

    // Provider only: windowClass should default to the manifest's own id.
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
      omasnap: { windowClass: "no.provider.field" },
    });

    const providers = scanProviders(pluginsDir);
    assert.equal(providers.length, 2);

    const omawordl = providers.find((p) => p.windowClass === "com.keithrowell.omawordl.window");
    assert.ok(omawordl, "explicit windowClass entry present");
    assert.equal(omawordl.command, "bin/omawordl-snap");
    assert.equal(omawordl.pluginDir, join(pluginsDir, "com.keithrowell.omawordl"));

    const otherapp = providers.find((p) => p.windowClass === "org.example.otherapp");
    assert.ok(otherapp, "provider-only entry defaults windowClass to the manifest's own id");
    assert.equal(otherapp.command, "snap.sh");
    assert.equal(otherapp.pluginDir, join(pluginsDir, "org.example.otherapp"));

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

test("scanProviders: a non-directory entry inside pluginsDir (a stray file) is ignored", () => {
  const pluginsDir = scratchDir("omasnap-providers-strayfile-");
  try {
    writeFileSync(join(pluginsDir, "README.txt"), "not a plugin");
    assert.deepEqual(scanProviders(pluginsDir), []);
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

// --- runProvider -----------------------------------------------------------------

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
    const provider = findProvider(providers, "com.keithrowell.omawordl"); // defaulted from id
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
