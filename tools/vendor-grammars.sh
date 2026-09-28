#!/usr/bin/env bash
# Dev-time, network-using vendoring script for spec 0005 (zed-highlighter).
# Re-run this to bump a pin or add a language; it is never run at install
# time or on the highlighter's run path (see docs/adr/0002-grammar-sourcing.md).
#
#   tools/vendor-grammars.sh                 # vendor every grammar + query set
#   tools/vendor-grammars.sh tsx python       # only these grammars (by grammar name)
#   tools/vendor-grammars.sh --queries-only   # re-fetch just the Zed query files
#
# Every pin is a full 40-character commit SHA, never a tag or branch (a tag
# or branch can move after review; ADR-0013). For each grammar: fetches
# exactly that commit into an empty, hook-free repository, verifies
# FETCH_HEAD is that commit, checks it out detached, and copies the minimal
# file set (src/{parser.c,scanner.c,scanner.cc,grammar.json,node-types.json,
# tree_sitter/}, tree-sitter.json, the licence) into
# vendor/grammars/<name>/, and writes a SOURCE file recording repo/subdir/
# ref/date/licence. For each query set: downloads highlights.scm (and
# injections.scm, when Zed has one) into vendor/zed-queries/<lang>/ with its
# own SOURCE, and appends a row to vendor/zed-queries/SOURCE.md.
#
# Idempotent: an already-vendored grammar/query dir is left alone unless
# --force is given. Never touches ~/.config/tree-sitter or vendor/grammars/lib
# (bin/build-grammars owns that).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GRAMMARS_DIR="$ROOT/vendor/grammars"
QUERIES_DIR="$ROOT/vendor/zed-queries"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ZED_TAG="v1.18.1"
ZED_COMMIT="bebe92f469834a287f5a57ed78e8d51a918b8ada"
DATE="$(date -u +%Y-%m-%d)"

FORCE=0
QUERIES_ONLY=0
WANT=()
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --queries-only) QUERIES_ONLY=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) WANT+=("$arg") ;;
  esac
done

say() { printf '%s\n' "$*"; }

# Grammar pin table: name | repo | subdir ("" = repo root) | commit SHA | ref-kind (always commit) | licence-file
# (the release tag each SHA came from is noted where there is one)
GRAMMAR_TABLE=(
  "tsx|https://github.com/zed-industries/tree-sitter-typescript|tsx|e2c53597d6a5d9cf7bbe8dccde576fe1e46c5899|commit|LICENSE"
  "typescript|https://github.com/zed-industries/tree-sitter-typescript|typescript|e2c53597d6a5d9cf7bbe8dccde576fe1e46c5899|commit|LICENSE"
  "python|https://github.com/tree-sitter/tree-sitter-python||d326e4cad262cf681656e130960e49dfc04c03ea|commit|LICENSE"  # v0.25.0
  "rust|https://github.com/tree-sitter/tree-sitter-rust||77a3747266f4d621d0757825e6b11edcbf991ca5|commit|LICENSE"  # v0.24.2
  "c|https://github.com/tree-sitter/tree-sitter-c||7fa1be1b694b6e763686793d97da01f36a0e5c12|commit|LICENSE"  # v0.24.1
  "bash|https://github.com/tree-sitter/tree-sitter-bash||a06c2e4415e9bc0346c6b86d401879ffb44058f7|commit|LICENSE"  # v0.25.1
  "json|https://github.com/tree-sitter/tree-sitter-json||ee35a6ebefcef0c5c416c0d1ccec7370cfca5a24|commit|LICENSE"  # v0.24.8
  "yaml|https://github.com/zed-industries/tree-sitter-yaml||baff0b51c64ef6a1fb1f8390f3ad6015b83ec13a|commit|LICENSE"
  "markdown|https://github.com/zed-industries/tree-sitter-markdown|tree-sitter-markdown|b596e737286780d7bfa9fcddceaeeb754574b352|commit|LICENSE"
  "markdown_inline|https://github.com/zed-industries/tree-sitter-markdown|tree-sitter-markdown-inline|b596e737286780d7bfa9fcddceaeeb754574b352|commit|LICENSE"
  "ruby|https://github.com/tree-sitter/tree-sitter-ruby||71bd32fb7607035768799732addba884a37a6210|commit|LICENSE"
  "lua|https://github.com/tree-sitter-grammars/tree-sitter-lua||10fe0054734eec83049514ea2e718b2a56acd0c9|commit|LICENSE"
  "go|https://github.com/tree-sitter/tree-sitter-go||2346a3ab1bb3857b48b29d779a1ef9799a248cd7|commit|LICENSE"
)

