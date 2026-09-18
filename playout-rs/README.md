# Play-out

Simulates an accepting Petri net into a real event log — the inverse of
discovery.

Every miner in Promenade turns a log into a model. This turns a model back into
a log, and the log it produces is an ordinary `TraditionalEventLog`: it opens in
the log views, it can be filtered and exported, and every miner, conformance
checker and organisational plugin in the workspace reads it. That is what makes
a model *testable*, and a miner *benchmarkable* against a process whose ground
truth is known rather than guessed at.

```
Discover (any miner) ──▶ Accepting Petri Net ──▶ Play out ──▶ Event Log ──▶ re-mine, replay, compare
```

## What it does

Two modes, answering two different questions.

**Simulate cases** — a sample of the process in operation. Cases arrive as a
Poisson process, each activity takes an exponentially distributed service time,
and every choice in the net is taken at random. The log is sorted by time, so
cases interleave the way they do in a real log.

**Every distinct trace** — the model's language, enumerated rather than sampled.
Bounded by trace length and a trace limit, because a model with a loop has
infinitely many traces and one with concurrency has factorially many; whether
the bounds were reached is recorded with the log, so a comparison between two
models never silently rests on a partial enumeration.

### Time is real, so concurrency is real

Starting an activity takes its input tokens; its output tokens appear only when
it finishes. After an AND-split both branches therefore start at the same
instant and genuinely overlap, rather than being interleaved after the fact.
This matters downstream: with **Start and complete** lifecycle events, Split
Miner 2.0 can read true concurrency from the log, the Resource Behavior plugin
has real durations, and the Performance Spectrum has something to draw.

### And it is still the model's behaviour

Every case written to the log is a firing sequence of the net — a completed run,
replayable on the model it came from. That is not a claim about the code being
careful: `crates/playout-core/tests/invariants.rs` replays every simulated case
against an independent replayer over hundreds of randomised nets on every build,
and `package.sh` will not produce a package if one of them fails.

### Resources come in groups

A pool assigned by coin flip gives an organisational miner a complete graph with
equal weights — noise that looks like structure. Each activity is instead served
by one group of the pool, so a handover between activities is a handover between
groups, and the Social Network and Organizational Model plugins have something
real to recover.

## Parameters

| Parameter | What it decides |
|---|---|
| **Mode** | Sample the process, or enumerate its language |
| **Cases** | How many cases to simulate |
| **Trace limit** | How many distinct traces to keep, when enumerating |
| **Steps per case** | Cut-off for a case the random walk cannot finish (a loop, usually) |
| **Seed** | The same seed gives byte-for-byte the same log |
| **Lifecycle** | Completions only, or start *and* complete events |
| **Cases that never finish** | Leave them out, or keep the prefix as deliberately unfitting behaviour |
| **Minutes between cases** | Mean case inter-arrival time |
| **Minutes per activity** | Mean service time; silent transitions take none |
| **Resource pool** | How many people perform the work; 0 leaves the log without resources |

## What it tells you about the model

A net that cannot complete a case cannot be played out, and the run says so
rather than producing a shorter log quietly:

- **deadlocked cases** — the walk reached a marking with nothing enabled. Run
  **Check soundness** on the net to see where.
- **truncated cases** — still running at the step limit; a loop, or a livelock.
- **discarded cases** — how many of the above were left out of the log.

These counts are on the log's own statistics, along with the seed, the mode and
the variant count.

## Limits

- The input is an **accepting Petri net**. A BPMN diagram or a process tree
  reaches it through the existing conversions (`Convert to Petri net` in
  `run.promenade.bpmn`); there is no direct play-out of either yet.
- A **start and complete** log has two events per activity, so conformance
  checking it against a plain Petri net scores badly (0.67 rather than 1.00 in
  the round trip below) unless the checker is told to read the lifecycle. Play out with
  **Completions only** when the log is meant for a miner or checker that expects
  one event per activity.
- Durations are exponential draws from a single mean, and resources never
  queue. This generates a log that *looks* like a process; it is not a fitted
  simulation model and should not be used to forecast anything.
- Choices are uniform over the enabled transitions. A stochastic net with
  learned branch probabilities would be the next step, and is what
  Rozinat et al.'s simulation model actually calls for.
- One case, one instance of the model: no object-centric play-out.

## Verified end to end

Helpdesk (4 580 cases) → Inductive Miner → BPMN → accepting Petri net → **Play
out** (300 cases, 2 721 events) → conformance checking against the very net it
came from: **fitness 1.00, precision 1.00, 300/300 cases aligned, 0 unreachable**,
and token replay with no missing or remaining tokens. Re-mining the simulated log
recovers a model of the same size (21 leaves vs 20, 13 activities, 13 operators).

## References

Rozinat, A., Mans, R.S., Song, M. & van der Aalst, W.M.P. (2009).
*Discovering simulation models.* Information Systems 34(3), 305–327.
[doi:10.1016/j.is.2008.09.002](https://doi.org/10.1016/j.is.2008.09.002)

van der Aalst, W.M.P. (1998). *The Application of Petri Nets to Workflow
Management.* Journal of Circuits, Systems and Computers 8(1), 21–66.

## Building

```bash
./package.sh
```

Runs the unit tests and the invariants first (`PLAYOUT_CHECK_CASES` raises the
case count), then `wasm-pack`, then packages `dist/run.promenade.playout-<version>.pmplugin`.
