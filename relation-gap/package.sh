#!/bin/bash
# Packages the plugin, gated on both test suites.
#
# `cargo test` covers the network: the hand-written backward pass against
# central differences, and recovery of a link whose answer the graph structure
# determines. `check.py` covers the simulator and the co-occurrence arm against
# real DuckDB and randomised logs. `set -e` means a failure in either blocks
# packaging outright rather than producing an archive nobody checked.
#
# `+simd128` is not optional for this plugin the way it is for a conversion
# kernel: training is three layers of dense matrix products per step, and the
# vectorised build is several times faster for the same result.
set -euo pipefail
cd "$(dirname "$0")"
cargo test --release
python3 check.py
RUSTFLAGS="-C target-feature=+simd128" wasm-pack build --target web --out-dir pkg --release
OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage/view"
cp manifest.json ablate.sql plugin.py README.md CHANGELOG.md "$OUT/stage/"
cp view/plugin.js "$OUT/stage/view/"
cp pkg/promenade_relation_gap.js pkg/promenade_relation_gap_bg.wasm "$OUT/stage/"
( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"
echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
