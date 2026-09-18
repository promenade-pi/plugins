#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
CARGO_NET_OFFLINE=true wasm-pack build --target web --out-dir pkg --release
npm run build
OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"
cp manifest.json README.md CHANGELOG.md "$OUT/stage/"
cp pkg/ivm_alignment.js pkg/ivm_alignment_bg.wasm "$OUT/stage/"
cp build/plugin.js build/dfg-plugin.js "$OUT/stage/"
( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"
echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
