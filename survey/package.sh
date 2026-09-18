#!/bin/bash
# Builds the .pmplugin package.
#
# `npm run check` gates it: the model's rules (validation, counterbalancing,
# what counts as an answer) are the part a broken build would corrupt a study
# with, so they are checked before anything ships.
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
