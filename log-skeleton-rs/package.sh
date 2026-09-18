#!/bin/bash
# Mirrors plugins/declare-rs/package.sh: Rust tests, wasm-pack, the view
# bundles, then the archive.
#
# `cargo test --release` runs FIRST and the `set -e` is load-bearing. A log
# skeleton is a *classifier*: a relation whose semantics are subtly wrong
# produces a skeleton that reads perfectly and rejects cases it was built from.
# The invariants — including "the skeleton accepts its own log" and the
# correspondence with the DECLARE plugin's templates — are what stands between
# that and a package.
set -euo pipefail
cd "$(dirname "$0")"

SKELETON_CHECK_CASES="${SKELETON_CHECK_CASES:-3000}" cargo test --release -p log-skeleton-core
wasm-pack build --target web --out-dir pkg --release
( cd view-src && npm install --no-audit --no-fund && npm run check && npm run build )

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json README.md CHANGELOG.md "$OUT/stage/"
cp pkg/promenade_log_skeleton.js pkg/promenade_log_skeleton_bg.wasm "$OUT/stage/"
cp -R docs "$OUT/stage/"
cp -R view "$OUT/stage/"

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
