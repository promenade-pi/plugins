#!/bin/bash
# Builds the .pmplugin package.
#
# Mirrors plugins/metro-map/package.sh: `wasm-pack build` produces the metric
# kernel, `view-src`'s esbuild bundle produces the single classic-script IIFE
# the sandboxed frame evals (view/plugin.js), and this packages both plus the
# manifest and docs into the archive. The view build is gated on
# `npm run check` — the filter chain's invariants over randomised models.
set -euo pipefail
cd "$(dirname "$0")"

cargo test --release
wasm-pack build --target web --out-dir pkg --release
( cd view-src && npm install --no-audit --no-fund && npm run check && npm run build )

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json README.md CHANGELOG.md "$OUT/stage/"
cp pkg/promenade_fuzzy_miner.js pkg/promenade_fuzzy_miner_bg.wasm "$OUT/stage/"
cp -R docs "$OUT/stage/"
cp -R view "$OUT/stage/"

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
