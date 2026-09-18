#!/bin/bash
# Assembles the headless ProM oracle used for differential testing.
#
# The jars are downloaded, never vendored: ProM's InductiveMiner package is
# L-GPL and this repository is MIT. The oracle is a test fixture, it is not
# part of the plugin and is never shipped in the .pmplugin.
#
#   tools/oracle/setup.sh            -> ~/.cache/promenade-im-oracle
#   ORACLE_DIR=/somewhere setup.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${ORACLE_DIR:-$HOME/.cache/promenade-im-oracle}"
REPO=http://www.promtools.org/prom6/packages

mkdir -p "$DIR/dl"
cd "$DIR/dl"

# The framework, the log model and the utility libraries (trove, guava,
# commons) that the miner's collections are built on.
for p in ProM-Framework ProM-Plugins ProM-Models OpenXES BasicUtils ApacheUtils; do
  if [ -f "$p.done" ]; then continue; fi
  url=$(curl -sS -L --retry 3 "$REPO/$p/packages.xml" \
        | grep -oE 'url="[^"]*\.zip"' | tail -1 | sed 's/url="//;s/"//')
  echo "fetching $url"
  curl -sS -L --retry 3 --max-time 600 -o "$p.zip" "$REPO/$url"
  unzip -o -q "$p.zip" -d x
  touch "$p.done"
done

# The miner itself, plus the package its process-tree representation and
# tree-reduction rules live in. Pinned to the commits the analysis was written
# against — see docs/prom-reference.md.
for repo in InductiveMiner InductiveMinerDeprecated; do
  if [ ! -d "$DIR/dl/$repo" ]; then
    git clone --depth 1 "https://github.com/promworkbench/$repo.git" "$DIR/dl/$repo"
  fi
done

CP="$DIR/dl/x/OpenXES.jar:$DIR/dl/x/ProM-Framework.jar:$DIR/dl/x/ProM-Models.jar"
CP="$CP:$DIR/dl/x/ProM-Plugins.jar:$DIR/dl/x/BasicUtils.jar:$DIR/dl/x/ApacheUtils.jar"
CP="$CP:$(ls "$DIR"/dl/x/lib/*.jar | tr '\n' ':')"
CP="$CP$DIR/dl/InductiveMiner/latestrelease/InductiveMiner.jar"
CP="$CP:$DIR/dl/InductiveMinerDeprecated/latestrelease/InductiveMinerDeprecated.jar"
echo "$CP" > "$DIR/cp.txt"

mkdir -p "$DIR/classes"
javac -nowarn -cp "$CP" -d "$DIR/classes" "$HERE/OracleMain.java"

echo "oracle ready in $DIR"
echo '{"id":"smoke","traces":[["a","b"],["b","a"]],"variant":"IM"}' \
  | java -cp "$DIR/classes:$CP" OracleMain
