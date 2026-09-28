// The editor plugin registry: one small, consistent interface every
// supported editor implements, so adding one is "write a new file in this
// directory and add it to `EDITORS`," not "find every place `snap.mjs`
// special-cased the existing two and add a third branch."
//
// Each adapter is a plain object shaped like:
//
//   {
//     id: string,
//
//     // Does this editor own the focused window? `windowClass`/`pid` come
//     // straight from `hyprctl activewindow -j`. Return an opaque
//     // `context` object (passed to every hook below) if so, else `null`.
//     // Checked in `EDITORS` order — first match wins, so cheap/specific
//     // checks (a window-class lookup) go before expensive/general ones
//     // (Neovim's `/proc` walk + RPC probe), and the catch-all `other`
//     // adapter is always last.
//     async detect({ windowClass, pid }) -> context | null,
//
//     // An editor-specific *replacement* for the selection text OmaCodeSnap
//     // would otherwise read from the Wayland primary selection — most
//     // adapters don't have one and return `null` (see `lib/editors/zed.mjs`,
//     // `vscode.mjs`, `other.mjs`); `neovim.mjs` is the exception,
//     // querying the live buffer's own visual selection over RPC instead.
//     // A non-null override may also supply already-highlighted `lines`
//     // (again, only Neovim does — colours come from the same live query
//     // as the text, guaranteeing perfect alignment), in which case
//     // `highlight()` below is never called for this snap at all.
//     async resolveSelection({ context, primaryText }) ->
//       { text, filename?, lines? } | null,
//
//     // Colour `text` (already resolved: the override's, or the primary
//     // selection's). Returning `null` means "this editor has nothing to
//     // colour it with" (an unresolvable VS Code language, mainly) — the
//     // *registry*, not the adapter, then runs the universal fallback
//     // highlighter (today: the Zed tree-sitter highlighter, which is also
//     // what every stock Omarchy theme's "generic Omarchy-palette" fallback
//     // ultimately is — see `lib/theme.mjs`'s `synthesizeZedTheme`).
//     async highlight({ text, language, theme, root, context }) ->
//       { lines, warnings } | null,
//
//     // The editor's own configured buffer/editor font, or `null` to fall
//     // back to the system monospace font (see `lib/fonts.mjs`).
//     font({ context }) -> { family, size } | null,
//
//     // This editor's window-title convention -> the filename it names,
//     // or `null` if none can be extracted (or, for Neovim, because the
//     // filename comes from the RPC probe instead — see `lib/editors/neovim.mjs`).
//     filenameFromTitle(title) -> string | null,
//   }

import { zed } from "./zed.mjs";
import { vscode } from "./vscode.mjs";
import { neovim } from "./neovim.mjs";
import { other } from "./other.mjs";

/** Checked in order; `other` always matches, so this list is never exhausted without a result. */
export const EDITORS = [zed, vscode, neovim, other];

/**
 * Find the first adapter whose `detect()` matches `windowClass`/`pid`,
 * returning `{ editor, context }`. Always resolves (`other` is the
 * unconditional last resort) — never `null`, never throws.
 */
export async function detectEditorContext({ windowClass, pid }) {
  for (const editor of EDITORS) {
    const context = await editor.detect({ windowClass, pid });
    if (context) return { editor, context };
  }
  // Unreachable: `other.detect()` always returns `{}`. Kept as a safety
  // net rather than a `throw` — a bug in a future adapter's `detect()`
  // (returning `undefined` instead of `null`, say) should still degrade,
  // not crash a snap.
  return { editor: other, context: {} };
}
