# Algorithm

Five steps, each a standalone operation on the output of the last — which is
what let the 2021 paper replace three of them without touching the other two.

```text
  Event log ─► DFG and loops ─► Concurrency ─► Filtering ─► Splits ─► Joins ─► BPMN
```

## 1. Directly-follows graph, self-loops and short-loops

The classic relation (Definition 2) counts how often `b` immediately follows
`a` in a case. Self-loops (`|a → a| > 0`) and short-loops are lifted out before
anything else reads the graph, because both break the concurrency oracle: a
short loop `a ↺ b` produces exactly the two mutual arcs the oracle reads as
concurrency.

A short loop exists when neither activity is a self-loop and the pattern
⟨a, b, a⟩ or ⟨b, a, b⟩ occurs in some case.

Two artificial nodes are added, a source and a sink, standing for the BPMN
start and end event. The filtering step requires every node to be on a path
from *one* start to *one* end, and a log with several start activities has no
such node of its own.

## 2. Concurrency

`a` and `b` are concurrent iff

```text
(1)  |a → b| > 0  and  |b → a| > 0          they occur in either order
(2)  no case contains <a, b, a>             ...and it is not a short loop
(3)  no case contains <b, a, b>
(4)  ||a → b| − |b → a|| / (|a → b| + |b → a|)  <  ε
```

Condition (4) is the discriminating one: genuinely interleaved executions
should be seen in both orders about equally often, so a smaller ε demands more
balance before concurrency is claimed.

Then the graph is **pruned** (Definition 5): both arcs of a concurrent pair
go, because there is no causality there to draw; and for a mutual pair that is
*not* concurrent — an ordering the log is merely inconsistent about — only the
dominant direction survives.

## 3. Filtering

Three properties are wanted and cannot all be had:

1. every node on a path from source to sink;
2. the number of arcs minimal;
3. every path carrying the highest possible sum of frequencies.

Algorithm 1 trades between (2) and (3): keep every arc above the η percentile
of the *candidate* frequencies, and keep each node connected to its single most
frequent successor and predecessor whatever their frequency. Property (1) is
then restored afterwards by dropping whatever the filter stranded — which this
plugin reports rather than performs silently.

## 4. Splits

For every node with more than one outgoing arc, a *hierarchy* of gateways is
built between it and its successors, using two functions over the successors:

- **cover** `C(s)` — what is reachable only through `s`;
- **future** `F(s)` — the other successors concurrent with `s`.

and two rules applied alternately until one successor is left:

| rule | condition | new gateway's cover | its future |
|---|---|---|---|
| **XOR** (Alg. 3) | successors share the same `F` | union of their covers | the shared future |
| **AND** (Alg. 4) | successors share the same `C ∪ F` | union of their covers | intersection of their futures |

The intuition the paper gives: mutually exclusive successors of a task must
share the same concurrency relations; successors meant to run together share
the union of their covers and futures.

## 5. Joins

A join gateway goes in front of every node with more than one incoming arc. Its
type is the type of the entry gateway of the acyclic homogeneous
single-entry-single-exit region it closes — and OR otherwise.

That rule is computed here as dominance and post-dominance over the model's
loop-free skeleton: for a join `j`, the innermost region is bracketed by the
nearest dominator of `j` that `j` post-dominates, and the region is everything
dominated by the one and post-dominated by the other. It is *homogeneous* when
every gateway in it is of one kind, and *acyclic* when no back edge crosses its
boundary or lies inside it.

These rules are where the deadlock-freedom comes from: AND-joins are only ever
placed inside AND-homogeneous regions, so an AND-join always has an AND-split
that eventually activates all of its incoming branches.

## Split Miner 2.0

Three of the five steps change when the log records when activities *start* as
well as when they finish.

**Refined directly-follows (Definition 6)** — `b` directly-follows `a` when
`b` *starts* after `a` *ends* with no other activity ending in between. Two
activities whose executions overlap therefore have no directly-follows relation
in either direction at all, which is the point.

**True concurrency (Equation 5)** — concurrency is measured rather than
inferred:

```text
(5)  2 · |a ⋈ b| / (|a| + |b|)  ≥  ε
```

where `|a ⋈ b|` counts executions of the two whose life-cycles overlapped. At
ε = 1 this is strong simultaneousness; below it, the paper's parametrised weak
form, which real logs need. Equation (5) **replaces** conditions (1)–(4) rather
than joining them — under the refined relation two truly concurrent activities
have no arc in either direction, so keeping condition (1) would make the
variant unable to find what it exists to find.

**Two heuristics** (§3.3) —

- an AND-split with a loop-edge among its branches forces the loop on every
  iteration, leaving tokens behind: the loop-edge is moved onto a new XOR-split
  placed in front, so going round again is a choice;
- an AND-split whose branches are sometimes concurrent and sometimes mutually
  exclusive is an inclusive choice: when the majority of its branch pairs show
  both, with at least one observation of one per two of the other, the split
  and the join that closes its region become OR.

## The invariants

`crates/split-miner-core/tests/invariants.rs`, gated in `package.sh`. Split
Miner's selling point is a structural guarantee, so what is asserted is that
guarantee over randomised logs — drawn from random block-structured processes,
in two flavours: plain completions, and full life-cycles whose parallel
branches genuinely overlap.

1. **Every discovery is a valid BPMN diagram.**
2. **Gateway discipline** — every task has exactly one way in and one way out.
   Branching happens only at gateways, which is what the split and join steps
   exist to establish.
3. **No dead activity, and the end always reachable** — every node on a path
   from the start event to the end event. This is the paper's property (1).
4. **Determinism** — one log, one diagram.
5. **Soundness, checked by something else.** Where the diagram converts to an
   accepting Petri net, the Soundness Checker plugin's core — an independent
   implementation of the van der Aalst criteria, written against a different
   paper, sharing no code with this crate — must not find it unsound. That is
   this paper's headline claim, verified rather than restated.

Each randomised test also asserts a floor on what the corpus exercised, so a
generator that drifted into producing only flat sequences would fail rather
than pass vacuously.

Two defects surfaced this way during development, both invisible to a diagram
that merely looked right: a filtered graph that had lost every path from start
to end produced a diagram with a start event, an end event and no flow between
them; and Split Miner 2.0's loop-edge repair could strip an AND-split of every
branch it had, leaving a gateway that routed nothing.

## References

- Augusto, A., Conforti, R., Dumas, M., La Rosa, M. (2017). *Split Miner:
  Discovering Accurate and Simple Business Process Models from Event Logs.*
  ICDM 2017, 1–10.
- Augusto, A., Conforti, R., Dumas, M., La Rosa, M., Polyvyanyy, A. (2019).
  *Split miner: automated discovery of accurate and simple business process
  models from event logs.* KAIS 59(2), 251–284.
  [doi:10.1007/s10115-018-1214-x](https://doi.org/10.1007/s10115-018-1214-x)
- Augusto, A., Dumas, M., La Rosa, M. (2021). *Automated Discovery of Process
  Models with True Concurrency and Inclusive Choices.* ICPM Workshops, LNBIP
  406, 43–56. [arXiv:2105.06016](https://arxiv.org/abs/2105.06016)
- Johnson, R., Pearson, D., Pingali, K. (1994). *The Program Structure Tree:
  Computing Control Regions in Linear Time.* PLDI 1994 — the SESE
  characterisation join typing rests on.

See [licensing.md](licensing.md) for what was and was not used to build this,
and for the four places the papers leave a decision open.
