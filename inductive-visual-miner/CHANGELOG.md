# Changelog

## 0.3.12

- Declares `family: "model"` on `VisualMinerReplay` and
  `DirectlyFollowsVisualMinerReplay`. Without it both fell back to
  `result`, so a mined replay was coloured as an outcome rather than a
  model in the artifact tree.

## 0.3.11

- "Export as figure…" now fits the whole diagram into view before
  capturing, in both the Inductive Visual Miner and Directly-Follows
  Visual Miner views, instead of exporting whatever was panned/zoomed into
  the visible viewport, then restores the user's own view afterwards.

## 0.3.10

- Adds an "Export as figure…" button to the canvas controls, next to the
  minimap toggle, in both the Inductive Visual Miner and Directly-Follows
  Visual Miner views: exports the diagram as PNG, SVG, or PDF.

## 0.3.9

- Fixes the Directly-Follows replay view drawing arcs, arrowheads and the
  token dot at a fixed pixel size regardless of canvas zoom. Its animation
  overlay is a canvas, not React Flow's own SVG edge layer, so it has no
  automatic viewport transform — every stroke/radius now scales with
  `viewport.zoom` explicitly, matching the fix already shipped for the
  Petri-net replay view (0.3.6).

## 0.3.8

- Fixes token counts (0.3.7) staying near-saturated for an entire place
  throughout the whole animation instead of settling low between bursts.
  The dwell window between two firings was computed with a `% duration`
  wraparound left over from an earlier version of this code, but the two
  timestamps it dwells between never actually wrap — they're always in
  non-decreasing order within one pass of the loop. Whenever two firings
  were back-to-back or shared a timestamp (silent moves inherit the
  previous move's timestamp, so this is routine), the small negative gap
  that should have meant "basically no dwell" instead wrapped into a
  window spanning nearly the *entire* loop. Every place with any such hop
  read as permanently, almost-fully occupied. Removed the wraparound —
  there was nothing for it to legitimately wrap around in the first place.
- Replaces the filled badge circle with a plain number above the place,
  in the theme's text colour — the badge read as heavier than the rest of
  the diagram.

## 0.3.7

- Removes the resting-token dot at places added in 0.3.6 — it used the same
  filled-circle styling as the ".initial" marker every place already
  carries, so every place momentarily read as a start place. Replaced with a
  new "Show token counts at places" view parameter (Inspector panel, off by
  default): a small numeric badge instead of a dot, showing exactly how many
  tokens are resting there — unlike a sampled dot, the count is always
  exact, not limited to the representative-sampled subset the moving
  particles use.

## 0.3.6

- Tokens dwelling at a place between two firings are now drawn there instead
  of vanishing the instant they arrive and reappearing out of nowhere when
  the next transition fires — the animation only ever drew motion along an
  arc, never a token actually at rest.
- The animation overlay (arcs, tokens, the traffic-load glow, transition
  pulses) now scales with the canvas zoom, matching React Flow's own nodes
  and edges; previously every stroke and radius stayed a fixed pixel size
  regardless of zoom level.
- Removes the small white highlight drawn on each token — a decorative
  pseudo-3D touch that read as visual noise at animation speed.
- Adds a legend explaining token colour: it identifies the case (cycled
  across a small palette, so two cases can share a colour), except orange,
  which marks a deviation from the log at that step.
- Switches ELK node placement from `NETWORK_SIMPLEX` to `LINEAR_SEGMENTS`,
  matching the same fix already shipped in the sibling ocdfg-flow-view and
  ocpn-flow-view presets — the former can overflow the call stack outright
  on a dense net.

## 0.3.5

- Fixes the Hybrid/recommended animation mode going almost completely quiet
  for logs whose cases all follow a similarly-shaped alignment (a common
  case — everything mined from one process tree does). The "which events get
  an individual particle" sample was chosen by `index % drawEvery`, a plain
  position in the full event list; when a case's move count divides evenly
  into `drawEvery` (four moves per case, drawEvery landing on eight, say),
  that stride always lands on the exact same relative step of every case and
  never any other — so whichever step happened to fall elsewhere (routinely
  the one flowing into the sink) got a particle in literally 0 of however
  many thousand firings, which reads as "no tokens" even though every event
  was still scheduled and drawn into the traffic-glow layer underneath.
  Sampling now keys off a hash of the event instead of its position, which
  can't resonate with any particular alignment shape.

## 0.3.4

- Fixes token replay never showing a token move at the source or sink place.
  The animation scheduler was dropping every replay event fired by a silent
  (τ) transition — and Inductive Miner routes loop re-entry and skips through
  silent transitions by construction, so the hops immediately next to source
  and sink are silent far more often than internal ones. Every firing is now
  animated regardless of visibility, matching ProM's own Inductive Visual
  Miner.

## 0.3.3

- Makes the Inductive Visual Miner's Token animation panel collapsible and
  moves its playback timeline into the shared bottom control bar.
- Adds a video-style speed popover and source-time display to the Petri-net
  replay, and adds minimap toggles below the Zoom controls in both replay
  views.

## 0.3.2

- Adds a video-style playback-speed popover (`0.25×`–`4×`) and shows the
  current source date/time alongside the Directly-Follows replay timeline.

## 0.3.1

- Uses the shared React-Flow DFG/OC-PN ELK spline handling in the Directly-
  Follows Visual Miner. Self-loops are now compact node metadata instead of
  oversized loop paths, and React Flow controls/minimap sit above playback.

## 0.3.0

- Adds **Mine with Directly-Follows Visual Miner** directly on a traditional
  event log. It derives and animates the observed DFG in one action; no
  Accepting Petri Net or separately-created DFG artifact is required.
- Uses the same `(case, timestamp NULLS LAST, import order)` event ordering as
  Promenade's relational Discover DFG reference, including self loops and
  events without timestamps.
- Adds a lifecycle-aware IVM action. It structurally expands every visible
  Petri-net transition to `enqueue → start → complete` before the existing
  exact Rust/WASM alignment, retaining original routing and concurrency.

## 0.2.5

- Draws the permanent ELK spline routes and arrowheads on the Canvas overlay,
  so idle edges remain visible even when the sandboxed React Flow SVG layer is
  suppressed by iframe rendering.

## 0.2.4

- Corrects the typed visual-net DTO's camelCase boundary fields, and adapts
  them to the renderer's shared snake_case net shape. This restores nodes and
  arcs on the replay canvas.

## 0.2.3

- Fixes the blank replay canvas: the visual net now crosses the WASM boundary
  as an explicit typed structure rather than as `serde_json::Value`, which
  turns JavaScript objects into empty objects in this bridge.

## 0.2.2

- The alignment contract now always carries a compact, renderable Petri-net
  copy. Replays produced from historical models therefore render even when
  their separate raw inline payload is missing.

## 0.2.1

- Accepts legacy nested inline-result envelopes when rendering a saved replay,
  so a malformed or older persisted envelope cannot blank the React Flow view.
- Treats missing optional net arrays as empty while loading, instead of
  crashing the entire sandboxed panel.

## 0.2.0

- Replaced the Pyodide/PM4Py replay stage with a browser-native Rust/WASM
  kernel. It computes exact Dijkstra alignments once per trace variant and
  retains case timing/transition ids for the animation.
- Made permanent React Flow SVG edges explicit, so the model remains visible
  when no token is currently travelling on an edge.

## 0.1.0

- Initial alignment-backed replay action and React Flow / Canvas hybrid viewer.
