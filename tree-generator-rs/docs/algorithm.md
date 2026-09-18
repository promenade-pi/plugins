# Algorithm

## The construction

```
n  ~ Triangular(fewest, most likely, most)        // the number of activity leaves
build(n):
  n == 1                    -> a leaf
  otherwise                 -> an operator drawn from the normalised weights,
                               and the n leaves split between two children
```

with three refinements, below. The tree is then **folded**: a child that is the
same associative operator as its parent is spliced into it, so `→(a, →(b, c))`
becomes `→(a, b, c)`. Folding changes nothing about what the model does — that
is what associativity means — and is the difference between a tree someone can
read and a staircase of nested pairs. A loop is never folded: its first child is
the body and the rest are repeat branches, so flattening would mix up which is
which.

### 1. The split

The paper fixes the operator distribution and the size distribution and leaves
the split between two children open. Here it is **uniform** over the ways to
divide the leaves — the choice that adds no further bias of its own. A 50/50
split would make every tree balanced; a geometric one would make every tree a
staircase.

### 2. Silent steps

`silent` is the probability that an operator node uses a silent child *instead
of* splitting, and it applies to exactly two operators:

- a **choice** gets the whole subtree on one branch and τ on the other, so the
  subtree becomes optional;
- a **loop** gets the whole subtree as its body and τ as its repeat part, so the
  body simply repeats.

Those are the two places a silent step changes what the model does. Under a
sequence or a parallel, τ is a node with no behavioural effect whatsoever —
nothing a log could show and nothing any algorithm could discover — so none is
ever placed there. The consequence worth knowing is that the activity count you
ask for is the count you get: silence is never paid for in activities.

### 3. Duplicate labels

`duplicate` is the probability that a leaf reuses a label already in the tree
rather than taking a fresh one. The number of activity *leaves* is unchanged;
the number of *distinct* activities falls, which is the point — duplicate tasks
are the classic blind spot of discovery algorithms, which mostly cannot tell two
leaves with the same name apart.

Labels are `a`…`z`, then `aa`, `ab`, … — short, ordered, and deliberately
meaningless.

## Randomness

The size is drawn by inverse-CDF from the triangular distribution on
`[fewest, most]` peaking at `most likely`: one uniform draw, no rejection loop,
so a seed maps to a size in a fixed number of steps.

The stream is xoshiro256\*\* seeded through SplitMix64, implemented in the crate.
A published benchmark's seed has to keep meaning the same thing across every
version of everything, and a dependency that changed its algorithm in a minor
release would break that silently.

## What is not implemented

**Long-term dependencies** (`lt_dependency`). The paper's parameter constrains
*combinations* of choices in different parts of a model — take this branch here
and you must take that one there. A process tree cannot express that: each
operator decides independently of every other. PTandLogGenerator enforces the
dependency while generating the *log*, by discarding traces that violate it, not
in the tree it generates. Adding a parameter here that quietly did nothing would
be worse than not having it.

**A population per run.** PTandLogGenerator draws `no_models` trees at once.
Here one run makes one artifact, with its own parameters and provenance; a
population is a series of seeds. The alternative would be an artifact that is
secretly a list, which nothing downstream could read as a model.

**The log half.** That is `plugins/playout-rs`: convert the tree to BPMN, then to
an accepting Petri net, then play it out. The intermediate models stay visible
and checkable, which is the difference between this pair and a single generator
that emits a log from a model nobody sees.

## The inclusive choice

The `∨` operator is offered because the tree view draws it and the BPMN
conversion maps it to an inclusive gateway — but it has no compact plain Petri
net translation, and Favre & Völzer's local OR-join replacement does not always
exist. A tree containing one therefore stops at BPMN, and the generator says so
in the model's statistics as soon as it produces one. Its weight is 0 by
default.

## Provenance of this implementation

Written from Jouck & Depaire's published description of the construction. pm4py
ships a port of the original generator under the GPL; it was deliberately not
read, and nothing here is derived from it. Where the paper leaves a decision to
the implementation, this document states what was chosen and why rather than
leaving it to be inferred from the code.
