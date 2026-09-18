#!/bin/bash
# Golden tests over real XES logs, across classifiers and thresholds.
#
# The logs are downloaded to the oracle cache, never committed: they are third-
# party data with their own terms, and a test suite that needs a multi-megabyte
# download to run at all is a test suite that stops being run. What lands in the
# repository is `tests/golden-logs.txt` — the canonical trees, a few hundred
# bytes each.
#
# ProM parses the XES and applies the classifier, then dumps the *classified*
# traces for the Rust side. That is the same division of labour as in Promenade,
# where the host's classifier defines the log's activity column and the plugin
# only ever sees event classes.
set -euo pipefail
cd "$(dirname "$0")/.."
ORACLE_DIR="${ORACLE_DIR:-$HOME/.cache/promenade-im-oracle}"
LOGS="$ORACLE_DIR/logs"
CP="$ORACLE_DIR/classes:$(cat "$ORACLE_DIR/cp.txt")"
TMP="$(mktemp -d)"

mkdir -p "$LOGS"
BASE=https://raw.githubusercontent.com/pm4py/pm4py-core/release/tests/input_data
for f in running-example.xes reviewing.xes receipt.xes; do
  [ -s "$LOGS/$f" ] || curl -sS -L --retry 3 --max-time 600 -o "$LOGS/$f" "$BASE/$f"
done

cargo build --release -p inductive-miner-cli >/dev/null 2>&1

fail=0
total=0
: > "$TMP/report"

for log in running-example reviewing receipt; do
  for classifier in name name+lifecycle; do
    for setting in "IM 0.0" "IMf 0.0" "IMf 0.2" "IMf 0.5"; do
      set -- $setting
      variant=$1; noise=$2
      total=$((total + 1))
      key="$log/$classifier/$variant@$noise"

      prom=$(java -Xmx4g -cp "$CP" OracleMain --xes "$LOGS/$log.xes" \
               --classifier "$classifier" --variant "$variant" --noise "$noise" \
               --dump "$TMP/traces.json" 2>/dev/null | tail -1)
      rust=$(./target/release/im < "$TMP/traces.json")

      pc=$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('canonical',''))" "$prom")
      rc=$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('canonical',''))" "$rust")

      if [ "$pc" = "$rc" ] && [ -n "$pc" ]; then
        echo "ok    $key" >&2
        echo "$key	$pc" >> "$TMP/report"
      else
        fail=$((fail + 1))
        echo "FAIL  $key" >&2
        echo "  prom: $pc" >&2
        echo "  rust: $rc" >&2
      fi
    done
  done
done

sort "$TMP/report" > tests/golden-logs.txt
echo "" >&2
echo "$((total - fail))/$total golden log cases agree" >&2
[ "$fail" -eq 0 ]
