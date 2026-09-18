#!/bin/bash
# Builds the single bundled classic-script IIFE consumed by the sandboxed
# view frame, then packages it with the manifest and documentation.
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
