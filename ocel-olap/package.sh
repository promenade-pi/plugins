#!/bin/bash
# Packages the plugin, gated on `check.mjs`.
#
# There is no Rust here and no kernel: the four operations *are* the SQL, so
# the check is not a formality. It runs each program through the host's own
# SQL Profile v1 parser and compiler, and then executes the compiled
# statements against real DuckDB (the same duckdb-wasm the app runs, via its
# node build — no new dependency) over hand-built logs. `set -e` means a
# failing invariant blocks the archive.
set -euo pipefail
cd "$(dirname "$0")"

node check.mjs

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json README.md CHANGELOG.md "$OUT/stage/"
cp -R sql docs "$OUT/stage/"

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
