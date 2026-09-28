# Project Brief — OmaCodeSnap

The living context the loop steers by. `/ag-shape`, `/ag-spec`, `/ag-prioritise`,
and the `ag-planner` read this; Business Value in triage is scored against the
**prioritised outcomes** below. Keep it short (it loads into context) and update
it as the project learns — `/ag-retro` treats it as an update target.

OmaCodeSnap turns selected code into a beautiful, unmistakably Omarchy image for a
social post, a doc, or a chat. Think codesnap.dev, minus the macOS traffic
lights, wearing the live Omarchy theme — and coloured exactly the way the
editor it was snapped from shows the code.

## Who it's for

Omarchy users who post code: anyone on Omarchy who wants a pretty, on-brand
code image. Keith is the first user; it is built to publish as a community
Omarchy plugin.

## The outcome that matters first

Select code in Zed, press one Hyprland binding, and get a gorgeous PNG on the
clipboard and on disk that looks like Zed under the current Omarchy theme.

## Prioritised outcomes

1. **End to end from Zed.** Selection → binding → preview → PNG on the clipboard
   and in `~/Pictures`, with the code coloured as Zed displays it under the
   current Omarchy theme.
2. **A frame that is obviously Omarchy.** The window chrome and the backdrop
   come from the theme (and the wallpaper); a few backdrop variants to choose
   from in the preview. No macOS traffic lights, ever.
3. **Editor-exact colours everywhere.** Pixel-faithful highlighting under every
   Omarchy theme, with VS Code supported alongside Zed. Any other focused app
   gets a generic highlight in the Omarchy palette.

## Constraints

- **Input is editor-agnostic.** A Hyprland keybinding runs OmaCodeSnap; it reads the
  Wayland *primary selection* (`wl-paste --primary`), falling back to the
  clipboard when nothing is selected. `hyprctl activewindow` identifies the
  focused editor (class + title); the filename in the title drives language
  detection. No editor extensions.
- **Stack.** quickshell/QML app (`qs -p app/Main.qml`) with pure JavaScript in
  `lib/` (ES modules) and `node --test` suites, as in the Pacman plugin.
  Highlighting is per editor: tree-sitter with Zed's queries and the Zed
  Omarchy theme's `syntax` map for Zed; TextMate/shiki with the VS Code
  Omarchy theme's `tokenColors` for VS Code. Both produce one token-span
  interface the renderer consumes.
- **Every colour comes from the theme.** `~/.local/state/omarchy/current/theme/`
  (`colors.toml`, `zed-theme.json`, `vscode.json`) and nothing else. Never
  hard-code a colour.
- **Follows live theme switches.** Each snap reads the current theme; no
  restart.
- **Arch/Omarchy packages only.** Runtime dependencies must be in pacman or
  already shipped by Omarchy (quickshell, wl-clipboard, node). No global npm
  installs at runtime; vendored JS is fine.
- **Fast.** Binding to preview window in about a second.
- **Distributed as an Omarchy plugin** (`manifest.json`, `bin/omacodesnap`,
  `bin/install`), registered as a submodule in the dotfiles.

## Non-goals

- No editor plugins or extensions — OmaCodeSnap never asks Zed or VS Code to do anything.
- No non-Omarchy styling: no theme picker, no macOS/Windows chrome, no arbitrary colour schemes.
- No direct posting to social networks; it produces an image, sharing is yours.
- No editing or annotation UI: no arrows, highlights, or captions on the image.

## What "shipped v1" looks like

Zed only, with a preview window. Select code in Zed, press the binding, an
Omarchy-styled preview appears showing the framed code exactly as Zed colours
it, pick a backdrop variant, then copy to the clipboard or save to
`~/Pictures`. Installed as an Omarchy plugin via `bin/install`.
