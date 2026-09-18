#!/bin/bash
# Builds the .pmplugin package.
#
# Mirrors plugins/fuzzy-miner-rs/package.sh: `wasm-pack build` produces the
# mining kernel, `view-src`'s esbuild bundle produces the two classic-script
# IIFEs the sandboxed frames eval (view/plugin.js, view/matrix.js), and this
# packages both plus the manifest and docs into the archive.
#
# Both test suites are gates, not advice: `set -e` above means a failing Rust
# test or a violated layout invariant stops the package being built at all.
set -euo pipefail
cd "$(dirname "$0")"

cargo test --release
wasm-pack build --target web --out-dir pkg --release
( cd view-src && npm install --no-audit --no-fund && npm run check && npm run build )

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json README.md CHANGELOG.md "$OUT/stage/"
cp pkg/promenade_social_network.js pkg/promenade_social_network_bg.wasm "$OUT/stage/"
cp -R docs "$OUT/stage/"
cp -R view "$OUT/stage/"

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
