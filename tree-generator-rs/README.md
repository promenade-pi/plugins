# Process Tree Generator

Draws a random process tree from a parameterised distribution — the tree half of
Jouck & Depaire's **PTandLogGenerator**.

An evaluation of a discovery algorithm needs models whose properties are
*controlled*, not observed. A real log cannot supply that: its generating model
is precisely the unknown. A handful of hand-drawn models is a sample of the
author's imagination. Drawing the model from a distribution is what lets an
experiment state its population instead of its examples — 100 models with
10–30 activities, this much concurrency, this many loops.

```
Generate a process tree ──▶ Process Tree ──▶ BPMN ──▶ Petri net ──▶ Play out ──▶ Event Log
                                 │                        │                          │
                            known model            known soundness            known ground truth
```

The result is an ordinary `ProcessTree` artifact. The tree view draws it, the
BPMN conversion converts it, the soundness checker checks it — nothing knows or
cares that no log was involved.

## Parameters

| Parameter | What it decides |
|---|---|
| **Activities (most likely / fewest / most)** | The triangular distribution the size is drawn from |
| **Sequence / Exclusive choice / Parallel / Loop / Inclusive choice** | Relative weights of the operators; normalised |
| **Silent steps (τ)** | How often a choice gets a silent branch, or a loop repeats with no work in between |
| **Duplicate labels** | How often a leaf reuses a label already in the tree |
| **Seed** | The same seed and settings give exactly the same tree |

Defaults are PTandLogGenerator's own (mode 20, min 10, max 30, equal operator
weights, 20% silent, no duplicates), so "generated with the default parameters"
means the same thing here as in the paper.

## What it guarantees

- **The size you asked for.** The number of activity leaves always lands inside
  the range you gave; duplicates reduce the number of *distinct* activities
  below it, which is what that parameter is for.
- **Silent steps only where they mean something** — a branch of a choice
  (making the rest optional) or a loop's repeat part. A τ under a sequence or a
  parallel is a node with no behavioural effect at all.
- **Soundness.** Every generated tree converts to BPMN, then to an accepting
  Petri net, and the soundness checker finds it sound. That is not a claim
  about the construction being careful: `crates/tree-gen-core/tests/invariants.rs`
  does exactly that, through two other plugins' crates, on hundreds of randomised
  parameter sets, and `package.sh` will not build a package if one fails.
- **Reproducibility.** Same seed, same tree, byte for byte.

## Limits

- **One tree per run.** PTandLogGenerator draws a population of models at once;
  here a population is a series of seeds, and each tree is its own artifact with
  its own provenance.
- **No long-term dependencies.** The paper's `lt_dependency` is a constraint
  *between* choices in different parts of the model, which a process tree cannot
  express — PTandLogGenerator enforces it when generating the log, not in the
  tree. Nothing here pretends to.
- **An inclusive choice has no Petri net.** It converts to a BPMN inclusive
  gateway, but a plain Petri net needs *Replace OR-joins* first, and Favre &
  Völzer's local replacement does not always exist. The weight is 0 by default
  and the tree says so in its statistics when it is not.
- Labels are `a`, `b`, `c`… on purpose: a generated activity called "Approve
  invoice" invites reading meaning into a model that has none.

## References

Jouck, T. & Depaire, B. (2019). *Generating artificial data for empirical
analysis of control-flow discovery algorithms: a process tree and log
generator.* Business & Information Systems Engineering 61(6), 695–712.
[doi:10.1007/s12599-018-0541-5](https://doi.org/10.1007/s12599-018-0541-5)

Implemented from the paper's description of the construction. pm4py's port of
the same generator is GPL and was deliberately not consulted; every decision the
paper leaves open is documented in [docs/algorithm.md](docs/algorithm.md).

## Building

```bash
./package.sh
```

Runs the unit tests and the invariants first (`TREE_CHECK_CASES` raises the case
count), then `wasm-pack`, then packages
`dist/run.promenade.tree-generator-<version>.pmplugin`.
