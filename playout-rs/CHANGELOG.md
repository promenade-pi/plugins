# Changelog

## 0.1.0

First release.

- **Play out** — an `AcceptingPetriNet` simulated into a `TraditionalEventLog`.
  Two modes: a stochastic sample of the process in operation, or every distinct
  trace the model can produce (bounded, and honest about which bound it hit).
- A **timed token game**: starting an activity consumes its input tokens and its
  outputs appear only when it completes, so the branches of an AND-split
  genuinely overlap. With `start` and `complete` events in the log, that overlap
  is what Split Miner 2.0 reads concurrency from and what gives the Resource
  Behavior plugin real durations.
- **Case arrivals, service times and a resource pool** — the four perspectives
  Rozinat et al.'s simulation model consists of, generated rather than mined.
  Resources are grouped per activity so an organisational miner finds structure
  rather than noise.
- **Seeded and reproducible**: the same net and settings give byte-for-byte the
  same log. The RNG (xoshiro256\*\*, seeded through SplitMix64) is in the crate
  rather than a dependency, so the stream cannot change under a minor release.
- **Executable invariants** (`crates/playout-core/tests/invariants.rs`), gating
  the package: every simulated case is replayed against an independent replayer
  and must be a firing sequence of its net; a completed case must land on the
  final marking; the columns must be a well-formed log; a seed must reproduce;
  and extensive play-out is compared against a brute-force enumeration of small
  acyclic nets.
- Deadlocked, truncated and discarded cases are counted and explained on the
  log's statistics rather than silently changing how much log you get.

### Host requirement

Needs the host's `ActionContext.persistLog({ rows })` path (Promenade ≥ the
change that added `app/src/host/artifact/log-rows.ts`): an action whose declared
output type is log-shaped returns the log's columns and the host writes the
storage. This is the first plugin to produce a log rather than read one.
