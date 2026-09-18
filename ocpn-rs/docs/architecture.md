# Architecture

## Reuse of existing Promenade primitives

| Component | Status | Where |
|---|---|---|
| Trace-variant `EventLog`, `discover()`, `Tree` (Inductive Miner) | **Reused, unmodified**, as a path dependency | `../inductive-miner-rs/crates/inductive-miner-core` |
| Per-object-type OCEL projection semantics | **Reused** — the same convergence/divergence rules `flattenByObjectType` already implements, generalized to N object types in one SQL pass | `project.sql` (SQL Profile v1 program, compiled and run by the host's generic relational dispatch — mirrors `host/transform/compile.ts`'s flatten branch) |
| Activity dictionary encoding | **Reused convention** — dictionary-encoded on the host/SQL side before crossing into wasm, the same as every other Promenade wasm kernel | `app/src/worker/wasm-plugin-worker.ts`'s `prepare()` — the same generic worker every installed wasm plugin scans through, not a dedicated one for this plugin |
| ProcessTree → Petri net conversion | **Net new** — no such conversion exists anywhere else in this repository's Rust code (the only prior art is pm4py via Pyodide, not used here) | `crates/ocpn-discovery/src/tree_to_net.rs` |
| Merge-by-activity / variable-arc detection | **Net new** — OCPN-specific, no precedent | `crates/ocpn-discovery/src/lib.rs` |
| Colour registry (`objectType` domain) | **Reused** — same registry `OcdfgView`/dotted-chart already use | `app/src/host/services/colors.ts` |
| Selection bus, result store, zoom controls | **Reused** — same infrastructure every native graph view uses | `app/src/host/services/selection.ts`, `app/src/host/actions/results.ts`, `app/src/ui/views/{useZoom,ZoomControls}.tsx` |

## How this ships as one installable `.pmplugin`

An earlier version of this plugin lived partly in Promenade's own codebase
(a core-provider action, bespoke `ocpn-projection.ts`/`ocpn-plugin-worker.ts`
files, a hand-registered `ActionDef` in `core-actions.ts`) because OCPN
discovery's input is fundamentally different from every other miner's: it
needs a **combined, multi-object-type projection** built before any scan can
run at all, and neither the generic wasm dispatch (which resolves exactly one
input artifact's own event table) nor the plugin manifest (whose `runtime`
was a single package-wide field) had a hook for that.

That was judged a flaw in the *host*, not a reason to keep this discovery
special-cased: a plugin author with no access to Promenade's own source
should be able to build exactly this. Two infrastructure gaps were closed
generically, for every plugin, to make it possible:

- **Per-action manifest `runtime`.** `PluginManifest.actions[].runtime` (and
  matching `entry`/`wasm`/`kernel`/`queryFile` overrides) let one package
  declare actions of different runtimes — see `app/src/host/plugins/manifest.ts`.
  This plugin uses it to declare **two** actions instead of one.
- **A real relational output → artifact path.** `ActionContext.persistLog`
  (`app/src/host/actions/executeAction.ts`) lets an installed
  `runtime: 'relational'` action materialize a SQL Profile v1 program's
  output as a genuine, storage-backed artifact — not just an inline query
  result — via a generic worker command
  (`materializeRelationalLog` in `app/src/worker/data-worker.ts`).

With those in place, OCPN discovery is two actions under the hood, each
dispatched through the exact same generic runtime adapter any other
installed plugin's action of that runtime gets
(`app/src/host/plugins/runtimeAdapters.ts`):

- **`run.promenade.ocpn.project`** (`runtime: relational`, `project.sql`) —
  projects the OCEL onto every selected object type at once, output typed
  `TraditionalEventLog` (a real logical schema, so it materializes to real
  Parquet, not just an in-memory value). Declared `internal: true` (see
  below) — not offered as its own clickable action.
- **`run.promenade.ocpn.discover`** (`runtime: wasm`) — scans a projected log
  through the shared `wasm-plugin-worker.ts`, exactly like `alpha-miner-rs`
  or `inductive-miner-rs` scan theirs. Its own `inputs[0]` is declared
  `ObjectCentricEventLog`, not `TraditionalEventLog` — the type a user
  actually selects.

