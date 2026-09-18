# Algorithm

## What a Local Process Model is

A Local Process Model (LPM) is a small Petri-net fragment over a *subset* of
a log's activities, capable of firing several times within one trace. This
plugin ports the search and scoring from ProM's
[`LocalProcessModelDiscovery`](https://github.com/promworkbench/LocalProcessModelDiscovery)
package (Tax, Sidorova, Haakma & van der Aalst) — the recursive
process-tree-expansion algorithm, not the newer, architecturally much larger
place-combination approach (`LocalProcessModelDiscoveryByCombiningPlaces` +
`SPECpp`) that ProM also ships; see "What's out of scope" below.

> Tax, N., Sidorova, N., Haakma, R., van der Aalst, W.M.P. (2016). Mining
> Local Process Models. *Journal of Innovation in Digital Ecosystems*, 3(2),
> 183–196.

The object-centric layer follows
[`ObjectCentricLPMs`](https://github.com/promworkbench/ObjectCentricLPMs) (a
git fork of `LocalProcessModelDiscovery` by Marvin Porsil, RWTH Aachen PADS),
which does not invent an object-centric search: it re-runs the same
single-perspective algorithm once per object type on a flattened log, then
merges structurally matching fragments across types and statistically flags
"variable arcs" — (activity, object type) pairs where the activity often
relates to more than one object of that type.

## Search (`crates/lpm-core/src/search.rs`)

Candidate fragments are process trees built from five operators — sequence
(`→`), exclusive choice (`×`), parallel (`∧`), inclusive choice (`∨`, off by
default, matching ProM) and a single-activity repeat-or-exit loop (`↻`).
Starting from one candidate per activity, each expansion step replaces one
`Task` leaf with a small two-child subtree (or, for the loop operator, wraps
it in place, consuming no new activity). A candidate is scored once it has
at least two real activities; monotonicity-based pruning (an operator that
can only *reduce* support/determinism is skipped once the parent is already
below threshold) and a co-occurrence upper bound (a pair of activities that
never occurs together often enough can never raise a fragment's support)
keep the search from trying everything.

**Ported differently on purpose:**
- **Duplicate-candidate detection** uses a canonical-string `HashSet`
  (commutative operators sort their children by canonical key) instead of
  ProM's insertion-position symmetry rule (`exp_1`). Functionally
  equivalent — a few more candidates generated before being deduped away,
  much simpler to get right.
- **The alphabet-size problem** (the search is exponential in the number of
  activities) is answered by the host's own `maxActivities` scan parameter —
  shared with every other miner in this repo — rather than ProM's
  Markov/MRIG/entropy-clustering projection methods. A wide-alphabet log is
  narrowed to its most frequent activities before this crate ever sees it,
  not partitioned into independently-searched clusters.
- **A wall-clock budget** (`maxSearchMillis`) replaces ProM's
  `ForkJoinPool` parallelism as the thing that keeps a run responsive: a
  Wasm worker is single-threaded, so the search runs breadth-by-breadth and
  returns the best fragments found so far once the budget is spent —
  flagged honestly in the result (`truncatedBySearchBudget`) rather than
  silently cut off.
- **The expansion budget counts steps, not leaf count.** `numTransitions`
  caps how many expansion steps a fragment has gone through
  (`LPMRecursiveAction`'s own `recursionDepth`), not how many activities it
  uses — a loop step is one step like any other even though it adds no new
  activity, so a fragment can still combine a loop with a later
  sequence/choice/parallel step within the same budget.

## Scoring (`crates/lpm-core/src/{align,evaluator}.rs`)

Every candidate is wrapped with a silent **backloop** transition connecting
its exit place back to its entry place, and that shared place becomes both
the initial and final marking — an alignment against this augmented net can
complete zero, one or several full loops before the trace runs out, and each
backloop firing is one occurrence of the fragment. This is exactly
`LocalProcessModelEvaluator.evaluateNetOnLog`'s trick.

Alignment itself is a from-scratch Dijkstra over the synchronous product
(bitmask markings, a `MAX_STATES` safety bound), modeled on
`plugins/alignment-rs`'s technique rather than depending on that plugin — see
`crates/lpm-core/src/align.rs`'s own doc comment for why a shared crate
wasn't a good fit (different result shape, a much smaller state space, and a
different cost regime: a *visible* model move costs the trace length here,
not 1, so the optimal alignment never invents an unobserved firing just to
shorten the trace-position walk elsewhere — ported from ProM's
`CostBasedCompleteParam`).

Metrics, all in `[0, 1]`:
- **support** — `log10(occurrences) / (log10(occurrences) + 1)`, a
  diminishing-returns squash of the case-weighted total backloop-firing
  count.
- **confidence** — harmonic mean, over the fragment's own transitions, of
  `(observed firings of this transition) / (that activity's total log-wide
  occurrences)`. Only *synchronous* moves count as an observed firing.
- **determinism** — `1 / average number of enabled transitions` sampled at
  every point a real (non-silent) transition fires during replay.
- **language fit** — fraction of the fragment's own possible behaviour (its
  un-augmented net's language, one pass from entry to exit, activity firing
  counts capped by `maxLoop`) that was actually observed in the log.
- **coverage** — fraction of the whole log's events whose activity is in the
  fragment's own alphabet.
- **weighted score** — a linear combination of the above (plus average
  firings per occurrence and a fragment-size term), normalised by the sum of
  the weights. Confidence and determinism dominate by default, matching
  ProM's own `LocalProcessModelParameters`.

Re-weighting (changing which metric matters most) never re-runs the search:
the Wasm kernel caches the full evaluated candidate pool (generously larger
than the requested `topK`) keyed by every *structural* parameter, and
recombines each candidate's already-known metrics under new weights in place
— `reweight` in `evaluator.rs`.

## Object-centric layer

`run.promenade.lpm.discover-oc` runs the identical search/scoring above
against a per-object-type flattened log (`project-oc.sql`: one trace per
object of the selected type, standard OCEL flattening). `combine-oc`
(`combine-oc/plugin.py`) then merges two such per-type runs: fragments whose
discovered tree is structurally identical across both are combined into one
multi-type fragment, and an (activity, object type) pair is flagged as a
variable arc once at least 95% (configurable) of the activity's events
relate to more than one object of that type — `ObjectCentricLPMs`'
statistical heuristic, computed here as one SQL aggregate over the OCEL
rather than a per-event streaming pass. Chain `combine-oc` pairwise to merge
more than two object types.

## What's out of scope

- **`LocalProcessModelDiscoveryByCombiningPlaces` + `SPECpp`** — a newer,
  more scalable place-mining and windowed FP-Growth combination approach.
  Architecturally much larger (an eST-Miner-style place-enumeration tree,
  pluggable composers, an FP-tree, streaming evaluators) and its quality
  metrics are not alignment-based. A plausible future scalability upgrade if
  the exhaustive search here proves too slow on very wide/deep patterns, but
  not attempted here.
- **`ObjectCentricLPMs`' full case-notion machinery** — leading-type process
  executions, connected-component executions, and their optimisation
  variants. This port uses the simplest standard case notion (flatten by
  object type) instead.
- **High/Closed/Maximal-Utility LPM variants** — a secondary research thread
  in the original repo scoring numeric-attribute-weighted "utility" instead
  of frequency; not ported.
