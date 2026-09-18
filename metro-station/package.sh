#!/bin/bash
# Builds the .pmplugin package.
#
# Two gates, both of which have already caught real defects in this plugin:
#
#   cargo test        the plan's invariants — no two routes on the same line,
#                     no platform on another, every hand-off descending — over
#                     the worked example and 250 randomised graphs.
#   npm run check     the view's invariants — everything about the third
#                     dimension, which the Rust cannot see.
#
# `set -euo pipefail` means a red gate stops the release. That is deliberate:
# a diagram whose routes overlap is not a packaging problem to schedule later.
set -euo pipefail
cd "$(dirname "$0")"

cargo test -p station-map-core
wasm-pack build --target web --out-dir pkg --release
( cd view-src && npm install --no-audit --no-fund && npm run check && npm run build )

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json README.md CHANGELOG.md "$OUT/stage/"
cp -R docs "$OUT/stage/"
cp -R view "$OUT/stage/"
cp pkg/promenade_metro_station.js pkg/promenade_metro_station_bg.wasm "$OUT/stage/"

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
