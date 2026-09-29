import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, readlinkSync, lstatSync, statSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// bin/install against a scratch HOME. The plugin symlink, the desktop file,
// the launcher symlink and the printed binding are checked; nothing under
// the real HOME is touched. PATH is a purpose-built directory of symlinks to
// just the coreutils the script needs, so the result never depends on what
// happens to be installed on the machine running the suite; a fake `pacman`
// is added to it only for the tests that need one.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = join(ROOT, "bin", "install");
const LAUNCH = join(ROOT, "bin", "omacodesnap");

function scratchHome() {
  const home = mkdtempSync(join(tmpdir(), "omacodesnap-install-"));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  return home;
}

// A PATH with only the tools bin/install shells out to. Built once per home
// and reused across every run() call against that home (building it twice
// would try to recreate the same symlinks).
function basePath(home) {
  const dir = join(home, "path");
  mkdirSync(dir, { recursive: true });
  for (const tool of ["bash", "readlink", "dirname", "mkdir", "ln", "rm", "chmod", "mktemp", "mv", "cat", "printf", "grep", "cut"]) {
    const real = join("/usr/bin", tool);
    const link = join(dir, tool);
    if (existsSync(real) && !existsSync(link)) symlinkSync(real, link);
  }
  return dir;
}

function addStub(dir, name) {
  writeFileSync(join(dir, name), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
}

// A fake `pacman` that only understands `-Q <pkgs...>`: it writes the
// requested package list to argv.txt and reports every name in `missing` as
// not found, exactly as the real `pacman -Q` does on stderr.
function addFakePacman(dir, missing = []) {
  writeFileSync(join(dir, "missing.txt"), missing.map(m => m + "\n").join(""));
  const script = `#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
if [[ "\${1:-}" == "-Q" ]]; then
  shift
  printf '%s\\n' "$@" > "$here/argv.txt"
  status=0
  while IFS= read -r pkg; do
    [[ -z "$pkg" ]] && continue
    for arg in "$@"; do
      if [[ "$arg" == "$pkg" ]]; then
        echo "error: package '$pkg' was not found" >&2
        status=1
      fi
    done
  done < "$here/missing.txt"
  exit $status
fi
echo "fake pacman: unsupported args: $*" >&2
exit 1
`;
  writeFileSync(join(dir, "pacman"), script, { mode: 0o755 });
}

function run(home, args, path) {
  const result = spawnSync(INSTALL, args, {
    encoding: "utf8",
    env: { HOME: home, XDG_DATA_HOME: join(home, ".local", "share"), PATH: path },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const pluginPath = home => join(home, ".config", "omarchy", "plugins", "com.keithrowell.omacodesnap");
const desktopPath = home => join(home, ".local", "share", "applications", "OmaCodeSnap.desktop");
const launcherPath = home => join(home, ".local", "bin", "omacodesnap");

test("--dry-run in a fresh home reports what it would do and creates nothing", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    const result = run(home, ["--dry-run"], path);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^plugin: would link /m);
    assert.match(result.out, /^desktop file: would write /m);
    assert.match(result.out, /^launcher: would link /m);
    assert.ok(!existsSync(join(home, ".config")), "nothing written under ~/.config");
    assert.ok(!existsSync(join(home, ".local", "share")), "nothing written under ~/.local/share");
    assert.deepEqual(readdirSync(join(home, ".local", "bin")), []);
    assert.match(result.out, /not applied/);
    assert.match(result.out, /o\.bind\(/);
    assert.match(result.out, /o\.window\(\{ title = "\^\(OmaCodeSnap\)\$" \}, \{ float = true, center = true \}\)/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("first run links the plugin, writes the desktop file and links the launcher; the second reports unchanged", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    const first = run(home, [], path);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /^plugin: linked /m);
    assert.match(first.out, /^desktop file: written /m);
    assert.match(first.out, /^launcher: linked /m);

    const second = run(home, [], path);
    assert.equal(second.code, 0, second.err);
    assert.match(second.out, /^plugin: unchanged /m);
    assert.match(second.out, /^desktop file: unchanged /m);
    assert.match(second.out, /^launcher: unchanged /m);
    assert.doesNotMatch(second.out, /written|linked /);

    const apps = readdirSync(join(home, ".local", "share", "applications")).filter(f => f.endsWith(".desktop"));
    assert.deepEqual(apps, ["OmaCodeSnap.desktop"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the plugin symlink, launcher and desktop file all point at this checkout", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    run(home, [], path);

    assert.ok(lstatSync(pluginPath(home)).isSymbolicLink());
    assert.equal(readlinkSync(pluginPath(home)), ROOT);

    assert.ok(lstatSync(launcherPath(home)).isSymbolicLink());
    assert.equal(readlinkSync(launcherPath(home)), LAUNCH);

    const text = readFileSync(desktopPath(home), "utf8");
    const lines = text.trimEnd().split("\n");
    assert.equal(lines[0], "[Desktop Entry]");
    assert.ok(lines.includes("Type=Application"));
    assert.ok(lines.includes("Name=OmaCodeSnap"));
    assert.ok(lines.includes(`Exec="${LAUNCH}"`), "Exec is the checkout's bin/omacodesnap, quoted");
    assert.ok(lines.includes("Terminal=false"));
    assert.ok(!lines.some(l => l.startsWith("StartupWMClass")));
    assert.ok(!lines.some(l => l.startsWith("Icon=")));
    assert.ok(text.endsWith("\n"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("running when this checkout is already the plugin path (a submodule clone) reports unchanged", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    const pluginParent = join(home, ".config", "omarchy", "plugins");
    mkdirSync(pluginParent, { recursive: true });
    symlinkSync(ROOT, pluginPath(home));

    const result = run(home, [], path);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^plugin: unchanged /m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a foreign plugin directory is left alone; the rest of the install still happens", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    mkdirSync(pluginPath(home), { recursive: true });

    const result = run(home, [], path);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^plugin: not ours, left alone /m);
    assert.match(result.out, /^desktop file: written /m);
    assert.match(result.out, /^launcher: linked /m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("without ~/.local/bin the launcher is skipped and everything else still lands", () => {
  const home = mkdtempSync(join(tmpdir(), "omacodesnap-install-"));
  try {
    const path = basePath(home);
    const result = run(home, [], path);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^launcher: skipped /m);
    assert.match(result.out, /^plugin: linked /m);
    assert.ok(existsSync(desktopPath(home)));
    assert.ok(!existsSync(join(home, ".local", "bin")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Setup must never replace a file it did not create (marketplace review,
// omacom/omarchy-plugin-marketplace#9111). "Ours" means what --uninstall
// already means: a regular desktop file whose Exec points into this checkout,
// and a launcher symlink to this checkout's bin/omacodesnap.
const appDirOf = home => join(home, ".local", "share", "applications");
const ourDesktopLine = `Exec="${LAUNCH}"`;

test("a foreign desktop file is left alone, byte for byte; the rest of the install still happens", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    mkdirSync(appDirOf(home), { recursive: true });
    const foreign = "[Desktop Entry]\nType=Application\nName=Mine\nExec=/opt/mine/run\n";
    writeFileSync(desktopPath(home), foreign);

    const result = run(home, [], path);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^desktop file: not ours, left alone /m);
    assert.equal(readFileSync(desktopPath(home), "utf8"), foreign);
    assert.match(result.out, /^launcher: linked /m);
    assert.deepEqual(readdirSync(appDirOf(home)), ["OmaCodeSnap.desktop"], "no temporary left behind");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a desktop-file symlink is never written through, even when its target looks like ours", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    mkdirSync(appDirOf(home), { recursive: true });
    const decoy = join(home, "decoy.txt");
    const decoyText = `pretend precious file\n${ourDesktopLine}\n`;
    writeFileSync(decoy, decoyText);
    symlinkSync(decoy, desktopPath(home));

    const result = run(home, [], path);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^desktop file: not ours, left alone /m);
    assert.equal(readFileSync(decoy, "utf8"), decoyText);
    assert.ok(lstatSync(desktopPath(home)).isSymbolicLink());
    assert.equal(readlinkSync(desktopPath(home)), decoy);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a stale desktop file of our own is replaced with a fresh regular 0644 file", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    mkdirSync(appDirOf(home), { recursive: true });
    writeFileSync(desktopPath(home), `[Desktop Entry]\nName=Old\n${ourDesktopLine}\n`, { mode: 0o600 });

    const result = run(home, [], path);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^desktop file: written /m);
    const st = lstatSync(desktopPath(home));
    assert.ok(st.isFile());
    assert.equal(st.mode & 0o777, 0o644);
    const text = readFileSync(desktopPath(home), "utf8");
    assert.ok(text.includes("Name=OmaCodeSnap\n"));
    assert.ok(!text.includes("Name=Old"));
    assert.deepEqual(readdirSync(appDirOf(home)), ["OmaCodeSnap.desktop"], "no temporary left behind");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a fresh desktop file is a regular 0644 file", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    run(home, [], path);
    const st = lstatSync(desktopPath(home));
    assert.ok(st.isFile());
    assert.equal(st.mode & 0o777, 0o644);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a foreign ~/.local/bin/omacodesnap file is left alone", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    writeFileSync(launcherPath(home), "#!/bin/sh\necho mine\n", { mode: 0o755 });

    const result = run(home, [], path);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^launcher: not ours, left alone /m);
    assert.ok(lstatSync(launcherPath(home)).isFile());
    assert.equal(readFileSync(launcherPath(home), "utf8"), "#!/bin/sh\necho mine\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a ~/.local/bin/omacodesnap symlink to somewhere else is left alone", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    symlinkSync("/opt/other/bin/omacodesnap", launcherPath(home));

    const result = run(home, [], path);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^launcher: not ours, left alone /m);
    assert.equal(readlinkSync(launcherPath(home)), "/opt/other/bin/omacodesnap");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--dry-run with foreign files in the way reports them and changes nothing", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    mkdirSync(appDirOf(home), { recursive: true });
    writeFileSync(desktopPath(home), "mine\n");
    symlinkSync("/opt/other/bin/omacodesnap", launcherPath(home));

    const result = run(home, ["--dry-run"], path);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^desktop file: not ours, left alone /m);
    assert.match(result.out, /^launcher: not ours, left alone /m);
    assert.equal(readFileSync(desktopPath(home), "utf8"), "mine\n");
    assert.equal(readlinkSync(launcherPath(home)), "/opt/other/bin/omacodesnap");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--uninstall leaves a desktop-file symlink alone, even when its target looks like ours", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    mkdirSync(appDirOf(home), { recursive: true });
    const decoy = join(home, "decoy.desktop");
    writeFileSync(decoy, `${ourDesktopLine}\n`);
    symlinkSync(decoy, desktopPath(home));

    const result = run(home, ["--uninstall"], path);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^desktop file: not ours, left alone /m);
    assert.ok(lstatSync(desktopPath(home)).isSymbolicLink());
    assert.ok(statSync(decoy).isFile());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a foreign desktop file that merely mentions our Exec line is not ours: install and uninstall leave it", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    mkdirSync(appDirOf(home), { recursive: true });
    const foreign = `[Desktop Entry]\nName=Mine\nExec=/opt/mine\n# was: ${ourDesktopLine}\nTryExec=${LAUNCH}\n`;
    writeFileSync(desktopPath(home), foreign);

    const install = run(home, [], path);
    assert.equal(install.code, 0, install.err);
    assert.match(install.out, /^desktop file: not ours, left alone /m);
    const uninstall = run(home, ["--uninstall"], path);
    assert.equal(uninstall.code, 0, uninstall.err);
    assert.match(uninstall.out, /^desktop file: not ours, left alone /m);
    assert.equal(readFileSync(desktopPath(home), "utf8"), foreign);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a directory, a FIFO or a dangling symlink at the desktop path is left alone", () => {
  for (const kind of ["directory", "fifo", "dangling"]) {
    const home = scratchHome();
    try {
      const path = basePath(home);
      mkdirSync(appDirOf(home), { recursive: true });
      const target = join(home, "nowhere", "file");
      if (kind === "directory") mkdirSync(desktopPath(home));
      if (kind === "fifo") execFileSync("/usr/bin/mkfifo", [desktopPath(home)]);
      if (kind === "dangling") symlinkSync(target, desktopPath(home));

      for (const args of [[], ["--uninstall"]]) {
        const result = run(home, args, path);
        assert.equal(result.code, 0, `${kind} ${args}: ${result.err}`);
        assert.match(result.out, /^desktop file: not ours, left alone /m, `${kind} ${args}`);
      }
      const st = lstatSync(desktopPath(home));
      if (kind === "directory") assert.ok(st.isDirectory());
      if (kind === "fifo") assert.ok(st.isFIFO());
      if (kind === "dangling") { assert.ok(st.isSymbolicLink()); assert.ok(!existsSync(target)); }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("a directory at the launcher path is left alone and nothing is linked inside it", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    mkdirSync(launcherPath(home));
    const result = run(home, [], path);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^launcher: not ours, left alone /m);
    assert.deepEqual(readdirSync(launcherPath(home)), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the desktop file goes under a custom XDG_DATA_HOME, and a relative one is ignored", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    const custom = join(home, "data home");
    const env = xdg => spawnSync(INSTALL, [], { encoding: "utf8", cwd: home, env: { HOME: home, XDG_DATA_HOME: xdg, PATH: path } });

    const absolute = env(custom);
    assert.equal(absolute.status, 0, absolute.stderr);
    assert.ok(lstatSync(join(custom, "applications", "OmaCodeSnap.desktop")).isFile());

    const relative = env("rel");
    assert.equal(relative.status, 0, relative.stderr);
    assert.ok(!existsSync(join(home, "rel")), "a relative XDG_DATA_HOME is not used");
    assert.ok(lstatSync(desktopPath(home)).isFile(), "falls back to ~/.local/share");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup writes nothing else into the applications directory", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    writeFileSync(join(path, "update-desktop-database"), `#!/usr/bin/bash\n: > "${join(path, "update-desktop-database.called")}"\n`, { mode: 0o755 });
    run(home, [], path);
    run(home, ["--uninstall"], path);
    assert.deepEqual(readdirSync(appDirOf(home)), []);
    run(home, [], path);
    assert.deepEqual(readdirSync(appDirOf(home)), ["OmaCodeSnap.desktop"]);
    assert.ok(!existsSync(join(path, "update-desktop-database.called")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("packages: skipped when pacman is not on PATH", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    const result = run(home, ["--dry-run"], path);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^packages: skipped \(pacman not on PATH\)$/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("packages: reports missing packages, without failing the install", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    addFakePacman(path, ["tree-sitter-cli", "gcc"]);
    const result = run(home, ["--dry-run"], path);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^packages: missing tree-sitter-cli gcc$/m);
    assert.match(result.out, /^ {2}install them from the Arch repositories/m);
    assert.doesNotMatch(result.out, /sudo|--needed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("packages: reports all present when none are missing", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    addFakePacman(path, []);
    const result = run(home, ["--dry-run"], path);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^packages: all \d+ present$/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the required-packages line in README.md is exactly what bin/install checks", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    addFakePacman(path, []);
    const result = run(home, ["--dry-run"], path);
    assert.equal(result.code, 0, result.err);

    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const match = readme.match(/<!-- required-packages -->\n```\n(.+)\n```/);
    assert.ok(match, "README has a package list under <!-- required-packages -->");
    const expected = match[1].trim().split(/\s+/);

    const argv = readFileSync(join(path, "argv.txt"), "utf8").trim().split("\n");
    assert.deepEqual(argv, expected);
    assert.match(result.out, new RegExp(`^packages: all ${expected.length} present$`, "m"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the Hyprland binding uses uwsm-app when it is on PATH, and says so plainly when it is not", () => {
  const withUwsm = scratchHome();
  const withoutUwsm = scratchHome();
  try {
    const uwsmPath = basePath(withUwsm);
    addStub(uwsmPath, "uwsm-app");
    const first = run(withUwsm, ["--dry-run"], uwsmPath);
    assert.match(first.out, /o\.bind\("SUPER \+ ALT \+ SHIFT \+ S", "OmaCodeSnap", "uwsm-app -- ~\/\.config\/omarchy\/plugins\/com\.keithrowell\.omacodesnap\/bin\/omacodesnap"\)/);

    const bareResult = run(withoutUwsm, ["--dry-run"], basePath(withoutUwsm));
    assert.match(bareResult.out, /o\.bind\("SUPER \+ ALT \+ SHIFT \+ S", "OmaCodeSnap", "~\/\.config\/omarchy\/plugins\/com\.keithrowell\.omacodesnap\/bin\/omacodesnap"\)/);
    assert.match(bareResult.out, /uwsm-app is not on PATH/);
  } finally {
    rmSync(withUwsm, { recursive: true, force: true });
    rmSync(withoutUwsm, { recursive: true, force: true });
  }
});

test("--uninstall removes the plugin symlink, desktop file and launcher, and is idempotent", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    run(home, [], path);
    assert.ok(existsSync(pluginPath(home)));
    assert.ok(existsSync(desktopPath(home)));
    assert.ok(existsSync(launcherPath(home)));

    const first = run(home, ["--uninstall"], path);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /^plugin: removed /m);
    assert.match(first.out, /^desktop file: removed /m);
    assert.match(first.out, /^launcher: removed /m);
    assert.ok(!existsSync(pluginPath(home)));
    assert.ok(!existsSync(desktopPath(home)));
    assert.ok(!existsSync(launcherPath(home)));

    const second = run(home, ["--uninstall"], path);
    assert.equal(second.code, 0, second.err);
    assert.match(second.out, /^plugin: absent$/m);
    assert.match(second.out, /^desktop file: absent$/m);
    assert.match(second.out, /^launcher: absent$/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--uninstall leaves foreign files alone", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    mkdirSync(pluginPath(home), { recursive: true });
    const appDir = join(home, ".local", "share", "applications");
    mkdirSync(appDir, { recursive: true });
    const foreignDesktop = "[Desktop Entry]\nType=Application\nName=OmaCodeSnap\nExec=/opt/other/bin/omacodesnap\n";
    writeFileSync(desktopPath(home), foreignDesktop);
    symlinkSync("/opt/other/bin/omacodesnap", launcherPath(home));

    const result = run(home, ["--uninstall"], path);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^plugin: not ours, left alone /m);
    assert.match(result.out, /^desktop file: not ours, left alone /m);
    assert.match(result.out, /^launcher: not ours, left alone /m);
    assert.equal(readFileSync(desktopPath(home), "utf8"), foreignDesktop);
    assert.equal(readlinkSync(launcherPath(home)), "/opt/other/bin/omacodesnap");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--dry-run --uninstall reports what it would remove and removes nothing", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    run(home, [], path);
    const result = run(home, ["--dry-run", "--uninstall"], path);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^plugin: would remove /m);
    assert.match(result.out, /^desktop file: would remove /m);
    assert.match(result.out, /^launcher: would remove /m);
    assert.ok(existsSync(pluginPath(home)));
    assert.ok(existsSync(desktopPath(home)));
    assert.ok(existsSync(launcherPath(home)));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an unknown option fails with usage", () => {
  const home = scratchHome();
  try {
    const path = basePath(home);
    const result = run(home, ["--bogus"], path);
    assert.equal(result.code, 2);
    assert.match(result.err, /unknown option/);
    assert.match(result.err, /usage: bin\/install/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
