# Cases & Variants (OCEL)

The object-centric analogue of the traditional "Cases & variants" view
(`core.traceExplorer`, `TraditionalEventLog`-only — case is a single-object
concept and does not generalize by itself). This implements the case/variant
notion from Adams, Schuster, Schmitz, Schuh & van der Aalst, ["Defining Cases
and Variants for Object-Centric Event Data"](https://arxiv.org/abs/2208.03235)
(arXiv:2208.03235):

- **Case → process execution.** The *object graph* connects two objects
  whenever they co-occur in an event (not the `{o2o}` relation — that is a
  separate, explicitly-declared link the paper's case notion does not use). A
  process execution is a connected subgraph of that graph, together with the
  events touching its objects and the directly-follows edges between them.
  Two extraction techniques (the params panel switches between them):
  - **Leading type** — every object of a chosen type roots its own
    execution; a breadth-first search pulls in, for every other type, only
    the object(s) at the shortest graph distance from the root.
  - **Connected components** — every transitively co-occurring object is
    grouped into one execution. Parameter-free, but a highly entangled log
    can collapse into a single giant execution.
- **Variant → equivalence class.** Two executions are the same variant iff
  their activity-labelled directly-follows graphs are isomorphic. Exact graph
  isomorphism has no known polynomial algorithm, so — as the paper itself
  does — this buckets executions by a Weisfeiler-Lehman canonical hash first,
  then runs a small backtracking matcher to verify true isomorphism within
  each bucket (bucket sizes are typically tiny). A bucket whose members
  exceed `VERIFY_NODE_CAP` (`src/lib/isomorphism.ts`) events skips
  verification and is trusted as one variant outright — the same scalability
  concession the paper makes for its own baseline.
- **Visualization.** A swimlane per object, events placed in a shared DAG
  column so partial order and shared/concurrent events line up across lanes
  — same idea as the paper's Table I/III. The `chevronColor` param picks how
  each chevron is filled:
  - **By involved object types** (default) — a chevron is split into
    diagonal bands, one per distinct object type touching that event
    (`promenade.color('objectType', type)` per band), which is what Table I
    itself specifies for a shared event: "each type has a specific base
    color... colored with the corresponding colors" (plural) — not just the
    lane's own type. This is also how
    [ocpa](https://github.com/ocpm/ocpa)'s reference rendering
    (`docs/source/_static/variant.png`) draws a shared event. A chevron
    touched by only one type renders as a plain solid fill (the multi-band
    gradient degenerates to one band). Each lane also gets the same pale
    type wash behind its row as "by swimlane" below, so a lane's own type
    still reads at a glance even though its chevrons carry every touching
    type.
  - **By activity** — every chevron is a single solid color from its
    activity, the same convention as the compact path chips in the
    Variants/Cases tables and the rest of the view: the same activity reads
    as the same color in every lane, at the cost of not showing which object
    types share the event. No lane wash either, since a lane's own type
    plays no part in this mode.
  - **By swimlane** — every chevron in a lane takes that lane's own
    object-type color, plus a pale wash behind the whole row
    (`color-mix(in srgb, ...)`), good for a quick read of which single
    object type dominates an execution, but blind to any other type sharing
    a given event — a simplification of Table I's convention, not a
    reproduction of it, kept as an option because the at-a-glance
    "which type owns this lane" reading is sometimes what's wanted.

  A wide execution scrolls horizontally inside its own row rather than
  ballooning the whole table (see `.trace-cases-table`/`.trace-variants-table`
  below). The lane-label column (which object a row is) is a separate,
  never-scrolling pane next to an independently `overflow-x: auto` cell pane
  — not `position: sticky` on a grid item, which stops sticking as soon as
  the scroll passes that item's own grid-area width (a grid item's
  containing block for sticky purposes is its own area, not the whole grid).
  The label pane fades in a drop-shadow off its trailing edge once the cell
  pane scrolls — the label being visible either way, the shadow is what
  actually tells you there's more to the left.

## Cross-checked against ocpa

[ocpa](https://github.com/ocpm/ocpa) is the reference Python library by the
same authors (Adams, Park, van der Aalst). Its
`ocpa/algo/util/process_executions/versions/leading_type.py` and
`ocpa/algo/util/variants/versions/twophase.py` were read directly to sanity-check
this plugin's reading of the paper:
- **Object graph & leading-type extraction match**: `leading_type.py` builds
  the object graph from `itertools.combinations` of each event's full object
  set (no qualifier filtering, same as here), and pulls in *every* event of
  every object once it's included in a case — with no size cap. A hub object
  causes the identical blow-up there; this isn't a misreading of the paper on
  this plugin's part. (One difference: `leading_type.py`'s BFS prunes its
  search frontier through objects it doesn't end up keeping, which can
  under-count reachable objects of a further-out type in some topologies —
  this plugin computes true shortest-path distances first via a full BFS,
  then filters, which reads as more faithful to Def. 6's `dist(o,o')`-based
  definition.)
- **Variant computation matches**: `twophase.py` buckets by
  `nx.weisfeiler_lehman_graph_hash` first, then optionally verifies exact
  isomorphism pairwise within each bucket via `nx.is_isomorphic` — the same
  two-step structure as `src/lib/isomorphism.ts`. Notably, `ocpa`'s exact
  verification step defaults to *off* (`exact_variant_calculation=False`) —
  this plugin always verifies (up to `VERIFY_NODE_CAP`), so it's the more
  conservative of the two by default.

## Scoping shared objects to their closest case (extension beyond the paper)

Def. 4 has no time- or locality-scoping: once an object is in a case's
object set O′, *every* event that object was ever involved in — anywhere in
the log — becomes part of that case, full stop. On a log where a handful of
resource objects are reused across almost every case (a runway, a fuel
truck, an employee), this makes the strict reading close to unusable: one
turnaround's process execution ends up including a runway's *entire* history
across every other flight that ever used it.

With `scopeSharedObjects` on (the default, for leading-type extraction only —
`"Scope shared objects to their closest case"` in the params panel), a shared
object still legitimately appears in every case it touches (you still see the
runway's lane), but only its events *closest to that specific case* are
counted; its unrelated appearances elsewhere are not. "Closest" is **not**
graph distance — a hub object sits at distance 1 from every event it touches,
so a closest-by-distance tie-break would just re-include its whole reach.
Instead, for every event, `computeAllowedEventsByRoot` (`src/plugin.tsx`)
finds the touching object with the smallest *membership count* — how many
executions include that object at all — and assigns the event only to the
case(s) that include that least-shared, most case-specific anchor (a runway
touches hundreds of executions; the specific flight touching the same event
usually touches exactly one). Ties keep every case sharing the minimum,
consistent with how leading-type extraction already treats per-type distance
ties elsewhere. This computation is global (one pass over every event,
independent of how many leading-type roots there are), not per-execution, so
it's cheap even on a log with thousands of cases.

This is an explicit, opt-out deviation from Def. 4, not an interpretation of
it — turn `scopeSharedObjects` off to see the paper's strict reading (and
watch entangled logs collapse back into `MAX_EXECUTION_EVENTS`-truncated
"showing the first N events" territory).

## Documented simplifications

- **Truncation on entangled logs.** A real object graph is sometimes one
  single densely-connected component — a shared hub object (an employee, a
  truck, a busy customer) links a large part of the log together, and every
  execution's true event set can approach the whole log. There's no Worker to
  offload that to (the sandboxed view's CSP blocks them), so executions are
  truncated to their chronologically-first "Max events per execution" events
  (default 300, tunable in the params panel). Truncation is deterministic and
  provably exact — not an arbitrary cutoff — see `buildExecution`'s doc
  comment in `src/plugin.tsx` for the proof — so two executions that agree on
  their early behavior still truncate to the same graph and group into one
  real variant, rather than every large execution being forced into its own
  singleton. The paper's own evaluation hits the same wall from the other
  direction: on its synthetic maximally-entangled dataset (DS2), it reports
  "almost no process execution is equivalent to any other... a clustering or
  subgraph mining approach might be more suited for such extreme cases" — a
  genuinely, sometimes-irreducibly hard case for this case notion, not a bug
  to hide.
- **Directly-follows scope.** The paper defines `D = con_L ∩ (E'×E')`, where
  `con_L` ranges over *every* object in the whole log, not just the
  execution's own object set. This plugin computes directly-follows edges
  only from the objects actually inside the execution. For connected
  components the two definitions are provably identical — no outside object
  can share an event with the execution without already being part of the
  same component. For leading-type extraction it is a minor, documented
  approximation: an object left out of this particular execution (because a
  closer same-type object won) that still directly-follows-links two of its
  events, strictly speaking, is not reflected in `D`.
- **Layout.** The paper's Algorithm 1 computes each event's horizontal
  position via a two-directional `x_start`/`x_end` recursion. This plugin
  uses a standard DAG longest-path-from-sources layering (Kahn's algorithm
  with a running max) instead — the same left-to-right partial-order reading
  with far less code, at the cost of not reproducing the paper's exact
  column-width bookkeeping.

## Isolation

Runs behind an opaque origin: no host DOM, no storage, no credentialed
network, no panel handle. All data comes through `promenade.sql()` — the
object graph, event/object tables, and per-object event sequences are loaded
in full (case/variant computation is inherently a whole-log, not a
per-page, computation), so a very large or extremely entangled log may be
slow to extract and hash client-side.

Since the sandbox has no storage of its own, that extraction is redone from
scratch on every fresh iframe — which closing and reopening this exact
panel's tab used to always mean. `promenade.setCachedState()`/`cachedState()`
close that gap: the raw object/event data (`RawData`, with its `Map`s intact
— the channel is a structured clone, the same one `sql()`'s own results
cross on) is handed to the host once loaded, and handed straight back on the
next open of the same panel, skipping the SQL fetch. The computed
`executions` *and* the variant grouping that follows them (`computeVariants`
— a Weisfeiler-Lehman canonical hash over every execution, run again by
`summarizeVariants`) are cached alongside it, tagged with a signature of the
params that produced them (`extraction`/leading type/`maxEvents`/
`scopeSharedObjects`) — a reopen with that exact combination still showing
skips both, not just the fetch; a reopen after changing any of them falls
back to recomputing from the cached `raw`, still skipping the fetch. Either
way the "extracting…" chevrons get a chance to paint before each of those
two recomputations runs (each is a `setTimeout(…, 0)`-deferred effect, not
a blocking `useMemo`) — a `raw` restored from cache turned the SQL wait
into silence, not speed, without this: extraction and variant-grouping are
each their own real cost, and a plain `useMemo` runs inline during render
with no paint in between, cached `raw` or not.

`cachedState()` itself is an RPC (`await`ed, same as `sql()`), not a value
read synchronously off the initial handshake — on a log Order Management's
size, `raw` plus 7,659 execution graphs plus 4,923 variant summaries is
large enough that the structured clone needed to hand it back across the
iframe boundary is itself a real, sometimes multi-second cost, paid by the
browser as part of delivering whatever message carries it. Baked into the
synchronous `init` payload the earlier version of this used, that cost
landed *before* this component's own code — the thing that would otherwise
render a loading state — had run even once: nothing can paint during a
cost that precedes the first paintable frame. Asking for it afterwards
means React has already committed its first render (`executions` starts
`null`, so that first paint is already the loading chevrons) before the
clone cost lands — the total wall-clock time doesn't change, but the page
is never inexplicably frozen while it passes.

This only helps within one browser session — a page reload starts the
host's cache over empty, same as everything else the sandbox itself cannot
remember.
## Reusable execution partitions

The **Create execution partition** button publishes a typed, source-bound
`ObjectCentricExecutionPartition`. It records the exact extraction settings,
execution-to-variant membership, and the event/object identifiers used by each
execution. It does not copy OCEL event or object records: downstream views
resolve the memberships against the source OCEL recorded in provenance.

The first implementation uses bounded inline storage. If a partition exceeds
8 MiB, publishing stops with an explicit message; no execution is silently
truncated beyond the already-declared `Max events per execution` setting.
