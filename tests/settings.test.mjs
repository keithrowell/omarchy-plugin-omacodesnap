import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readWrapSettings, writeWrapSettings, stateDir, WRAP_WIDTH_DEFAULT } from "../lib/settings.mjs";

function scratch() {
  return mkdtempSync(join(tmpdir(), "omacodesnap-settings-"));
}

test("stateDir: XDG_STATE_HOME when absolute, else ~/.local/state", () => {
  assert.equal(stateDir({ XDG_STATE_HOME: "/x/state", HOME: "/home/u" }), "/x/state/omacodesnap");
  assert.equal(stateDir({ XDG_STATE_HOME: "relative", HOME: "/home/u" }), "/home/u/.local/state/omacodesnap");
  assert.equal(stateDir({ HOME: "/home/u" }), "/home/u/.local/state/omacodesnap");
});

test("readWrapSettings: nothing saved gives the defaults", () => {
  const base = scratch();
  try {
    assert.deepEqual(readWrapSettings({ dir: join(base, "omacodesnap") }), { wrap: true, wrapWidth: WRAP_WIDTH_DEFAULT, saved: false });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeWrapSettings then readWrapSettings round-trips; the dir is 0700 and the file 0600, with no temporary left behind", () => {
  const base = scratch();
  const dir = join(base, "state", "omacodesnap");
  try {
    writeWrapSettings({ wrap: false, wrapWidth: 120 }, { dir });
    assert.deepEqual(readWrapSettings({ dir }), { wrap: false, wrapWidth: 120, saved: true });
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "settings.json")).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ["settings.json"]);
    writeWrapSettings({ wrap: true, wrapWidth: 60 }, { dir });
    assert.deepEqual(readWrapSettings({ dir }), { wrap: true, wrapWidth: 60, saved: true });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeWrapSettings: refuses an invalid setting", () => {
  const base = scratch();
  try {
    for (const bad of [{ wrap: "yes", wrapWidth: 80 }, { wrap: true, wrapWidth: 19 }, { wrap: true, wrapWidth: 241 }, { wrap: true, wrapWidth: 80.5 }]) {
      assert.throws(() => writeWrapSettings(bad, { dir: join(base, "s") }));
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("readWrapSettings: a malformed, wrongly typed or out-of-range file gives the defaults", () => {
  const base = scratch();
  const dir = join(base, "omacodesnap");
  mkdirSync(dir, { mode: 0o700 });
  try {
    for (const body of ["not json", "[]", '{"wrap":"no","wrapWidth":80}', '{"wrap":true,"wrapWidth":5}', '{"wrap":true,"wrapWidth":"80"}', '{"__proto__":{"wrap":false},"wrapWidth":80}']) {
      writeFileSync(join(dir, "settings.json"), body, { mode: 0o600 });
      assert.equal(readWrapSettings({ dir }).saved, false, body);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("readWrapSettings: a symlinked settings file is not followed", () => {
  const base = scratch();
  const dir = join(base, "omacodesnap");
  mkdirSync(dir, { mode: 0o700 });
  try {
    writeFileSync(join(base, "elsewhere.json"), '{"wrap":false,"wrapWidth":40}');
    symlinkSync(join(base, "elsewhere.json"), join(dir, "settings.json"));
    assert.equal(readWrapSettings({ dir }).saved, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("readWrapSettings / writeWrapSettings: a directory that is a symlink, or not private, is refused", () => {
  const base = scratch();
  try {
    const real = join(base, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = join(base, "omacodesnap");
    symlinkSync(real, link);
    assert.throws(() => writeWrapSettings({ wrap: true, wrapWidth: 80 }, { dir: link }));
    assert.ok(!existsSync(join(real, "settings.json")), "nothing written through the symlinked directory");

    const open = join(base, "open");
    mkdirSync(open, { mode: 0o700 });
    chmodSync(open, 0o755);
    assert.throws(() => writeWrapSettings({ wrap: true, wrapWidth: 80 }, { dir: open }));
    writeFileSync(join(open, "settings.json"), '{"wrap":false,"wrapWidth":40}');
    assert.equal(readWrapSettings({ dir: open }).saved, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeWrapSettings: a symlink planted at settings.json is replaced, not written through", () => {
  const base = scratch();
  const dir = join(base, "omacodesnap");
  mkdirSync(dir, { mode: 0o700 });
  try {
    const victim = join(base, "victim.txt");
    writeFileSync(victim, "must survive");
    symlinkSync(victim, join(dir, "settings.json"));
    writeWrapSettings({ wrap: true, wrapWidth: 100 }, { dir });
    assert.equal(readFileSync(victim, "utf8"), "must survive");
    assert.deepEqual(readWrapSettings({ dir }), { wrap: true, wrapWidth: 100, saved: true });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("readWrapSettings: a FIFO at settings.json does not hang", () => {
  const base = scratch();
  const dir = join(base, "omacodesnap");
  mkdirSync(dir, { mode: 0o700 });
  try {
    execFileSync("mkfifo", [join(dir, "settings.json")]);
    assert.equal(readWrapSettings({ dir }).saved, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
