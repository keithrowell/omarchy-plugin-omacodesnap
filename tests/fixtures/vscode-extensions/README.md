# VS Code extension fixtures

Fake and real-but-trimmed extension trees used by `tests/vscode-extensions.test.mjs`
and `tests/highlight-vscode.test.mjs`, so those tests never depend on what's
actually installed on the machine running them (see `lib/vscode-extensions.mjs`
for why OmaCodeSnap reads grammars from the real install at runtime instead of
vendoring them).

- `app-root/json/`, `app-root/javascript/` — real `package.json` grammar
  declarations plus real grammar files copied verbatim from VS Code
  (`microsoft/vscode` tag `1.136.1`, `extensions/json` and
  `extensions/javascript`, MIT), standing in for VS Code's own built-in
  extensions directory (e.g. `/usr/share/code/resources/app/extensions/`).
  JavaScript's is here specifically to exercise a grammar with a dependency
  (`source.js` includes `source.js.regexp`) resolved through the same index.
- `user-extensions/` — fake marketplace extensions: one with no grammar at
  all (mirrors the real `rust-lang.rust-analyzer`, which ships none — see
  `lib/vscode-extensions.mjs`'s header), one with a minimal (non-functional)
  Lua grammar, to test that a later/user root can add a language the app
  root doesn't have.