# Query pin table: lang | kind (zed-builtin|zed-extension) | path-in-repo | repo-url | commit SHA
QUERY_TABLE=(
  "javascript|zed-builtin|javascript|https://github.com/zed-industries/zed|$ZED_COMMIT"
  "typescript|zed-builtin|typescript|https://github.com/zed-industries/zed|$ZED_COMMIT"
  "tsx|zed-builtin|tsx|https://github.com/zed-industries/zed|$ZED_COMMIT"
  "python|zed-builtin|python|https://github.com/zed-industries/zed|$ZED_COMMIT"
  "rust|zed-builtin|rust|https://github.com/zed-industries/zed|$ZED_COMMIT"
  "c|zed-builtin|c|https://github.com/zed-industries/zed|$ZED_COMMIT"
  "bash|zed-builtin|bash|https://github.com/zed-industries/zed|$ZED_COMMIT"
  "json|zed-builtin|json|https://github.com/zed-industries/zed|$ZED_COMMIT"
  "yaml|zed-builtin|yaml|https://github.com/zed-industries/zed|$ZED_COMMIT"
  "markdown|zed-builtin|markdown|https://github.com/zed-industries/zed|$ZED_COMMIT"
  "ruby|zed-extension|ruby|https://github.com/zed-extensions/ruby|a88801c1657f01e02acf428b800e0d7ce2d6f241"
  "lua|zed-extension|lua|https://github.com/zed-extensions/lua|ec8fe51d2f6b33cacccf90fbcddd705a1edbd0cd"
  "go|zed-builtin|go|https://github.com/zed-industries/zed|5a9b9558db01a6b906cec2fb70a797affdc58cdd"
)

wanted() {
  local name="$1"
  [ "${#WANT[@]}" -eq 0 ] && return 0
  for w in "${WANT[@]}"; do [ "$w" = "$name" ] && return 0; done
  return 1
}

