#!/bin/bash
# Mirrors plugins/playout-rs/package.sh: tests, then wasm-pack, then the
# archive. No view bundle — what this produces is an ordinary Process Tree,
# which the tree view already draws.
#
# `cargo test --release` runs FIRST and the `set -e` is load-bearing. A
# generator's output is nobody's expectation, so a defect in it would not show
# up as a wrong answer — it would show up as a benchmark that quietly measured
# something else. The invariants (including "every generated tree is a sound
# workflow net", checked through two other plugins' crates) are what stands in
# for an expectation, so a failing one blocks packaging.
set -euo pipefail
cd "$(dirname "$0")"

TREE_CHECK_CASES="${TREE_CHECK_CASES:-3000}" cargo test --release -p tree-gen-core
wasm-pack build --target web --out-dir pkg --release

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json README.md CHANGELOG.md "$OUT/stage/"
cp pkg/promenade_tree_generator.js pkg/promenade_tree_generator_bg.wasm "$OUT/stage/"
cp -R docs "$OUT/stage/"

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
