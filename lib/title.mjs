// Window class/title parsing: maps a Hyprland `class`/`initialClass` to a
// coarse editor id, and (per editor) a window title to the filename it
// names. Split out of `lib/snap.mjs` so `lib/editors/*.mjs` adapters can
// reuse `EDITOR_CLASSES` without importing `snap.mjs` itself (which imports
// the adapter registry — a cycle).
//
// Pure ES module: no I/O, no imports.
//
// Recorded title samples (spike 0002's findings.md, Q3, plus a live
// `hyprctl activewindow -j` read taken during this build against a real
// project-open Zed window): a standalone Zed file (no project open) is
// `<file> — <file>` (em dash, U+2014, both halves the same). A real
// project-open window's title is `<project> — <file>` — **project first,
// file last** (the spike's own guess of `<file> — <project>` was wrong;
// corrected here from `omarchy_pacman — Board.js` and, dirty, `●
// omarchy_pacman — src/Board.js` — Zed keeps the file's path relative to
// the project root after the dash). VS Code's convention is `<file> -
// <folder> - Visual Studio Code` (hyphen, **file first**) — unaffected by
// the Zed correction above.

/** Window classes each editor is known to launch under (spike 0002, Q3, for Zed; VS Code's forks/variants by convention). */
export const EDITOR_CLASSES = {
  zed: ["dev.zed.Zed", "dev.zed.Zed-Dev", "dev.zed.Zed-Preview"],
  vscode: ["code", "Code", "code-url-handler", "code-oss", "Code - OSS", "codium", "VSCodium", "cursor", "Cursor"],
};

/**
 * Window classes known to appear as a transient "active window" right after
 * an exec-style dispatch fires, per the spike's Q2 (a keyring prompt, a
 * quickshell overlay) plus OmaCodeSnap's and Omarchy's own shell/lock surfaces.
 * Never an editor; used only to skip title parsing defensively (see
 * `prepareSnap`) — `detectEditor` already resolves any of these to
 * `"other"` on its own, since none of them is in `EDITOR_CLASSES`.
 */
export const TRANSIENT_CLASSES = ["gcr-prompter", "quickshell", "omarchy-shell", "hyprlock"];

/** A leading "unsaved buffer" marker some editors prefix a dirty file's title with. */
const DIRTY_MARKER_RE = /^[●•*◌]\s+/;

/** `"zed" | "vscode" | "other"`, from a Hyprland `class`/`initialClass` string. Neovim is not detected here — see `lib/editors/neovim.mjs`, which needs the window's PID, not just its class. */
export function detectEditor(windowClass) {
  if (EDITOR_CLASSES.zed.includes(windowClass)) return "zed";
  if (EDITOR_CLASSES.vscode.includes(windowClass)) return "vscode";
  return "other";
}

/**
 * Extract a filename from a window title, per editor:
 * - Zed: `<project> — <file>` (em dash) -> the segment **after the last**
 *   em dash (a standalone file with no project open repeats the filename
 *   on both sides, so this still gives the right answer: `sample.js —
 *   sample.js` -> `sample.js`). The result may be a project-relative path
 *   (e.g. `src/Board.js`) rather than a bare filename — `detectLanguage`
 *   basenames it before matching a suffix, so that's fine as-is. If there
 *   is no em dash at all but the (marker-stripped) title looks like a bare
 *   filename (contains a dot, no spaces), the whole title.
 * - VS Code: `<file> - <folder> - Visual Studio Code` (hyphen, file
 *   *first*, unlike Zed) -> the first `" - "`-delimited segment.
 * - anything else: `null` (never guessed).
 *
 * A leading dirty-buffer marker (`● `, `• `, `* `, `◌ `) is stripped first.
 * Returns `null` when there is nothing to extract, or the extracted
 * candidate is empty or made up only of path separators.
 */
export function filenameFromTitle(title, editor) {
  if (typeof title !== "string" || title === "") return null;
  const stripped = title.replace(DIRTY_MARKER_RE, "").trim();
  if (stripped === "") return null;

  let candidate = null;
  if (editor === "zed") {
    const dashIndex = stripped.lastIndexOf("—");
    if (dashIndex !== -1) {
      candidate = stripped.slice(dashIndex + 1).trim();
    } else if (stripped.includes(".") && !/\s/.test(stripped)) {
      candidate = stripped;
    }
  } else if (editor === "vscode") {
    // VS Code's own delimiter is literally " - " (space, hyphen, space) —
    // matching a bare `-` (the old `\s*-\s*`) truncated any hyphenated
    // filename at its first hyphen (e.g. "my-component.tsx - project -
    // Visual Studio Code" -> "my", not "my-component.tsx").
    const match = /^(.+?) - /.exec(stripped);
    if (match) candidate = match[1].trim();
  }

  if (!candidate) return null;
  if (/^\/+$/.test(candidate)) return null;
  return candidate;
}
