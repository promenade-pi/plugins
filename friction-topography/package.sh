#!/bin/bash
# Builds the .pmplugin package.
#
# This is a view-only plugin: no wasm kernel, no Python. The one build step is
# `view-src`'s esbuild bundle, which produces the single classic-script IIFE the
# sandboxed frame evals (view/plugin.js) — and it is gated on `npm run check`,
# the height field's invariants over fixed and randomised plans. A terrain whose
# summit is not the log's slowest step is not worth packaging.
set -euo pipefail
cd "$(dirname "$0")"

( cd view-src && npm install --no-audit --no-fund && npm run check && npm run build )

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json README.md CHANGELOG.md "$OUT/stage/"
cp -R docs "$OUT/stage/"
cp -R view "$OUT/stage/"

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
