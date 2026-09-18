#!/bin/bash
# Mirrors plugins/social-network/package.sh: Rust tests, wasm-pack, the view
# bundles, then the archive.
#
# `cargo test --release` runs FIRST and the `set -e` is load-bearing. A
# declarative model is a list of claims about a log, and a template whose
# semantics are subtly wrong produces a model that reads perfectly and is
# false — the worst possible failure mode for this plugin. The invariants
# (every template against a literal transcription of its definition, the
# counters against a naive count, discovery against its own checker) are what
# stands between that and a package.
set -euo pipefail
cd "$(dirname "$0")"

DECLARE_CHECK_CASES="${DECLARE_CHECK_CASES:-6000}" cargo test --release -p declare-core
wasm-pack build --target web --out-dir pkg --release
( cd view-src && npm install --no-audit --no-fund && npm run check && npm run build )

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json README.md CHANGELOG.md "$OUT/stage/"
cp pkg/promenade_declare.js pkg/promenade_declare_bg.wasm "$OUT/stage/"
cp -R docs "$OUT/stage/"
cp -R view "$OUT/stage/"

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
