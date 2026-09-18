#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage/view"
cp manifest.json plugin.py README.md "$OUT/stage/"
[ -f CHANGELOG.md ] && cp CHANGELOG.md "$OUT/stage/" || true
cp view/plugin.js "$OUT/stage/view/"
( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"
echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
