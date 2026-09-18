# Metro Map

Current view pipeline: this plugin's own `complexity.ts` filters the displayed graph, then the shared `metro-layout` package (`view-src/packages/metro-layout`, which the Variant Metro plugin also consumes) places it (`relayout.ts`), assigns tracks (`router.ts`) and refines final pixel geometry (`geometry.ts`) before `MetroEdge.tsx` renders it. The routing descriptions below include historical design rationale; the active renderer does not use the older `routeHop` pipeline. Final refinement preserves activity ranks, uses actual node footprints, and limits chamfers per corner. Stability remains an optional view setting; this change does not introduce layout from the full unfiltered graph.

Run **Discover metro map** directly on an `ObjectCentricEventLog`, then open
the resulting artifact's **Metro map** view. Requires `run.promenade.ocpn`
to be installed too: this action `scans`/`scanAction`-chains to its
`Discover OCPN` (the same generic host mechanism `run.promenade.ocpn`'s own
action uses for its internal projection step — declarative, not a
special-cased dependency), so an Object-Centric Petri Net is mined
transparently as an internal stage. The objectTypes/minerVariant/
noiseThreshold parameters shown here are `run.promenade.ocpn`'s own — set
them here and they are forwarded straight through.

## Two bases: Petri net (default) or OC-DFG

There are two discovery actions, both producing the same `OCMetroMap`:

- **Discover metro map** — from the Petri net, as described above. Keeps the
  structurally-mined `×` / `+` gateways (including real AND-parallelism). No
  per-activity or per-arc counts.
- **Discover metro map (OC-DFG)** — from an Object-Centric Directly-Follows
  Graph (`core.discover.ocdfg`, run transparently as an internal stage). No
  gateway diamonds — an OC-DFG cannot distinguish choice from concurrency,
  so branching just reads as a line splitting —
  but every station and arc carries its observed frequency.

The **Metro map** view adapts to whichever basis produced the map. Both get
a **complexity slider** (top-right) that opens the map deliberately sparse
and reveals more on demand: for the OC-DFG basis it keeps the busiest arcs
per object type (top-N-per-group model); for the Petri-net basis it
reveals the process core first and optional leaf activities last, using a
structural leaf-peel order computed in `metro-map-core`. Two more view
options: **Stations** as Budapest-metro dots (default) or labelled
rectangles, and **Show numbers** (default off) to print frequencies — the
latter only does anything on an OC-DFG-based map.

The usual object-centric process diagrams (OC-DFG, OC-BPMN) draw every object
type's flow as its own curved, independently-routed arc, which turns into an
unreadable tangle once a real log has more than a couple of object types or
activities. This plugin draws the same information the way a transit map
draws a city's rail network instead:

- every turn is 0°, 45° or 90° — no splines, no bezier curves;
- object types are "lines": where several run through the same stretch of the
  diagram they stay parallel and equidistant, in a consistent left-to-right
  order, instead of crossing and re-crossing each other;
- an activity shared by several object types is one "station" (bigger, with a
  multi-coloured ring, the way a transit map draws an interchange);
- choice and real parallelism are drawn as `×` / `+` gateway markers, read
  directly off the underlying Petri net's structure — not guessed from raw
  frequency;
- object types get explicit terminus markers for where they start and end;
- the diagram runs top to bottom in roughly process time order.

## Where the gateways come from

`run.promenade.ocpn` already mines a sound, block-structured WF-net per
object type with Inductive Miner. That structure already encodes exactly the
distinction a schematic needs:

- a place with more than one outgoing arc is a choice (XOR);
- a place with more than one incoming arc is where a choice rejoins;
- a silent (τ) transition with more than one outgoing arc is real
  parallelism (AND) — the object genuinely does both branches;
- a silent transition with more than one incoming arc is where parallel
  branches synchronise back together.

This is a structural read of the net, not a new discovery algorithm — it
needs no case-level log access at all, only the already-discovered OCPN.
Reading gateways from something an aggregate directly-follows graph alone
cannot answer reliably (frequency never tells you whether two activities
that both follow a third one occur together or as alternatives) is exactly
why this depends on OCPN rather than OC-DFG.

