#!/bin/bash
# Builds the .pmplugin package.
#
# Bundles npm dependencies (React, React Flow, elkjs) for the view, same as
# `ocim-rs`/`ocpn-flow-view` — `view-src && npm run build` (esbuild) produces
# the single classic-script IIFE the sandboxed frame evals, written straight
# into `view/plugin.js`.
#
# `cargo test --release` runs FIRST and the `set -e` is load-bearing. The
# OR-join replacement is checked by behavioural equivalence over randomised
# diagrams, and a replacement that changes what a model means is worse than no
# replacement at all — so a failing invariant blocks packaging rather than
# producing a package with a note attached.
set -euo pipefail
cd "$(dirname "$0")"

OR_JOIN_CHECK_CASES="${OR_JOIN_CHECK_CASES:-4000}" cargo test --release --workspace
wasm-pack build --target web --out-dir pkg --release
( cd view-src && npm install --no-audit --no-fund && npm run build )

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json README.md "$OUT/stage/"
[ -f CHANGELOG.md ] && cp CHANGELOG.md "$OUT/stage/" || true
cp pkg/promenade_bpmn.js pkg/promenade_bpmn_bg.wasm "$OUT/stage/"
[ -d view ] && cp -R view "$OUT/stage/" || true

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
