#!/bin/bash
# Builds the .pmplugin package.
#
# Unlike the hand-written-JS example view plugins (dotted-chart,
# petrinet-layered), this one bundles npm dependencies (React, React Flow,
# elkjs) — `npm run build` (esbuild) produces the single classic-script IIFE
# the sandboxed frame evals; `views[].entry` is resolved to a flat basename
# (see `host/plugins/store.ts`), so the package ships that one bundled file,
# not the source tree or node_modules.
set -euo pipefail
cd "$(dirname "$0")"

npm run build

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json README.md "$OUT/stage/"
cp build/plugin.js "$OUT/stage/"
[ -f CHANGELOG.md ] && cp CHANGELOG.md "$OUT/stage/" || true

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
