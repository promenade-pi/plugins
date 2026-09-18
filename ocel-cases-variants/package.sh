#!/bin/bash
# Builds the .pmplugin package: one bundled view script plus the manifest.
set -euo pipefail
cd "$(dirname "$0")"

# Gate, not a suggestion (`set -e`): the checks assert that the variant
# partition is unchanged and that no single stretch of main-thread work is
# long enough for the browser to call the page unresponsive. Both are easy to
# regress and impossible to notice by looking.
npm run check
npm run build

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json README.md "$OUT/stage/"
[ -f CHANGELOG.md ] && cp CHANGELOG.md "$OUT/stage/" || true
cp build/plugin.js "$OUT/stage/"

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
