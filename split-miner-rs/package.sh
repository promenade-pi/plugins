#!/bin/bash
# Mirrors plugins/alpha-miner-rs/package.sh: `wasm-pack build` produces the
# wasm kernel, and this only packages it plus the manifest and documentation
# into the .pmplugin archive. No view of its own — the BPMN 2.0 plugin renders
# what this produces.
#
# `cargo test --release` runs FIRST and the `set -e` is load-bearing. Split
# Miner's whole claim is a structural guarantee about its output, so a failing
# invariant is a failing algorithm, not a note to attach to a package.
set -euo pipefail
cd "$(dirname "$0")"

SPLIT_MINER_CHECK_CASES="${SPLIT_MINER_CHECK_CASES:-6000}" cargo test --release --workspace
wasm-pack build --target web --out-dir pkg --release

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json README.md CHANGELOG.md "$OUT/stage/"
cp pkg/promenade_split_miner.js pkg/promenade_split_miner_bg.wasm "$OUT/stage/"
cp -R docs "$OUT/stage/"

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