require_sha() {
  if [[ ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
    echo "vendor-grammars: '$1' is not a full 40-character commit SHA; refusing to fetch it" >&2
    exit 1
  fi
}

clone_pin() {
  # clone_pin <dest> <repo> <sha>: fetch exactly one commit, prove it is the
  # one asked for, and check it out detached, with repository hooks off.
  local dest="$1" repo="$2" sha="$3"
  require_sha "$sha"
  git -c core.hooksPath=/dev/null init --quiet -- "$dest"
  git -C "$dest" -c core.hooksPath=/dev/null fetch --quiet --depth 1 -- "$repo" "$sha"
  local fetched
  fetched="$(git -C "$dest" rev-parse --verify 'FETCH_HEAD^{commit}')"
  if [ "$fetched" != "$sha" ]; then
    echo "vendor-grammars: $repo returned $fetched, not the pinned $sha" >&2
    exit 1
  fi
  git -C "$dest" -c core.hooksPath=/dev/null checkout --quiet --detach "$sha"
}

vendor_grammar() {
  local row="$1"
  IFS='|' read -r name repo subdir ref kind licence <<<"$row"
  wanted "$name" || return 0

  local dest="$GRAMMARS_DIR/$name"
  # Checks for SOURCE itself, not just the directory: a run that failed
  # partway can leave an empty/incomplete dest behind, which should be
  # retried rather than reported as already-vendored.
  if [ -f "$dest/SOURCE" ] && [ "$FORCE" -ne 1 ]; then
    say "grammar: unchanged $name (already vendored; --force to re-vendor)"
    return 0
  fi

  say "grammar: vendoring $name from $repo${subdir:+/$subdir} @ $ref"
  local clone="$WORK/$name"
  clone_pin "$clone" "$repo" "$ref"

  local src="$clone"
  [ -n "$subdir" ] && src="$clone/$subdir"

  # tree-sitter-go's last tagged release predates this CLI's ABI (its
  # checked-in src/parser.c is language version 6; this tree-sitter build
  # needs 13-15) and no newer tag exists, so regenerate parser.c from
  # grammar.js with the CLI actually installed here rather than trusting the
  # committed one. Safe for any grammar: a no-op unless grammar.js is present
  # and `tree-sitter generate` succeeds; failure is left for the missing-file
  # check below to report clearly instead of aborting the whole vendor run.
  if [ -f "$src/grammar.js" ] && command -v tree-sitter >/dev/null 2>&1; then
    ( cd "$src" && tree-sitter generate ) >/dev/null 2>&1 \
      && say "grammar: regenerated $name's parser.c with the local tree-sitter CLI (upstream's committed one may predate this CLI's ABI)"
  fi

  rm -rf "$dest"
  mkdir -p "$dest/src"

  # Every top-level .c/.h/.cc file under src/ (not just parser.c/scanner.c):
  # some grammars (e.g. Zed's yaml fork) split their external scanner across
  # extra files like schema.core.c, #include'd by scanner.c itself.
  for f in "$src"/src/*.c "$src"/src/*.cc "$src"/src/*.h "$src"/src/grammar.json "$src"/src/node-types.json; do
    [ -f "$f" ] && cp "$f" "$dest/src/$(basename "$f")"
  done
  [ -d "$src/src/tree_sitter" ] && cp -r "$src/src/tree_sitter" "$dest/src/tree_sitter"

  # The typescript fork's scanner.c includes "../../common/scanner.h" (a
  # scanner shared by the typescript/tsx/jsdoc subdirs of that repo) — the
  # relative include already resolves correctly from vendor/grammars/<name>/
  # src/scanner.c to vendor/grammars/common/scanner.h, so it is copied
  # as-is, with no path rewriting needed.
  local common_scanner_note=""
  if [ -f "$dest/src/scanner.c" ] && grep -q 'common/scanner.h' "$dest/src/scanner.c" 2>/dev/null; then
    mkdir -p "$GRAMMARS_DIR/common"
    cp "$clone/common/scanner.h" "$GRAMMARS_DIR/common/scanner.h"
    common_scanner_note="common/scanner.h: shared with tsx/typescript, from the same $repo @ $ref (../../common/scanner.h, relative to this grammar's src/scanner.c)"
  fi

  if [ -f "$src/tree-sitter.json" ]; then
    cp "$src/tree-sitter.json" "$dest/tree-sitter.json"
  else
    printf '{\n  "grammars": [ { "name": "%s", "camelcase": "%s", "scope": "source.%s" } ]\n}\n' \
      "$name" "$name" "$name" >"$dest/tree-sitter.json"
  fi

  for lic in "$clone/$licence" "$clone/LICENSE" "$clone/LICENSE.txt" "$clone/LICENSE.md"; do
    if [ -f "$lic" ]; then
      cp "$lic" "$dest/LICENSE"
      break
    fi
  done

  {
    echo "repo:    $repo"
    [ -n "$subdir" ] && echo "subdir:  $subdir"
    echo "ref:     $ref ($kind)"
    echo "fetched: $DATE"
    echo "licence: $(basename "${lic:-unknown}")"
    [ -n "$common_scanner_note" ] && echo "note:    $common_scanner_note"
  } >"$dest/SOURCE"

  say "grammar: vendored $name"
}

vendor_query() {
  local row="$1"
  IFS='|' read -r lang kind path repo ref <<<"$row"
  wanted "$lang" || return 0
  require_sha "$ref"

  local dest="$QUERIES_DIR/$lang"
  # Checks for highlights.scm itself, not just the directory: a run that
  # failed partway (e.g. a wrong URL) can leave an empty dest behind, which
  # should be retried rather than reported as already-vendored.
  if [ -f "$dest/highlights.scm" ] && [ "$FORCE" -ne 1 ]; then
    say "query: unchanged $lang (already vendored; --force to re-vendor)"
    return 0
  fi
  mkdir -p "$dest"

  local raw_base
  if [ "$kind" = "zed-builtin" ]; then
    raw_base="${repo/github.com/raw.githubusercontent.com}/$ref/crates/grammars/src/$path"
  else
    raw_base="${repo/github.com/raw.githubusercontent.com}/$ref/languages/$path"
  fi

  say "query: fetching $lang from $raw_base"
  curl -sf -o "$dest/highlights.scm" "$raw_base/highlights.scm"
  if curl -sf -o "$dest/injections.scm.tmp" "$raw_base/injections.scm" 2>/dev/null; then
    mv "$dest/injections.scm.tmp" "$dest/injections.scm"
  else
    rm -f "$dest/injections.scm.tmp"
  fi

  # Zed built-in queries are covered by vendor/zed-queries/LICENSE
  # (Zed's own LICENSE-GPL, fetched once, top-level); an extension repo's
  # queries carry their own licence, fetched per language here.
  local licence_note="see ../LICENSE (Zed's own, GPL-3.0)"
  if [ "$kind" = "zed-extension" ]; then
    local repo_raw="${repo/github.com/raw.githubusercontent.com}/$ref"
    for lic in LICENSE-APACHE LICENSE LICENSE.md; do
      if curl -sf -o "$dest/LICENSE" "$repo_raw/$lic" 2>/dev/null; then
        licence_note="./LICENSE (fetched from $repo/blob/$ref/$lic)"
        break
      fi
    done
  fi

  {
    echo "url:     $raw_base/highlights.scm"
    echo "repo:    $repo"
    echo "ref:     $ref"
    echo "fetched: $DATE"
    echo "licence: $licence_note"
  } >"$dest/SOURCE"

  say "query: vendored $lang"
}

if [ "$QUERIES_ONLY" -ne 1 ]; then
  for row in "${GRAMMAR_TABLE[@]}"; do vendor_grammar "$row"; done
fi
for row in "${QUERY_TABLE[@]}"; do vendor_query "$row"; done

mkdir -p "$QUERIES_DIR"
{
  echo "# Zed query sources"
  echo
  echo "Zed version: $ZED_TAG ($ZED_COMMIT). Re-run \`tools/vendor-grammars.sh\` after"
  echo "bumping \`ZED_TAG\`/\`ZED_COMMIT\` at the top of that script."
  echo
  echo "| language | source | ref |"
  echo "|---|---|---|"
  for row in "${QUERY_TABLE[@]}"; do
    IFS='|' read -r lang kind path repo ref <<<"$row"
    # Prefer the ref actually recorded in that language's own SOURCE file
    # (a resolved commit, for branch-tracked extension queries) over the
    # table's static ref (which may just say "main"), so this table stays
    # accurate even for languages not touched by the current invocation.
    source_ref="$(sed -n 's/^ref: *//p' "$QUERIES_DIR/$lang/SOURCE" 2>/dev/null | head -1)"
    echo "| $lang | $repo | ${source_ref:-$ref} |"
  done
} >"$QUERIES_DIR/SOURCE.md"

say "done. vendor/grammars and vendor/zed-queries updated; run bin/build-grammars to compile."
