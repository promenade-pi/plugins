# Promenade plugins

Every analysis, miner and visualisation in [Promenade](https://github.com/promenade-pi/promenade)
ships as a plugin — 52 of them in this repository. The app itself knows nothing
about process mining: it provides storage, typed artifacts, a scheduler and a
sandbox, and everything else arrives from here.

Plugins are installed **at runtime** from a registry, not compiled into the app.
Each is packaged as a `.pmplugin` archive (a zip: manifest, entry point, docs,
and whatever runtime payload it needs) and published to the registry the app
reads. Nothing here is a build dependency of the app.

## What a plugin is

A directory with a `manifest.json` declaring some combination of:

- **actions** — produce a new artifact from existing ones (discover a model,
  check conformance, transform a log). Typed: an action declares what it
  consumes and produces, and the host only offers it where the types fit.
- **views** — render an artifact in a sandboxed iframe, with no access to the
  host page, the filesystem or the network beyond the API the manifest asks for.
- **artifact types** — new kinds of object other plugins can then consume. An
  artifact type declared here can be produced by one plugin and read by another.

67 actions and 65 views across the 52 plugins.

## The four runtimes

| Runtime | Used for | Built from |
|---|---|---|
| `wasm` | Rust kernels — the miners, conformance, layout | `crates/`, via `wasm-pack` |
| `pyodide` | pm4py and other Python reference implementations | `plugin.py` |
| `relational` | Set-based work pushed into DuckDB as SQL | `*.sql` |
| `view` | Sandboxed TypeScript/React panels | `view-src/`, via esbuild |

A plugin may use several: the object-centric miners typically project the log
in SQL, mine in Rust, and render in a view.

## Index

### Control-flow discovery

- **[Inductive Miner](inductive-miner-rs/)** `wasm` — Leemans' Inductive Miner (IM and IMf) in Rust: recursively cuts the directly-follows graph into a block-structured process tree
- **[Inductive Miner (pm4py)](inductive-py/)** `pyodide` — Discovers a process tree with pm4py's inductive miner, and converts it to an accepting Petri net
- **[Inductive Visual Miner](inductive-visual-miner/)** `wasm` — Runs browser-native, exact alignment replay between a traditional event log and an accepting Petri net, then animates token flow in React Flow
- **[Heuristics Miner](heuristics-miner-rs/)** `wasm` — Flexible Heuristics Miner: discovers a causal net or converts its AND/XOR grouping to an accepting Petri net with silent routing transitions,…
- **[Fuzzy Miner](fuzzy-miner-rs/)** `wasm` — Günther & van der Aalst's Fuzzy Miner for case-centric event logs: instead of a control-flow model it measures the log from several perspectives —…
- **[Split Miner](split-miner-rs/)** `wasm` — Augusto, Conforti, Dumas, La Rosa and Polyvyanyy's Split Miner: an event log to a BPMN model in five steps — directly-follows graph and loops,…
- **[Alpha Miner (Classic)](alpha-miner-rs/)** `wasm` — van der Aalst's original 2004 discovery algorithm — the textbook starting point for process discovery, kept here mainly for teaching its own…
- **[Directly-Follows Graph (Rust)](dfg-rs/)** `wasm` — Discovers a directly-follows graph from an event log: for every pair of activities that ever occur back-to-back within a case, the number of times it…
- **[Local Process Models](lpm-rs/)** `wasm` `sql` `pyodide` — Discovers Local Process Models: small, frequently-recurring Petri-net fragments over a subset of a log's activities, each possibly firing several…

### Object-centric discovery

- **[Object-Centric Petri Net Discovery](ocpn-rs/)** `sql` `wasm` — Discovers an Object-Centric Petri Net from an OCEL 2.0 log: per selected object type, project the log, mine a process tree with Inductive Miner,…
- **[OCPN Discovery (pm4py)](ocpn-pm4py/)** `pyodide` — Discovers an Object-Centric Petri Net directly from an OCEL 2.0 log using pm4py's own object-centric discovery (pm4py.discover_oc_petri_net), run in…
- **[Object-Centric Inductive Miner](ocim-rs/)** `sql` `wasm` — Niklas van Detten's Object-Centric Inductive Miner in Rust
- **[OC-DFG Discovery (pm4py)](ocdfg-pm4py/)** `pyodide` — Discovers an Object-Centric Directly-Follows Graph directly from an OCEL 2.0 log using pm4py.discover_ocdfg, run in Pyodide
- **[TOTeM Discovery](totem/)** `pyodide` — Discovers a Temporal Object Type Model (TOTeM): a type-level graph of an OCEL log's object types, connected by their most precise event-cardinality,…
- **[Object-Centric Variant Metro](variant-metro/)** `wasm` `pyodide` — An experimental metro map whose slider is the number of process variants, not the number of arcs

### Conformance & log quality

- **[Conformance Checking](alignment-rs/)** `wasm` — Replays a log against a Petri net two ways: alignments (the cheapest explanation of every trace variant, with fitness and escaping-edges precision)…
- **[OCEL/OCPN Replay](ocpn-replay/)** `pyodide` — Replays every timestamped OCEL event against a selected Object-Centric Petri Net using a deterministic object-bound token game
- **[Soundness Checker](soundness-rs/)** `wasm` — Verifies an accepting Petri net: is it a workflow net, and is it sound?
- **[Log Quality](log-quality/)** `pyodide` — Data-quality analysis for XES and OCEL logs
- **[DECLARE](declare-rs/)** `wasm` — Declarative process mining: instead of a model you can walk through, a list of rules the process never broke — “every claim is eventually assessed”,…
- **[Log Skeleton](log-skeleton-rs/)** `wasm` — The facts a log never broke: which activities always follow which, which never occur together, which occur equally often, and how many times each may…
- **[OCPN Comparison](ocpn-compare/)** `pyodide` — Compares two Object-Centric Petri Nets per object type
- **[OCEL Relation Gaps](relation-gap/)** `sql` `pyodide` `wasm` — Simulates and reconstructs missing event-object relations in an OCEL 2.0 log

### Transformation, generation & authoring

- **[BPMN 2.0](bpmn-rs/)** `wasm` — BPMN 2.0 support: convert a process tree or a Petri net to a BPMN diagram, convert a BPMN diagram back to a Petri net or process tree, replace…
- **[Petri Net Reduction](net-reduce-rs/)** `wasm` — Removes the scaffolding from an accepting Petri net without changing what it does
- **[Play-out](playout-rs/)** `wasm` — Simulates an accepting Petri net into a real event log — the inverse of discovery
- **[Process Tree Generator](tree-generator-rs/)** `wasm` — Draws a random process tree from a parameterised distribution, after Jouck and Depaire's PTandLogGenerator: how many activities, how much…
- **[Event Log Transformations](event-log-transformations/)** `pyodide` — Compares two object-centric event logs
- **[OCEL Builder](ocel-builder/)** `view` — Writes an OCEL 2.0 log by hand, schema first, and edits existing ones
- **[Object-Centric OLAP](ocel-olap/)** `sql` — The four multi-dimensional operations on an object-centric event log: drill down and roll up along the object-type dimension, unfold and fold along…
- **[Petri Net Editor](net-editor/)** `view` — Draw a Petri net or an object-centric Petri net by hand, or open an existing one and edit it

### Organizational mining

- **[Social Network Mining](social-network/)** `wasm` — Derives the organisation from the log: who hands work to whom, who subcontracts, who works together, who does the same kind of work
- **[Organizational Model Mining](org-model/)** `wasm` — Groups the people in a social network into roles, and names each one by the work its members do
- **[Resource Behavior](resource-behavior/)** `wasm` — How each person in a log actually works: how much they do, how fast, how specialised, how often they batch or juggle several things at once, and…

### Visualisation

- **[Metro Map](metro-map/)** `wasm` — Renders an object-centric process as a transit-schematic 'metro map': activities become stations shared across object types, object types become…
- **[Metro Station](metro-station/)** `wasm` — The metro-map metaphor taken into the third dimension, the way a station atlas draws Shinjuku: activities are circular platforms, object types are…
- **[Process Friction Topography](friction-topography/)** `view` — A performance overlay that makes waiting time part of the model's geometry
- **[Interaction Atlas](interaction-atlas/)** `view` — Object-centric visual analytics for when and how objects co-occur over their lifecycles
- **[Performance Spectrum](performance-spectrum/)** `view` — Fine-grained performance analysis after Denisov, Fahland, and van der Aalst: every observed directly-follows segment is plotted over calendar time…
- **[Dotted Chart](dotted-chart/)** `view` — A dotted chart of events over time: rows by case, activity, resource or object type; color by any of those; actual, relative or logical time;…
- **[Object Dynamics](object-dynamics/)** `view` — A family of independent object-centric exploration views over an OCEL 2.0 log: Multiplicity, Type Signatures, Lifecycle Repetition, Activity Timing,…
- **[Synchronization Lens](synchronization-lens/)** `view` — Explains which related objects keep a target object from satisfying an object-centric synchronization rule
- **[OC-DFG Viewer](ocdfg-flow-view/)** `view` — An interactive Object-Centric DFG renderer using React Flow and the same tuned ELK layered preset as the OCPN React Flow view
- **[OCPN Viewer](ocpn-flow-view/)** `view` — A second renderer for Object-Centric Petri Nets: React Flow for rendering, elkjs (layered algorithm, run synchronously — the sandboxed view…
- **[OC-DFG Backbone Layout (IP)](ocdfg-backbone-layout/)** `pyodide` — Lays out an Object-Centric Directly-Follows Graph with the backbone-based method of Lee, Song and van der Aalst: each object type gets its own…
- **[Petri Net](petrinet-layered/)** `view` — React Flow renderer for accepting Petri nets, using the same ELK layered preset as the OCPN React Flow view
- **[Process Tree View](process-tree-view/)** `view` — Draws a process tree: operator nodes, activity leaves and silent steps, with the operator notation used by pm4py
- **[OCEL 2.0 Inspector](ocelot/)** `view` — Ocelot (rwth-pads/ocelot) ported into an OCEL 2.0 inspector: an object-type / event-type relationship graph, paginated Objects and Events tables with…
- **[Cases & Variants (OCEL)](ocel-cases-variants/)** `view` — The object-centric analog of the traditional "Cases & variants" view
- **[Cardinality Impact Explorer](cardinality-impact-explorer/)** `pyodide` — Explores how an object-type cardinality scenario propagates into the variants, elapsed time and rework indicators of a downstream object lifecycle in…
- **[Raw Artifact Viewer](raw-artifact-viewer/)** `view` — Looks at an artifact the way its storage does: a tree of the files actually present in its OPFS directory — Parquet relations, the catalog sidecar, a…
- **[Survey & Task](survey/)** `view` — Runs a study inside the workspace: a questionnaire panel that opens the visualisation each question is about, beside itself, with the parameters the…

## Building

Each plugin carries its own `package.sh`, which builds whatever that plugin
needs (`wasm-pack build`, an esbuild bundle of `view-src/`, or nothing at all)
and zips the result into `dist/<id>-<version>.pmplugin`:

```bash
cd metro-map && ./package.sh
```

The scripts run under `set -euo pipefail` and several gate on a test suite
(`npm run check`) before packaging — a failing invariant stops the build rather
than producing a package. Rust build output (`target/`, `pkg/`), view bundles'
`dist/`, and `node_modules/` are not tracked; `package.sh` regenerates them.

## Porting from ProM

[`PORTING.md`](PORTING.md) is the account of porting ProM's Inductive Miner to
Rust/WebAssembly — reaching behavioural parity with the reference over ~208,000
differential cases, and the three host-boundary defects that survived all of
them. It opens with the licence gate, which matters more than it looks:

> The licence is usually not in the repository.

ProM's framework is GPL and individual packages set their own terms, so a
*translation* of one cannot be MIT. Where the reference implementation's licence
forbids it, the plugin here is an independent implementation written from the
published algorithm and its paper — algorithms are not copyrightable, their
expression is. `split-miner-rs/docs/licensing.md` and
`inductive-miner-rs/docs/licensing.md` record that reasoning per plugin.

Plugins that port or build on someone else's public work cite it in their
manifest, README and `docs/`.

## Licence

MIT — see [LICENSE](LICENSE).
