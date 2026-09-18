#!/bin/bash
# Builds the .pmplugin package. `npm run check` runs first: the editor's
# autofill/validation logic is plain TypeScript with real invariants, and a
# type error there is not something a packaged bundle should ever carry.
set -euo pipefail
cd "$(dirname "$0")"

npm run check
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
