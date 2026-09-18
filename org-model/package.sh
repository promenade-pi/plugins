#!/bin/bash
# Builds the .pmplugin package.
#
# `wasm-pack build` produces the clustering kernel, `view-src`'s esbuild bundle
# produces the classic-script IIFE the sandboxed frame evals, and this packages
# both plus the manifest and docs. Both test suites are gates, not advice:
# `set -e` means a failing Rust test or a violated dendrogram invariant stops
# the package being built at all.
set -euo pipefail
cd "$(dirname "$0")"

cargo test --release
wasm-pack build --target web --out-dir pkg --release
( cd view-src && npm install --no-audit --no-fund && npm run check && npm run build )

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json README.md CHANGELOG.md "$OUT/stage/"
cp pkg/promenade_org_model.js pkg/promenade_org_model_bg.wasm "$OUT/stage/"
cp -R docs "$OUT/stage/"
cp -R view "$OUT/stage/"

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
