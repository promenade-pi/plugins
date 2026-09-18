# TOTeM Discovery

Discovers a **Temporal Object Type Model (TOTeM)**: a type-level graph of an
OCEL log's object types, connected by their most precise event-cardinality,
log-cardinality and temporal-containment relations at a chosen support
threshold τ.

Ported from [Grkmr/TOTeM](https://github.com/Grkmr/TOTeM). See that repo (or
the underlying paper it implements) for the full definition of the notation;
this package's `plugin.py` docstring explains exactly what was carried over
1:1, what was simplified without changing the result, and the one line where
this port deliberately corrects an apparent bug in the reference (a
self-referential object-object merge) — see the docstring for details.

## What it produces

One `TotemModel` artifact per run: a list of object types and a list of
edges. Each edge carries three (forward, inverse) relation pairs:

- **Event cardinality** (`ec`/`ecInverse`) — when an event involves one
  type, how many objects of the other type does it typically also involve,
  in that same event. Drawn as the centered, colored label.
- **Log cardinality** (`lc`/`lcInverse`) — across the whole log, how many
  objects of the other type does one object of this type typically relate
  to (via a shared event or an explicit O2O link). Drawn as the two plain
  labels near each end.
- **Temporal relation** (`tr`/`trInverse`) — how the two objects' lifespans
  relate: `D`/`Di` (one contains the other), `I`/`Ii` (one starts and ends
  before the other), or `P` (parallel — the always-true fallback). Drawn as
  the arrow shape at each end: triangle = parallel, tee = dependent, circle
  = initiating, no marker = the inverse of dependent/initiating (the
  forward reading on the other end already says it).

Each relation is reported at the most specific label whose observed
fraction meets τ — raise τ to keep only strongly-supported relations, lower
it to see weaker/noisier ones too.

## View

A [React Flow](https://reactflow.dev) graph, force-laid-out with `d3-force`
(the JS analogue of the reference's Graphviz `sfdp` layout) so nodes start
spread apart rather than stacked, and fully draggable from there. Click a
node to select that object type across other open views; use the legend to
hide object types (and their edges) or as a key for the arrow markers.
