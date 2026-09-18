#!/bin/bash
# Builds the .pmplugin package: manifest.json, the wasm module and its glue,
# the SQL projection, the pyodide merge script, and the built view bundle —
# a plain zip, nothing host-specific.
set -euo pipefail
cd "$(dirname "$0")"

wasm-pack build --target web --out-dir pkg --release
( cd view-src && npm install --no-audit --no-fund && npm run build )

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json "$OUT/stage/"
cp pkg/promenade_lpm.js "$OUT/stage/"
cp pkg/promenade_lpm_bg.wasm "$OUT/stage/"
cp project-oc.sql "$OUT/stage/"
mkdir -p "$OUT/stage/combine-oc"
cp combine-oc/plugin.py "$OUT/stage/combine-oc/"
mkdir -p "$OUT/stage/view"
cp view/plugin.js "$OUT/stage/view/"
[ -f README.md ] && cp README.md "$OUT/stage/" || true
[ -f CHANGELOG.md ] && cp CHANGELOG.md "$OUT/stage/" || true
[ -d docs ] && cp -R docs "$OUT/stage/" || true

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
