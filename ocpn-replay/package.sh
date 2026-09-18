#!/bin/bash
# Builds the .pmplugin package: the pyodide replay action (plugin.py) plus the
# bundled sandboxed Replay-animation view (view-src → build/view.js, esbuild
# IIFE — same setup as plugins/ocpn-flow-view).
set -euo pipefail
cd "$(dirname "$0")"

( cd view-src && npm run check && npm run build )

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage/docs"
cp manifest.json plugin.py README.md "$OUT/stage/"
[ -f CHANGELOG.md ] && cp CHANGELOG.md "$OUT/stage/" || true
cp build/view.js "$OUT/stage/"
cp docs/semantics.md "$OUT/stage/docs/"
( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"
echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
