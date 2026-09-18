# Changelog

## 0.19.5

- **Laying out a dense map is another 3x faster: the full-detail Order Management map (18 activities, 208 arcs) drops from ~650 ms to ~230 ms of blocked main thread.** Two hot paths in the shared `metro-layout` package, neither of which moves a pixel.
- **Crossing minimisation decided a swap by recounting, not by subtracting.** The transpose pass in `relayout.ts` tries every adjacent pair in every layer and, for each candidate, re-counted all crossings between that layer and both its neighbours — O(E^2) in the edges between two layers, per candidate. But swapping two adjacent nodes moves no other node, so every crossing not involving one of the two is identical before and after and cancels: the verdict only needs the pairs with one edge at each of them, read off their own neighbour positions in O(deg v + deg w). On Order Management that was 56,772 full recounts and ~99M inversion tests, and it was essentially the whole cost of ranking and ordering: 293 ms to 27 ms.
- **`findOverlaps` sorted every segment of the whole drawing on every call, to then read one window of it.** The refinement asks it 2,863 times while changing a handful of edges per call; each call decomposed all 208 polylines and sorted the resulting ~754 segments by line offset. Measured over one map: 84 ms building segments, 202 ms sorting them, 61 ms actually scanning. The decomposition of an unchanged polyline is now cached on the polyline itself, and the sort is replaced by offset bucketing — a pair within tolerance shares a bucket or sits in one beside it, which is the same superset filter the sorted window was, with the exact offset test stated in `pair` rather than implied by the enumeration order. 370 ms to ~195 ms.
- Verified output-identical, not merely still-passing: `npm run check`'s output over its 27 graphs and the eight Logistics pipelines is byte-for-byte what it was (same 234/299 crossing totals, same 1,401), and on the three fixtures behind the metro-map paper every geometric measure is unchanged — crossings 4,184 / 158 / 113, zero cross-type collinear overlap, routed length 619,356 / 30,790 / 18,825 px, 1,560 bends, 5255x4926 bounding box.
- What is left is smaller and no longer a scalability story: `findOverlaps` still rebuilds its segment array and bucket index per call when only a few edges moved, which an incremental index would remove.

## 0.19.4

- Sink markers now center under the edges that actually target them after final track allocation. A busy column could previously fool the column/rank anchoring heuristic into treating an unrelated segment as another line touching the sink, leaving the real arrival offset from its stop circle.
- Sink alignment uses graph endpoint identity and retains node, caption, and unrelated-route clearance checks. A regression covers an arrival track offset from its sink's nominal lane.

## 0.19.3

- A centered join's single outgoing branch now keeps the diamond's final x-position for its whole initial vertical run. It no longer reconnects briefly to the pre-centering lane and then reverses toward its target, which rounding exaggerated into an S-shaped hook.
- The gateway regression now asserts that both the departure endpoint and the following point remain on the adjusted centerline.

## 0.19.2

- Join diamonds now sit at the midpoint of their incoming track span instead of remaining anchored to one incoming arc. The outgoing branch uses the same adjusted center, keeping the diamond and its departure aligned.
- The shared router regression now covers an asymmetric two-in/one-out gateway and asserts both the centered node position and the outgoing attachment.

## 0.19.1

- Incoming branches at a join gateway now keep their allocated tracks through a vertical final approach and stop just above the diamond's bounding box. They no longer funnel together into overlapping, slanted arrowheads at the diamond's top point. Split gateways continue to fan out from the marker itself.
- The shared router check now asserts that join branches remain distinct, arrive vertically, and terminate at the gateway's top bounding edge.

## 0.19.0

- **The layout is now a package, `metro-layout`, shared with the Variant Metro plugin instead of copied into it.** The Rust half of these two plugins has shared one implementation from the start (`crates/metro-map-core`, which Variant Metro path-depends on); the TypeScript half — re-laying out the filtered subgraph, allocating tracks, routing, and refining the drawn geometry — existed twice, and the copies had drifted badly. `view-src/packages/metro-layout` is now the single implementation, and the checks are shared with it: `npm run check` in either plugin runs the same 27-graph invariant suite first, and both `package.sh` gate on it.
- Nothing about this plugin's own drawing changed in the move. What moved: `relayout.ts`, `router.ts`, `route.ts`, `geometry.ts`, `nodeGeometry.ts`, the router check, and the node-footprint constants that used to live beside the React components that draw them (the one thing the router and the renderer may never disagree about). What stayed: the complexity slider, colours, labels, and every component.
- **Start markers now sit directly above the activity they feed, whatever the stability setting.** The ranking is a single as-soon-as-possible pass: a node lands on its floor and is pushed down only by its predecessors, so a node with no predecessor never moves at all. With "Preserve layout stability" on, that floor is the discovered model's own rank and the model already puts an object type's ▶ marker one row above its first activity — so this was invisible. With stability off the floor is one shared value per connected component, and *every* marker collapsed onto it: six object types starting side by side on the top row however far apart the activities they actually feed were.
- A start marker is an annotation, not a process step, so it has no rank of its own to defend: it is now pulled down to exactly one rank above its earliest successor, derived from the visible topology alone. This only ever lowers a node, so the stability guarantee — adding detail pushes a node down, never reshuffles — is untouched, and with stability on a marker still can never rise above where the full model put it. Verified on Logistics: with stability off, the six ▶ markers move from ranks 0/0/0/0/0/0 to 0/0/1/2/3/5, which is exactly where stability-on puts them, without consulting the full model.
- The file's own header has claimed "ALAP roots" as part of this pass since it was written, and no such step existed. It does now — for markers. Applying it to *every* root was tried first and rejected: a station that became a root only because the slider hid its predecessors still has a real position, and dragging it down to meet its successor moves a genuine hub through rows that unrelated long edges are routed past. `logistics.check.ts` caught that immediately as arcs cutting through node footprints.
- **The three baselined drawn overlaps are gone, so the allowance is gone with them.** 0.17.6 had to exempt three straight-track collisions in the fresh/dots 38-of-77 Logistics view; ALAP start markers removed all three. All eight Logistics pipelines are now asserted overlap-free outright rather than against a list.
- Stability-on output is unchanged, byte for byte: same crossing counts on all four stable Logistics pipelines and the same 234 across the randomised pipeline block.

## 0.18.2

- **The standby screen no longer labels its three interchanges.** The names were legible enough once haloed, but they were the one thing on that screen that could be read as the map being computed — real station names, in a panel whose entire job is to say your stations are not ready yet. The larger interchange rings stay, which keeps the Budapest shape recognisable without naming anything.

## 0.18.1

