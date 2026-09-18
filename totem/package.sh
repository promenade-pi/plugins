#!/bin/bash
# Builds the .pmplugin package: `npm run build` (esbuild) produces the single
# classic-script IIFE the sandboxed frame evals for the view; `plugin.py`
# ships as-is for the pyodide action. `views[].entry` is resolved to a flat
# basename (see `host/plugins/store.ts`), so the package ships the bundled
# file renamed to `view.js` at the zip root, not the source tree or
# node_modules.
set -euo pipefail
cd "$(dirname "$0")"

npm run build

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json plugin.py README.md "$OUT/stage/"
cp build/view.js "$OUT/stage/"
[ -f CHANGELOG.md ] && cp CHANGELOG.md "$OUT/stage/" || true

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
