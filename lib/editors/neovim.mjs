// Neovim adapter — the odd one out. Every other adapter only overrides
// `highlight()`, colouring text that arrived the normal way (the Wayland
// primary selection). Neovim overrides `resolveSelection()` instead: it
// asks the *live, running* Neovim for both its current visual selection
// and the exact colours it is already rendering for it
// (`lib/nvim/probe.lua`, via `lib/nvim-rpc.mjs`) — nothing here
// re-implements a highlighter, and no static theme file is read for this
// path (`highlight()` below is never called; the registry only reaches it
// if `resolveSelection()` returns `null`, i.e. no reachable/live Neovim
// selection, which falls the whole request back to every other editor's
// path: the primary selection, then the universal fallback highlighter).
//
// Why the primary selection is bypassed here specifically — a deliberate,
// documented exception to "input is editor-agnostic" (docs/DEVELOPING.md) — is
// recorded in `docs/adr/0007-neovim-rpc-highlighting.md`.
//
// See `lib/editors/registry.mjs` for the adapter interface.

import { discoverNvimAddresses, probeSelectedNvim, TERMINAL_CLASSES } from "../nvim-rpc.mjs";

/**
 * Drop any empty-text span unless it's the line's only one. The renderer
 * requires that invariant (empty text is only ever valid as a line's sole
 * span) and `probe.lua` now avoids emitting a stray one itself, but this is
 * a live, external, versioned tool's output crossing into strict
 * validation — cheap insurance against the next Neovim/treesitter version's
 * own column-arithmetic edge case, the same way a VS Code theme's JSONC
 * comments or a Zed grammar's missing query file degrade here rather than
 * crashing the whole snap.
 */
export function sanitizeSpans(spans) {
  if (spans.length <= 1) return spans;
  const nonEmpty = spans.filter((span) => span.text !== "");
  return nonEmpty.length > 0 ? nonEmpty : [spans[0]];
}

/** `probe.lua`'s `{text,color,bold,italic}` to the renderer's `{text,color,fontStyle,fontWeight}`, falling back to the probe's own editor foreground for a colourless run (whitespace against no active capture). */
function toRenderSpans(spans, fallbackColor) {
  return sanitizeSpans(spans).map((span) => ({
    text: span.text,
    color: span.color ?? fallbackColor ?? null,
    fontStyle: span.italic ? "italic" : null,
    fontWeight: span.bold ? 700 : null,
  }));
}

export const neovim = {
  id: "neovim",

  /**
   * Only even looks inside a known terminal-emulator window (see
   * `TERMINAL_CLASSES` — outside that list, no `/proc` walk and no
   * subprocess ever run). `context.addresses` are every verified RPC socket
   * in the window's process tree (a single-instance terminal can hold
   * several), and `context.address` is the first of them.
   */
  async detect({ windowClass, pid }) {
    if (!pid || !TERMINAL_CLASSES.includes(windowClass)) return null;
    const addresses = discoverNvimAddresses(pid);
    return addresses.length > 0 ? { address: addresses[0], addresses } : null;
  },

  /**
   * `null` — no live visual selection right now, or the RPC call failed —
   * means "not a Neovim override after all," which the registry treats
   * exactly like Zed/VS Code's `null`: fall back to the Wayland primary
   * selection and the universal highlighter. Anything reachable but with
   * no active selection is genuinely a "nothing selected in Neovim" case,
   * not a Neovim bug — the primary-selection fallback still gives a
   * reasonable result if the user separately yanked something.
   */
  async resolveSelection({ context }) {
    const probe = probeSelectedNvim(context.addresses ?? [context.address]);
    if (!probe) return null;

    const lines = probe.lines.map((spans) => toRenderSpans(spans, probe.editorForeground));
    const text = lines.map((spans) => spans.map((s) => s.text).join("")).join("\n");
    return {
      text,
      lines,
      filename: probe.filename || undefined,
    };
  },

  async highlight() {
    return null; // unreachable in practice: resolveSelection always supplies `lines` when it returns non-null
  },

  font() {
    return null; // a terminal renders Neovim, not Neovim itself — system monospace fallback (see the module header on scope)
  },

  filenameFromTitle() {
    return null; // the filename comes from the RPC probe (expand("%:p")), not the terminal's window title
  },
};
