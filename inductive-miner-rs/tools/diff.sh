#!/bin/bash
# Differential runner: one NDJSON case file through both implementations.
#
#   tools/diff.sh cases.ndjson
#
# Both sides read the same file and emit one canonical tree per line, so a
# mismatch is a line-for-line diff rather than a re-derivation. The oracle
# lives outside the repo (ProM jars are L-GPL and are not vendored); point
# ORACLE_DIR at a checkout built with tools/oracle/setup.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

CASES="${1:?usage: diff.sh cases.ndjson}"
ORACLE_DIR="${ORACLE_DIR:-$HOME/.cache/promenade-im-oracle}"
OUT="${OUT:-$(mktemp -d)}"

cargo build --release -p inductive-miner-cli >/dev/null 2>&1
./target/release/im < "$CASES" > "$OUT/rust.ndjson"

java -cp "$ORACLE_DIR/classes:$(cat "$ORACLE_DIR/cp.txt")" OracleMain \
  < "$CASES" > "$OUT/prom.ndjson"

python3 tools/compare.py "$CASES" "$OUT/prom.ndjson" "$OUT/rust.ndjson"
