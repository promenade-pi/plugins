# Inductive Miner (pm4py)

Two actions, one Pyodide module:

| Action | In | Out |
|---|---|---|
| `discover` | Traditional Event Log | **Process Tree** |
| `toPetriNet` | Process Tree | Accepting Petri Net |

## Why it returns a tree, not a net

The inductive miner *computes* a process tree; the Petri net is a translation
of it. Version 0.1.0 returned only the net, which threw away the intermediate
result the algorithm actually derives — and the tree is what you read to
understand what the miner decided. Producing it as its own artifact also makes
the conversion visible in the provenance DAG:

```
log ──discover──▶ Process Tree ──toPetriNet──▶ Accepting Petri Net
```

`pm4py.discover_petri_net_inductive()` does both steps internally. Splitting
them costs one extra click and buys an inspectable intermediate.

## This plugin does not know a viewer exists

It declares that it produces a `ProcessTree`. It has no dependency on anything
that draws one, and does not reference the Process Tree View package except as
a `recommends` hint for the plugin manager. The host matches the artifact type
against what is installed — and against the registry — so a different viewer,
or a different tree producer, needs no change here.

## Two actions in one module

Each action names an `entryPoint` in the manifest, which selects a pair of
stage functions:

```
discover     ->  prepare_discover(ctx)      finalize_discover(prepared, params, ctx)
toPetriNet   ->  prepare_to_petri_net(ctx)  finalize_to_petri_net(prepared, params, ctx)
```

A module with no entry points uses plain `prepare` / `finalize`.

`toPetriNet` reads no tables. Its input is an artifact another action produced,
which arrives as `ctx.input` in exactly the shape its producer returned.
`ctx.sql()` remains the only door to *log* data.

## Why `pythonDeps` is explicit

Installation runs with `deps=False`. `micropip.install("pm4py")` fails because
pm4py declares `cvxopt`, which has no pure-Python wheel — and which pm4py runs
fine without. The package therefore names its own dependency closure.

## Performance

Discovery is re-run on every `noiseThreshold` change. On BPI-2017 with 200 000
events that is roughly 12 seconds, so this is *not* a live-loop parameter in
the way a Rust kernel's threshold is. `maxEvents` invalidates the cached fetch.

Conversion is cheap: 2 ms of `finalize` for a 34-node tree, against ~2.6 s of
`prepare` — which is dominated by Pyodide importing pm4py, not by the work.