- **The long wait before a large map appears is 30–40× shorter.** Order Management (18 activities, 105 arcs, station captions on) took ~2.9 s of blocked main thread to lay out; it now takes ~70 ms. This is the wait 0.18.0 put the standby animation in front of — the animation stays, but on maps this size it barely gets to show.
- Profiled the whole view-side pipeline stage by stage on four real maps. Essentially all of it was in `refineDrawing`, and within that in the overlap verifier it calls tens of thousands of times: `findOverlaps` compared every pair of segments in the drawing, and asked the "are these the same metro line?" predicate about each pair before any of the cheap geometric tests.
- Four changes, none of which moves a single pixel:
  - `findOverlaps` now walks the segments in order of their line offset and stops each scan as soon as it leaves the tolerance window, instead of testing all O(n²) pairs; the survivors are put back into the original pair order, so the returned list is unchanged. The merge predicate is asked last, and memoised.
  - A proposal in the refinement only ever needs the overlaps that touch an edge it just moved, so it now asks for exactly those (`findOverlaps`' new `restrictTo`) rather than for every overlap in the drawing and then discarding almost all of them. It also reuses one scratch copy of the drawing instead of cloning all 105 polylines per proposal, and skips a proposed track position it has already tried.
  - `nodeIntersections` resolves each node's box once per call and skips any node whose bounds cannot meet the polyline's; the innermost slab test no longer allocates an array per call.
  - `relayoutVisible`'s transpose pass carries each layer's crossing count forward instead of recounting it per adjacent pair, and a swap rewrites two positions rather than every node's.
- `plugin.tsx` builds the router's node/edge arrays once and shares them across the pitch, routing and drawing stages instead of rebuilding them three times. (This was never the bottleneck — it measured about 0.1 ms — but there is no reason to pay it.)
- Verified output-identical, not merely still-passing: the full drawing (every polyline, node x, chamfer cut, residual overlap and crossing count) hashes identically across four real maps × two station styles × four detail levels × stability on/off, and `npm run check`'s own output over its 27 graphs is byte-for-byte what it was. That check is itself 2.4× faster now.

## 0.18.0

- **The two long waits are no longer a blank screen.** Discovering a metro map, and then drawing a large one, both used to show nothing — the first a top-bar progress bar with no panel at all, the second a panel that stayed entirely white while the view laid the graph out. Both now show an animated schematic of the Budapest metro, with trains that run station to station and wait at each one, plus whatever the run is actually reporting ("120,000 / 250,000 events").
- The view opts into the host's run-bound live preview (`livePreview`), so its panel now opens the moment discovery starts rather than a minute later, and the top-bar indicator has a **Cancel** button for as long as the run lasts. Both are host changes; this version is what makes the metro map use them.
- Every moving part of that screen is a CSS animation on `transform`/`opacity` of an HTML element, never SVG animation or a `requestAnimationFrame` loop. The second wait *is* the main thread being blocked by the layout pass, so anything needing the main thread would freeze on its first frame — exactly when the animation has to keep going. Verified against a deliberately blocked main thread: with JavaScript unable to run for 5.1 seconds, the trains kept moving.
- The loader fades in after 250ms, so a map small enough to lay out immediately never flashes it.
- **Fixed a latent race in how this view receives its saved settings.** The host answers the plugin handshake with one burst (resize, theme, params), and `on()` keeps a single handler per event, so a handler registered from a React effect only worked because the handshake happened in that same effect. It no longer does — the standby screen has to be up and handshaken before the layout pass starts, frames before the component that wants the params exists. All host handlers are now registered at module scope, before the handshake, so nothing in the burst can arrive before there is something to receive it.
- The M3 line is drawn in a lighter blue on a dark background. The official colour is dark enough to all but vanish there, and the point of using the real line colours is that they stay recognisable.

## 0.17.6

- Refine final drawing geometry without changing activity ranks or frequency tie-break: align short unbranched source tails to their arrival ports when clearance permits, removing unnecessary sparse-view bends.
- Detour obstructed interior vertical runs around actual node footprints and sink captions. Gateway branches now remain separate up to the marker; ordinary station trunks are preserved.
- Use per-corner chamfer limits in the renderer and checks, removing overlapping diagonal sections without flattening every corner in the map.
- Add the Logistics fixture and checks at 14/77 and 38/77 in both station styles, with stability on/off. Three existing straight-track overlaps remain explicitly baselined in the 38/77 dots view with stability off; this is not a general overlap-free guarantee.

## 0.17.5

- **The OC-DFG "N% shown" readout was frequency-weighted, not a plain arc count — so it could read e.g. "85% shown" next to "8 / 22 arcs", which looks like a mismatch rather than two views of the same number.** The top-N-per-object-type filter already keeps the busiest arcs first, so weighting by traffic instead of count always reads much higher than the arc-count fraction beside it. `pct` is now a plain `shown / total` arc count, matching the "X / Y arcs" readout right next to it — and matching 0.17.4's own seed target, which already picks the default slider position by arc count, not traffic. Both now agree.

## 0.17.4

- **Corrected 0.17.2's "detail slider defaults to 50%": it meant 50% of the slider's own numeric scale, not 50% of arcs actually shown — for a graph with several object types of very different sizes those are quite different things** (e.g. one object type with 70 arcs and another with 4: the slider's own scale tops out at 70, so "50% of the scale" picked position 35 on that axis, which — combined with the other, much shorter type — actually showed nowhere near half the graph's arcs). The seed now instead searches for whichever slider position first brings the *combined arc count* to about half of every arc in the graph (e.g. 70 arcs total → shows ~35), regardless of how many object types there are or how unevenly sized they are.
- Verified with the exact "70 arcs, one object type" example plus several unevenly-split multi-type cases: every one now lands at or just above half of the true total arc count.

## 0.17.3

- **Fixed a flicker on "Animate flow" for a line's first/last (dashed) edge.** Those edges draw a static `8 4` dash pattern to mark "first edge out of the start / last edge into the end"; the flow animation draws its own independent travelling dash (a small pulse via `stroke-dashoffset`) on top. Two competing dash patterns on the same path beat against each other as their gaps drift in and out of phase — visible as dithering, worst on exactly these already-dashed edges. Fixed by drawing the base line solid whenever "Animate flow" is on (the dashed convention only matters as a static cue; the moving pulse already reads as motion without it).
- Verified with a harness rendering the real `MetroEdge` component directly: confirmed the base line's `stroke-dasharray` is `8 4` when not animating, `none` (solid) when animating, and unaffected for an edge that wasn't dashed to begin with.

## 0.17.2

- **"Rank tie-break" (OC-DFG discovery) now defaults to "frequency"**, not "structural" — the busier direction of a cross-type merge-cycle wins by default, rather than an arbitrary station-name accident. Still switchable back to "structural" per discovery.
- **The OC-DFG detail slider now opens at roughly the middle of its own range by default** (previously it grew as far as it could while keeping the combined arc count under a fixed cap of 22, which usually landed nowhere near the middle). It still never opens busier than that same 22-arc sparse cap on an unusually busy log — only the *target* changed, not the safety ceiling.
- **The legend panel is now titled "Objects"**, not "Lines" — matches the vocabulary used everywhere else in the view (object types, not "lines").
- **Removed the legend's slider/click-to-highlight explanation text** ("The slider keeps the busiest arcs...", "Click a line or a station... to highlight it.") — the All/None/only links and the slider's own coverage readout already make this self-evident, and shorter is better here.

## 0.17.1

- **A station shared by several object types (an "interchange") rendered with square corners in the "labels" style, while a single-type station right next to it rendered rounded.** Both declared the same `border-radius: 8` — the difference was that a multi-type station's ring is a multi-colour `conic-gradient`, which needs CSS `border-image` to paint (a plain `border-color` can't show more than one colour), and `border-image` ignores `border-radius` in every browser, `overflow: hidden` included. Fixed by drawing the ring as a `background` behind an inset content `div` instead — the same technique the "dots" style already used for its own interchange ring — so both a single- and multi-type station's border radius is a real CSS `border-radius` all the way round, no `border-image` involved at all.
- Verified with a harness rendering the real `StationNode` component standalone (single-type vs. a 3-type interchange) at 4x zoom: both round identically, all four corners, ring colours included.

## 0.17.0

- **New "Rank tie-break" parameter on "Discover metro map (OC-DFG)": "structural" (default, unchanged) or "frequency".**
  Ranking (which row a station lands on) needs the whole merged model to be acyclic, but two object types can each flow acyclically through their own lifecycle and still form a cycle only once merged, purely from sharing stations — something has to give, and until now *which* direction gave way was decided by a single greedy DFS pass: fast and deterministic, but an accident of station-name sort order, unrelated to which direction is actually the real flow. A busy through-line could lose to a rare cross-type wraparound just as easily as the other way round — diagnosed from a real map where a station's own high-traffic predecessor ranked *below* it because a much rarer edge from an unrelated object type happened to share the same two stations.
  "Frequency" mode instead always keeps the *busier* direction and discounts the *rarer* one of each such cycle (ties still broken deterministically by station id), so a station's dominant through-line reliably outranks an occasional detour instead of an arbitrary coin flip between the two. Off by default — every existing diagram keeps ranking exactly as before; opt in per discovery from the action's own parameters. Only meaningful on the directly-follows basis (the Petri-net basis has no frequencies to weigh by).
- Verified with a dedicated Rust unit test reproducing the exact failure shape (two object types, one high-frequency and one rare, sharing two stations in opposite directions): confirms `structural` mode still ranks the busy edge away (unchanged, regression-safe) and `frequency` mode keeps it in order instead. Full `cargo test --workspace`: 32/32 passing, no regressions.

## 0.16.10

- The overview minimap now starts **off** by default (it can still be
  toggled on from the button beside the Detail slider). It was defaulting
  to shown, adding a permanent corner overlay most sessions never needed.

## 0.16.9

- **The even-split tie-break added in 0.16.8 broke the tie by merge-key
  alone — arbitrary, but not innocuous: it could anchor a turn-back/rework
  loop at the station's exact centre instead of a genuine forward
  through-line, whenever the loop's object type happened to sort first.**
  Confirmed against a real station ("Load Truck", four converging groups:
  two forward through-lines and two self-loops) from its exact DOM
  measurements — the station rendered dead-centre in its *loop*, visibly
  off-centre from the two real lines passing through it. A rework
  detour has less claim to the centre than a real through-line, so the
  tie-break now prefers whichever of the two tied middle slots is a
  forward group over a turn-back/loop group, falling back to merge-key
  order only when both tied slots are the same kind (both forward, or
  both loops).
- Verified with a targeted repro matching the real station's exact
  4-group structure (two forward lines, two same/different-type loops):
  the forward group now lands at the exact centre; re-ran the full
  `npm run check` suite, all green, no regressions.

## 0.16.8

- **A genuine multi-type interchange (several distinct object types
  actually converging on one station) could leave the station looking
  "skewed" — none of its lines passing through its own exact centre —
  whenever an *even* number of groups shared its column.** The symmetric
  spread `router.ts` falls back to for these (correctly, when no single
  group is unambiguously "the" line — see 0.16.7) puts slots at
  `..., -1.5*gap, -0.5*gap, +0.5*gap, +1.5*gap, ...`: for an even count,
  the two middle slots straddle the centre and nothing lands on it,
  even though the spread's own average is exactly the node's position.
  Diagnosed from a real station's exact DOM measurements (node centre and
  three of its edges' `d` attributes matched a predicted 4-group,
  evenly-spaced arrangement to 0.1px). Fixed by forcing one of the two
  tied middle groups to anchor at the centre anyway when there's no
  unambiguous single line to prefer — the tie is broken by merge-key alone
  (arbitrary, but deterministic, so the same graph always resolves the
  same way).
- **Along the way, found and fixed a real pre-existing bug this exposed:**
  a column's own track count (`n`) was computed as the number of distinct
  *merge-key groups* sharing it, not the number of distinct *tracks*
  actually used — but `allocateSlots` legitimately reuses one track for
  two groups whose row-spans don't overlap, so a column could hold, say,
  three groups on only two real tracks. Every computation downstream of
  `n` (the spread's own width, and now the anchored reach) means "how many
  tracks", so counting groups instead let an anchored column's real reach
  quietly exceed what pass 2's inter-column clearance had been told to
  expect — caught as a genuine collinear overlap in the pipeline check
  suite's own fixed-seed graphs, not a hypothetical. Fixed by deriving `n`
  from the actual maximum slot index assigned, not from how many groups
  asked for one.
- Verified with two targeted repros (the even-split case, and a re-run of
  the exact fixed-seed graph the check suite caught the regression on) and
  the full `npm run check` suite: all green, no regressions, same
  already-documented residual.

## 0.16.7

- **A station's own straight through-line could still detach from the
  station by half a track gap, even after 0.16.6, whenever the only other
  thing sharing its column was that same station's own rework/self-loop —
  no second object type involved at all.** 0.16.6 only anchored a node's
  edge at its exact centre when *exactly one* group touched the node, so a
  plain through-chain sharing a column with its own self-loop (two groups:
  the ongoing flow, and the loop's separate excursion) still fell back to
  the old symmetric split, offsetting the main line for no good reason.
  Fixed by preferring a *forward* group as the anchor whenever there's
  exactly one, regardless of how many turn-back (rework) groups also touch
  — a rework loop is already a deliberate detour, drawn via its own side
  corridor precisely because it isn't the ongoing line, so it's the one
  that should yield. A genuine multi-type interchange (several distinct
  forward groups actually converging) still finds more than one and keeps
  the existing symmetric spread. Verified with a targeted repro (a plain
  through-chain plus its own self-loop, one object type, nothing else in
  the graph) and the full `npm run check` suite: no regressions, same
  already-documented residual.
- **Lines panel:** added "All" / "None" links and a per-line "only" link,
  so isolating one object type (or clearing back to everything) no longer
  needs one checkbox click per line — asked for specifically to make this
  kind of alignment debugging faster to set up.

## 0.16.6

- **A boundary marker's own single edge — or any node's straight
  through-line — could visibly detach from its own station by half a
  track gap, even though that node is pinned and never moves.** Diagnosed
  from precise devtools measurements: a node centred at flow-space x=0 with
  its own edge drawn at x=-7.5, exactly `LINE_SPACING / 2` for two tracks
  sharing that column. The cause: `router.ts`'s column-spread pass spreads
  every group sharing a pixel column *symmetrically* around the column's
  centre, with no way to know that one of those groups is the segment
  that actually terminates at the real (pinned) node living there — which
  has nowhere else to be, unlike a track that's merely passing through or
  coincidentally rounds to the same column. Fixed by anchoring that one
  group's slot at offset 0 (the node's own centre) whenever it's the
  *only* group genuinely touching the node, and shifting every other slot
  in that column by the same constant — a pure translation, so every
  pairwise distance between tracks (and the overlap guarantee) is exactly
  as before, just centred differently. A column with two or more distinct
  groups genuinely converging on one node (a real multi-type interchange)
  keeps the existing symmetric spread, since no single one of them is more
  entitled to the centre than another. Verified with a targeted repro
  (a boundary + an unrelated same-column coincidence elsewhere in the
  diagram) and the full `npm run check` suite: no regressions, same
  already-documented residual, unchanged.

## 0.16.5

- **A station could land at the very first rank, tied with the true start
  of the process, even though a real forward edge should have pushed it
  much later — most visible on a station that both continues forward and
  is reworked back to from downstream (e.g. "Weigh" and "Place in Stock"
  cycling through Forklift rework, with Container's own onward flow
  threaded through the same two stations).** 0.16.4's topological tie-break
  (`topoPos`) was itself built from *every* visible edge, rework loops
  included — but a rework edge is exactly what makes this graph cyclic, and
  feeding a cycle into a topological sort forces it to arbitrarily "break"
  the cycle somewhere. Which edge lost that coin flip was undirected by
  anything real, so it could just as easily be a perfectly ordinary,
  perfectly acyclic forward edge a few hops away — which is what then
  silently vanished as a ranking constraint, leaving its target stuck at
  the shared component floor. Fixed by building `topoPos` only from edges
  the model's own full-graph rank already calls forward (the same test the
  precedence loop right below it applies) — a genuine rework edge no longer
  gets a vote in the tie-break at all, so it can no longer cost an
  unrelated, perfectly acyclic edge its say in the ranking.
