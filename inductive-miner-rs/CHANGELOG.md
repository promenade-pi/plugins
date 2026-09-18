# Changelog

## 0.1.3

- Corrected the `homepage` and `repository` URLs. The plugins live in one
  repository, [`promenade-pi/plugins`](https://github.com/promenade-pi/plugins),
  not one repository per plugin under a `promenade-lab` organisation that was
  never created. Metadata only — no functional change.

## 0.1.2

Renamed the activity parameter, because "Activity limit" read as though it
capped events and was taken that way.

- **"Activity limit" → "Distinct activities."** The parameter key is unchanged,
  so existing results keep their provenance. The description now leads with what
  the control is *not*: there is no event limit here, and every event is read
  however many there are. The Road Traffic Fine Management log — 561,470 events,
  150,370 traces, 11 distinct activities — mines in 796 ms with nothing dropped.

The sibling pm4py plugin's "Event limit" is a genuinely different quantity: it
truncates the log because pm4py materialises it as a pandas DataFrame, so its
memory tracks events. This plugin streams the log in chunks and collapses it
into repeated trace patterns first, so its memory tracks distinct behaviour
instead. Giving the two controls one name would have made a real difference
invisible.

## 0.1.1

The activity limit was set by analogy with the other plugins rather than
measured, and measuring it showed the guess was wrong in both directions.

- **Limit raised to 10,000, default 500 → 2,000.** A well-structured log of
  10,000 activities discovers in about a second; an *unstructured* one of 2,000
  already takes seconds, with fewer than 2,000 events in it. Alphabet size is
  not the cost driver — missing structure is, because once no cut applies the
  fall-throughs peel one activity per recursion level and each level runs a
  quadratic parallel-cut test. The old ceiling was far too low for real logs and
  no protection at all against the case it was meant to guard.
- **Truncated runs are reported.** Activities beyond the bound were silently
  dropped. A missing activity can remove a whole branch, so the result is now
  flagged with `activitiesDropped` rather than looking like a complete run.
- **~9× less memory on large alphabets.** The sequence cut stored its transitive
  closure as a byte matrix *and* a backward copy of the same information — "b
  reaches a" is the forward relation read the other way round. One bitset
  instead: at 10,000 activities, peak memory 463 MB → 49 MB, runtime 1.57 s →
  1.07 s.

No behavioural change to discovery: the full differential suite (208,000 cases,
364 golden cases, 24 golden-log cases) is unchanged and still has no mismatches.

## 0.1.0

Initial release. Leemans' Inductive Miner, IM and IMf variants, in Rust:
`TraditionalEventLog → ProcessTree`.

Verified against ProM's own implementation (`promworkbench/InductiveMiner`
@ `de00027c`, published as 6.14.5) rather than against intuition: 364
hand-written cases, ~208,000 generated differential cases, and 24 golden cases
over three real XES logs at two classifiers and four parameter settings. No
unresolved mismatches.

Needed three additions to the host's WASM scan, all opt-in per manifest and all
defaulting to the previous behaviour, so the DFG, Alpha and Heuristics kernels
are unaffected. Each was found by running the plugin in the app and comparing
against the reference — none of them show up in the crate's own tests, because
each lives at the host boundary rather than in the algorithm:

- **`scan.order: "log"`** — order events as recorded rather than by timestamp.
  The reference reads a log sequentially, and the timestamp rule discards every
  event on a log without timestamps.
- **`scan.includeEmptyTraces`** — a case with no events produces no rows, so a
  kernel fed `(case, activity)` pairs could not see it at all. For this
  algorithm an empty trace is the evidence that a block is optional, and losing
  it silently changed the model.
- **`scan.activityIds: "firstAppearance"`** — the host numbered activities
  most-frequent-first. Three of this algorithm's tie-breaks fall back on the
  activity id, so the numbering is part of the behaviour: on `mini.xes` at
  threshold 1, frequency numbering gave `→(A,X,C,B,D)` where ProM gives
  `→(A, ×(B, →(X,C)), D)`. Both are valid models; only one is the reference's.
  The activity *limit* still keeps the most frequent activities.

Also fixed in the host, and not specific to this plugin: a sandboxed view was
handed an artifact's payload once, when its frame was created, and never again.
Any live recompute left the viewer drawing the previous result — no error, no
console message, just a picture that had quietly stopped matching the
parameters beside it. `PluginPanel` now rebuilds the frame when the payload
changes.
