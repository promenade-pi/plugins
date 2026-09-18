# Object-Centric Variant Metro

An **experimental** metro map of an object-centric log whose slider is the
number of **process variants**, not the number of arcs.

At the top of the slider you see the object-centric directly-follows graph of
the *whole* log — every variant. At the bottom you see the single **most
frequent variant** alone. Every position in between is the OC-DFG of exactly
the *k* most frequent variants, drawn on a layout that never moves.

That is the whole idea: the ordinary way to simplify a discovered graph is to
throw away infrequent *arcs*, which produces a picture no single case ever
followed. Filtering by variant instead only ever shows you graphs that real
groups of cases actually produced — and stepping up one notch at a time shows
you, one behaviour at a time, what the next-most-common group of cases adds.

## What it does, in order

1. **Extracts process executions** from the object graph — the object-centric
   analogue of a case. Either *leading type* (every object of the chosen type
   roots its own execution, pulling in the closest related objects) or
   *connected components* (every transitively co-occurring object in one
   execution).
2. **Groups them into variants** by activity-labelled graph isomorphism: a
   Weisfeiler-Lehman canonical hash buckets the likely-equivalent executions,
   then a backtracking matcher verifies isomorphism within each bucket.
3. **Folds every variant back into one OC-DFG**, recording on each node and
   arc the rank of the most frequent variant it first appears in
   (`minVariant`), along with its per-variant counts.
4. **Lays that graph out as a metro map**, once, over every variant.