- Investigated, not a bug: a lone self-loop in an otherwise short, sparse
  single-object-type chain (e.g. Container-only, low detail) can look
  strikingly lopsided — the loop reaches out by roughly one full lane pitch
  to clear its own station, which reads as disproportionately wide next to
  small "dots"-style stations with nothing on their far side to balance the
  composition. Traced this precisely (a standalone repro of the exact
  6-edge subgraph, both `preserveStability` values): every station sits at
  the identical lane already, and the loop's reach is the minimum a single
  lane pitch requires, not an inflated or misplaced value. This is a
  genuine, open aesthetic question about small/sparse diagrams, not a
  mispositioned node — left as-is pending a deliberate design decision.

## 0.16.4

- **An object type's own end-of-life marker could land beside its start
  marker at the very top of the diagram, instead of below wherever its
  last activity actually is — needing a huge detour to connect the two —
  and, separately, later stations in a chain could drift further and
  further right of where their own arcs actually terminate.** Both were the
  same root cause: `relayout.ts`'s ranking pass constrains a node's rank
  using its real predecessors, but only when a same-node total order
  (`orderKey`) agrees the edge runs forward — a safety gate against a
  genuine cycle in the model. With "Preserve layout stability" off, two
  nodes in the same visible component with no lane hint (every node, in
  that mode) tied on every part of that order except the last: a plain
  alphabetical comparison of their ids. An id has no relationship to which
  of two nodes a real edge says comes first, so whenever it disagreed with
  a real edge's own direction, that edge was silently dropped as a ranking
  constraint — its target stuck at the shared floor rank instead of pushed
  below its source. Fixed by tie-breaking with a real topological order (a
  DFS-postorder-reversed sort over the visible edges) instead of id — it
  agrees with a real edge's direction everywhere except inside an actual
  cycle, which is exactly the case the gate exists to fall back on.
  Verified with a targeted repro of the end-marker case and the full
  `npm run check` suite: previously the fresh-mode pipeline block carried
  one already-documented residual overlap (present since 0.16.0) — this
  fix removes it outright rather than merely shifting it, and total
  fresh-mode crossings across that block dropped from 326 to 305.

## 0.16.3

- **A boundary marker (an object type's start/end terminus) could sit
  visibly offset from its own sole successor or predecessor station,
  even with nothing else pulling on it and "Preserve layout stability"
  off.** The coordinate-relaxation pass in `relayout.ts` already converges
  a degree-1 boundary marker onto exactly its one neighbour's position —
  nothing else has any opinion on where it goes. But a later pass
  (`MIN_ADJACENT_RANK_GAP`, added to keep two *unrelated* nodes at adjacent
  ranks from drawing their own local approach/departure segments on top of
  each other) pooled *every* node at two adjacent ranks together and forced
  a uniform minimum lane-gap between neighbours in position order, with no
  exemption for a pair that is directly joined by a visible edge — where
  sharing the exact same lane is precisely the correct, desired drawing (one
  straight line down), not a collision to prevent. Fixed by zeroing the
  required gap for exactly the pair a visible edge connects; every other
  adjacent-rank pair keeps the normal 0.5-lane minimum.
- Investigated, but not changed this release: the same-object-type "several
  arcs converging on a station" merge deliberately excludes a turn-back
  (rework loop) edge from ever sharing a track with anything — including
  its own type's forward arrival at the same station, which is why a loop's
  return arrow can draw as a visibly separate parallel line right next to
  the forward line of the same colour. Making that specific case merge
  turns out to need `router.check.ts`'s own `buildMayMerge` invariant
  (which currently hard-excludes any turn-back edge from ever validly
  overlapping anything) to be deliberately revised alongside it — a bigger,
  riskier change than this release makes. A first attempt confirmed the
  risk is real: it broke 52 of the suite's checks by letting a loop's
  approach merge into its *entire* transitive same-type run rather than
  just the one arrival it actually shares, so it was reverted rather than
  shipped half-verified.

## 0.16.2

- **A short, purely local rework loop (e.g. a self-loop on one early
  station) could draw absurdly wide, detouring almost the full width of the
  diagram — worst with "Preserve layout stability" off, on a filtered view
  made of several disconnected components.** A turn-back edge's corridor
  used to be placed clear of *every node in the whole routed graph*, so even
  a loop spanning just one rank had to travel out past the single farthest
  node anywhere on the canvas — including one in a completely unrelated,
  disconnected component, since ranks (and their shared row of pixels) are
  canvas-wide even when the nodes occupying them are not. Fixed by scoping
  each turn-back edge's corridor to only the nodes it could actually run
  behind: its own connected component (by any edge, not just its own
  object type), restricted to the ranks its own excursion actually passes
  through. A loop confined to one or two ranks now only has to clear the
  handful of nodes at those ranks in its own component, not the entire
  diagram. Verified with a targeted two-component repro (mirroring what a
  filtered, disconnected view produces) and the full `npm run check` suite,
  both `preserveStability` modes — the same already-documented residual
  (see 0.16.0) is unaffected, and total measured crossings across the
  pipeline block *dropped* (314→235 stable, 400→334 fresh) as a side effect
  of edges now routing tighter instead of via a shared, far-flung corridor.

## 0.16.1

- **With "Preserve layout stability" off, an early activity and a much
  later one could land on the same row, or in the wrong relative order
  entirely, once whatever used to connect them was filtered out.** 0.16.0's
  "fresh" mode zeroed out every full-graph rank/lane hint uniformly, which
  conflated two different things: *stability across slider moves* (which
  the cited paper's finding is actually about, and which this mode should
  drop) and *correctness of relative time order* (a fact about the process,
  independent of what is currently hidden, which should never be
  discarded). Two activities with no path between them in the *currently
  visible* graph fell back to an arbitrary alphabetical tie-break, with
  nothing left to say which one the process actually reaches first.
  Fixed by computing the connected components of the visible graph and
  ordering *components* against each other by the full model's own rank —
  still a fact, not an anchor — while a node's exact position *within* its
  own component remains computed fresh from only the visible topology, with
  no floor, exactly as this mode intends. A rework-loop edge's own backward
  check was fixed the same way: whether a specific edge loops backward is
  also a fact about the process, not something this mode should forget.
- `npm run check`'s pipeline block (both `preserveStability` values, 12
  seeds each) is unaffected in the default mode and remains fully gated;
  the "fresh" mode's own already-documented, reported-not-gated residual
  (see 0.16.0) still occurs, at a different position in the one seed it
  affects, since the rank values it depends on changed.

## 0.16.0

- **New: "Preserve layout stability" toggle, on by default.** Until now,
  the complexity slider always laid out the visible subgraph as a monotone
  refinement of the *full, unfiltered* model's own rank and lane — a
  station never reshuffles as detail is added, only ever settles further
  down. That default reflects the common assumption that a stable mental
  map helps process analysis, but Häge & Rehse, "Mental Maps in Process
  Mining: Does Stabilizing DFGs Improve Process Analysis Performance?"
  (BPM 2025), found no positive effect from stabilisation in their study,
  and a significant negative one on one of their measures. Switching the
  toggle off computes rank and lane fresh from only the currently visible
  stations and arcs on every slider move, as if the hidden ones never
  existed, instead of anchoring to the full model. Exposed both as a
  checkbox in the view's own controls panel and as a manifest-declared
  view parameter (so the host's Inspector can set it too).
- The two places `relayoutVisible` reads a hint from the full, unfiltered
  model — the rank floor and the initial lane seed — are now the only two
  places gated by the new option; everything downstream (crossing
  minimisation, coordinate relaxation, object-type trunks, component
  packing, the adjacent-rank nudge from 0.15.5) already worked from the
  visible topology alone and needed no change.
- **Known trade-off of turning stability off, reported not hidden:**
  removing the rank floor tends to compress a filtered view into fewer
  ranks, which means more edges span several ranks at once — exactly the
  shape of 0.15.5's already-documented three-body residual (two
  independently busy stations bridged by one long, unbent waypoint run
  that together demand more room than exists between them). Disabling
  stability makes that existing, accepted rarity more frequent; it is not
  a new defect, and `npm run check`'s own pipeline block now runs both
  modes on the same 12 seeds, reporting any such case for the "fresh" mode
  as a visible note rather than gating on it, exactly as it already treats
  crossing counts — the default, gated, `preserveStability: true` path is
  unaffected and still fully asserted.

## 0.15.5

- **A node's own edges could resolve to a different column than the node
  itself, visibly detaching the line from its own station.** A node is
  always drawn at its own nominal lane position; the router's cross-column
  fix from the previous release could still nudge an *edge's* column away
  from that same position when a nearby column needed room, since nothing
  distinguished "a column with a real node in it" from an ordinary
  dummy-waypoint column. Every column containing a real node is now pinned
  at its own position unconditionally — never moved, since the node itself
  never moves either. Only dummy columns are still free to shift clear of a
  neighbour.
