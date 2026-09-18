# OCPN Discovery (pm4py)

A second backend for `ObjectCentricPetriNet` discovery, alongside
`run.promenade.ocpn` (native Rust/WASM — see `plugins/ocpn-rs`). Both
produce the exact same artifact type, so a net discovered here opens in
either installed OCPN viewer (the host's own `core.ocpnView`, or
`run.promenade.ocpn-flow-view`) — pick this action instead of "Discover
OCPN" on the same log to compare pm4py's own object-centric discovery
against the Rust implementation.

```text
ObjectCentricEventLog
        ↓
run.promenade.ocpn-pm4py.discover   (runtime: pyodide, this plugin)
        ↓
ObjectCentricPetriNet artifact       (same type run.promenade.ocpn produces)
```

One action, not two: unlike `run.promenade.ocpn`'s split (an internal
relational projection feeding a wasm mining action, needed because the wasm
kernel can only scan one flattened log), pm4py's own
`pm4py.discover_oc_petri_net` takes a real OCEL object directly and handles
every selected object type itself. So this plugin's single action declares
`ObjectCentricEventLog` as its input with no `scans` indirection at all.

## What it does

`plugin.py`:
1. `prepare` — fetches the whole OCEL (every object type, up to the
   `maxEvents` cap) into three pandas DataFrames (`events`, `objects`,
   `relations`) shaped the way `pm4py.objects.ocel.obj.OCEL` expects
   (`ocel:eid`, `ocel:activity`, `ocel:timestamp`, `ocel:oid`, `ocel:type`).
   Cached by the host, keyed by artifact + `maxEvents` only.
2. `finalize` — subsets those DataFrames down to the selected object types
   (object-type selection can't live in `prepare`: the host's cache key for
   it doesn't include `objectTypes`, so a `prepare`-time filter would keep
   serving a stale selection after the user changed it), builds the `OCEL`,
   runs `pm4py.discover_oc_petri_net`, and converts the result to
   Promenade's `OcpnPayload` shape.

The converter (`_convert` in `plugin.py`) reads pm4py's per-object-type
`{ot: (PetriNet, Marking, Marking)}` dict (`ocpn["petri_nets"]`, present on
every pm4py version whether or not it also returns the newer `OCPetriNet`
class) and pm4py's own `double_arcs_on_activity` for the variable-arc flag —
no need to re-derive either from scratch. Id conventions
(`t:<activity>`, `t:silent:<ot>:<n>`, `p:<ot>:src`/`:snk`/`:<n>`) mirror
`ocpn-rs` exactly, so a transition genuinely shared across object types
merges into one node here the same way it does in the Rust plugin's output.

No host code changes were needed to build this. The host's `pm_plugin`
module (injected into every Pyodide plugin) has converters for a process
tree and a plain Petri net (`pm_plugin.process_tree`/`petri_net`, used by
`run.promenade.inductive-py`) but none for an OCPN — there was nothing to
add there, though: the whole conversion is plain Python against pm4py's own
return value, exactly what any third-party plugin author already has access
to.

## Parameters

Same shape as `run.promenade.ocpn`'s own `discover` action, for direct
comparison: `objectTypes` (picker, empty = every type present),
`minerVariant` (`imf`/`im`, passed straight through as
`inductive_miner_variant`), `noiseThreshold` (IMf only — passing a nonzero
value together with `im` would make pm4py silently switch variants, so this
plugin always sends `0.0` when the variant is `im`, never the raw slider
value), plus `maxEvents` — a safety ceiling on the Pyodide fetch, not
normally something to touch (see `run.promenade.inductive-py`'s own param
of the same name for the identical rationale).

## Known differences from `run.promenade.ocpn`

- **Determinism.** `ocpn-rs`'s ids and layout are engineered to be
  byte-identical across runs on identical input (see its own docs). This
  plugin's place/transition ids depend on pm4py's own (Python `set`-backed,
  not guaranteed-ordered) iteration of `net.places`/`net.transitions` — so
  while the *identity* of a shared transition (`t:<activity>`) is always
  stable, an individual object type's *internal* place numbering
  (`p:<ot>:<n>`) may not be, run to run. This does not affect correctness
  or the viewer's rendering, only whether re-running discovery on an
  unchanged log produces byte-identical ids.
- **Performance.** Pyodide's own pm4py import alone is on the order of
  seconds (see `docs/pyodide-pm4py-report.md` at the repo root), before
  discovery itself runs — noticeably slower than the Rust/WASM path for the
  first run in a session. `memory: "high"` is set in the manifest for this
  reason.
- **pm4py version.** `pythonDeps` names `pm4py` unpinned (matching
  `run.promenade.inductive-py`'s own convention), so it always resolves to
  whatever is newest on PyPI at install time. `_as_dict()` in `plugin.py`
  normalises both the newer `OCPetriNet`-class return value and the older
  plain-dict one, so either should work.

## Building

```bash
./package.sh   # no build step — zips manifest.json + plugin.py + docs
```
