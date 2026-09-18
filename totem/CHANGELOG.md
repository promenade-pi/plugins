# Changelog

## 0.1.4

- Declares `family: "model"` on `TotemModel`. Without it the artifact
  type fell back to `result`, so a discovered TOTeM was coloured as an
  outcome rather than a model in the artifact tree.

## 0.1.3

- "Export as figure…" now fits the whole diagram into view before
  capturing, instead of exporting whatever was panned/zoomed into the
  visible viewport, then restores the user's own view afterwards.

## 0.1.2

Adds an "Export as figure…" button to the canvas controls: exports the
diagram as PNG, SVG, or PDF. The controls previously had no buttons at all.

## 0.1.1

Fixes edge connection points: edges now attach at the actual intersection of
the source-to-target line with each node's rectangle boundary (React Flow's
"floating edges" pattern), recomputed live as nodes are dragged, instead of
snapping to one of four fixed per-side handles — which looked arbitrary on
a force-directed layout where nodes aren't arranged top-to-bottom.

## 0.1.0

Initial release: discovers a Temporal Object Type Model from an
`ObjectCentricEventLog` (pyodide, ported from
[Grkmr/TOTeM](https://github.com/Grkmr/TOTeM)) and renders it as a
draggable, force-laid-out React Flow graph with event/log-cardinality
labels and temporal-relation arrow markers.
