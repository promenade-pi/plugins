# Changelog

## 0.3.4

- Picks up the shared `metro-layout` speedups (see Metro Map 0.19.5): the transpose pass in crossing minimisation now decides each adjacent swap by local difference instead of recounting both layer pairs, and `findOverlaps` caches each polyline's segment decomposition and buckets by line offset instead of sorting the whole drawing on every call. A dense map lays out about 3x faster.
- No drawing changes. The shared 27-graph invariant suite produces byte-for-byte identical output.

## 0.3.3

- Sink markers now center under their actual incoming tracks after allocation. The shared layout uses edge-to-node identity rather than coincident column/rank geometry, while preserving marker, caption, and unrelated-route clearance.

## 0.3.2

- A centered join's single outgoing branch now remains on the diamond's final centerline for its whole initial vertical run. This removes the S-shaped hook caused by briefly reconnecting to the old pre-centering lane before turning toward the target.

## 0.3.1

- Rebuilt against the shared `metro-layout` gateway fixes. Incoming join branches now retain separate vertical arrival tracks and stop above the diamond rather than converging into slanted arrowheads.
- Join diamonds are centered on the span of their incoming tracks, and their outgoing branch starts from that same adjusted center. The shared regression covers the asymmetric two-in/one-out shape.

## 0.3.0

- **This plugin's copy of the metro layout is gone; it now uses the same `metro-layout` package the Metro Map plugin does.** The Rust layout was always shared (`metro-map-core`, by path dependency). The TypeScript layout was not — this plugin carried its own `relayout.ts`, `router.ts` and `route.ts`, and they had fallen well behind. It inherits everything that drift cost it:
  - **The drawing-refinement pass, which this plugin simply did not have** (no `geometry.ts` at all). Arcs are now aligned at short unbranched source tails, detoured around the node footprints and stop captions they would otherwise be drawn straight through, and chamfered per corner instead of globally.
  - **Gateway-aware routing.** Its router had no notion of a gateway at all, so explicit branches were routed as if the diamond were an ordinary stop; they now meet at the marker, with the junction ordering and end-fans the Metro Map plugin has had for several versions.
  - **Per-corner chamfer limits**, so one tight bend no longer flattens corners elsewhere in the map.
- Measured on the Logistics OC-DFG graph (33 nodes, 77 arcs), refinement alone — same routing either side — roughly halves the cross-type overlaps in the drawn geometry (dots/stable 34 → 17, dots/fresh 25 → 11, labels/stable 38 → 13, labels/fresh 29 → 13) and reduces arcs drawn through node footprints (labels/stable 8 → 5). It does not eliminate them on a completely unfiltered graph, and does not claim to.
- **Start markers sit one row above the activity they feed even with "Preserve layout stability" off**, instead of every object type stacking on the top row. See the Metro Map plugin's 0.19.0 entry — the fix is in the shared package, so both views get it.
- `npm run check` is now the shared suite: the same 27 graphs, asserted identically here and in the Metro Map plugin, and `package.sh` gates on it as before. The two views can no longer drift apart on geometry.

## 0.2.0

- **The wait before the map appears is no longer a blank screen.** Discovery here runs the pyodide variant-extraction stage first, so the wait includes starting Python — and until now it showed only a top-bar progress bar, with no panel at all. The view opts into the host's run-bound live preview (`livePreview`), so its panel opens the moment discovery starts, showing an animated schematic of the Budapest metro — trains running station to station, waiting at each — together with whatever the run is actually reporting. The top-bar indicator has a **Cancel** button for as long as the run lasts. Both are host capabilities; this version is what makes this view use them.
- The same screen also covers the view's own first layout pass, which is synchronous and blocks the panel until it finishes.
- Every moving part of that screen is a CSS animation on `transform`/`opacity` of an HTML element, never SVG animation or a `requestAnimationFrame` loop: the layout wait *is* the main thread being blocked, so anything needing the main thread would freeze on its first frame. It fades in after 250ms, so a map that lays out immediately never flashes it.
- **Fixed a latent race in how this view receives its saved settings.** The host answers the plugin handshake with one burst (resize, theme, params) and `on()` keeps a single handler per event, so registering from a React effect only worked because the handshake happened in that same effect. It no longer can — the standby screen has to be up and handshaken before the layout pass starts, frames before the component that wants the params exists. All host handlers now register at module scope, before the handshake.
- The dev harness (`view-src/harness`) grew a `?live` mode standing in for a run-bound preview, a `?params` mode that answers `ready()` with the host's real initial burst, and probes for the standby screen — so all three branches are asserted in headless Chrome rather than eyeballed. Verified: the loader is on screen with zero map nodes at 0ms and 30ms and gone with 13 nodes by 300ms, and a burst asking for labelled stations and frequency edge labels survives to first render.

