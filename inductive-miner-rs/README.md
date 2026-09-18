# Inductive Miner

Discovers a **process tree** from a traditional event log, using Leemans,
Fahland & van der Aalst's Inductive Miner. Two variants:

- **IM** — every trace in the log can be replayed by the model. Fitness is
  guaranteed by construction.
- **IMf** — tolerates infrequent behaviour, giving up that guarantee in
  exchange. This is the default, and the one to use on a real log.

Unlike Alpha Miner, the result is **always a sound model**: the recursion can
only build blocks that are sound, and it has a fallback (the flower model) that
always applies. There is no input for which it returns something unsound, or
nothing at all.

## What it produces, and what it does not

The output is a `ProcessTree`, not a Petri net. That is not a limitation — it is
what the algorithm actually computes; a Petri net is a translation of it.
Converting is a separate action on the `ProcessTree` artifact, so the tree, the
thing that shows you what the miner *decided*, stays available.

This plugin does not know a process tree viewer exists. It declares the type it
produces; the host matches that against what is installed and offers a viewer
from the registry if none is.

## Two-stage execution

- **scan** — one pass over the ordered event stream, collapsing it into trace
  variants with multiplicities. Expensive, parameter-independent, cached by the
  host.
- **discover(variant, noiseThreshold)** — the recursion.

**Unlike the DFG, Alpha and Heuristics kernels, the second stage is the
expensive one here.** The scan is nearly free; the algorithm is the recursion.
The noise threshold is therefore *not* marked `cheap` in the manifest, and its
description says so — a threshold slider on a big log is a re-run, not a live
loop. Measured in the browser runtime:

| shape | events | scan | discover |
|---|---|---|---|
| many traces, few variants | 1.6 M | 19 ms | 2 ms |
| many variants | 147 K | 2 ms | 8 ms |
| 200 activities | 198 K | 3 ms | 31 ms |
| deep recursion (60 levels) | 300 K | 2 ms | 0 ms |

WASM module: 181.5 KB raw, **74.1 KB gzipped**; 28 ms to compile and
instantiate.

## The noise threshold, precisely

It is easy to assume this filters the log. It does not.

- It applies to the **directly-follows graph**, per activity: an outgoing path
  is dropped when it is weaker than `threshold ×` the strongest alternative
  leaving the same activity. Ending the trace counts as one of those
  alternatives, so an activity that usually finishes a case prunes its rare
  successors hard.
- **Filtering is a fallback, not a preprocessing step.** The ordinary cut
  detectors run first on the unfiltered graph; only when all of them fail is a
  filtered copy tried. A log with clean structure and rare noise is therefore
  often unaffected by the threshold entirely.
- **Log splitting never uses it.** How a trace that does not fit the chosen cut
  is assigned to a branch is the same at every threshold, including 0.
- At **0**, nothing is filtered and IMf behaves exactly like IM. At **1**, only
  the strongest path out of each activity survives.

Two further threshold-dependent rules: empty traces are treated as noise when
there are fewer than `threshold ×` the number of traces, and a single activity
repeating close to once per trace is read as a plain step rather than a loop.

## Verification

The implementation is checked against ProM's, not against intuition:

| | |
|---|---|
| Hand-written cases (per construct, per boundary) | **364** |
| Generated differential cases | **208,000** |
| Golden real-log cases (3 logs × 2 classifiers × 4 settings) | **24** |
| Unresolved mismatches | **0** |

Reference: `promworkbench/InductiveMiner` @ `de00027c`, published as 6.14.5,
run headless with multithreading disabled.

`docs/prom-reference.md` documents what ProM actually does, including the parts
that appear in no paper. `docs/licensing.md` explains why this is an independent
implementation rather than a port.

## Known differences from ProM

All of them are places where ProM's own answer is arbitrary, plus one where it
is not reproducible at all:

1. ProM races the candidates of its "leave out an activity" fall-through on a
   thread pool and keeps whichever finishes first. This is single-threaded and
   deterministic.
2. Where ProM's choice depends on the iteration order of its collections, this
   follows the order those collections are observed to produce (descending
   activity index) — but that order is a property of a Java library, not of the
   algorithm, and a sparse enough activity set can diverge from it. No such case
   appeared in 208,000 generated logs.
3. Life cycles are not modelled. For IM and IMf that is exact, not an
   approximation: both variants map every event to `complete`, so the machinery
   is inert. The `IMlc` variants, which do use it, are not implemented.
4. Only IM and IMf. Not the life-cycle, partial-trace or DFG-based variants.

## Limits

**There is no event limit.** Every event is read, however many there are: the
scan streams the log in chunks and collapses it into repeated trace patterns
before the algorithm sees it, so memory tracks *distinct behaviour*, not log
size. The Road Traffic Fine Management log — 561,470 events, 150,370 traces —
mines end to end in 796 ms in the browser, with nothing dropped.

That is worth stating because the sibling pm4py plugin *does* have an event
limit, and for a real reason: it hands the log to pm4py as a pandas DataFrame,
so its memory tracks events and it has to cap them. The two limits are different
quantities, which is why they cannot share a name.

What this plugin caps is the number of **distinct activity labels**, at 10,000
with a default of 2,000, the host keeping the most frequent. It is a safety
ceiling for pathological input, not a modelling decision — dropping an activity
can remove a whole branch — and a run that hit the ceiling reports
`activitiesDropped` rather than looking like a complete one. For scale: RTFM has
11 distinct activities, and a large real log has a few hundred.

The ceiling is set from measurement, and the number that matters is not the one
you would guess. **Alphabet size is not the cost driver; missing structure is.**

| log | activities | events | time | peak memory |
|---|---|---|---|---|
| pure sequence | 10,000 | 200,000 | 1.1 s | 49 MB |
| pure sequence | 2,000 | 40,000 | 36 ms | 8 MB |
| random traces | 2,000 | 1,900 | 5.6 s | 188 MB |
| random traces | 1,000 | 1,900 | 1.4 s | 78 MB |

A well-structured log of 10,000 activities is comfortable. An unstructured one
of 2,000 already takes seconds — with fewer than 2,000 events in it — because
once no cut applies, the fall-throughs peel one activity per recursion level and
each level runs a quadratic parallel-cut test. Real logs sit far to the cheap
side of this: a few hundred activities is a large one, and an alphabet in the
thousands almost always means the classifier is picking up identifiers rather
than activity names, in which case the model would not be meaningful anyway.

## Citation

> Leemans, S.J.J., Fahland, D., van der Aalst, W.M.P. (2013). *Discovering
> Block-Structured Process Models from Event Logs — A Constructive Approach.*
> Petri Nets 2013, LNCS 7927, 311–329.
> [doi:10.1007/978-3-642-38697-8_17](https://doi.org/10.1007/978-3-642-38697-8_17)

> Leemans, S.J.J., Fahland, D., van der Aalst, W.M.P. (2014). *Discovering
> Block-Structured Process Models from Event Logs Containing Infrequent
> Behaviour.* BPM Workshops 2013, LNBIP 171, 66–78.
> [doi:10.1007/978-3-319-06257-0_6](https://doi.org/10.1007/978-3-319-06257-0_6)

Behaviour was verified against ProM's L-GPL implementation of these algorithms.
No ProM source was translated; see `docs/licensing.md`.