- **Pinning surfaced a further gap in how a dummy column clears the columns
  around it, fixed properly rather than patched twice more:**
  - a dummy sitting to the *left* of a pinned column needed to clear it too,
    not only whatever preceded the dummy — a purely left-to-right sweep
    never saw a fixed obstacle coming from the right. Replaced with two
    directional passes (left-to-right and right-to-left) combined, so a
    dummy clears whichever side actually constrains it;
  - separation was being demanded between *any* two nominally-close columns,
    even when their row spans never overlap — two stations several ranks
    apart never share a channel, however close their columns land in X.
    Demanding separation anyway could trap a dummy between two obstacles
    that were never really in conflict with each other. Column separation
    is now required only between columns whose row spans actually overlap,
    the same principle the router already applies *within* one column.
- Two different real nodes at *adjacent* ranks can end up placed only a
  fraction of a lane apart by the layout pass, sharing the channel between
  their ranks for their own local approach/departure segments — nothing a
  routing pass can fix once drawing starts, since neither node may move.
  `relayoutVisible` now nudges apart any two adjacent-rank nodes placed
  closer than a conservative minimum, reusing its own proven
  order-preserving primitive rather than a new ad hoc heuristic.
- A rare residual remains, found only through stress testing well beyond
  what this package's own `npm run check` exercises (up to 28 edges across
  20 nodes and 8 ranks, four station-width variants, over a hundred random
  seeds): two independently busy real nodes, not necessarily at adjacent
  ranks, connected by one long unbent waypoint run that happens to occupy
  both their row spans at once, can together demand more room than actually
  exists between them — a genuine three-way conflict no repositioning of
  the dummy alone can fully resolve, since neither pinned node may move. The
  resolution now at least minimises the worse of the two resulting
  shortfalls rather than always favouring one side. A further attempt to
  eliminate this by letting a busy node's own internal track spacing yield
  when a neighbour genuinely needs the room was tried and reverted: it
  regressed this package's own gating checks by relocating the conflict
  into a node's own different-type tracks instead of removing it. `npm run
  check`'s own 39 checks (27 randomised graphs, hand-built fixtures, and 12
  real-pipeline graphs, all on both geometries) all pass; this residual
  needs a deeper fix — most likely account for the edges an unbent waypoint
  run will bridge when placing real nodes in `relayoutVisible`, not another
  router-side patch — tracked as a follow-up rather than rushed.

## 0.15.4

- **Two genuinely different lines could still be drawn close enough to
  overlap visually, at a small "dot" station with several different-type
  turn-back edges converging on it.** This is a pre-existing tension, not
  new today: a column's spread has always been capped to stay inside its
  own node's width, so every arrowhead lands on it — but a small station
  (as little as 26px across) divided across even 4-5 converging tracks
  produces a per-track gap *below* the line's own stroke width, so two
  different-coloured lines physically overlap on screen even though their
  centrelines are formally distinct. Removing the old fixed 4px floor in an
  earlier fix fully exposed this rather than partially masking it. Fixed by
  letting the spread exceed the node's own width when — and only when — the
  node is too narrow for a legible gap between its own converging tracks;
  arrowheads then land just outside the node's edge rather than forcing an
  illegible squeeze. The other bound (never spreading past the lane pitch,
  which is what actually stops two different lanes' columns bleeding into
  each other) is never relaxed.
- `npm run check`'s real-pipeline block now sizes its lane pitch the same
  way `plugin.tsx` actually does (via `peakTrackDemand`) instead of a fixed
  value, so it tests the configuration that ships, not a more pitch-starved
  one. Verified with a dedicated script measuring the minimum gap between
  any two genuinely different (non-mergeable) lines, not only whether they
  formally overlap — this is what caught the bug above, since `npm run
  check` itself is blind to a gap that is small but not zero.

## 0.15.3

- **A variable arc's two rails are easier to tell apart from an ordinary
  single line.** The gap of background that has to read as "two lines, not
  one thick one" was only 3px (rail offset 2.5px, stroke 2px) — inside
  typical anti-aliasing/compression noise, so most variable arcs read as
  slightly thick rather than doubled, except on a long, dead-straight run
  where the two rails happened to separate visually. Widened the offset to
  3.5px (5px gap), still well inside one track's `LINE_SPACING` band so it
  cannot reach a neighbouring track.

## 0.15.2

- **0.15.1's fix for two nominally-close lane columns was itself broken, and
  is replaced here.** It merged every column transitively within reach of
  another into one shared allocation centred on their *mean* position —
  correct against the overlap invariant, but it could pull a whole chain of
  otherwise perfectly fine, well-separated lanes into one shared centre the
  moment any two neighbours in the chain happened to sit close together,
  dragging real stations' own lines far from their true position. In a real
  diagram this showed up as edges taking huge, sweeping detours around
  almost the entire map to reach a station sitting right next to their own
  source. Replaced with a left-to-right sweep that nudges a column's centre
  only as far right as needed to clear whichever already-settled column
  immediately precedes it — the minimum correction for an actual conflict,
  never a wholesale re-centring of unrelated lanes. `npm run check` (which
  only asserts the overlap invariant) passed on the broken version too; this
  was caught by comparing each edge's drawn horizontal excursion against its
  diagram's own lane span before treating the fix as done.

## 0.15.1

- **Variable arcs are represented, not silently dropped.** An OCPN arc
  flagged `variable` (a single firing consuming/producing more than one
  token of that object type) now marks the collapsed metro-map edge it
  contributes to, even across a collapsed wire — OR'd across every arc on
  the path, not just the one nearest the station. Drawn as two parallel
  rails instead of one solid line. Always `false` on the OC-DFG basis,
  which has no arc/token structure to derive it from.
- **The router's "no cross-type collinear overlap" guarantee is now
  unconditional, not best-effort.** Two independent gaps closed:
  - A column's own track spacing used to fall back to a fixed 4px floor
    once a busy column's ideal spacing dropped below it — which could let
    that column's drawn spread exceed the bound it was computed to respect,
    bleeding into the next lane's own band. The floor is gone; lane pitch is
    now sized to the diagram's actual peak track demand instead (see
    `peakTrackDemand`), so a busy diagram gets more room rather than an
    unsafe fallback.
  - The render-time corner chamfer (`MetroEdge.tsx`) used a fixed cut length
    with no knowledge of how close a neighbouring track sits — for two
    adjacent tracks whose corners happened to land near a 45° relationship
    (routine, since column and channel gaps are usually similar), each
    edge's own chamfer could reach far enough to become collinear with its
    neighbour's. The cut is now bounded by the smallest track gap the
    router actually used (`safeChamferCut`), so it can never reach past its
    own track's share of that gap.
- **Two different nominal lane columns close enough together to reach each
  other are now allocated tracks jointly, not independently.** Each
  column's own spread was already bounded (previous point), but two
  *different* columns whose nominal centres sit closer together than the
  sum of their own worst-case spreads could still have their independent
  offsets collide — this is what a real diagram's dummy-waypoint column
  landing a few px from an unrelated lane's own column actually was.
  Columns within that reach of each other are now clustered into one
  shared `allocateSlots` call, centred on the cluster's own mean position,
  exactly generalizing the single-column guarantee to the group.
- `findOverlaps` generalized from axis-aligned segments to arbitrary slopes,
  and `npm run check` now asserts it against the *chamfered* geometry
  `MetroEdge.tsx` actually draws, not only the pre-chamfer polyline — and
  against the real `relayoutVisible → routeAll` pipeline, not only
  hand-built router fixtures. This is what caught both gaps above; every
  synthetic, hand-built and pipeline-derived check now passes on both
  geometries, with zero known remaining counterexamples.

## 0.15.0

- **Uses the host's new conditional-parameter API.** "Edge labels" now
  declares `showWhen: { artifactMeta: "basis", equals: "directlyFollows" }`,
  so the host hides it in the **inspector** on a Petri-net map — previously
  only the panel's own copy could be hidden, and the inspector still showed a
  control that could never do anything.
- The map's payload now carries a `stats` block (`basis`, `stations`, `arcs`,
  `objectTypes`). The host copies it into the artifact's `meta`, which is
  what the condition reads — and it populates the Statistics panel too.

## 0.14.3

- **The "Edge labels" section is gone entirely on a Petri-net map**, rather
  than shown disabled with a note. A Petri net's arcs carry no counts and no
  timestamps, so there is nothing to configure — and an explanation you
  cannot act on from that panel was just clutter.

## 0.14.2

- The Petri-net edge-label note is now one short line on the canvas; the full
  explanation stays on the parameter in the inspector, where there is room
  for it.

## 0.14.1

- **Clearer edge-label state on a Petri-net map.** The note used to read
  "Needs an OC-DFG map", which sounded like an instruction to add something
  to the map you were looking at — impossible, since the two bases are
  separate artifacts from separate actions. It now says plainly that a Petri
  net is a structural model carrying no counts or durations, and points at
  "Discover metro map (OC-DFG)" on the log as the way to get a labelled map.
  The Frequency and Performance options are disabled there rather than
  selectable-but-silently-empty.

## 0.14.0

**Performance labels.** The edge-label dropdown gains **Performance**: the
mean wait between the two activities, shown on each arc as `45s`, `12min`,
`3.4h`, `2.1d`.

The duration did not exist anywhere before — `core.discover.ocdfg` emitted
only a frequency per arc — so this reaches down the whole chain:

- **`core.discover.ocdfg` 0.2.0** now also computes `avgSecs` per arc
  (`AVG(date_diff('second', …))` over consecutive events per object). Null
  where the log has no usable timestamps.
- **metro-map's Rust** carries it through as `durationSecs`, averaged
  **weighted by frequency** so that collapsing several upstream arcs into one
  drawn edge still yields the correct mean (a plain average of means would
  not). Covered by a new `cargo test`.
- Station numbers stay frequency-only — a station count is not a duration —
  so they show in *Frequency* mode and are hidden in *Performance* mode.

*An OC-DFG map discovered before this needs re-discovering to pick up the
durations; the label falls back to blank rather than showing a wrong number.*

## 0.13.2

- **Two rework loops of one object type no longer merge.** Track sharing was
  keyed on object type alone, so two separate loops — or two arcs of one type
  that share no station at all — were drawn on top of each other, with their
  flow animations running in opposite directions. A "metro line" is now
  defined properly as a *connected run* of same-type arcs, and turn-back
  edges are always their own strand. The correctness check was tightened to
  the same definition, and it caught two further real cases.
- **A busy column can no longer bleed into its neighbour.** A column's lines
  are now capped to spread less than the lane pitch, so a turn-back corridor
  cannot end up sharing an x with a lane column.
- **Better horizontal placement.** The ordering pass was six barycentre
  sweeps that kept whatever the last one produced — but barycentre
  oscillates, so it could end on an arrangement worse than one it had already
  passed through, stranding unrelated activities far apart. It is now the
  median heuristic plus a transpose pass, keeping the best arrangement
  *measured*: **352 → 319 crossings** on the check's 12-graph benchmark.
- **"Show numbers" is now an "Edge labels" dropdown** (None / Frequency).
  *Performance (average duration) is not offered yet* — `core.discover.ocdfg`
  emits only a frequency per arc, so there is no duration to show; adding it
  needs a change to that discovery action.

## 0.13.1

**The layout now optimises for the filtered view, not the full graph.**

Ranks were taken verbatim from the discovered model so that nodes would not
jump around while dragging the slider. But stability does not require
freezing them — it only requires the filtered ranking to be a *monotone
refinement* of the model's. So the model's rank is now a **floor**, and
every visible edge additionally has to descend strictly.

That removes a compound defect: two activities the full graph happened to
co-rank stayed on one row, so an edge between them was drawn as a very long
horizontal — *and* the ordering pass skips same-row edges entirely, so the
barycenter step never learned the two nodes were related and let them drift
lanes apart. Both halves are gone; such a pair now sits directly above one
another. Adding detail can only push a node further down, never reshuffle,
so the map still stays stable as the slider moves.

- The detail slider is now **vertical**, + at the top and − at the bottom.
- The **Lines legend starts collapsed** — its line-width note was covering a
  good part of the canvas.

## 0.13.0

**The edge router is rewritten.** Line overlaps are now impossible by
construction rather than patched after the fact.

Every previous round of layout fixes added another local "nudge on
collision" rule. There were six of them and none knew what the others had
done, so each fix perturbed the inputs of the rest and the overlaps kept
coming back. All six are gone, replaced by one router with a single
occupancy model (`view-src/src/router.ts`):

- Nodes sit on a grid of rows and lanes. Every edge is an alternating chain
  of axis-aligned segments.
- A **vertical** segment is assigned a track in its lane **column**; a
  **horizontal** segment a track in the **channel** between two rows.
  Assignment is interval partitioning, so two segments may share a track
  only when their spans are disjoint — different object types can never end
  up collinear and overlapping.
- Segments of the *same* object type deliberately do share a track: that is
  the metro-map "one line" merge.
- Row heights now fall out of each channel's own track count, so a busy
  channel gets exactly the room it needs and a quiet one stays tight.

This also fixes, as consequences rather than special cases: arrowheads
colliding or hiding each other, lines running behind station boxes, loops
sharing a horizontal, and lines meeting an arrowhead on the diagonal.

**A correctness gate** ships with it (`npm run check`, wired into
`package.sh`): it asserts on 27 graphs, including 25 randomised ones, that
no two segments of different object types are collinear and overlapping.
Packaging fails if that is ever violated again.

## 0.12.5

- **Node "ports": a final pass that de-collides every arrowhead.** After all
  routing, each line that ends at a station is snapped to its own slot
  spread across the station's width, with a straight vertical run into the
  arrowhead. Two lines can no longer terminate at the same point (a loop's
  arrowhead can't hide a forward line's), and every arrowhead now sits just
  off the border instead of on it.
- Loop side corridors clear the node boxes; loops meet their arrowhead
  straight down; loops sharing an endpoint are staggered so they never run
  collinear.

## 0.12.2

More loop-routing fixes:

- **Loop corridors clear the node boxes.** The side corridor is now placed
  past the whole component's box extent, not just its lane centres, so a
  loop no longer runs behind a station.
- **A loop meets its arrowhead straight down.** A fixed vertical approach
  (~52 px, before the chamfer and arrowhead) is reserved, instead of the
  line coming in on the diagonal.
- **Loops sharing an endpoint never share a line.** Each loop's entry/exit
  point (per object type), its side corridor, and both of its horizontal
  segments are independently staggered — a rework loop's arrowhead can't
  land on the forward line's, and two loops' horizontals can't run
  collinear.

## 0.12.1

Layout structure, from feedback on a filtered OC-DFG:

- **Disconnected parts of the graph are packed side by side** in their own
  bands instead of drifting into (or overlapping) each other. A two-node
  fragment no longer strands itself far off to one side.
- **Self-loops are a small bump on one side of the activity**, not a sweep
  out to the edge of the map — a self-loop clears nothing, so it must not
  widen the whole diagram.
- **Rework loops sweep only their own component's side corridor**, on
  whichever side is nearer, staggered so several don't stack on one line.

## 0.12.0

- **A start ▶ / end ■ marker always carries exactly one line.** When the
  discovered model has a choice sitting right on the boundary (a source
  place feeding two first activities, or a sink fed by two last ones), a
  synthetic XOR gateway is now spliced between the marker and those steps —
  the marker no longer appears to fan out to several activities.
  *(wasm change — Remove + reinstall the plugin, an in-place update keeps
  the old compiled worker.)*

## 0.11.9

Convergence-routing cleanup (OC-DFG feedback):

- **Arrowheads no longer float off the activity.** The parallel run into a
  station and its arrowhead now use the exact same offset, so each line
  goes straight in and lands on the box — no steep fan-in that left the
  outer arrowheads hanging above the node.
- **No more wide gap between arrowheads.** Object-type lines converging on
  one activity now sit ~17–28 px apart (was up to ~110), a tight readable
  cluster centred on the station, each still with its own arrowhead.

## 0.11.8

- **Filtered views keep the process-time order.** The view re-ranked the
  visible subgraph from its own (filtered) edges, which could float a late
  activity — e.g. "package delivered" — up to the top the moment the slider
  hid its last visible predecessor. Ranks now come straight from the
  discovered model (which was ordered with every predecessor present),
  dense-packed to drop empty bands.
- **Distinct object types never share one arrowhead / one vertical**, even
  when the two activities are only one rank apart (no waypoint chain to
  carry the separation). Each type now takes its trunk offset straight into
  the node, clamped so the arrowhead still lands on the station.

## 0.11.7

- Terminus reconnection (0.11.6) now attaches a ▶ source to its line's
  *earliest* still-visible stop and a ■ sink to its *latest*, so the marker
  never comes in from the wrong side.

## 0.11.6

- **Petri-net basis: every line always keeps its start ▶ and end ■**, at any
  complexity-slider level. Previously a terminus only showed when its
  immediate neighbour survived the filter, so a line could fade out
  mid-diagram with no visible source/sink. The terminus now always shows; if
  the stop it connected to is hidden, a dashed synthetic edge links it to
  the nearest still-visible stop of that line (so the slider still hides
  mid-line detail — the terminus just doesn't float).

## 0.11.4

Follow-up to 0.11.3's bundling.

- **Distinct object types no longer collapse onto one vertical line.**
  0.11.3 snapped every same-type bundle onto the shared node's exact lane,
  so two or three different lines feeding the same activity ended up drawn
  on top of each other. Each object type now gets its own trunk lane
  (`TRUNK_SEP` apart), so distinct lines stay clearly parallel on the
  approach and only converge over the final hop into the activity.
- **Longer straight run between consecutive 45° turns** (`CHAMFER_CUT`
  17 → 28 px).
- **Flow animation pulse is bigger and a touch faster** — easier to see.

## 0.11.3

Routing polish from live feedback, plus a flow animation.

- **No bare 90° turns.** Every right-angle corner is now cut into two 45°
  corners with a short straight diagonal between them — the octilinear
  "Budapest" look applied consistently, including the horizontal trunks and
  the side-corridor loops that still had square corners.
- **Same-line edges merge before the station.** Several edges of the *same*
  object type feeding one station (or leaving it) are one metro line: they
  now collapse onto a single trunk and run overlapping into the node,
  joining it via one 45° diagonal each and merging gradually from the top,
  instead of arriving as a fan of separate parallel tracks with their own
  arrowheads. Distinct object types sharing a corridor still get their own
  offset lane.
- **New view toggle "Animate flow"** (off by default) — a travelling pulse
  along every line in its process direction.

## 0.11.2

Hardens `relayout.ts` against any malformed node id reaching the layout
pass (belt-and-braces on top of 0.11.1).

## 0.11.1

Defensive fix: an `OCMetroMap` produced by an early 0.10.x build could be
missing `kind` on its nodes (a serde bug, since fixed) and made the view
throw. Such payloads are now filtered out with a note to re-discover;
freshly discovered maps are unaffected.

## 0.11.0

Routing fixes from live feedback on the 0.10 OC-DFG map.

- **Top-in / bottom-out, always.** Every edge now leaves its source from the
  bottom and enters its target from the top. Forward edges already did;
  turn-back edges (rework loops, and OC-DFG self-loops) used to leave from
  the top and arrive from below. They now sweep out to a side corridor and
  back — the same convention, so the whole map reads top-to-bottom.
- **Self-loops are visible.** The old self-loop arc was drawn inside the
  station's own footprint (only the arrowhead poked out). It's now a proper
  side loop around the node.
- **Less bunching where lines converge.** Wider fan-out spacing (12 → 22 px)
  so several lines meeting at one station keep their arrowheads apart.
- **Frequency labels de-overlap.** With "Show numbers" on, colliding labels
  are nudged apart vertically instead of stacking on the same spot.
- Labelled-rectangle lane pitch widened a little more (168 → 176 px).

## 0.10.0

Two big additions, plus "clean by default" controls.

- **New action "Discover metro map (OC-DFG)".** The map can now be derived
  from an Object-Centric Directly-Follows Graph (`core.discover.ocdfg`, run
  transparently as an internal stage) instead of a Petri net. No ×/+ gateway
  diamonds on this basis — an OC-DFG cannot tell choice from concurrency, so
  branching just reads as a line splitting — but every station
  and arc carries its observed frequency. The existing Petri-net action is
  unchanged and stays the default; the view auto-adapts to whichever basis
  produced the map.
- **Complexity slider** (top-right panel), with a coverage readout
  (`shown / total`, `% shown`, activities/stations) and −/+ buttons:
  - OC-DFG basis: keeps the busiest arcs per object type (top-N), seeded
    deliberately sparse (~22 arcs) so a large log opens clean.
  - Petri-net basis: reveals the process core first and optional leaf
    activities last, via a structural leaf-peel order (`revealOrder`)
    computed in `metro-map-core`.
- **Stations as dots or labels.** A new view option (`stationStyle`) draws
  activities either as the current Budapest-metro interchange dots (default)
  or as labelled rectangles.
- **Show numbers** checkbox (view option `showNumbers`, default off): prints
  the observed frequency on every station, arc and terminus. Only has an
  effect on an OC-DFG-based map.
- Self-referential arcs (an activity directly following itself, OC-DFG only)
  are drawn as a small side loop instead of being dropped.
- **The slider now re-lays-out.** The complexity filter used to hide nodes
  from a layout computed on the whole graph, leaving the visible subset
  scattered or crushed into one column. `view-src/relayout.ts` now runs a
  small Sugiyama pass (ranking, ALAP roots, dummy waypoints, barycenter
  ordering, order-preserving coordinate relaxation) over just the visible
  subgraph, so a filtered map stays a compact, branching schematic.
- **Labelled-rectangle stations widen the layout.** Lane pitch is now
  bigger in `labels` mode so the boxes don't collide.

Internals: `build_metro_map` was split into a basis-specific front-end and a
shared, graph-shape-agnostic layout back-end (`assemble_metro_map`) that the
new `build_metro_map_from_ocdfg` reuses verbatim — all the tuned Sugiyama /
PAVA layout code is unchanged. 25 `cargo test`s, deterministic across runs.

## 0.9.9

"Export as figure…" now fits the whole map into view before capturing,
instead of exporting whatever was panned/zoomed into the visible viewport,
then restores the user's own view afterwards.

## 0.9.8

Adds an "Export as figure…" button to the canvas controls, next to the
minimap toggle: exports the map as PNG, SVG, or PDF.

## 0.9.7

Default `minerVariant` changed `IMf` -> `IM` and default `noiseThreshold`
changed `0.2` -> `1`, following live feedback that IM (with noise
threshold, which it ignores, left at its max) produces the best-looking
metro maps. No code changes — `manifest.json` only.

## 0.9.6

Two more fixes from live feedback, isolated by filtering discovery down to
a single object type (Transport Document) to get a clean reproduction:

- **"Curly" multi-bend edges, straightened into one bend.** A long edge's
  dummy chain (`Depart` to the final `+` join, three ranks, two waypoints)
  was drifting gradually -- confirmed live: lanes moved -0.50 -> -0.28 ->
  0.01 -> 0.36, a distinct bend at *every* rank instead of one. That's the
  smoothest per-rank compromise `assign_coordinates` optimises for, but the
  wrong objective for a schematic that wants the *fewest* bends, not the
  smallest average one -- a real transit map runs a line exactly parallel
  to its current track, then makes one deliberate diagonal switch, not a
  continuous drift. New `concentrate_dummy_drift` (`metro-map-core`) runs
  after coordinate assignment: since a dummy waypoint is never shared
  between edges, every interior waypoint of a long edge's chain is pinned
  to the edge's own source lane and the one closest to the target is
  pinned to the target lane, then each touched rank is re-settled with the
  same `resolve_order_preserving` used elsewhere -- concentrating the whole
  shift into one hop near the end, the same asymmetry `route.ts#routeHop`
  already applies view-side. Can only move a dummy within the order
  `layers` already fixed, so it cannot introduce a crossing.
