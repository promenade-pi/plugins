# BPMN 2.0

BPMN 2.0 support for Promenade: conversions to/from Petri nets and process
trees, BPMN 2.0 XML import, and a React Flow view with BPMN 2.0 XML export.

## Scope

Pure control-flow BPMN only: tasks, start/end events, exclusive/parallel/
inclusive gateways, sequence flows. No pools, lanes, message flows,
sub-processes, or boundary/timer events — none of the conversions below need
them.

## Actions

- **Process Tree → BPMN** (`run.promenade.bpmn.from-process-tree`): a direct
  recursive translation, block-structured by construction. Rejects
  `interleaving`/`partialorder` process-tree operators, which have no BPMN
  equivalent.
- **Petri Net → BPMN** (`run.promenade.bpmn.from-petrinet`): clean and
  block-structured for a sound, free-choice workflow net; still converts
  (behavior-preserving) otherwise, flagging the result as not
  block-structured rather than rejecting.
- **Import BPMN 2.0 XML…** (`run.promenade.bpmn.import`): a manufacturing
  action (no artifact input, a `file`-typed param instead) reachable from
  the sidebar's "New…" menu, alongside "Import log…" and "Browse sample
  logs…". A construct outside this plugin's control-flow subset is
  represented as an opaque pass-through task, with a warning naming it.
- **BPMN → Petri Net** (`run.promenade.bpmn.to-petrinet`): solid for tasks, a
  single start/end event, and XOR/AND gateways, including a canonical
  loop-back. Rejects an inclusive (OR) gateway outright -- no compact plain
  Petri net translation exists even for a structured one -- and any other
  non-block-structured construct, naming the offending element.
- **BPMN → Process Tree** (`run.promenade.bpmn.to-process-tree`): via a
  block-structure decomposition (`crates/bpmn-core/src/rpst.rs` -- a
  simpler, local-reduction-rules alternative to a full RPST/SPQR-tree
  analysis, exactly correct for the same purpose: it can reject a few
  block-structured diagrams a full RPST would still accept, but it never
  accepts one that genuinely isn't). Rejects with a diagnostic naming the
  unreducible region rather than approximating.

## Architecture

- `crates/bpmn-core`: pure Rust BPMN model + conversions, independently
  unit-testable (`cargo test`), no wasm/browser types.
- `src/lib.rs`: the wasm-bindgen boundary, one kernel class per action.
- `view-src/`: the bundled sandboxed React Flow view (esbuild → a single
  classic-script IIFE at `view/plugin.js`).
