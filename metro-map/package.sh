#!/bin/bash
# Mirrors plugins/ocim-rs/package.sh: `wasm-pack build` produces the wasm
# kernel, `view-src`'s esbuild bundle produces the single classic-script IIFE
# the sandboxed frame evals (view/plugin.js), and this only packages both
# plus the manifest/docs into the .pmplugin archive.
set -euo pipefail
cd "$(dirname "$0")"
wasm-pack build --target web --out-dir pkg --release
# `npm run check` runs the shared `metro-layout` suite (packages/metro-layout,
# which the Variant Metro plugin gates on too) and then this plugin's own
# Logistics fixture, which exercises that layout through the complexity filter.
( cd view-src && npm install --no-audit --no-fund && npm run check && npm run build )
OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"
cp manifest.json README.md CHANGELOG.md "$OUT/stage/"
cp pkg/promenade_metro_map.js pkg/promenade_metro_map_bg.wasm "$OUT/stage/"
[ -d view ] && cp -R view "$OUT/stage/" || true
( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"
unzip -l "$OUT/$NAME"