- **Dashed boundary edges use real dashes, not a dotted line.** `2 4` was
  short enough to render as dots (`strokeDasharray`, `MetroEdge.tsx`); now
  `8 4`.

## 0.9.5

Edges converging on a node from a much higher lane offset — most visibly a
loop edge jumping several lanes in one hop to reach a gateway far above it
— used to enter it at a steep diagonal, close to "from below," rather than
settling into it straight. Confirmed against the live payload: two Vehicle
loop edges (`edge:Vehicle:place:p:Vehicle:5:place:p:Vehicle:4` and
`edge:Vehicle:transition:t:Reschedule Container:place:p:Vehicle:4`) both
target the same gateway, one needing an ~0.58-lane shift in its final hop
and the other an ~2.58-lane shift — and `routeHop`'s `lead` (the straight
vertical run reserved on each end of a diagonal) was split evenly between
departure and arrival, so a shift that large left almost nothing for
either side. Root cause: an even 50/50 split starves the *arrival* side
exactly when it matters most — the hop's shift needs the least excuse for
looking abrupt right where it meets a node, not right after leaving one.
`routeHop` now caps departure's share of the leftover room at `MIN_LEAD`
and hands arrival everything past that, so the diagonal front-loads near
the previous point and every arrival — loop edges included — settles into
a long straight vertical run before touching its node. View-layer only,
`route.ts#routeHop`; no Rust change needed.

