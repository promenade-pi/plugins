#!/bin/bash
# Builds the .pmplugin package.
#
# `npm run build` (esbuild) produces the single classic-script IIFE the
# sandboxed frame evals; `views[].entry` is resolved to a flat basename (see
# `host/plugins/store.ts`), so the package ships that one bundled file, not the
# source tree or node_modules.
set -euo pipefail
cd "$(dirname "$0")"

npm run check
npm run build

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json README.md CHANGELOG.md "$OUT/stage/"
cp build/plugin.js "$OUT/stage/"

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
