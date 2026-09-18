# OC-DFG Discovery (pm4py)

A second backend for the `OCDFG` artifact, alongside Promenade's built-in SQL
discovery. It calls `pm4py.discover_ocdfg` on a real `pm4py.objects.ocel.obj.OCEL`
inside Pyodide, then converts PM4Py's typed activity, start/end, and
directly-follows metric dictionaries to Promenade's existing OC-DFG payload.

```text
ObjectCentricEventLog
        ↓
run.promenade.ocdfg-pm4py.discover  (runtime: pyodide)
        ↓
OCDFG artifact                       (same type as core.discover.ocdfg)
```

The result opens in either the built-in Object-Centric DFG view or the
installed React-Flow renderer.

## Parameters

- **Object types** — empty means all types. The selected types are projected
  only in `finalize`, after the cached source OCEL is fetched.
- **Event limit** — caps the deterministic timestamp-ordered event prefix
  fetched into Pyodide. The payload records whether this truncated the source.

Node counts use PM4Py's `unique_objects` metric. Edge frequencies use its
`total_objects` metric, preserving `(event A, event B, object)` occurrences.

## Build

```bash
./package.sh
```