## 0.9.4

Fixes real, visible overlap between *unrelated* edges' lines — confirmed
directly against the live artifact's payload (a small geometric scan for
two different edges' hops sharing a rank pair and landing within 0.1 lane
of each other at both ends found 4 such coincidences, e.g. a Transport
Document edge and an entirely unrelated Vehicle edge drawing on top of
each other for a whole hop, sharing neither source nor target). Root
cause: `plugin.tsx#localOffsets` (v0.6.0) only ever separates edges that
share a *node* — two edges with completely different endpoints that merely
pass through the same rank-to-rank corridor mid-journey are invisible to
it, and the Rust layout has no structural reason to avoid the coincidence
either (two unrelated dummy waypoints landing on the same lane at the same
ranks isn't a conflict from its point of view, just chance). New
`corridorOffsets` scans every edge's hops directly for this coincidence
and fans out only the colliding ones, leaving every other hop untouched.

## 0.9.3

Two more fixes from live feedback:

- **Dashed no longer means "loop" at all.** On reflection this was the
  right call from the start — a genuine redo edge already routes backward
  up the page, which reads as "this goes back" on its own; dashing it too
  was redundant, and unreliable besides back when `kind` could still
  reflect a cross-object-type merge artifact (fixed in 0.9.1, but the
  visual convention itself was still the wrong one). Dashed now marks an
  object type's very first edge (out of its source) and very last edge
  (into its sink) instead — computed straight from each edge's own
  `source`/`target` node kind in `plugin.tsx`, no Rust changes needed.
  `kind: Loop` still exists in the payload and still drives backward-rank
  routing (a real structural distinction), it just no longer drives
  dashing.
- **A real algorithmic fix for "wobble"**: several unrelated parallel
  lines all detouring left-then-right in lockstep through the same few
  ranks, for no reason a crossing count could explain. Root cause:
  `transpose_pass` only ever takes a swap that *strictly* reduces
  crossings — a swap that's crossing-*neutral* but would let several lines
  land exactly on their own straight path instead of splitting a
  compromise is never taken, because crossing count has no way to see
  straightness at all. New pass, `straighten_by_reordering`, runs after
  coordinate assignment settles: for every adjacent same-rank pair, if
  swapping them doesn't cost a crossing (same `swap_delta` safety check as
  `transpose_pass`) *and* strictly reduces the rank's total weighted
  squared deviation from each node's own desired position, take it —
  looping until no more such swaps are found, then re-relaxing coordinates
  (a straightening swap in one rank can unlock another one nearby) up to
  20 outer rounds. New test `straighten_by_reordering_fixes_a_crossing_
  neutral_wobble`, a hand-worked case where the initial order forces a
  compromise and swapping reaches both nodes' exact targets.

## 0.9.2

