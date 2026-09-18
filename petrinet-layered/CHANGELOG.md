# Changelog

## 0.4.0

- Adds a **Flow direction** view parameter — the view's first one: the net
  can now run top to bottom as well as left to right. The shared layered
  preset is otherwise unchanged, so the two orientations are the same
  drawing, turned.
- A silent (tau) transition's bar turns with the flow, so it is still drawn
  across the direction of travel rather than along it.

## 0.3.4 — 2026-08-29

- "Export as figure…" now fits the whole diagram into view before
  capturing, instead of exporting whatever was panned/zoomed into the
  visible viewport, then restores the user's own view afterwards.

## 0.3.3 — 2026-08-25

- Adds an "Export as figure…" button to the canvas controls, next to the
  minimap toggle: exports the diagram as PNG, SVG, or PDF.

## 0.3.2 — 2026-08-22

- Adds a "Hide overview map" toggle button to the canvas controls, matching
  the other React Flow views — the minimap could not be dismissed before.

## 0.3.1 — 2026-08-19

- Unwraps legacy nested inline-result envelopes before drawing a net, and
  safely handles partial historical payloads rather than blanking the panel.

## 0.3.0 — 2026-08-19

- Renamed from `Petri Net (Layered)` to `Petri Net`; it is now the maintained
  accepting-Petri-net renderer.
- Added a one-pixel background-coloured edge around tau bars to separate
  converging arcs cleanly without a broad white gutter.

## 0.2.1 — 2026-08-19

- Silent transitions are narrow, solid bars with no surrounding white gutter.

## 0.2.0 — 2026-08-19

- Rebuilt the renderer on React Flow and ELK using the same layered-layout
  preset as `OCPN (React Flow)`.
- Uses accepting-Petri-net notation: initial places contain a token and final
  places are double-ringed. The old play/stop boundary markers are not used.
- Removed the legend; React Flow controls and minimap remain available.

## 0.1.1 — 2026-08-17

- Fixed: switching to another tab and back could leave this view permanently
  blank. A hidden dockview tab can report a transient `{w:0,h:0}` resize,
  and `draw()` was clearing the SVG for that event *before* checking it was
  valid, then bailing — nothing afterwards ever repainted it, since
  refocusing an already-open panel does not by itself send a fresh resize.
  The check now runs before the clear.
- Renamed the view "Petri net (layered)" → "Petri Net (Layered)", matching
  the artifact type's own "Accepting Petri Net" casing instead of clashing
  with it.

## 0.1.0 — 2026-08-16

Initial release. A second `AcceptingPetriNet` view alongside the host's
built-in one, using a Sugiyama-style layered layout (rank assignment,
barycenter crossing-reduction, coordinate assignment) instead of a plain
longest-path ranking — the same three stages Graphviz's `dot` runs, native
to the sandbox rather than a bundled WASM binary. Handles both net shapes
(pm4py's self-describing `net.labels`, and the Alpha Miner's id-only shape,
which falls back to `#<id>` labels — a real boundary limitation, not a bug
in this plugin). Silent transitions draw as the small filled square Petri
net tools conventionally use; places show their initial/final marking as a
filled token. Click a transition to highlight it by activity across other
open panels.
