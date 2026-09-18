#!/bin/bash
# Builds the .pmplugin: the pyodide layout action (plugin.py) plus the bundled
# sandboxed React Flow view (view-src -> build/view.js, esbuild IIFE).
#
# Both test suites gate the build. The Python invariants need numpy and scipy,
# which are not the host interpreter's business, so a local venv is created on
# first run — the same scipy that Pyodide ships, so the integer programs are
# exercised by the same HiGHS build that runs in the browser.
set -euo pipefail
cd "$(dirname "$0")"

VENV=".venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "creating $VENV for the Python invariants (numpy, scipy)"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q --disable-pip-version-check numpy scipy
fi
"$VENV/bin/python" -m unittest discover -s test

( cd view-src && npm run check && npm run build )

OUT="dist"
NAME="$(node -p "require('./manifest.json').id")-$(node -p "require('./manifest.json').version").pmplugin"
rm -rf "$OUT" && mkdir -p "$OUT/stage/docs"
cp manifest.json plugin.py README.md CHANGELOG.md "$OUT/stage/"
cp docs/method.md "$OUT/stage/docs/"
cp build/view.js "$OUT/stage/"
( cd "$OUT/stage" && zip -q -r "../$NAME" . )
rm -rf "$OUT/stage"

echo "built $OUT/$NAME"
unzip -l "$OUT/$NAME"
