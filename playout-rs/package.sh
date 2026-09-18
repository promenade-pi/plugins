#!/bin/bash
# Mirrors plugins/soundness-rs/package.sh, minus the view bundle: this plugin
# contributes no panel of its own — what it produces is an ordinary event log,
# which the host's own log views already render.
#
# `cargo test --release` runs FIRST and the `set -e` is load-bearing. The
# invariants are what the log *means*: a play-out that emits a trace its own net
# cannot produce would corrupt every benchmark built on it, and the error would
# look like a finding rather than a bug. A failing invariant blocks packaging
# rather than producing a package with a note attached.
set -euo pipefail
cd "$(dirname "$0")"

PLAYOUT_CHECK_CASES="${PLAYOUT_CHECK_CASES:-1500}" cargo test --release -p playout-core
wasm-pack build --target web --out-dir pkg --release

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage"

cp manifest.json README.md CHANGELOG.md "$OUT/stage/"
cp pkg/promenade_playout.js pkg/promenade_playout_bg.wasm "$OUT/stage/"
cp -R docs "$OUT/stage/"

( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