## 0.1.1

- Renames the view to "Metro map with variant slider" and the action to
  match. "Variant metro" named the technique rather than the result, so in
  a list of destinations it read as an unrelated thing and sorted away from
  the metro maps it is a variation of.

## 0.1.0

First release. An experimental metro map whose slider is the number of process
variants rather than the number of arcs.

- **Two stages, one click.** `variants.py` (an internal pyodide action, run for
  you through `scans`/`scanAction`) extracts process executions and groups them
  into variants; the wasm stage lays the result out. The intermediary is hidden
  and reused across parameter changes, so moving a parameter does not litter
  the artifact tree.
- **Variants exactly as "Cases & Variants (OCEL)" defines them** — process
  executions by leading type or connected components, variant equivalence by
  activity-labelled graph isomorphism (Weisfeiler-Lehman bucketing, then exact
  verification within a bucket). A direct port of that plugin's own
  `objectGraph.ts` / `isomorphism.ts`, deliberately, so the two agree on what a
  variant is. `scopeSharedObjects` and `maxEvents` carry over with the same
  meanings and the same defaults.
- **The slider.** Every node and arc records `minVariant`, the rank of the most
  frequent variant it first appears in, so slider position k *is* the OC-DFG of
  the k most frequent variants. Top of the slider: the whole log. Bottom: the
  most frequent variant alone. Everything past `maxVariants` (25 by default)
  shares one final position, so the top always means the complete log rather
  than a truncated model.
- **The layout is metro-map's, reused as a library** (`metro-map-core`), run
  once over every variant — which is what lets a station stay put as the slider
  moves. `rankTiebreak` defaults to `frequency` here, as on the metro map's own
  OC-DFG basis.
- **Extraction bounded by the per-type distance field.** An object belongs to
  a root's execution exactly when it sits at that root's *nearest* distance for
  its own type, and one multi-source BFS per object type gives every one of
  those distances up front. The per-root search then only descends as deep as
  the furthest type actually needs, and only looks up the types still
  outstanding at that last level — 0.2s instead of 213s for the 7 819
  item-rooted executions of the order-management sample, with a bit-identical
  result (`check.py` asserts the agreement against the plain per-root search on
  randomised logs). Stdlib only; no numpy, no scipy.
- **The ▶/■ boundary-split gateway is attributed through its own boundary.**
  When several activities start or end one object type's lifecycle, the layout
  splices a synthetic XOR gateway in front of the marker and reroutes those
  terminus arcs through it. Those arcs are the same arcs, so they carry the
  same variant — without that, 31 of the order-management sample's 210 arcs
  came out unattributed and (by the always-visible fallback) showed at every
  slider position. `cargo test` now asserts total attribution coverage, and
  its fixture asserts that it still produces a boundary split at all.
- **`serialize_maps_as_objects`.** The payload is assembled as a
  `serde_json::Value`, and `serde_wasm_bindgen`'s default serializer turns a
  serde map into a JS `Map` — which clones fine and fails silently: the host
  found no `stats` to copy into the artifact's meta, and the inline value
  would have persisted as `{}`.
- **Honest numbers.** Arc frequencies, mean waits and station counts are
  re-derived per slider position from sparse per-variant tables, so a label
  always counts the variants actually on screen — not the whole log.
