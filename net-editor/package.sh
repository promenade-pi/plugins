#!/bin/bash
# Builds the .pmplugin package.
#
# Bundles React and React Flow into the single classic-script IIFE the
# sandboxed frame evals (`views[].entry` resolves to a flat basename — see
# `host/plugins/store.ts`), so the package ships one file, not the source tree.
#
# Gated on `npm run check`: the compilers are the part with a contract, and the
# test runs the host's *own* validators over what they produce. A net the
# editor would publish and the host would reject must not ship.
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
