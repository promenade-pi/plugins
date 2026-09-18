# Changelog

## 0.3.0

- Adds a **Flow direction** view parameter — the view's first one: the net
  can now run top to bottom as well as left to right. The tuned layered
  preset is otherwise unchanged, so the two orientations are the same
  drawing, turned.
- Source/sink places carry their object-type label on whichever side the
  flow does not leave by — above a source and below a sink when running top
  to bottom — instead of always underneath, where a vertical source place's
  outgoing arcs would have been drawn straight through their own label.
  Running top to bottom, a boundary place also reserves its label's width in
  the layout, so markers sharing a layer are spaced on what is actually
  drawn rather than on the 29px circle alone.
- A silent (tau) transition's bar turns with the flow, so it is still drawn
  across the direction of travel rather than along it.

## 0.2.7

- Drops "(React Flow)" from the view label and the package name, for the
  same reason as the OC-DFG viewer: the renderer it distinguished this from
  is disabled, so the qualifier no longer distinguishes anything.

## 0.2.6 — 2026-08-29

- "Export as figure…" now fits the whole net into view before capturing,
  instead of exporting whatever was panned/zoomed into the visible
  viewport, then restores the user's own view afterwards.

## 0.2.5 — 2026-08-25

- Adds an "Export as figure…" button to the canvas controls, next to the
  minimap toggle: exports the net as PNG, SVG, or PDF.

## 0.2.4 — 2026-08-22

- Adds a "Hide overview map" toggle button to the canvas controls, matching
  the other React Flow views — the minimap could not be dismissed before.

## 0.2.3 — 2026-08-22

Fixes an uncaught `RangeError: Maximum call stack size exceeded` that could
crash this view outright on a dense net (many object types sharing arcs
across the same transitions), with nothing shown in the UI to explain it:

- Node placement now uses ELK's `LINEAR_SEGMENTS` strategy instead of
  `NETWORK_SIMPLEX`. The latter recurses per constraint-graph node in this
  GWT-compiled build with no tail-call elimination, and a dense net's
  auxiliary graph is large enough to overflow V8's stack before layout would
  even be slow. `LINEAR_SEGMENTS` is iterative and gives near-identical
  layouts for the graphs this preset actually sees.
- A layout that would still need more than 1,500 ELK edges is no longer
  attempted at all — past that point `LINEAR_SEGMENTS` itself gets slow
  enough (measured: tens of seconds) to read as a frozen tab, since this
  sandboxed view's CSP has no `worker-src` and elkjs can only run
  synchronously on the same thread as everything else. The panel now shows
  what was too large and suggests hiding object types or silent
  transitions, instead of hanging or throwing silently to the console.
- Any other layout failure is now caught and shown in the panel, rather than
  left as an unhandled promise rejection with the view stuck empty forever.

## 0.2.1 — 2026-08-19

Source and sink places now use the same compact boundary notation as the
OC-DFG React Flow view: a filled object-type-coloured circle, play/stop glyph,
and object-type label. Normal Petri-net places retain their outlined-circle
notation.

## 0.2.0 — 2026-08-18

Deterministic, spline-routed layout:
- ELK input (places, transitions, arcs) is now sorted into a canonical order
  before layout, instead of inheriting whatever order the discovery run's own
  arrays happened to be in — same OCPN, same layout, every time.
- A tuned, fuller ELK layered option set (hierarchy handling, greedy-switch
  crossing minimization, per-kind spacing, higher thoroughness).
- Edges are rendered as real smooth curves through ELK's own routed points
  (a Catmull-Rom → cubic-Bézier conversion), not straight-line segments
  connecting the same points — `elk.edgeRouting: SPLINES` was already being
  asked for, this is what makes the render actually look like one. Multiple
  routed sections per edge are now supported (each becomes its own subpath).
- React Flow configured as a pure interaction layer: explicit
  `nodeOrigin={[0,0]}` matching ELK's own top-left convention, panning via
  drag only (not scroll, which now zooms), `fitView` fires exactly once per
  real layout change (not on every selection), `onlyRenderVisibleElements`
  for large nets.

## 0.1.0 — 2026-08-18

Initial release. React Flow + elkjs (`layered`, synchronous — no Web Worker,
per the sandboxed view boundary's CSP) rendering of `ObjectCentricPetriNet`.
Source places show a Play glyph, sink places a Stop glyph. Object-type
visibility and silent-transition visibility are in-canvas legend toggles,
kept as local component state rather than manifest-declared params.
