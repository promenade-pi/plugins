# Testing

## Strategy

No native Rust or in-repo reference implementation of OCPN discovery exists
to differentially test against — unlike Inductive Miner, which was validated
against ProM as a black box (`../inductive-miner-rs/docs/prom-reference.md`).
Routing through pm4py/Pyodide for validation was explicitly out of scope for
this work. Tests are therefore **structural and canonicalized**: each
scenario asserts the expected place/transition/arc set (or a property of it)
against the algorithm semantics documented in `docs/algorithm.md`, not
against a trusted external oracle.

This is a real, acknowledged gap — see `docs/algorithm.md`'s "Known
differences" section. If a second OCPN discovery implementation ever becomes
available (native or otherwise), `ocpn-cli` (a JSON-in/JSON-out debug
harness mirroring `inductive-miner-cli`'s contract) is the intended
attachment point for a differential-testing harness, the same role
`inductive-miner-cli` plays for the Java oracle.

## Reference scenarios

| Scenario | Where | What it checks |
|---|---|---|
| Single object type | `ocpn-discovery/src/lib.rs` `single_object_type_reduces_to_a_traditional_lifecycle` | Reduces to a normal lifecycle net; every activity gets exactly one transition, owned by that one object type. |
| Two independent object types | `…` `independent_object_types_do_not_accidentally_synchronize` | No transition is shared unless the activity label is literally shared. |
| Shared activity | `…` `shared_activity_produces_one_transition_with_both_types` | Exactly one transition id for the shared activity; its `objectTypes` lists both. |
| Variable multiplicity | `…` `variable_multiplicity_flags_only_the_declared_pair`, and `tests/reference_scenarios.rs`'s `variable_flag_applies_symmetrically_to_input_and_output_arcs` / `no_declared_multiplicity_means_no_variable_arcs` | Only the declared `(objectType, activity)` pair is flagged; the flag is symmetric across direction; nothing is flagged without an explicit signal. |
| Start/end places | `tests/reference_scenarios.rs` `each_object_type_gets_its_own_source_and_sink_place` | Every object type gets its own `source_OT`/`sink_OT`, correctly typed and namespaced, even when object types share every activity. |
| Sparse object type | `ocpn-discovery/src/lib.rs` `sparse_object_type_is_skipped_with_a_reason` | Zero-event object type excluded from the result and reported in `skippedObjectTypes` with a reason; other types unaffected. |
| Multiple objects of the same type per event | Covered by the variable-multiplicity scenarios above — this *is* what variable multiplicity means. | |
| Noise parameter | `tests/reference_scenarios.rs` `noise_threshold_only_affects_imf`, `different_noise_thresholds_can_change_the_discovered_structure` | `IM` ignores the threshold entirely (echoed as `0.0`); different `IMf` thresholds are permitted to disagree on structure. |
| Object-type selection | `ocpn-discovery/src/lib.rs` `excluded_object_types_do_not_appear` | An object type never passed to `discover()` produces no places, no arcs, no mention anywhere in the result. |

`ocpn-core`'s own tests (`ocpn-core/src/lib.rs`) cover the model in
isolation: id determinism (`activity_id_is_pure_function_of_label`,
`silent_ids_never_collide_across_object_types`), and `validate()`'s
structural checks (object-type consistency, place/transition bipartite
alternation, and entry-only source / exit-only sink boundary places — see
`docs/algorithm.md` §3).

## Running

```bash
cargo test -p ocpn-core -p ocpn-discovery -p ocpn-cli   # 16 tests, all native
cargo check --target wasm32-unknown-unknown              # wasm boundary type-checks
wasm-pack build --target web --out-dir pkg --release      # full wasm build
```

From the app side:

```bash
cd app && npx tsc --noEmit -p tsconfig.json   # introduces zero new type errors
cd app && npm run build                        # bundles both new workers + the wasm module cleanly
```

## What was verified end-to-end, manually

The packaged `.pmplugin` (`package.sh`'s output) was installed into a running
dev build exactly as a third-party plugin would be — no core-code shortcut —
and both actions run through the host's fully generic dispatch
(`runtimeAdapters.ts`'s `relationalActionRuntime`/`wasmActionRuntime`, the
same code path any other installed plugin's actions use):

- **Real-world OCEL log** (AirportGroundHandling, 29K events, 3.2K objects, 6
  object types, no genuine multi-object cardinality — confirmed independently
  by scanning the source JSON): projection then discovery produced a real
  merged net (28 transitions, 96 arcs), correctly rendered with per-object-type
  colours, source/sink markers, and a silent transition, and correctly showed
  **0** variable arcs — matching what the raw log actually contains.
- **Positive variable-arc case** (OrderManagement, a log with genuine
  `Item`/`Product` multiplicity per event — confirmed independently the same
  way): the same two actions produced **38** variable arcs (84 transitions,
  294 arcs), rendered dashed per the notation legend — proof the projection
  action's auxiliary `variableMultiplicity` `@output` block, its generic
  surfacing into artifact `meta`, and `wasmActionRuntime`'s generic
  meta-to-param forwarding all actually connect end-to-end, not just compile.
- **Live recompute** (`ActionContext`'s `reuse` path in `executeAction`):
  dragging the noise threshold on an already-discovered net (0.20 → 0.23)
  re-ran mining in place (23ms, cached projection table) and updated the
  count (84→86 transitions, 38→42 variable arcs) without creating a sibling
  artifact or erroring.
- **One-click flow (0.2.0)**: selecting the OCEL log directly showed
  "Discover OCPN" — not "Project for OCPN discovery" — in Available Actions;
  one click produced both the internal projection artifact (correct name,
  provenance, and params in its own Inspector panel) and the OCPN net in one
  step, with an `objectTypes` picker rendered on `discover`'s own params
  reaching the projection's SQL correctly (`38` variable arcs, matching the
  0.1.0 two-click result exactly). Confirmed the fixed correctness trap too:
  a plain XES-derived `TraditionalEventLog` no longer offers "Discover OCPN"
  in its own Available Actions, since `discover` now declares
  `ObjectCentricEventLog` as its user-facing input type.
- **No regression in a pre-existing, unrelated action**: "Discover DFG
  (Rust/WASM)" (`core.discover.dfg`, a core-provider wasm action, not this
  plugin) was re-run on the same OrderManagement projection through the same
  `executeAction()`/dispatch rearchitecture and produced a correct DFG (64/105
  edges) with live-interactive activity/frequency filters.

This is not a substitute for the automated suite above, and no formal
performance benchmarking (large synthetic logs, many object types) has been
done. See `docs/algorithm.md`'s "Known differences" for what is explicitly
deferred.