Fixes the steady rightward diagonal drift live feedback caught (the whole
diagram leaning instead of running roughly vertically) — confirmed against
the live artifact's own payload (Python notebook) that this wasn't a
structural bias in `assign_coordinates` at all: the "spine" line's own
per-rank position was measurably still sliding by whole lanes at round 40
(the fixed round count picked against small synthetic test fixtures, none
of which are anywhere near a real ~20-rank diagram's size) — not converged,
just not yet caught up, since each round only advances settled information
by the ranks it sweeps across before reversing direction. Fixed properly:
the sweep now runs until positions actually stop moving (tracked as the
largest single-position change in a round, threshold `1e-6`) instead of a
fixed count, with a generous safety cap (`MAX_ROUNDS = 2000`) against a
pathological input that never quite settles. Verified live: the spine's
per-rank mean lane, which swung from -26 to +14 over 19 ranks at round 40,
now stays within about ±3 lanes end to end. Negligible cost — the extra
rounds only run for graphs that actually need them; the existing test
suite still finishes in well under a tenth of a second.

## 0.9.1

Two fixes from live feedback:

- **Dashed no longer means "an artifact of merging object types."** Cycle
  breaking (`feedback_arcs`) has to run on the *merged* cross-object-type
  graph for ranking — every type's edges need to combine into one DAG for
  a topological rank to even be well-defined. But that means a "back edge"
  it flags there isn't necessarily a genuine redo for any specific object
  type: two types can each flow acyclically through their own lifecycle
  and still form a cycle only once merged (type A goes station1→station2,
  type B goes station2→station1 through some shared station — neither
  individually loops). Marking whichever edge the merged-graph pass picked
  as `kind: Loop` dashed a perfectly ordinary edge with no real redo behind
  it. Fixed: `kind` is now decided by a *separate* pass — `feedback_arcs`
  run again, once per object type, over that type's own subgraph in
  isolation — so dashed genuinely means "this object type's own lifecycle
  revisits an earlier point," never a merge artifact. New test
  `cross_type_merge_cycle_is_not_a_genuine_loop`.
- **Fixes a real off-centre case at gateways with a loop-edge input.** A
  gateway fed by one ordinary edge from above and a loop edge merging in
  from below had both edges dumped into the *same* local fan-out group
  (`plugin.tsx#localOffsets`, v0.6.0) purely because they shared a target —
  even though they approach from opposite physical sides and were never
  competing for the same lateral space. That forced the ordinary edge off
  the gateway's true centre for no structural reason, visibly misaligning
  it against the single edge continuing on below. Fixed: fan-out groups
  are now split by which side of the node an edge actually touches
  (`splitBySide`) before being ordered/offset within each side
  independently.

## 0.9.0

Live feedback pointed at a concrete, avoidable crossing: two edges arriving
at the same station (e.g. "Transport Document" and "Register Customer
Order", both feeding "Create Transport...") visibly crossed each other on
the way in, even though swapping which side each one landed on would have
avoided it entirely. Root cause: `plugin.tsx#localOffsets`'s local fan-out
at a shared node ordered the converging (or diverging) edges by object type
(`laneOffset`, alphabetical) — a purely cosmetic key with no relation to
where each edge is actually coming from. If two edges' real source
positions run left-to-right in one order but their object types happen to
sort the other way alphabetically, sorting by type hands them crossing
fan-out slots and forces a crossing that has nothing to do with the graph,
purely an artefact of the sort key. Fixed: local fan-out is now ordered by
each edge's actual approach direction (`approachLane`) or departure
direction (`departureLane`) — the lane of its last waypoint (or source
directly), and first waypoint (or target directly) respectively — with
object type only as a last-resort tiebreak between edges arriving from the
exact same lane. This is a stronger fix than a "swap if it helps" pass:
sorting directly by real geometry gets every avoidable local crossing at
once, not just the ones a swap heuristic happens to try.

## 0.8.4

0.8.3's flip-flop fix worked (verified: mutually degree-1 pairs now align
correctly), but live-testing the full Logistics diagram surfaced a new
regression it introduced: the whole diagram now drifted into a steady
diagonal from top-left to bottom-right instead of running roughly
vertically. Root cause: `assign_coordinates`' order-preserving resolution
processed same-rank nodes by priority and pushed lower-priority ones out of
the way with a greedy `max`/`min` clamp, one at a time. That scheme has no
mechanism to ever push back the *other* direction — every resolved
conflict only ever moves a node to the right (or leaves it), rank after
rank, across a diagram with dozens of ranks that compounds into a visible
tilt. Replaced with the mathematically exact fix for this exact
problem: weighted isotonic regression via the standard pool-adjacent-
violators algorithm (PAVA, `isotonic_nondecreasing`) — the true
least-squares-closest non-decreasing (here, >=1.0-separated) arrangement of
the desired positions, with no directional bias by construction. Priority
is now a PAVA weight (a dummy waypoint's near-fixed desired position
resists being pulled as far as an unweighted mean would) rather than a
processing order. Three new tests: `isotonic_nondecreasing_matches_hand_
worked_cases`, `resolve_order_preserving_keeps_min_gap`, and confirms the
existing alignment/flip-flop tests still pass under the new resolver.

## 0.8.3

Found the actual root cause after 0.8.2's rounds increase made no visible
difference: `assign_coordinates`' "desired position" alternated which
direction it consulted based on the current sweep — predecessors on a
downward sweep, successors on an upward one — rather than considering both.
For a node with a real pull on *both* sides (a station whose sole
predecessor wants one thing and whose successor, shared with an unrelated
line, wants another — confirmed against the live artifact: "Collect
Goods"'s downstream "Load Truck" is also fed by the separate Container
line), this doesn't converge to a compromise, it flip-flops: downward
sweeps snap it toward its predecessor, upward sweeps snap it toward its
successor, forever re-deciding rather than settling. More rounds only
changed *which* direction happened to run last, never fixed it. Fixed by
computing "desired" as the mean of both directions' current positions
whenever a node has both (falling back to whichever one exists otherwise)
— every round now pulls toward one stable compromise instead of
alternating between two different targets. New test
`mid_chain_node_settles_instead_of_flip_flopping`, built directly from the
real shape found live: a source with a single successor whose own
downstream is shared with an unrelated line.

## 0.8.2

Live data still showed "Handling Unit" one lane off "Collect Goods" after
0.8.1 despite both being mutually degree-1 (verified directly against the
artifact's own payload via its Python notebook). An isolated two-pair unit
test of the exact same shape aligned perfectly, which narrowed it down:
`assign_coordinates`'s 6 rounds are enough for two directly adjacent ranks
in isolation, but not necessarily enough for a real diagram's full depth —
each round only advances settled information across the ranks it sweeps
before reversing direction, so a rank's desired position (itself pulled by
its own further-downstream neighbours, which can take several more rounds
to settle) can still be slightly stale when an alignment from several
sweeps away needs to catch up to it. `ROUNDS` raised 6 → 40 (cheap: this is
a few hundred nodes at most, not a hot loop). Also renamed the debug test
added while diagnosing this to a permanent regression test
(`two_sources_align_with_their_own_targets_independently`).

## 0.8.1

Live-testing 0.8.0 on Logistics showed "Handling Unit" still bending into
"Collect Goods" despite the new coordinate-assignment stage. Root cause:
spine centring (unchanged since 0.4.0) shifted every rank by its *own
independent* mean position of the spine object type's nodes at that rank —
correct for the old dense-per-rank-integer system, where each rank's
coordinate space genuinely was independent and needed separate
re-centring, but actively harmful now that `assign_coordinates` produces
coordinates that are already meaningfully comparable across ranks: if the
spine's own mean position happened to differ even slightly between two
adjacent ranks, the shift silently undid an exact alignment the coordinate
pass had just achieved between a node in one and its neighbour in the
other. Fixed by computing one single global shift (the spine's overall
mean position, one scalar) instead of a per-rank vector, so every
cross-rank alignment survives centring untouched.

## 0.8.0

Live-testing 0.7.0 immediately surfaced why its `align_degree_one_pass`
didn't actually straighten "Handling Unit" above "Collect Goods": that pass
could only *reorder* nodes within a rank's existing dense `0..N` integer
lane sequence, and two different ranks generally have different node
counts. A source alone in a one-node-wide rank can never reach "lane 3" to
sit above its successor in a six-node-wide rank — no amount of reordering
fixes that, the integer-per-rank unit itself is the ceiling.

Fixed at the root: lane assignment is now explicitly two stages instead of
one. **Ordering** (barycenter sweep + `transpose_pass`, mostly unchanged
from 0.7.0) still produces a crossing-minimised left-to-right *sequence*
per rank. A new **coordinate assignment** stage
(`assign_coordinates`, the classic Sugiyama "priority method") then turns
that sequence into real-valued positions — not another dense integer
range. `align_degree_one_pass` is gone; its job is now done properly by
letting priority-ordered nodes (a dummy waypoint highest of all, since it
always has exactly one neighbour per direction by construction; a real
node by its neighbour count) claim their neighbours' *exact* mean position,
clamped only by already-fixed higher-priority same-rank neighbours. `lane`
changed from an integer to a plain number end to end (`OutNode`/`Waypoint`
in Rust, unchanged as `number` in TypeScript — no view-side changes needed
at all, `laneX()` already just multiplies by `COL_W`).

New test `degree_one_node_aligns_across_differently_sized_ranks`, which
fails against the 0.7.0 approach and passes against this one: a source
alone at rank 0 with a single successor several lanes into a six-node
rank 1 now lands in that successor's *exact* position.

## 0.7.0

Sixth-round feedback pointed at the layout algorithm itself, not just view
routing — degree-1 sources not aligning with their sole successor even with
plenty of room, and edge crossings that a simple reordering would remove.
Both are real gaps in `assign_lanes` (`crates/metro-map-core`), which only
ever did a barycenter sweep — no crossing-count-based cleanup, no explicit
straightening step. Two classic Sugiyama techniques added after it:

- **`transpose_pass`**: repeatedly swaps two adjacent same-rank nodes
  whenever doing so strictly reduces the actual number of edge crossings
  against both neighbouring ranks, until a full pass finds no more
  improving swaps. Barycenter ordering compares *mean* neighbour position,
  not a real crossing count, and can settle on an order a direct count
  would still improve — this is the missing piece for "switching the order
  of outgoing edges would remove edge crossings."
- **`align_degree_one_pass`**: a node with exactly one neighbour on a given
  side — most commonly a dummy waypoint, which always has exactly one by
  construction, but also a real node like a source with a single successor
  — bubbles one adjacent swap at a time toward that neighbour's *exact*
  lane, gated by the same crossing-delta check as the transpose pass but
  allowing neutral swaps too (crossing count alone has no way to prefer
  "exactly underneath" over "one lane off" — both cost the same 0
  crossings, so nothing about minimising crossings would ever move it into
  alignment on its own). This is the actual cause of a "microbend" that
  isn't a real crossing trade-off, and — since a dummy waypoint always has
  exactly one neighbour on each side — this pass also straightens a long
  edge's own dummy chain, which is most of what a "goes back, then down,
  then up again" zigzag over several ranks actually was.
- Two new `cargo test`s: `swap_delta_detects_crossing_reduction` (verifies
  the crossing-delta sign directly against a hand-worked X-crossing case)
  and `degree_one_node_aligns_with_its_sole_neighbour` (a case barycenter
  alone provably never resolves, tie-broken alphabetically forever
  regardless of how many more sweep rounds run — confirmed by hand before
  writing the fix).
- View/routing (`route.ts`, `plugin.tsx`, `MetroEdge.tsx`) is unchanged this
  round — every fix here is in the Rust layout stage.

## 0.6.0

Six more issues from live feedback on the Logistics diagram, all tracing back
to one underlying design flaw:

- **Root cause: two independent diagonals stacked at every node.** A rank/
  lane shift (the actual layout move) and the 0.5.0 bundling-offset funnel
  (fan to dead-centre or hold a constant offset) were computed and applied
  separately. They could point in *different* horizontal directions — funnel
  one way, shift back the other — which is exactly the "goes back, then
  down, then up again" zigzag reported against it, and is also why a source
  with its own shift left no straight run at all before its first bend.
  Routing is now a single pass: `route.ts#chainXs` computes one effective
  x-position per node in an edge's chain (its own lane position plus
  whatever local offset applies there), and `routeHop` draws exactly one
  diagonal to cover the full distance between two consecutive x's. There is
  never more than one bend near a node again.
- **The global per-object-type pixel offset (0.2.0) is gone.** It kept two
  *different* object types from ever coincidentally overlapping mid-journey,
  but the dummy-waypoint lane reservation (0.3.0) already solves the more
  important version of that problem (an edge running through a real,
  unrelated station) at the layout level, and the fixed global offset was
  the direct cause of several other reports: a lone edge (the common case)
  no longer necessarily passing through its node's true centre, and — worse
  — two edges that merely *arrive at the same node from different sources*
  (not a true parallel pair, e.g. two different upstream chains both feeding
  "Load Truck") both tapering independently to that one centre point and
  producing jumbled, crossed arrowheads right on top of each other.
- **Offsets are now purely local**, computed from how many edges actually
  touch a given node: a lone edge gets exactly 0 there (straight, dead-centre
  in or out); several edges converging on the same node fan out to evenly
  spaced points instead of one pixel. Computed separately for a node's
  incoming side and its outgoing side (grouped by shared *source*, and by
  shared *target*, not by the `(source, target)` pair as in 0.5.0), so edges
  that only share a target — not a true parallel bundle — fan out too,
  ordered by object type for a consistent left/right position.
