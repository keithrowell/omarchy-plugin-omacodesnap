// The one piece of state OmaCodeSnap keeps between snaps: the wrap setting
// last chosen in the preview (on/off and width), so the next snap starts
// from it. Stored as `settings.json` in `$XDG_STATE_HOME/omacodesnap/`
// (`~/.local/state/omacodesnap/` by default).
//
// Another same-user process can plant a symlink, a FIFO or an oversized
// file at a predictable path, so:
// - the directory must be a real directory owned by this user, mode 0700;
//   a symlink or a foreign/wider directory is refused, never repaired;
// - the file is opened once with O_NOFOLLOW|O_NONBLOCK, checked on that
//   descriptor (regular file, ours, not too big) and read from it;
// - a write goes to a fresh 0600 temporary created exclusively in the same
//   directory, is fsynced, then renamed over the file (which replaces a
//   planted symlink rather than writing through it);
// - anything unexpected in the file (bad JSON, wrong types, out-of-range
//   width) means "no saved setting": the defaults apply.
//
// Pure ES module; no Qt.

import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const WRAP_DEFAULT = true;
export const WRAP_WIDTH_DEFAULT = 80;
export const WRAP_WIDTH_MIN = 20;
export const WRAP_WIDTH_MAX = 240;

const FILE_NAME = "settings.json";
const MAX_BYTES = 4096;

/** `$XDG_STATE_HOME/omacodesnap`, or `~/.local/state/omacodesnap`. */
export function stateDir(env = process.env) {
  const base = env.XDG_STATE_HOME && env.XDG_STATE_HOME.startsWith("/") ? env.XDG_STATE_HOME : join(env.HOME || homedir(), ".local", "state");
  return join(base, "omacodesnap");
}

/** True for an integer width the preview's stepper can produce. */
export function isValidWrapWidth(width) {
  return Number.isInteger(width) && width >= WRAP_WIDTH_MIN && width <= WRAP_WIDTH_MAX;
}

// The directory, checked without following a symlink at its own name:
// a real directory, owned by us, with no group/other permissions.
function checkDir(dir) {
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (st.uid !== process.getuid()) throw new Error(`${dir} is not owned by this user`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${dir} is not private (mode ${(st.mode & 0o777).toString(8)})`);
}

/**
 * The saved wrap setting, or the defaults when there is none or it cannot
 * be trusted. Never throws: a snap must never fail over a preference.
 * Returns `{ wrap, wrapWidth, saved }`, `saved` saying whether it came
 * from the file.
 */
export function readWrapSettings({ dir = stateDir() } = {}) {
  const defaults = { wrap: WRAP_DEFAULT, wrapWidth: WRAP_WIDTH_DEFAULT, saved: false };
  let fd;
  try {
    checkDir(dir);
    fd = openSync(join(dir, FILE_NAME), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || st.nlink !== 1 || st.size > MAX_BYTES) return defaults;
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length <= MAX_BYTES) {
      const n = readSync(fd, buffer, length, MAX_BYTES + 1 - length, null);
      if (n === 0) break;
      length += n;
    }
    if (length > MAX_BYTES) return defaults;
    const data = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return defaults;
    if (typeof data.wrap !== "boolean" || !isValidWrapWidth(data.wrapWidth)) return defaults;
    return { wrap: data.wrap, wrapWidth: data.wrapWidth, saved: true };
  } catch {
    return defaults;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Save the wrap setting. Throws on an invalid value or an untrustworthy
 * directory; the caller decides whether that matters (the preview's
 * re-highlight only warns).
 */
export function writeWrapSettings({ wrap, wrapWidth }, { dir = stateDir() } = {}) {
  if (typeof wrap !== "boolean" || !isValidWrapWidth(wrapWidth)) {
    throw new Error("invalid wrap setting");
  }
  // Creates any missing parents; the directory itself is then checked
  // whether it was just made or already there.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  checkDir(dir);

  const payload = Buffer.from(JSON.stringify({ wrap, wrapWidth }) + "\n", "utf8");
  const tmp = join(dir, `.${FILE_NAME}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < payload.length) offset += writeSync(fd, payload, offset, payload.length - offset);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, join(dir, FILE_NAME));
  } catch (err) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
  const dirFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}
