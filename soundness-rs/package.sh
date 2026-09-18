#!/bin/bash
# Mirrors plugins/metro-map/package.sh: `wasm-pack build` produces the wasm
# kernel, `view-src`'s esbuild bundle produces the single classic-script IIFE
# the sandboxed frame evals (view/plugin.js), and this only packages both plus
# the manifest/docs into the .pmplugin archive.
#
# `cargo test --release` runs FIRST and the `set -e` is load-bearing: the
# invariants are what the verdicts mean. A checker that can call a sound net
# unsound is worse than no checker, so a failing invariant blocks packaging
# rather than producing a package with a note attached.
set -euo pipefail
cd "$(dirname "$0")"

SOUNDNESS_CHECK_CASES="${SOUNDNESS_CHECK_CASES:-20000}" cargo test --release -p soundness-core
wasm-pack build --target web --out-dir pkg --release
( cd view-src && npm install --no-audit --no-fund && npm run check && npm run build )

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json README.md CHANGELOG.md "$OUT/stage/"
cp pkg/promenade_soundness.js pkg/promenade_soundness_bg.wasm "$OUT/stage/"
cp -R docs "$OUT/stage/"
cp -R view "$OUT/stage/"

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