Steps 1 and 2 are a direct port of the
[Cases & Variants (OCEL)](../ocel-cases-variants) plugin's own
`objectGraph.ts` and `isomorphism.ts` — deliberately, so the two plugins agree
on what a variant is. Following Adams, Schuster, Schmitz, Schuh & van der
Aalst, *"Defining Cases and Variants for Object-Centric Event Data"*
([arXiv:2208.03235](https://arxiv.org/abs/2208.03235)); `scopeSharedObjects`
and `maxEvents` carry over from that plugin with the same meanings, the same
defaults and the same documented deviation from the paper's Definition 4.

Step 4 is not reimplemented here. It calls `metro-map-core`, the layout crate
of the [Metro Map](../metro-map) plugin, exactly the way that plugin's own
OC-DFG action does — including `rankTiebreak`, which defaults to `frequency`
here as it does there. This package's Rust is only the variant attribution on
top: it reconstructs the node and arc ids that crate mints and writes
`minVariant` / per-variant counts onto them, so the shared crate stays free of
this plugin's own concern. `cargo test` asserts that every node and arc really
does get attributed, which is what would break first if that id format ever
changed.

## Why the slider can be dragged without the map jumping

Because the layout runs once, over the complete graph, and `minVariant` is
**monotone along every arc**: an arc can never appear in an earlier variant
than the stations at its ends, so the set of visible elements only ever *grows*
as the slider rises, and never contains an arc whose endpoints are hidden.
Filtering is then a comparison, not a recomputation. (`cargo test`'s
`min_variant_is_monotone_along_every_edge` asserts this rather than assuming
it.)

The view half of the layout is shared the same way the crate is: since 0.3.0
this plugin consumes `metro-layout`
(`../metro-map/view-src/packages/metro-layout`) rather than its own copy, so
re-ranking, track allocation, routing and the final drawn-geometry refinement
are one implementation gated by one invariant suite, which `npm run check`
here runs exactly as the Metro Map plugin does.

The visible subgraph is still re-ranked and re-laned in the view, as a
*monotone refinement* of the full model's own rank and lane — a station only
ever settles further down as detail is hidden, never sideways. Turning
**Preserve layout stability** off instead lays out each position fresh from
only what is currently visible. Häge & Rehse, *"Mental Maps in Process Mining:
Does Stabilizing DFGs Improve Process Analysis Performance?"* (BPM 2025), found
no positive effect from stabilisation in their study — which is why this is a
toggle rather than a decision baked in.

## Verifying the view

The view is a *sandboxed* (opaque-origin) frame: nothing outside it can read
its DOM or click it. Worse, React Flow only mounts edges once the document
performs its rendering lifecycle, so in a hidden or non-compositing tab this
view draws its stations and **no lines at all** — which looks exactly like a
router bug and is not one. So the plugin ships its own harness, the same
approach `plugins/friction-topography` takes:

```bash
cd view-src
npm run build && npm run harness          # stage into app/public/__vm-harness/
node harness/drive.js --out /tmp/shots --variants 1   # headless Chrome, real rAF
npm run harness:rm                        # unstage when done
```

`drive.js` prints the page's own probe line — node, station and arc counts plus
the panel readout — which is what to assert against; the screenshot is for
judging how it reads. `--payload` on `npm run harness` swaps in a payload built
from a real log (`python3 harness/make-payload.py --log <ocel2.json>`);
`harness/payload.json` is the checked-in fixture, regenerated by the same
script from `check.py`'s own three-variant order log.

## Reading the map

- **Stations** are activities, shared across every object type that reaches
  them; the coloured dots on a station say which types those are.
- **Lines** are object types, routed with 45°-only turns and a consistent
  parallel lane order.
- **▶ / ■** are the start and end of an object type's own lifecycle.
- A line running **backward up the page** is a genuine loop (rework).
- **Arc labels** (frequency, or mean wait) are counted over the variants
  currently shown, never over the whole log — so the number on an arc always
  matches the picture around it.

## Parameters

| Parameter | Default | What it does |
| --- | --- | --- |
| Extraction method | Leading type | What counts as one case (see above). |
| Leading object type | most frequent | Only for leading-type extraction. |
| Scope shared objects to their closest case | on | Keeps a reused hub object (a runway, a fuel truck) from dragging its whole history into every case it touches. |
| Slider positions | 25 | How many of the most frequent variants get a position of their own. Everything past that shares one final position, so the top of the slider is always the complete log. |
| Object type limit | 12 | How many object types are *drawn*. Variants are always computed over every type — this only limits the picture. |
| Max events per execution | 300 | Safety bound for a densely entangled object graph; past it an execution keeps its chronologically-first N events (still a real, comparable graph). |
| Rank tie-break | Frequency | Which direction wins when two object types form a cycle only by sharing stations. Frequency keeps the busier one. |

## How extraction stays affordable

Leading-type extraction is defined per root: explore the object graph and keep,
for every other type, the object(s) at the shortest distance. Done literally
that is one full graph traversal per root — and a single shared hub object (an
employee, a runway) makes the object graph fully connected, so "full" means the
whole log. On the order-management sample that is 7 819 traversals of an
11 872-object graph: 213 seconds.

The way out is a restatement of the same definition. An object `o` belongs to
root `r`'s execution exactly when `d(r, o) = D_type(o)(r)`, where `D_t` is the
distance to the *nearest* object of type `t` — and each `D_t` is one
multi-source BFS from all objects of that type, so all of them together cost a
handful of passes over the graph rather than one per root. Each root then only
has to search down to `K = max_t D_t(r)` levels (1 or 2, in practice), and at
that last level only has to look up the types still outstanding instead of
enumerating a hub's whole neighbourhood. Same result — `check.py` asserts it
against the plain per-root search on randomised logs, and it is bit-identical
on the real sample — in 0.2 seconds instead of 213.

## Limits worth knowing

- **This is an experiment.** Variant grouping is still quadratic within a hash
  bucket, and everything runs in Pyodide; a large, densely entangled log will
  take a while. `maxEvents` and `Slider positions` are the two dials that
  bound it.
- **The "all variants" graph is not identical to `core.discover.ocdfg`.** It is
  the union of the *per-execution* directly-follows graphs, so an object's
  consecutive events are only related when both fall inside the same
  execution. That is the right reading for this plugin (a variant is a property
  of an execution) and it is why the numbers can differ slightly from the
  plain OC-DFG's.
- **A hash bucket larger than 40 events skips exact verification** and is
  trusted as one variant — the same scalability concession the paper and the
  Cases & Variants plugin both make.
