#!/bin/bash
# Mirrors plugins/soundness-rs/package.sh: tests, wasm-pack, archive. No view —
# what this produces is an ordinary Accepting Petri Net, which the layered
# renderer already draws.
#
# `cargo test --release` runs FIRST and the `set -e` is load-bearing. A
# reduction that is too aggressive produces a *smaller* net, which is what was
# asked for and looks like success; the only thing that catches it is the
# language comparison in `tests/invariants.rs`, which enumerates both nets with
# the play-out plugin's extensive mode. A failing invariant blocks packaging.
set -euo pipefail
cd "$(dirname "$0")"

REDUCE_CHECK_CASES="${REDUCE_CHECK_CASES:-1200}" cargo test --release -p net-reduce-core
wasm-pack build --target web --out-dir pkg --release

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json README.md CHANGELOG.md "$OUT/stage/"
cp pkg/promenade_net_reduce.js pkg/promenade_net_reduce_bg.wasm "$OUT/stage/"
cp -R docs "$OUT/stage/"

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
