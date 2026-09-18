# How the Heuristics Miner works

## The dependency measure

For every ordered pair with any directly-follows traffic:

```
dep(a, b) = (df(a→b) − df(b→a)) / (df(a→b) + df(b→a) + 1)     a ≠ b
dep(a, a) =  df(a→a) / (df(a→a) + 1)                           self-loop
```

Close to **1**: `a` is almost always directly followed by `b`, almost never
the other way round. An edge becomes a dependency when `df(a→b) ≥
minFrequency` **and** `dep(a,b) ≥ dependencyThreshold`.

## Keeping the graph connected

An activity that would otherwise end up with no surviving outgoing edge (and
isn't an end activity), or no surviving incoming edge (and isn't a start
activity), keeps its single strongest candidate anyway — provided it clears
`dependencyThreshold − relativeToBest`. An isolated node is a worse failure
than one under-strength edge; this is the standard Flexible Heuristics Miner
"all activities connected" heuristic.

## AND versus XOR

Two of a node's surviving neighbours are grouped as **concurrent (AND)**
exactly when the log shows traffic *in both directions* between them —
`df(x→y) > 0 and df(y→x) > 0`. Real concurrency gets serialised arbitrarily
by whatever timestamp granularity the log has, so a truly parallel pair shows
up ordered one way in some cases and the other way in others. That is Alpha
Miner's `∥` relation, not its `#`: two activities that are simply never seen
adjacent are not concurrent, they are unrelated alternatives, and — like any
one-directional (causal) pair — end up in the same **XOR** group, the
conservative reading whenever block structure genuinely is unclear.

Grouping is computed independently on each side of every surviving edge: once
among a node's outgoing edges (its *split*), once among a different node's
incoming edges (its *join*) — connected components of the "concurrent" graph
restricted to that neighbour set.

> This is a deliberate simplification of the original paper's AND measure,
> which also looks at how closely two activities co-occur within a case, not
> only whether traffic exists in both directions. Good enough to draw a
> useful causal net; not a claim of exactly reproducing ProM's numbers.

## Causal Net → Accepting Petri Net

The companion Petri-net action retains every visible activity transition and
adds one silent routing transition `τ(a,b)` per retained causal edge `a → b`.
For every split group `(a,g)` it creates a place `split(a,g)` after `a`; every
router belonging to that group consumes its token. Therefore routers in one
group compete (XOR), while `a` produces tokens into all of its different split
groups (AND). Dually, every join group `(b,g)` has one `join(b,g)` place fed by
its routers; `b` consumes a token from each of its join-group places, giving
XOR joins within a group and AND joins across groups.

One initial place chooses among observed start activities, and observed end
activities lead to one final place. The causal-net representation has no
separate grouping for starts or ends, so multiple starts/ends are necessarily
treated as alternatives by this boundary construction.

Long-distance (length-two) loop dependencies — `a → b → a` — are also not
detected separately from the ordinary pairwise measure above.
