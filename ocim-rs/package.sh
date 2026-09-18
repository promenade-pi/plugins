#!/bin/bash
# Unlike the hand-written-JS example view plugins (dotted-chart,
# petrinet-layered), the OCPT view bundles npm dependencies (React, React
# Flow) — `view-src/npm run build` (esbuild) produces the single
# classic-script IIFE the sandboxed frame evals, written straight into
# `view/plugin.js` (see `view-src/build.js`); this only re-runs it, no
# separate copy step needed.
set -euo pipefail
cd "$(dirname "$0")"
wasm-pack build --target web --out-dir pkg --release
( cd view-src && npm install --no-audit --no-fund && npm run build )
OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"
cp manifest.json project.sql README.md "$OUT/stage/"
[ -f CHANGELOG.md ] && cp CHANGELOG.md "$OUT/stage/" || true
cp pkg/promenade_ocim.js pkg/promenade_ocim_bg.wasm "$OUT/stage/"
[ -d docs ] && cp -R docs "$OUT/stage/" || true
[ -d view ] && cp -R view "$OUT/stage/" || true
( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"
unzip -l "$OUT/$NAME"