- **`MIN_LEAD` doubled** (26px → 52px): the straight run before any bend is
  longer, on both the departure side (leaving a node) and the arrival side
  (a diagonal can no longer run straight into an arrowhead).
- Net effect on the reported cases: a source with a single direct successor
  now leaves straight down when nothing else needs a shift there; two edges
  converging on the same station (shared target only, different sources)
  fan out into distinct parallel approaches instead of crossing; boundary
  (source/sink) nodes with a single edge sit dead-centre on it again.

## 0.5.0

Another round from live feedback on the Logistics diagram:

- **A "false root" isn't only a `Source`.** The gateway sitting at the very
  top of the diagram with no visible predecessor ("why does that choice
  begin there?") turned out to have exactly the same shape as the
  already-fixed source case: its only real incoming arc had been classified
  as a `Loop` back edge, leaving it with zero forward predecessors in
  `dag_adjacency` — indistinguishable from a genuine starting point to ASAP
  ranking, even though it isn't one. The ALAP pass now covers *any* node
  with no forward predecessor, not just `Source`-kind ones. New test
  `non_source_false_root_gets_alap_too`.
- **Found and fixed a second nondeterminism gap while writing that test**:
  `raw_edges` (which `adjacency`'s per-node child order — and therefore
  which edge of an ambiguous cycle `feedback_arcs` flags as `loop` — is
  built from) came from walking a `HashMap`/`HashSet`, unsorted. Same
  failure mode `node_ids.sort()` fixed a few versions back, just one level
  removed from it. Fixed with an explicit sort before cycle breaking.
- **Arrowheads are actually visible now.** They were real but nearly
  imperceptible: a small triangle sitting right at a `round`-capped line's
  own end blends into the cap. Bigger triangle, `butt` cap on the line
  itself (stopped at the arrow's base, not its tip), and —
- **Lines now end at a node's visible edge, not its centre.** The genuine
  root cause of "I can't see arrowheads": nodes render *after* edges, so an
  edge routed all the way to a node's exact centre point had its terminal
  segment, arrowhead included, completely hidden behind the node's own
  artwork. `route.ts#trimEnds` pulls each end back by that node's own
  visual radius before drawing.
- **Single-line edges now settle to a straight run before meeting their
  node**, instead of arriving on a steep diagonal. A row whose height was
  set by exactly one dominant shifting edge left that edge's own `lead` at
  zero on both sides — no vertical settling at all. `computeRowGaps` now
  reserves a `MIN_LEAD` on top of the diagonal's own footprint, always.
- **Genuinely parallel edges (sharing both endpoints) no longer converge to
  one point at their shared stations.** The funnel-to-centre behaviour from
  0.4.1 was right for a lone edge, wrong for two companions running the
  same route — they should stay the same fixed distance apart the entire
  way, the way two platforms at the same two stops never merge into one
  track. Edges are now grouped by `(source, target)`; a shared pair keeps a
  constant offset (`offsetPoints`), a lone edge still tapers to centre
  (`offsetPointsTapered`).
- **Clicking a station now highlights every object type it touches** (all
  of them, for a shared/interchange station), fading the rest — the same
  interaction a line click already had, generalised from a single
  `highlightedType` to a `highlightedTypes` set.
- Legend explains what a dashed line actually is (a genuine loop/rework in
  that object type, not a rendering artefact) and mentions station clicks.

## 0.4.1

Live-testing 0.4.0 on the Logistics log confirmed the loop-waypoint,
ALAP-source and spine-centring fixes, but also showed adjacent stations'
labels still overlapping — a real spacing gap, not just a contrast one:
`COL_W` (64px) was narrower than a label can be (up to ~110px), so two
neighbouring lanes' text collided regardless of any background. `COL_W`
raised to 104px and label `maxWidth` trimmed slightly (96px/88px) to match.

## 0.4.0

Layout-quality pass from live feedback on real Order Management / Logistics
diagrams:

- **Loop edges now get dummy waypoints too.** The 0.3.0 dummy-node fix only
  covered forward (`Flow`) edges — a `Loop`-kind back edge (its `source` sits
  at the *later* rank) could span many ranks with no reserved lane anywhere
  along that span, so it ran straight through whatever real station happened
  to already occupy those ranks. Same fix, extended: dummy chains are built
  low-rank-to-high-rank in the ordering graph regardless of which end is
  `source`/`target`, so a Loop edge's back pointer can't introduce a cycle
  there even though `dag_adjacency` (ranking) still only sees the forward
  ones. New test `long_loop_edge_gets_waypoints`. This is very likely what
  produced the odd gateway placements and stray diagonal dotted lines seen
  on the Logistics log — a real, unrelated node had no reason not to land on
  an unreserved loop edge's path.
- **Sources start right before their first use, not all pinned to the top.**
  A source has no predecessor, so ASAP ranking always put it at rank 0 —
  correct in that nothing blocks it, but visually wrong when its only real
  use is a station reached far later via a different, longer object type's
  chain (e.g. a vehicle only booked deep into an order's own lifecycle). A
  new ALAP-style pass moves each source to `(rank of its earliest direct
  use) − 1`; every other node keeps its ASAP rank. New test
  `source_pushed_to_just_before_first_use`.
- **The diagram is now centred on its own "spine"**, not left-packed. The
  object type touching the most stations (the closest proxy to "most
  events" this crate can measure without raw counts) is shifted to lane 0
  at every rank it — or one of its waypoints — touches; every other lane in
  that rank shifts by the same integer amount, preserving relative order
  and spacing. New test `spine_recentred_to_lane_zero`.
- View: removed the redundant "read from the underlying Petri net" line
  from the legend; clicking a line to highlight it no longer re-fits/zooms
  the view (only a legend toggle that actually changes which nodes are
  drawn does); station and terminus labels get a translucent background so
  they stay legible over colourful edges.

## 0.3.1

Fixes a crash (blank view, `TypeError: Cannot read properties of undefined
(reading 'toFixed')`) surfaced by live-testing 0.3.0 on a real log with a
loop: `routePoints` always assumed forward motion (`y[source.rank + 1]`,
valid because a normal flow edge's target is always exactly one rank
below), but a `loop`-kind edge's `source` is the *later* rank — a loop
edge whose source sat at the diagram's very last rank indexed one past the
end of the rank→y array, and every coordinate downstream turned into
`undefined`/`NaN`, breaking the whole view, not just that edge. Fixed by
solving the backward (or same-rank) case as the forward one and reversing,
reusing the already-correct forward geometry instead of duplicating it.

## 0.3.0

Three more fixes from live feedback, plus a real Sugiyama-layout gap this
surfaced:

- **Dummy waypoints for long edges** (`metro-map-core`): an edge spanning
  more than one rank now gets a classic Sugiyama dummy node at every
  intermediate rank it crosses, competing for lane space in the barycenter
  ordering pass exactly like a real node. Without this, a long edge was
  invisible to layout at the ranks it merely passed through, so an
  unrelated real station could land directly on its path — the edge then
  visibly ran straight through a place it has nothing to do with. Each
  edge's `waypoints: [{rank, lane}, …]` field carries the dummy positions;
  the view (`routeThroughWaypoints`) stitches them into one continuous
  routed line. New `cargo test`: `long_edge_gets_dummy_waypoints`.
- **Fixed a latent nondeterminism bug** found while writing that test:
  `feedback_arcs`'s node visiting order came from iterating a `HashMap`
  directly, whose order is randomised per process — which edge of a cycle
  got picked as the "back" edge (and therefore every downstream rank/lane
  value) could silently differ between two runs of the exact same input.
  Fixed by sorting the id list first, restoring the "same input → identical
  output" guarantee every other id in this crate already relies on.
- **Edges now terminate at the true centre of their node**, not offset from
  it. The global per-object-type bundling offset from 0.2.0 was applied
  uniformly along an edge's whole length, endpoints included, so a line
  visibly missed the middle of the circle it connects to. Fixed with a
  tapered "funnel": the offset ramps from 0 at the node centre up to its
  full value over a short 45° merge segment (`route.ts`'s
  `offsetPointsTapered`, replacing the old uniform `offsetPoints`) — the
  same thing a real transit map does, fanning lines out right next to a
  station rather than the whole way between two stations.
- **Interactive highlight.** Clicking a line (an edge on the canvas, or its
  entry in the legend) highlights every edge and every station/gateway/
  terminus touching that object type and fades everything else; clicking
  the same line again, or the canvas background, clears it.

## 0.2.0

Three usability/rendering fixes from live feedback:

- **One-click from the log.** "Discover metro map" now takes an
  `ObjectCentricEventLog` directly (`scans`/`scanAction`-chains to
  `run.promenade.ocpn`'s `Discover OCPN`, mirroring how that plugin itself
  chains to its own internal projection step) instead of requiring an
  already-discovered `ObjectCentricPetriNet`. Its own objectTypes/
  minerVariant/noiseThreshold parameters are forwarded straight through.
- **Rounded corners.** Every bend is now a short quadratic-Bézier curve
  (`route.ts`'s `roundedPathFromPoints`) instead of a sharp mitre, matching
  real transit-map schematics.
- **No more coincidental overlaps between unrelated lines.** Edges used to
  get their sideways bundling offset only when they shared both endpoints
  with another edge; two edges between *different* node pairs that
  happened to run through the same lane column had no offset from each
  other at all and could draw on top of one another. Every edge's offset
  is now a fixed function of its object type's alphabetical rank among
  every type in the net, applied globally — the same relative track
  position wherever that line runs, which also matches how a real metro
  map's lines behave.
- Strokes are visibly thicker (2.4px → 4px), closer to a real transit map's
  weight.

## 0.1.2

Removes the temporary console logging added in 0.1.1. Live-verified end to
end on a real OCEL (Order Management: 21K events, 11K objects, 6 object
types) — 83 nodes / 151 edges rendered with clean 45°-only turns, bundled
parallel lines, multi-coloured interchange stations, and choice/parallelism
gateway glyphs.

## 0.1.1

Debug build (temporary `console.log` of computed layout/edge data), used to
diagnose the view rendering nodes but no edges on first install. Root cause:
a stale cached copy of the sandboxed view frame from the previous install,
not a code defect — closing and reopening the artifact's view picked up the
rebuilt `view/plugin.js` and edges rendered correctly.

## 0.1.0

Initial prototype: "Discover metro map" converts an `ObjectCentricPetriNet`
into an `OCMetroMap` (gateway extraction, cycle breaking, longest-path
ranking, barycenter lane ordering, all in pure Rust — see
`crates/metro-map-core`), and the "Metro map" sandboxed view renders it with
45°-only octilinear routing and consistent parallel-line bundling.
