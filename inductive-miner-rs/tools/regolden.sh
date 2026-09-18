#!/bin/bash
# Regenerates crates/inductive-miner-core/tests/golden_cases.rs from the ProM
# oracle. Run after a deliberate behavioural change; read the resulting diff.
set -euo pipefail
cd "$(dirname "$0")/.."
ORACLE_DIR="${ORACLE_DIR:-$HOME/.cache/promenade-im-oracle}"
TMP="$(mktemp -d)"

python3 tools/gencases.py --seed 1 > "$TMP/hw.ndjson"
java -cp "$ORACLE_DIR/classes:$(cat "$ORACLE_DIR/cp.txt")" OracleMain \
  < "$TMP/hw.ndjson" > "$TMP/hw.prom.ndjson"
python3 tools/mkgolden.py "$TMP/hw.ndjson" "$TMP/hw.prom.ndjson" \
  > crates/inductive-miner-core/tests/golden_cases.rs
echo "wrote crates/inductive-miner-core/tests/golden_cases.rs"
