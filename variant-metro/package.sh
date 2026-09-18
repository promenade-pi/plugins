#!/bin/bash
# Mirrors plugins/metro-map/package.sh: `wasm-pack build` produces the wasm
# kernel, `view-src`'s esbuild bundle produces the single classic-script IIFE
# the sandboxed frame evals (view/plugin.js), and this only packages both
# plus the python first stage and the manifest/docs into the .pmplugin archive.
#
# Both gates run before anything is packaged, and `set -e` means a failure
# here blocks packaging outright rather than producing an archive nobody
# checked: `cargo test` covers the variant attribution (that the ids
# `metro-map-core` mints still line up, and that `minVariant` stays monotone
# along every arc — the invariant the slider rests on), `check.py` the variant
# extraction itself (both BFS paths agreeing, the counts summing, and position
# 1 really being the most frequent variant), and `npm run check` the shared
# `metro-layout` suite — literally the same invariants the Metro Map plugin
# gates on, since both now consume one layout package rather than a copy each.
set -euo pipefail
cd "$(dirname "$0")"
cargo test --release
python3 check.py
wasm-pack build --target web --out-dir pkg --release
( cd view-src && npm install --no-audit --no-fund && npm run check && npm run build )
OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"
cp manifest.json README.md CHANGELOG.md variants.py "$OUT/stage/"
cp pkg/promenade_variant_metro.js pkg/promenade_variant_metro_bg.wasm "$OUT/stage/"
[ -d view ] && cp -R view "$OUT/stage/" || true
( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"
unzip -l "$OUT/$NAME"
