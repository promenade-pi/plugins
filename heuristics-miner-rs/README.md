# Heuristics Miner

Discovers a **causal net** from a traditional event log using the Flexible
Heuristics Miner's dependency measure — noise-tolerant where Alpha Miner's
exact footprint relations are not: one contradicting trace can flip an Alpha
Miner relation outright, while a dependency measure only shifts a fraction.

## Two-stage execution

- **scan** — one pass over the ordered event stream, building the
  directly-follows matrix and start/end sets. Expensive, parameter-independent,
  cached by the host. Same shape as Alpha Miner's and dfg-rs's scan.
- **mine(dependencyThreshold, minFrequency, relativeToBest)** — derives the
  dependency graph and AND/XOR grouping. Runs on an n×n matrix, so it is fast
  enough to drive from a slider.

## Outputs: Causal Net and Accepting Petri Net

The original **Heuristics Miner** action still returns its direct Causal Net:
activities, weighted directed edges, and the AND/XOR groups that explain them.
The companion **Heuristics Miner → Petri net** action returns an accepting
Petri net from the same discovery calculation, so it can be rendered as a
Petri net, exported as PNML, and used by alignment-based conformance actions.

The conversion uses one silent router for each causal edge. A source activity
produces one token into each of its split groups: routers sharing a split place
compete (XOR), while separate split places receive tokens together (AND). At
the target, routers in a join group feed one place (XOR); the visible target
transition consumes from every join-group place (AND).

## Limits

Bounded to 1000 activities as a sanity cap, not a correctness one (no bitmask
here, unlike Alpha Miner). AND/XOR grouping only looks at pairwise
directly-follows traffic between siblings, not the full triple-based AND
measure from the original paper — a deliberate simplification, documented in
`docs/algorithm.md`.
