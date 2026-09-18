#!/bin/bash
# Builds the .pmplugin package. Python plugins ship their module and metadata.
set -euo pipefail
cd "$(dirname "$0")"
OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"
cp manifest.json plugin.py README.md CHANGELOG.md "$OUT/stage/"
( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"
echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
