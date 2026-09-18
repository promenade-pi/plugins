# Alpha Miner

Discovers an accepting Petri net from a traditional event log using
van der Aalst's Alpha algorithm.

## Two-stage execution

- **scan** — one pass over the ordered event stream, building the
  directly-follows matrix and start/end sets. Expensive, parameter-independent,
  cached by the host.
- **mine(minFrequency)** — derives the causal/parallel/unrelated relations,
  searches for maximal set pairs, builds the net. Runs on an n×n matrix with
  n ≤ 64, so it is fast enough to drive from a slider.

## Limits

Bounded to 64 activities so the relation sets fit in a `u64` bitmask. The host
filters to the most frequent activities first; Alpha Miner on hundreds of
activities is not meaningful, and the manifest says so rather than degrading
silently.

Known Alpha Miner limitations apply: it cannot represent short loops of length
one or two, invisible tasks, or duplicate activities.
