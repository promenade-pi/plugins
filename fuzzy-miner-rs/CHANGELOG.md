# Changelog

## 0.5.1 — 2026-09-15

- Declares `family: "model"` on `FuzzyModel`. Without it the artifact
  type fell back to `result`, so a mined fuzzy model was coloured as an
  outcome rather than a model in the artifact tree.

## 0.5.0 — 2026-09-15

Closes the last of the gaps found checking against ProM's real source (#6):
a diagnostic ProM itself never had, to make the (Inspector-only) maximal
distance / attenuation / radical choices informed rather than guessed.

- **Distances mode** — a third mode in the Fuzzy metrics view, alongside
  Matrix and Curves: a bar per look-back distance showing how many relation
  observations the scan actually found there, with the *current* attenuation
  curve (linear or nth-root, at the run's radical) overlaid on the same
  [0, 1] axis. Bars past the current maximal-distance cutoff are dimmed and
  the cutoff itself is marked with a dashed line, so it's visible at a
  glance whether raising the cutoff (which lives on the action's own params,
  not this view) would actually capture more real data, or whether the
  current radical discounts the tail so hard it wouldn't matter anyway.
  Hover shows the exact observation count and attenuation factor per
  distance. New `distanceHistogram: Vec<u64>` field on `FuzzyModel` —
  computed straight from the scan's raw per-distance accumulator, so it is
  independent of `maximalDistance` and does not need re-scanning as that
  param moves. New `DistanceHistogram.tsx`, same `forwardRef`+`exportPng()`
  pattern as `Heatmap.tsx`/`CurveChart.tsx`.

## 0.4.0 — 2026-09-15

Closes three of the gaps found checking this plugin against ProM's real
Fuzzy Miner source (`rapidprom-source`/`rapidprom`'s `FuzzyMinerOperator`
parameter definitions):

- **Per-metric invert** — every one of the seven raw metrics (frequency and
  routing significance unary; frequency and distance significance binary;
  proximity, endpoint and originator correlation) now has its own "Invert"
  checkbox, mirroring the metric around its own weight (`weight - value`, the
  Python reference's exact semantics — not `1 - value`, and not a shared
  toggle over the whole model as some ports simplify it to). Derivative
  metrics (routing/distance significance, which are computed from other
  already-possibly-inverted arrays) invert *after* their own computation, the
  same two-step layering the reference implementation uses. Pure kernel/manifest
  change — the host's generic Inspector renders the new booleans, no view code
  needed.
- **Maximal event distance raised to 20** — ProM's own parameter allows
  0–100 (`ParameterTypeInt(..., 0, 100, 1)`); this plugin's original ceiling
  of 5 was a placeholder. 20 is the chosen compromise: four times ProM's own
  default, while keeping the worst-case `scan` memory (which grows with
  `distance × MAX_ACTIVITIES²`) around 42MB rather than the ~210MB a full
  100 would cost in the WASM worker. See the `SCAN_DISTANCE` doc comment in
  `src/lib.rs`.
- **Fuzzy metrics view gets a Curves mode** — a second panel, toggled
  alongside the existing heatmap, plotting the unary metrics (overall
  significance, plus frequency/routing significance unary when per-metric
  detail was kept) as overlaid line charts across all activities — ProM's own
  second metrics panel, previously collapsed into the matrix's row-gutter
  bars. Y-axis fixed at `[0, 1]` (not renormalized per curve) so a reduced
  metric weight visibly shows as a shorter curve. Curve visibility toggles are
  local, unpersisted state — a reading aid, not a saved-view setting. Shares
  sort order and the "Export PNG" button with the matrix via a `mode: 'matrix'
  | 'curves'` param; `Heatmap.tsx`/`CurveChart.tsx`/`canvasUtils.ts` factored
  out of the former single-file `MatrixView.tsx` so both charts share layout,
  DPR and PNG-export code.

## 0.3.1 — 2026-09-14

Hardens the Fuzzy metrics view's theme handling: colour tokens are read with
`||` rather than `??`, so an empty-string theme value (as opposed to a
missing one) falls back to a sane default instead of being handed to a
canvas `fillStyle` as-is — which silently keeps whatever colour the context
already had (defaulting to black) rather than erroring, the one way a canvas
2D context's error handling differs from a DOM element's `style` attribute.
Caught live: a matrix opened immediately after its producing action finished,
with no observable delay in between, once rendered on a solid black
background before a subsequent open of the same view came back correctly
themed — not reproduced since, but the fallback gap was real regardless of
how narrow the window that exposed it turned out to be.

## 0.3.0 — 2026-09-14

Adds the second half of ProM's Fuzzy Miner screen: a coloured metrics matrix,
alongside the graph, rather than only ever seeing the simplified diagram.

- **Fuzzy metrics** — a new view (`Fuzzy metrics`) registered against the
  same `FuzzyModel` artifact, opened independently of `Fuzzy graph` from the
  artifact's Views list. Draws an n×n heatmap over ordered activity pairs —
  the two weighted totals (`edgeSignificance`, `edgeCorrelation`) always
  available, plus the five raw metrics behind them (frequency significance,
  distance significance, proximity/endpoint/originator correlation) once a
  model has been mined with "Keep per-metric values". A bar in the row
  gutter carries the unary side (per-activity significance) aligned with the
  same row order, in place of ProM's separate, unlinked unary-metrics chart.
  Hovering a cell or a header shows its exact value; clicking selects the
  activity or activity pair the same way a node click does in the graph
  view, and a selection made in either view highlights in the other.
  Two colour families distinguish the metric groups — the graph's existing
  blue for significance-type metrics, green for correlation-type ones — with
  a legend, a sort control (by significance or alphabetical), an adjustable
  cell size, and a PNG export.
- `bootstrap.tsx` factors the "no computed model" / "view failed to start"
  handling the graph view already had into a helper both views share.

## 0.2.1 — 2026-09-03

Fixes a regression from 0.2.0's own arrowhead fix: padding the box ELK laid
out (to keep the arrowhead from rendering under the node) meant edges were
routed to a boundary *larger* than the node actually drawn, centred inside
that padding. That reopened the visible gap between the arrowhead and the
node it was meant to close, and — because multiple incoming or outgoing ports
spread across the padded, wider boundary — compressed onto a narrower band of
the real node's width, sometimes missing it near the corners entirely.

- ELK now lays out every node at its real, drawn size, so ports spread across
  the node's true width and every edge terminates exactly on its boundary.
- The clearance for the arrowhead is applied to the *rendered* path only —
  each edge is resampled and shortened by `NODE_MARGIN` at both ends
  (`trimPath` in `layout.ts`) after ELK has already routed it against the
  real geometry. The edge label's anchor still uses the full, untrimmed route,
  so it continues to sit at the relation's true midpoint.

## 0.2.0 — 2026-09-03

The **Fuzzy graph** view's slider rail moves into the panel itself, and two
geometry bugs in the diagram are fixed.

- **Slider rail is now a side panel**, not a card floating over the diagram —
  a collapsible column down the right of the view, so the canvas has a real
  width of its own and nothing on it is ever covered. Collapsing it refits the
  canvas into the freed space.
- The cluster detail popover moved to the canvas's top-left, since the rail
  now owns the right edge.
- Edge labels take their colour from `promenade.theme()` instead of a
  host-injected CSS var, so they stay legible in dark mode instead of
  defaulting to white-on-dark wherever the var wasn't set.
- **Arrowheads no longer land half-buried under the node they point to.** ELK
  ends a route exactly on the node boundary and React Flow centres the arrow
  marker there; the node ELK lays out is now padded by `NODE_MARGIN`, with the
  real node drawn centred inside that padding, so every marker clears the
  border by a guaranteed margin.
- **Edge labels no longer land on top of nodes.** The anchor was an ELK bend
  point, which for a spline route is a Bézier *control* point, not a point on
  the curve — it can sit anywhere, including inside a box. Labels are now
  anchored at the drawn curve's true arc-length midpoint
  (`getPointAtLength(length / 2)`), with a polyline estimate as fallback. A
  hop too short to hold a number legibly gets no label at all, rather than one
  overlapping an endpoint.

## 0.1.0 — 2026-09-02

First release. Günther & van der Aalst's Fuzzy Miner (BPM 2007) for
case-centric event logs.

- **Fuzzy Miner** action (Rust/WebAssembly): one ordered pass over the log
  builds every metric ingredient per look-back distance; `finalize` folds them
  down with the chosen attenuation and produces a `FuzzyModel` — unary
  significance per activity, binary significance and correlation per ordered
  pair. Frequency and routing significance, frequency and distance
  significance, and proximity, endpoint and originator correlation. Attenuation
  (Nth root or linear), radical, maximal event distance and all seven metric
  weights are cheap parameters, so they re-run without re-scanning the log.
- **Fuzzy graph** view (React Flow + ELK): the original's three-stage filter
  chain — conflict resolution, edge filter, node aggregation into clusters —
  on a vertical slider rail beside the diagram, re-running live on every drag.
  Blue squares for activities, green octagons for clusters, edge thickness
  from the relation's combined weight. Clicking a cluster lists what went
  inside.
- Data-type and data-value correlation are not implemented; see
  `docs/algorithm.md`.
