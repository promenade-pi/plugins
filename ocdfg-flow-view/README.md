# OC-DFG (React Flow)

An alternate view for `OCDFG` artifacts. It renders shared activity nodes and
one coloured, parallel edge per object type with React Flow. Each visible
object type also has a source (play) and sink (stop) marker, connected using
the discovered start/end object counts. The legend controls object-type
visibility; activity nodes remain selectable.

The "Flow direction" view parameter (Inspector panel) turns the whole diagram
between left-to-right and top-to-bottom. Nothing else about the layout
changes, so the two orientations are the same drawing seen along a different
axis. Start/end markers keep their label clear of the flow — under the circle
when running left to right, above a source and below a sink when running top
to bottom — and reserve the label's width in the vertical layout, where
markers sitting side by side in one layer would otherwise be spaced on the
circle alone and collide by their text.

The "Combine parallel arcs" view parameter (Inspector panel) routes a single
arc per activity pair instead of one per object type, drawn as parallel
colour-coded stripes side by side. It only affects directly-follows arcs
between two activities — start/end arcs are already per object type by
construction and never overlap.

## Layout

The view uses the exact ELK layered preset of `ocpn-flow-view` — only
`elk.direction` follows the "Flow direction" parameter: splines, Network
Simplex layering with Linear Segments placement, greedy two-sided crossing
minimisation, and the same node/edge/component spacing.
Its ELK input is sorted deterministically by activity and typed edge
identity. ELK's returned section geometry is rendered directly, including
all spline bend points. Edges are rounded directional strokes, with their
colour indicating object type.

An arrowhead is aimed along the last stretch of the route that actually has
a direction, rather than along the final bend point alone: ELK returns an
edge it had to reverse — the back link closing a loop — with that bend point
sitting on the end point, and aiming along a zero-length vector collapses
the arrowhead to an invisible dot.

### Large graphs

ELK's `NETWORK_SIMPLEX` node-placement strategy recurses per constraint-graph
node in this GWT-compiled build, with no tail-call elimination — a dense
OC-DFG (many object types sharing the same activity pair) can overflow V8's
stack outright. `LINEAR_SEGMENTS` placement (used here) is iterative and
avoids that class of crash, but this sandboxed view has no `worker-src` in
its CSP, so elkjs can only run synchronously on the same thread as
everything else; past a few thousand ELK edges it just gets slow instead —
tens of seconds, read by the browser as a frozen tab. Past 1,500 ELK edges
the view skips layout entirely and shows what was too large, with a
suggestion to hide object types or turn on "Combine parallel arcs" to bring
the arc count back down.

The canvas controls also carry a "Hide overview map" toggle, matching the
other React Flow views.

## Build

Run `npm install && ./package.sh`. The resulting `.pmplugin` is written to
`dist/` and can be installed through Promenade's plugin dialog.