## Layout

`crates/metro-map-core` is a small, pure-Rust, `cargo test`-covered
algorithm — genuine Sugiyama-style layered-graph layout, hand-rolled rather
than pulled from ELK or any other layout crate:

1. gateway extraction (see above);
2. a greedy feedback-arc-set to break any loops before ranking — run
   *twice*, for two different purposes that don't share an answer. Once
   over the whole merged graph (every object type's edges together): this
   is what ranking needs, since a topological rank is only well-defined
   over a DAG, and object types sharing stations can combine into a cycle
   neither has on its own (type A flows station1→station2, type B flows
   station2→station1 through some other shared station — merged, that's a
   cycle, even though neither type's own lifecycle loops). And once more,
   independently, *per object type* over that type's own subgraph alone —
   this is what decides `kind: Loop` (drawn dashed): only a type's own
   lifecycle genuinely revisiting an earlier point counts, never an edge
   that merely had to be excluded from the merged ranking graph because a
   *different* type's cycle needed breaking somewhere;
3. longest-path (ASAP) ranking (top-to-bottom order);
4. **ALAP for every "false root"** — any node with no *forward* predecessor
   in `dag_adjacency`, not only `Source`-kind ones. A source has no
   predecessor by construction, so ASAP ranking always puts every one of
   them at rank 0 — correct in that nothing blocks it, but visually wrong
   once a source's only real use is a station reached far later via a
   different, longer object type's own chain (a vehicle only booked deep
   into an order's lifecycle, say). A gateway can end up exactly the same
   way for a subtler reason: if its *only* incoming arc gets classified as
   a `Loop` back edge, it has zero forward predecessors too, and ASAP
   ranking placed it at rank 0 — visually identical to a genuine starting
   point, which it isn't. Either way, the node moves to `(rank of its
   earliest forward use) − 1`; every node that *does* have a forward
   predecessor keeps ASAP, which is what keeps top-to-bottom order
   meaningful;
5. **dummy-node insertion**: an edge spanning more than one rank — a long
   `Flow` edge *or* a `Loop` back edge, which can span just as many ranks —
   gets a chain of dummy nodes, one per intermediate rank it passes through,
   the textbook Sugiyama technique for exactly this problem. Without it, a
   long edge is invisible to the ranking a real node could land in its way;
   the dummy chain reserves that lane the same way a real node would. The
   ordering graph these dummies live in always walks low-rank-to-high-rank
   regardless of which end is `source`/`target`, so a `Loop` edge's back
   pointer can't introduce a cycle into it;
6. lane assignment, in two explicit stages, over real *and* dummy nodes
   together. **Ordering** first: an iterative barycenter sweep for a
   left-to-right sequence per rank, then `transpose_pass`, which swaps two
   adjacent same-rank nodes whenever it strictly reduces the actual number
   of crossings against both neighbouring ranks — barycenter only compares
   *mean* neighbour position, not a real crossing count, and can settle for
   an order a direct count would still improve. That sequence is still a
   dense `0..N` integer per rank at this point — **coordinate assignment**
   (`assign_coordinates`, the classic Sugiyama "priority method") turns it
   into real-valued positions instead. This distinction matters: two
   different ranks generally have different node counts, so a source alone
   in a two-node rank can never *reorder* its way to lane index 4 to sit
   above its successor in a six-node rank — no amount of crossing-count
   optimisation removes that ceiling, since the integer-per-rank unit is
   itself the problem. Real coordinates remove it. Each node's "desired"
   position is the mean of *both* its predecessors' and its successors'
   current positions when it has both, not just whichever direction some
   current sweep happens to face (the textbook version) — alternating
   between the two makes a node with a genuine pull on both sides (a
   station whose sole predecessor wants one thing and whose successor,
   shared with an unrelated line, wants another) flip-flop every other
   round instead of settling anywhere; blending them gives it one stable
   target. Turning a rank's desired positions into an actual assignment
   without inverting the order `transpose_pass` already settled on, while
   keeping every node >=1.0 apart from its neighbours, is a constrained
   least-squares problem with an exact, well-known solution: weighted
   isotonic regression via the standard pool-adjacent-violators algorithm
   (PAVA, `isotonic_nondecreasing`) — the true closest valid arrangement,
   with no directional bias. A greedy priority-ordered push-out-of-the-way
   resolution (an earlier version of this) has no such guarantee: it can
   only ever push a conflict *one* direction, and across a real diagram's
   many ranks that compounds into a visible diagonal drift with nothing
   pulling back the other way to cancel it. A dummy waypoint (always
   exactly one neighbour per direction by construction) gets a much larger
   PAVA weight than any real node's — a real node's is its neighbour count
   — so it resists being pulled off its desired position by a same-rank
   conflict more than a low-degree real node would. This combination is
   what lets a source with a single successor land in that successor's
   *exact* position rather than merely close to it, which a crossing count
   alone can't tell apart from "one lane off" — nothing about minimising
   crossings would ever have straightened that on its own, and it's what a
   visible "microbend", or a long edge's dummy chain zigzagging over
   several ranks, actually was. Coordinate assignment then alternates with
   one more pass, `straighten_by_reordering`: for every adjacent same-rank
   pair, if swapping them doesn't cost a crossing (the same `swap_delta`
   safety check `transpose_pass` uses) *and* strictly reduces the rank's
   total weighted squared deviation from each node's own desired position,
   it takes the swap. `transpose_pass` alone only ever takes a *strictly*
   crossing-reducing swap — a swap that's crossing-*neutral* but would let
   several unrelated lines land exactly on their own straight path instead
   of splitting a compromise is never taken, since crossing count has no
   way to see straightness at all. That's what produced several parallel
   lines all detouring left-then-right in lockstep through the same few
   ranks — a "wobble" with no crossing anywhere to explain it, purely an
   artefact of which order the crossing-only pass happened to settle on;
   re-relaxing coordinates after any reordering lets the straightening
   propagate to neighbouring ranks, in turn sometimes unlocking further
   reordering there;
7. **concentrating long-edge bends** (`concentrate_dummy_drift`): coordinate
   assignment gives each dummy waypoint its own desired position
   independently (the mean of its immediate neighbours), which for a long
   edge's whole chain converges to a smooth, roughly even gradient spread
   across every intermediate rank — a distinct bend at *every* rank instead
   of one, confirmed live on a real diagram (three ranks, two waypoints,
   lanes drifting -0.50 → -0.28 → 0.01 → 0.36). That's the smoothest
   per-rank compromise in a least-squares sense, but the wrong objective
   for a schematic wanting the *fewest* bends, not the smallest average
   one — a transit map runs a line exactly parallel to its current track,
   then makes one deliberate diagonal switch, not a continuous drift.
   Since a dummy waypoint is never shared between edges, every interior
   waypoint of a chain can simply be pinned to its edge's own source lane,
   and the one closest to the target pinned to the target lane, with no
   risk of that fighting another edge's own preference for the same node.
   Each touched rank is then re-settled with the same
   `resolve_order_preserving` used everywhere else in this module, so this
   can only move a dummy within the order already fixed by ordering — it
   can shrink a gap to the minimum against a genuinely competing neighbour,
   never invert anything, so it cannot introduce a crossing that wasn't
   already safe. This mirrors the asymmetric lead the view applies at
   render time (`metro-layout`'s `route.ts#routeHop` `ARRIVAL_LEAD`, see below) — both
   layers now agree an edge's one bend belongs right before it arrives;
8. **spine centring**: the object type touching the most stations (the
   closest proxy to "most events" this crate can measure without raw event
   counts) is shifted to lane 0 at every rank it — or one of its waypoints —
   touches, and every other lane in that rank shifts by the same integer
   amount, so relative order and spacing are unchanged, only which lane
   counts as "the middle" is. Turns a left-packed diagram into one that
   visibly grows outward from its longest chain.

A dummy node is never a real `OutNode` — it exists purely as a `(rank,
lane)` pair on the owning edge's `waypoints` field. The wasm boundary
(`src/lib.rs`) exposes the whole thing as a `value-finalize/1` conversion
action, the same pattern `run.promenade.ocim.to-ocpn` uses for a pure
model-to-model transform with no SQL/log access.

`view-src/packages/metro-layout/src/route.ts` turns the integer rank/lane grid into pixels. A
node's own position is always its exact `(rank, lane)` grid point — nothing
ever moves a node to accommodate an edge. What can shift is where an edge's
*drawn line* sits relative to that node: `plugin.tsx#localOffsets` computes,
per edge, a `startOffset`/`endOffset` — 0 if that edge is the only one
touching its source (or target) node on that side, or a small evenly spaced
fan-out position if several edges share it, ordered by each edge's actual
approach or departure direction (`approachLane`/`departureLane` — the lane
of its last/first waypoint, or its source/target directly if it has none),
not by object type. Sorting by object type instead — an earlier version of
this — could disagree with the edges' real geometry: two lines whose real
positions run left-to-right one way but whose object types happen to sort
alphabetically the other way would get handed crossing fan-out slots,
forcing an avoidable crossing that has nothing to do with the graph, purely
an artefact of the sort key (object type is now only a last-resort tiebreak
between edges arriving from the exact same lane). This is deliberately
*local*, not the fixed global per-object-type offset earlier versions used:
a lone edge passes through its node's true centre, several edges converging
on the same node — even from different sources, not just a literal
parallel pair — fan out to distinct points instead of piling onto one
pixel. Being node-based, though, `localOffsets` can only ever separate
edges that *share* a node — two completely unrelated edges that merely
pass through the same rank-to-rank corridor mid-journey are invisible to
it, and the Rust layout has no structural reason to avoid that coincidence
either. `corridorOffsets` catches this directly: it scans every edge's
individual hops for another edge's hop landing on the same rank pair and
the same lane at both ends (confirmed as a real, live issue — two edges
sharing neither source nor target drawing exactly on top of each other for
a whole hop), and fans out only the colliding ones, added on top of
whatever node-based offset already applies at that point. `chainXs` folds each
node's grid position and its local offset into one effective x per point in
an edge's chain (source, any dummy waypoints, target), and `routeHop` draws
exactly one diagonal to cover the whole distance between two consecutive
x's — never two independent diagonals stacked on each other, which is what
could previously send a path one way and then partway back the other.
`routeThroughWaypoints` stitches a whole chain's hops into one continuous
polyline; each hop only ever spans one rank, so `routeHop` always takes its
simple two-rank branch. Row heights (`computeRowGaps`) reserve `MIN_LEAD` +
`ARRIVAL_LEAD` of straight run across *any* hop's shift, sized off its full
travel (lane shift and offset change together) — even for the one edge
whose own shift set the row's height, which otherwise settled to a
zero-length lead and met its node on a steep diagonal, or a diagonal running
straight into its own arrowhead, instead of coming in straight. That
reservation is deliberately split unevenly between the hop's two ends, not
50/50: departure gets capped at `MIN_LEAD`, arrival gets everything past
that. A symmetric split (this router's first version) starves the arrival
side exactly when it matters most — a large shift crammed into one row (a
loop edge jumping several lanes to reach a gateway far above it, say)
leaves so little room per side that the "straight run" is a sliver, and the
edge reads as coming in at a steep angle rather than settling into the node
from directly above; real transit maps commit to that asymmetry themselves,
a line can wander right after leaving a station but always meets the next
one straight-on. The final point is then pulled back to the target node's own visual radius
(`trimEnds`) — a node renders on top of its edges, so a path routed exactly
to its centre point had its arrowhead completely hidden underneath the node
artwork. Corners are eased into a short quadratic-Bézier curve
(`roundedPathFromPoints`) last.

## Interactivity

Clicking a line (on the canvas or in the legend) or a station highlights
every edge and node those object types touch, fading everything else —
clicking a shared station highlights *all* the types it touches at once.
Click the same thing again, or the canvas background, to clear it.

## Building

```bash
./package.sh
```

Requires `cargo`, `wasm-pack`, and Node/npm.
