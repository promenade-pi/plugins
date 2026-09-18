#!/bin/bash
# Builds the .pmplugin package.
#
# A plugin package is a plain zip: manifest.json at the root, the wasm module
# and its glue beside it. Nothing host-specific and no build step on the
# installing side — the host reads the manifest, stores the files, and
# registers what the manifest declares.
set -euo pipefail
cd "$(dirname "$0")"

wasm-pack build --target web --out-dir pkg --release

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json "$OUT/stage/"
cp pkg/promenade_inductive_miner.js "$OUT/stage/"
cp pkg/promenade_inductive_miner_bg.wasm "$OUT/stage/"
[ -f README.md ] && cp README.md "$OUT/stage/" || true
[ -f CHANGELOG.md ] && cp CHANGELOG.md "$OUT/stage/" || true
[ -d docs ] && cp -R docs "$OUT/stage/" || true

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