**Only one of the two is user-facing.** Through 0.1.0, both were separate,
independently-clickable actions: pick the OCEL, run "Project for OCPN
discovery", pick *that* output, run "Discover OCPN". Past the mechanics, this
was also a correctness trap left open to any user: `run.promenade.ocpn.discover`
declaring `TraditionalEventLog` as its input meant it showed up as "available"
against *any* log of that type, including a plain XES import — and running it
against one would have silently decoded a case id that isn't the
`type_idx * 8_000_000 + ordinal` encoding this plugin's own projection
produces.

0.2.0 collapses this into what a user actually wants — select the OCEL,
click "Discover OCPN" once — using two small, generic manifest capabilities
(`app/src/host/plugins/manifest.ts`, `app/src/host/actions/registry.ts`),
available to any plugin author, not specific to this one:

- **`internal: true`** on an action removes it from the Inspector's
  "Available actions" list without deregistering it — `produce()`'s own
  resolution (`actionRegistry.all()`) still sees it.
- **`scans: "<ArtifactTypeId>"`** on a `wasm`/`pyodide` action says: what
  this action's `inputs[0]` accepts is not what it scans. Before running,
  `wasmActionRuntime` calls `ctx.produce(action.scans, …)` — the *same*
  `ActionContext.produce()` any core action's own `run()` can call, not a
  parallel mechanism — to produce an artifact of that type from the
  selection, and scans that instead. `run.promenade.ocpn.discover` declares
  `scans: "TraditionalEventLog"`; `ctx.produce()` resolves that to the one
  action that outputs it (`run.promenade.ocpn.project`, still fully
  registered, just `internal`), runs it with the user's own params forwarded
  (so an `objectTypes` picker rendered on `discover`'s own params still
  reaches the projection's SQL), and records it as a real, inspectable
  provenance step — nothing about it is hidden, only the *separate click* is
  gone.

One more piece of data has to cross the same boundary an ordinary param
can't safely carry: which `(objectType, activity)` pairs are variable, a
fact only computable from the *original* OCEL log the projection action
sees, not from the projected log the mining action receives. This is not
OCPN-specific plumbing either — `project.sql` computes it as a third
`-- @output` block the projected log's own schema doesn't declare, which
`materializeRelationalLog` therefore records into the artifact's `meta`
generically (any non-schema `@output` block becomes `meta[name]`, rows as
column-value arrays), and `wasmActionRuntime` forwards any `meta` key whose
name matches a declared param — the same generic rule that already threads
`objectTypes` from the projection to the mining action. See "The WASM data
boundary" below and `docs/algorithm.md` §5.

The Rust crate itself was never the issue: it was always a proper,
independently buildable, natively testable Cargo workspace
(`ocpn-core`/`ocpn-discovery`/`ocpn-cli`) — the entire deviation this section
used to describe was in how the *browser build* was wired into the host, not
in the algorithm's own structure or portability, and that wiring is now
exactly what any third-party plugin author has available too.

## The WASM data boundary

One kernel session per discovery run, carrying every selected object type
through the **same** `pushChunk(cases, activities)` ABI every other
Promenade wasm plugin uses — no change to any shared infrastructure.

1. **The projection action (`project.sql`, run by the host's generic
   relational dispatch)** compiles one combined view spanning every selected
   object type: each type's cases are numbered into a disjoint range,
   `case = type_idx * 8_000_000 + local_object_ordinal`, then UNIONed, and
   materialized as a real `TraditionalEventLog` artifact. To the scan loop
   this looks like an ordinary single-log scan.
2. **The mining action's host runtime (`app/src/worker/wasm-plugin-worker.ts`,
   shared by every installed wasm plugin)** dictionary-encodes activities
   (first-appearance order, global across every object type — the same
   tie-break convention Inductive Miner's own kernel uses) and streams
   `(case, activity)` rows into the kernel.
3. **Kernel (`OcpnScan`, `src/lib.rs`)** recovers `type_idx = case_id /
   8_000_000` at case-close time — one integer division, no extra column,
   no change to the shared ABI — and buckets each closed trace into that
   object type's own variant map.
4. **`finalize(params)`** — `objectTypes` and `variableMultiplicity:
   [[objectType, activity], ...]` (both resolved by the projection action from
   the *original* OCEL log and forwarded generically via the projected
   artifact's own `meta`, not user-supplied — see "How this ships…" above and
   `docs/algorithm.md` §5), plus `variant`/`noiseThreshold` (real user params)
   — builds one `EventLog` per object type and calls `ocpn_discovery::discover`.
   Output crosses back as JSON via `serde-wasm-bindgen`, the same
   one-shot-result convention `inductive-miner-rs`'s kernel uses: a bare
   `ObjectCentricPetriNet`, not a wrapper around one.

**Never crosses the boundary**: raw OCEL JSON, an OPFS path, a DuckDB
connection, or per-event object identifiers beyond what a case id already
encodes. The plugin's only data door, on the host side, is `dataClient.sql()`
— the kernel itself never touches SQL at all, only the two integer columns
the host already reduced everything to.

## The artifact

`ObjectCentricPetriNet` (`app/src/host/artifact/ocpn.ts`) mirrors
`ocpn-core`'s Rust model field-for-field — the same contract in two
languages. No layout coordinates anywhere in it; layout is view state (see
below). Every id is a deterministic function of what the node means (see
`docs/algorithm.md` §4), so re-running discovery on unchanged input produces
byte-identical output. `validateOcpn()` runs at the artifact boundary, the
same role `validateProcessTree()` plays for `ProcessTree`.

## The view

`app/src/ui/views/OcpnView.tsx`, registered as `core.ocpnView` in
`Workspace.tsx`, `appliesTo: ['ObjectCentricPetriNet']`. Reuses
`colorRegistry` (`objectType` domain — same colours as `OcdfgView`/dotted
chart), `selectionBus`, `resultStore`, `ZoomControls`. Object-type
visibility, silent-transition visibility, layout direction and edge routing
are view params (`ownsControls: true`, persisted per saved view like
`OcdfgView`'s own filters) — they never touch the artifact.

Places are circles (object-type colour outline), source/sink get a double
ring, transitions are rounded rectangles (silent ones a small filled bar),
arcs are coloured by object type with variable arcs dashed — see
`docs/algorithm.md` and the legend rendered in the view itself for the exact
notation.

## ELK layout

First use of `elkjs` in this repository — every existing graph view
(`dfgLayout.ts`, `petrinet-layered`) uses a hand-rolled Sugiyama layout
instead. `app/src/ui/views/ocpnLayout.ts` builds the ELK graph and configures
the layered algorithm:

```js
{
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',              // or 'DOWN', a view setting
  'elk.edgeRouting': 'SPLINES',          // or 'ORTHOGONAL' / 'POLYLINE'
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.nodePlacement.favorStraightEdges': 'true',
  'elk.layered.spacing.nodeNodeBetweenLayers': '74',  // matches dfgLayout.ts's RANK_GAP
  'elk.spacing.nodeNode': '40',
  'elk.spacing.edgeNode': '20',
  'elk.spacing.edgeEdge': '12',
  'elk.partitioning.activate': 'true',
}
```

**OCPN-specific hint**: every `source_OT` place gets
`elk.partitioning.partition: '0'`, every `sink_OT` place gets partition
`'2'`, everything else (internal places, transitions) gets `'1'`. This pins
each object type's entry toward the left and exit toward the right without
attempting a full per-object-type lane assignment — a bounded, well-
understood ELK feature rather than bespoke pre-processing whose correctness
would be hard to verify. See `docs/algorithm.md`'s "Known differences" for
why a fuller per-object-type layout scheme was deliberately left out of v1.

**Off the main thread, without a hand-rolled worker wrapper.** elkjs ships
its own worker-offload mechanism: `elkjs/lib/elk-api.js` is a thin promise
wrapper that talks over `postMessage` to whatever `Worker` its
`workerFactory` constructs, and `elkjs/lib/elk-worker.min.js` is the actual
layout engine. `ocpnLayout.ts` hands it a real Vite-bundled worker via the
`?worker` import suffix (`import ElkWorker from
'elkjs/lib/elk-worker.min.js?worker'`) — the same mechanism that builds
`ocpn-plugin-worker.ts` into its own chunk. A second, hand-rolled
`postMessage` wrapper around that would just be a worker wrapping a worker.

(`elkjs/lib/elk.bundled.js`, the "all-in-one" browser build, looks like the
obvious first choice, but its default constructor tries to build its *own*
worker through a Node-oriented fallback path — `require('./elk-worker.min.js').Worker`,
a synchronous shim meant for Node's `require`, not a bundler — that does not
survive being bundled by Vite; constructing `new ELK()` with no options
throws `TypeError: _Worker is not a constructor` at runtime. `elk-api.js`
plus an explicit `workerFactory` sidesteps this entirely and is elkjs's own
documented integration path for bundlers.)
