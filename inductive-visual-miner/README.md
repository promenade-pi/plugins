# Inductive Visual Miner

An alignment-backed, animated process-model replay for Promenade, plus a
directly-follows visual miner that can be started on a traditional event log.

The original Inductive Visual Miner works from a process tree and uses an
expanded model for lifecycle-aware alignment. Promenade's replay view accepts
the equivalent `TraditionalEventLog + AcceptingPetriNet` interchange model so
it can visualise models from every Promenade miner. Its alignment kernel is
implemented in Rust/WASM: it finds the exact cheapest alignment with Dijkstra
over the synchronous product, once per distinct trace variant. No Pyodide or
PM4Py payload is downloaded for this plugin.

The viewer draws a bounded, representative token sample on top of the same
ELK spline routes React Flow uses for the model. It does **not** animate every
real case: exact sample counts and deviations are retained in the artifact,
while at most 220 particles are drawn at once.

## Directly-Follows Visual Miner

**Mine with Directly-Follows Visual Miner** is available directly on a
`TraditionalEventLog`. It calculates the observed directly-follows graph from
the full selected log and opens an animated React Flow view immediately. Its
event ordering is deliberately identical to the relational Discover DFG:
`(case, timestamp NULLS LAST, import order)`. It therefore retains both
self-loops and timestamp-less events.

This is a DFG replay, not an alignment replay: particles show the observed
log path, so it does not invent Petri-net markings or claim alignment fitness.

## Scope of this version

The Petri-net input lets the alignment viewer work with models produced by any
miner. It performs standard exact Petri-net alignments and uses their
synchronous/model/log moves for replay.

For logs carrying XES lifecycle values, **Inductive Visual Miner (lifecycle)**
creates an expanded alignment model before replay: every visible transition is
replaced structurally by `enqueue → start → complete`, with two private places
between the stages. The input/output arcs remain attached to the first/last
stage, so the source net's choices, parallelism and loops are retained. Missing
`enqueue` values become silent model steps; absent or unknown lifecycle values
are interpreted as `complete`. This is the lifecycle-aware model layer needed
for correct alignment, rather than a display-only animation convention.

The original ProM implementation starts its model from an Inductive Miner
process tree. Promenade's lifecycle action deliberately performs the equivalent
stage expansion on the interoperable Accepting Petri Net instead, so it can be
used with models from every Promenade miner; automatic Log → process-tree →
lifecycle-IvM orchestration is the remaining direct-start convenience layer.
The current WASM representation supports 1-safe nets with up to 128 places
and caps a pathological variant search at 300,000 states; an unreachable
variant is reported rather than approximated.

Reference: S. J. J. Leemans, D. Fahland, W. M. P. van der Aalst, *Exploring
Processes Using Inductive Visual Miner*, PETRI NETS 2014 Demonstration Track.
