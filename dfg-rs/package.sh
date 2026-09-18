#!/bin/bash
# Builds the .pmplugin package — two wasm builds of the same algorithm.
#
# A plugin package is a plain zip: manifest.json at the root, the browser
# wasm module and its glue beside it, and (new for this plugin) a `compute/`
# subfolder holding the second, WASI build Promenade Compute engines run
# instead. Nothing host-specific and no build step on the installing side —
# the host reads the manifest, stores the files, and registers what the
# manifest declares; the engine does the equivalent for the `compute` block.
set -euo pipefail
cd "$(dirname "$0")"

echo "building browser target (wasm32-unknown-unknown via wasm-pack)..."
wasm-pack build --target web --out-dir pkg --release

echo "building engine target (wasm32-wasip1)..."
rustup target add wasm32-wasip1 >/dev/null 2>&1 || true
cargo build --target wasm32-wasip1 --release

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage/compute"

cp manifest.json "$OUT/stage/"
cp pkg/promenade_dfg.js "$OUT/stage/"
cp pkg/promenade_dfg_bg.wasm "$OUT/stage/"
cp target/wasm32-wasip1/release/promenade_dfg.wasm "$OUT/stage/compute/promenade_dfg_wasi.wasm"
[ -f README.md ] && cp README.md "$OUT/stage/" || true
[ -f CHANGELOG.md ] && cp CHANGELOG.md "$OUT/stage/" || true

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
