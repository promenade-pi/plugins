# OC-DFG Backbone Layout (IP)

Lays out an Object-Centric Directly-Follows Graph the way a process is read
rather than the way a graph is drawn: every object type gets its own vertical
axis, its dominant path is held as a straight trunk, and node ranks come from
an integer program that minimises arcs running upwards against the flow.

This implements the method of Deoksang Lee, Minseok Song and Wil van der
Aalst, published across two papers — the object-centric structure from the
BPM 2025 paper and the refined layout core from the 2026 *Data & Knowledge
Engineering* article. [docs/method.md](docs/method.md) maps every step to its
definition in the papers, and lists every point where the papers leave
something open and this implementation had to decide.

It is an independent implementation. The reference implementation
([deoksanglee/BackboneLayoutIP](https://github.com/deoksanglee/BackboneLayoutIP))
solves its programs with Gurobi; the same models run here under HiGHS, which
Pyodide's scipy ships as a compiled extension, so nothing leaves the browser
and no licence is needed.

## What it produces

The action takes an `OCDFG` and produces an `OCDFGBackboneLayout`: every node
with a rank, an order, an object type axis and final x/y coordinates, every
typed arc with its routed polyline, plus the layout-quality metrics both
papers evaluate against. The bundled view draws it — it never re-layouts, so
what you see is exactly what was measured.

## Reading the picture

- **Colour is the object type.** Each type occupies one vertical band.
- **A straight coloured trunk is that type's backbone**, the dominant path
  through its part of the process. Trunk activities are outlined in the
  type's colour and drawn heavier.
- **A dashed red arrow runs upwards**, against the top-down flow. The whole
  point of the rank program is that there should be few of these; the panel
  counts them.
- **A horizontal arrow** connects a mutually dependent pair — two activities
  that follow each other in both directions, so neither comes first. It is
  drawn without an arrowhead, because there is no precedence to point at.
- **Hiding an object type dims it instead of removing it.** Stability under
  filtering is one of the method's selling points, and positions are fixed
  once computed; removing nodes would leave holes that read as movement.

## Comparing against the baseline

The parameters that matter are switches between the method and the baseline
it argues against, so both can be run on the same graph:

| Parameter | The method | The baseline |
| --- | --- | --- |
| Rank assignment | `Integer program` | `Heuristic` |
| Precedence penalty | `Squared` (journal) | `Linear` (BPM paper) |
| Allow horizontal edges | on | off |
| Component balancing | `Integer program` | `Greedy` |

Run the action twice and compare the metrics in each view's *Layout quality*
panel. What the difference amounts to depends entirely on the graph. On the
synthetic fixtures the program removes every avoidable back edge (3 → 0 on a
three-type order-to-cash graph, 1 → 0 on the journal's own toy example) and
shortens total edge length. On the real Procure-to-Pay OC-DFG — 7 types over
10 activities — the heuristic layering already attains the optimum (objective
123 either way, 6 back edges either way), and the only difference the program
makes is a slightly shorter drawing. That is a fair outcome to report, not a
disappointing one: it says the graph is small enough that a good heuristic
suffices, and the view tells you so by printing both objectives side by side.

Three cautions about the comparison. It varies the *rank assignment and
balancing* inside this same object-centric pipeline — it is not the external
tool the BPM paper benchmarks against, so it does not reproduce that paper's
reported figures. Per-type axes buy object-type separation at the cost of
longer arcs and more crossings, which is a trade the BPM paper reports for
itself, so a worse `crossings` figure here is the method working as
described, not a defect. And the metric definitions printed in the papers are
in two places ambiguous; [docs/method.md](docs/method.md) says which reading
is used.

## Scale

Rank assignment is a mixed-integer program, so it is the part that can get
expensive. Above 1 200 distinct activity pairs the action falls back to the
heuristic layering without attempting the program, and says so in the view;
raise *Integer-program ceiling* and *Solver time limit* together to push a
larger graph through it anyway. A program that hits its time limit yields its
best solution so far, reported as "best found within the time limit" rather
than as optimal.

## Why the view gates its own mount

React Flow renders nodes without measuring them, but only draws an edge once
that edge's endpoints have been measured. A graph initialised into a container
with no box therefore comes out as **nodes with no edges at all**, and stays
that way, because the measurement that would fix it never happens. React Flow
reports this itself as error 004 ("The parent container needs a width and a
height to render the graph") — it is its documented behaviour, not a bug in
it, and nothing to do with the layout, whose arcs are all present in the
store with full geometry.

A docked panel frame is mounted exactly like that whenever it is behind
another tab, in a collapsed dock, or reparented while off-screen, which is
why the symptom recurs across React-Flow-based views. `useBoxReady` in
`view-src/plugin.tsx` holds the mount until the container has a real box, and
polls as well as observing, because a hidden frame delivers no
ResizeObserver callback either. `view-src/harness/` reproduces both cases.

## Verification

`test/test_layout.py` asserts, over the papers' own worked examples and 25
randomised OC-DFGs, that: every admitted backbone constraint descends; every
activity sits strictly inside its type's start and end; a pair that may not
be horizontal is not; a mutually dependent pair *is* placed on one rank (the
journal's Fig. 5); virtual-node chains occupy consecutive ranks; no two nodes
on a rank overlap; every straight trunk is one vertical line; x agrees with
order; component balancing attains the optimum the greedy heuristic misses
(the journal's Fig. 7, to the node); the integer program never scores worse
than the heuristic it replaces; and the same input gives the same layout.

`view-src/geometry.test.ts` covers the arc geometry. `package.sh` runs both
and refuses to build if either fails.

```bash
./package.sh
```
