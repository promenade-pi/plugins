# Changelog

## 0.1.0

First release. Implements the backbone-based OC-DFG layout of Lee, Song and
van der Aalst — [1] BPM 2025 (LNBIP 564, pp. 204–220) for the object-centric
structure, [2] Data & Knowledge Engineering 164 (2026) 102601 for the layout
core. See `docs/method.md` for the step-by-step correspondence and for the
twelve points where the papers leave a choice open.

- Pyodide action producing an `OCDFGBackboneLayout` from an `OCDFG`: per-type
  backbones, integer-programming rank assignment, virtual-node routing,
  integer-programming component balancing, object type axis merge,
  axis-restricted crossing minimisation, and node positioning that holds each
  type's trunk straight.
- Both integer programs are solved by HiGHS through `scipy.optimize.milp`,
  which Pyodide's scipy ships compiled. The squared precedence penalty of [2]
  is linearised exactly, with the per-pair segment count grown only for the
  pairs that sit at their bound.
- Sandboxed React Flow view. It never re-layouts: it draws the coordinates the
  action computed, so the reported edge length and orthogonality describe what
  is on screen. Object type legend, layout-quality panel, arc drawing as
  polyline/spline/orthogonal, optional routing nodes and arc labels.
- The baseline both papers argue against is reachable as parameters
  (`rankMethod: heuristic`, `rankObjective: linear`, `allowHorizontalEdges:
  false`, `componentBalancing: greedy`), so the comparison can be run on the
  same graph.
- The view holds its React Flow mount until the container has a real box.
  React Flow draws an edge only once its endpoints are measured, so a graph
  initialised into a zero-size container renders as nodes with no edges,
  permanently (its own error 004) — the state a panel frame is in when it is
  hidden behind another tab or reparented off-screen. `view-src/harness/`
  reproduces it with and without the guard.
- Verified by executable invariants over the papers' own worked examples and
  25 randomised OC-DFGs (`test/test_layout.py`), plus geometry unit tests
  (`view-src/geometry.test.ts`). `package.sh` gates on both.
