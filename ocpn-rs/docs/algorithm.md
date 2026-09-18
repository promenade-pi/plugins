# OCPN discovery algorithm

Based on the object-centric Petri net discovery approach of van der Aalst &
Berti, *Discovering Object-centric Petri Nets*, Fundamenta Informaticae, 2020
— independently implemented, not a port of any reference implementation.

```text
OCEL
 ↓
for each selected object type:
    project the OCEL onto that type          (§1)
    build a global-activity-id trace-variant log
    discover a process tree                   (§2, Inductive Miner, reused)
    convert the tree to a Petri net            (§3, tree_to_net.rs)
 ↓
merge every object type's net, transitions keyed by activity label  (§4)
 ↓
flag variable arcs from event-object cardinality                    (§5)
 ↓
ObjectCentricPetriNet
```

## §1 — Per-object-type projection

For object type `OT`: one case per object of type `OT`; an object's case is
the time-ordered sequence of activities of every event related to that
object, through any qualifier (qualifier-sensitive projection — e.g. "only
events where this object is the primary subject" — is not implemented; see
"Known differences" below).

An event related to `k` objects of type `OT` contributes to `k` different
cases. This is the standard **convergence duplication** every OCEL flattening
performs (the same semantics `host/transform/compile.ts`'s
`flattenByObjectType` already implements for a single object type — see
`project.sql`, a SQL Profile v1 program run by the host's generic relational
dispatch, for how this generalizes to N object types in one SQL pass). An
event related to *no* object of type `OT` simply never
appears in `OT`'s projection (**divergence drop**) — nothing to do, it's a
consequence of the projection, not a separate step.

The activity dictionary is **global across every selected object type in one
discovery run** — "Ship" gets the same activity id whether it came from an
`Order`'s events or a `Package`'s. This is what makes §4's merge exact rather
than a fuzzy label match.

## §2 — Per-object-type mining

Each object type's projected trace-variant log is mined independently with
Inductive Miner (`inductive-miner-core`, reused unmodified — see
`docs/architecture.md`), producing a `ProcessTree`. Parameters (`variant`:
`IM`/`IMf`, `noiseThreshold`) apply per object type, independently — a noisy
object type does not affect another's discovery.

An object type with **zero** relevant events is excluded from discovery
entirely (`metadata.skippedObjectTypes`, with a reason) rather than
mined into a degenerate net. An object type with events, however few, is
mined normally — no artificial minimum-frequency threshold. Inductive Miner
handles small logs (including the empty trace) without special-casing.

## §3 — Tree → Petri net conversion

Standard block-structured (WF-net) construction — see
`crates/ocpn-discovery/src/tree_to_net.rs` for the exact per-operator
gadgets (sequence, xor, parallel, loop). No such conversion exists anywhere
else in Promenade's Rust code; the only prior art in this repository is
pm4py's `convert_to_petri_net`, reached only through Pyodide, which this
plugin does not use (see `docs/architecture.md`).

Each object type gets its own `source_OT` and `sink_OT` place — the tree's
entry and exit points — namespaced per object type and never merged, even
when two object types share every activity. They are strict boundary places:
no arc targets a source and no arc leaves a sink. For a root-level `Loop`,
the converter mirrors pm4py: it adds a boundary τ/place after `source_OT`,
then the loop's own `init_loop` τ/place before its body, with a corresponding
τ/place before `sink_OT`. Redo branches return to the private loop-entry
place, never to the user-visible source marking.

**Invariant this conversion relies on**: Inductive Miner's cuts partition the
*alphabet* disjointly among a node's children at every recursion step, so a
discovered tree contains each activity in **exactly one leaf**. Converting
one object type's tree therefore never creates two arc pairs between the
same transition and that object type's places on its own — the only way a
transition ends up with more than one arc pair per object type is by being
shared across *different* object types (§4). If a future miner without this
invariant were plugged in here, this assumption would need re-checking.

## §4 — Merging by shared activity

Transition identity is a **pure function of the activity label**
(`ocpn_core::transition_id_for_activity`): `"t:" + activity`. Two object
types that each produce a transition for the same activity therefore produce
the *same* id, and merging is a hash-map insert, not a separate matching
pass — see `ocpn-core`'s module docs for the full rationale, including why
this is safe against accidental merges (the id is derived from the log's own
activity classifier, never from an internal counter) and how silent
transitions are kept from ever merging (namespaced `"t:silent:" + object_type
+ ":" + ordinal`, private to one object type's own conversion pass).

A shared transition's `objectTypes` field lists every object type that
contributes an arc pair to it — this is the artifact-level record of "this
activity synchronizes these object types."

## §5 — Variable arcs

For a transition `A` and object type `OT`: if any single event with activity
`A` (in the **original**, unprojected event-object relation) relates to more
than one object of type `OT`, every arc between `A`'s transition and `OT`'s
places is flagged `variable: true` — symmetric across direction (both the
arc consuming into the transition and the arc producing out of it), because
variability is a property of the `(activity, object type)` relation's
cardinality, not of flow direction.

This is computed separately from the per-object-type projection (§1), which
is one-object-at-a-time by construction and cannot recover this — see
`project.sql`'s third `-- @output variableMultiplicity` block for the query
(run against the original, unprojected event-object relation, alongside the
projection itself), `docs/architecture.md`'s "How this ships…" section for
how that result crosses into the mining action's own params without being
user-editable, and `ocpn-discovery`'s crate docs for the exact contract this
passes into the Rust side (`variable_multiplicity: BTreeSet<(object_type,
activity_id)>`).

## Parameters

| Parameter | Meaning | Applies to |
|---|---|---|
| `objectTypes` | Which object types participate. Empty = every object type present. | The projection (§1); changing it re-runs the expensive scan. |
| `minerVariant` | `IM` (fitness-guaranteeing) or `IMf` (infrequent-behaviour tolerant, default). | Mining (§2), applied per object type. |
| `noiseThreshold` | `0..1`, IMf only. | Mining (§2), applied per object type. |

No other parameters are exposed. In particular there is no separate
minimum-frequency or annotation parameter for v1 — nothing here that isn't
load-bearing for the algorithm itself.

## Known differences / deliberate limitations

- **Qualifier-insensitive projection.** Every event-object relation counts
  toward an object's case, regardless of qualifier. A log that uses
  qualifiers to distinguish "this event modifies the object" from "this
  event merely references it" is not treated differently. Filtering by
  qualifier would be a natural v2 parameter.
- **No custom per-object-type frequency threshold.** An object type with one
  event is mined exactly like one with a thousand — see §2. This is a
  deliberate choice ("don't add parameters that aren't meaningful"), not an
  oversight.
- **No external validation oracle.** Unlike Inductive Miner (validated
  against ProM as a black box), no trusted reference OCPN-discovery
  implementation was used to differentially test this algorithm — see
  `docs/testing.md`.
- **ELK layout partitioning is a coarse 3-tier hint** (source / internal /
  sink), not a full per-object-type lane assignment — see
  `docs/architecture.md`'s ELK section.
