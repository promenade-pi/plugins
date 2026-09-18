# Phase 1 + 2 — What ProM's Inductive Miner actually does

Reference: `promworkbench/InductiveMiner` @ `de00027ca901b6bab5b7765d07c096aee58841eb`
(published as `InductiveMiner` 6.14.5), plus `promworkbench/InductiveMinerDeprecated`
@ `794e47ad99672dcbe643af193b7e9b6b548beba3` (`InductiveMinerDeprecated` 6.14.12).

This document is the **contract** for the Rust implementation. Everything below
is a statement about *behaviour*; none of it is a translation of code. Where a
behaviour appears in neither IM paper, it is marked **[impl]** — those are the
rules that only differential testing can keep honest.

---

## A. Entry points — what is ProM and what is the algorithm

| Layer | Classes | Port? |
|---|---|---|
| **ProM plugin entry** | `plugins/InductiveMinerPlugin` — `@Plugin` annotations, `UIPluginContext`, `context.getFutureResult(0).cancel()`, a `JOptionPane` "this may take a while" dialog | **No** |
| **UI** | `plugins/InductiveMinerDialog` (Swing variant combo + noise slider), `ProcessTreeVisualisation`, `DfgMsd*` import/export/visualise plugins, `IdentifyPartialTraces*` | **No** |
| **Log abstraction** | `logs/IMLog`, `IMLogImpl`, `IMTraceIterator`, `IMEventIterator` | **Concept yes, code no** |
| **Classifier** | `XEventClassifier` (OpenXES) + `XLifeCycleClassifier` | **Replaced** by Promenade's classifier |
| **Parameters** | `mining/MiningParameters`, `MiningParametersAbstract`, `variants/*` | Concept yes |
| **Algorithm driver** | `mining/InductiveMiner` (`mineEfficientTree`, `mineNode`) | **Yes** |
| **Algorithm parts** | `framework/{basecases,cutfinders,fallthroughs,logsplitter}`, `loginfo/*`, `helperclasses/*` | **Yes** |
| **Tree + reduction** | `InductiveMinerDeprecated` → `efficienttree/{EfficientTree,InlineTree,EfficientTreeReduce}` | **Yes** — and easy to miss |
| **Cancellation** | `PackageManager.Canceller` — a single `isCancelled()` polled at ~12 points | Concept yes |
| **Concurrency** | `MinerState` holds two `ExecutorService` pools | **No** (see hazard D5) |
| **Petri net** | `EfficientTree2AcceptingPetriNet` + `ReduceAcceptingPetriNetKeepLanguage`, invoked by a *separate* plugin variant | **No** — separate Promenade action, per the brief |

The split is clean: `mineEfficientTree(IMLog, MiningParameters, Canceller) → EfficientTree`
touches no ProM class except `Canceller`. That signature is the thing to
reproduce.

**Two entry points, not one.** "Mine efficient tree with Inductive Miner" returns
the tree; "Mine accepting Petri net with Inductive Miner" runs the tree miner,
reduces again, converts, and reduces the net. Promenade already models this as
two actions — the brief's `log → ProcessTree` / `ProcessTree → AcceptingPetriNet`
split is exactly ProM's own, so nothing is being invented here.

**The tests in the repository are a stub.** `tests/src-test/.../NewPackageTest.java`
is the ProM package template's placeholder. There is no test suite to port and no
golden data to reuse — which is precisely why Phase 3 has to build an oracle.

### Event classification in ProM, and what replaces it

`IMLogImpl` is built from an `XLog` with two classifiers:

- `XEventClassifier` — default `XEventNameClassifier` (`concept:name`).
- `XLifeCycleClassifier` — default `XLifeCycleClassifierIgnore`, which maps
  **every** event to `complete`.

Consequences that matter:

1. **For IM and IMf, life cycles are entirely inert.** All the
   `openActivityInstances` bookkeeping in the loop splitter and the tau-loop
   fall-throughs reduces to a no-op. The Rust port needs no life-cycle model for
   these two variants. (The `IMlc` variants do use it; out of scope.)
2. **Activity ids are assigned in order of first occurrence** across the log,
   scanning traces in order and events within a trace in order. This is not
   cosmetic: it is the node order of every component structure downstream, and
   therefore the tie-break for several arbitrary choices (hazard D1).
3. The miner works on **event classes**, never on XES fields. Promenade's
   classifier already redefines the `activity` column of a log's event view, so
   the plugin gets classified activities for free and can stay format-agnostic —
   the requirement in the brief's Phase 6 is met by the host, not by the plugin.

---

## B. Variants — which algorithms are actually in the package

Offered by the dialog, in order; **index 1 (IMf) is the default selection**:

| # | Variant | `hasNoise` | `hasFitness` | Scope |
|---|---|---|---|---|
| 0 | `MiningParametersIM` — "Inductive Miner (IM)" | no | yes | **Port** |
| 1 | `MiningParametersIMInfrequent` — "IM - infrequent (IMf)" | **yes** | no | **Port (default)** |
| 2 | `MiningParametersIMLifeCycle` (IMlc) | no | yes | Out of scope |
| 3 | `MiningParametersIMInfrequentLifeCycle` (IMflc) | yes | no | Out of scope |
| 4 | `MiningParametersIMPartialTraces` | no | yes | Out of scope |
| 5 | `MiningParametersIMInfrequentPartialTraces` | yes | no | Out of scope |
| 6 | `MiningParametersIMInfrequentPartialTracesAli` | yes | no | Out of scope |

Separately in the package, **not** in this dialog:

- `withoutlog/InductiveMinerWithoutLog` — IM over a DFG+MSD structure instead of a
  log ("IMd"-style, DFG-based). Different cut finders, different graph splitters,
  no log splitting. **Out of scope**, but it is the natural second plugin later
  (`DFG → ProcessTree`), and Promenade already has a `DFG` artifact type.
- `directlyfollowsgraph/mining/DFMMiner` — the Directly-Follows Model miner.
  Unrelated to IM; Promenade already has `core.discover.dfg`.
- IMc (probabilistic/SAT, `getSatProbabilities`) is referenced by the parameter
  interface but no dialog variant enables it here.

**Scope decision: implement IM and IMf.** They share every component; IMf is IM
plus four extra list entries. Anything else is a different algorithm wearing the
same name.

### The noise threshold, precisely

`defaultNoiseThreshold = 0.2f`. `getNoiseThreshold()` returns **0** whenever
`hasNoise()` is false, so for IM the parameter is not merely ignored — it is
forced to zero everywhere it is read.

Where the threshold is read, and what it does:

**1. Cut detection — `Filter.filterNoise`, applied to the DFG only.** **[impl]**
IMf appends **one extra cut finder to the end of the list**. The five ordinary
cut finders run **first, on the unfiltered DFG**; only if all five fail does the
sixth filter the DFG and re-run the same five on the filtered copy.

> *Filtering is a fallback, not a preprocessing step.* This is the single most
> important thing to get right about IMf, and it is easy to get wrong: a naive
> implementation that filters first and then cuts is a different algorithm.

The filter produces a **copy** of the DFG and touches four things:

- **Start activities**: drop `a` if `startCount(a) < threshold × max(startCount)`.
- **End activities**: symmetric.
- **Directly-follows edges**: for each source `a`, let
  `maxOut(a) = max(endCount(a), max over outgoing edges of weight)` — note that
  *being an end activity counts as an outgoing option*. Drop every outgoing edge
  of `a` with `weight < threshold × maxOut(a)`. The filter is therefore
  **per-source and relative**, not a global absolute cutoff.
- **Concurrency edges**: same rule (unused by IM/IMf, which never populate that
  graph).

Boundary behaviour:

| threshold | effect |
|---|---|
| `0` | `weight < 0` and `count < 0` are never true → **nothing is removed**; the extra cut finder is a redundant re-run of the same five detectors on the same graph. IMf at 0 ≡ IM on cut detection. |
| `0 < t < 1` | proportional per-source pruning as above |
| `1` | keeps only edges whose weight **equals** `maxOut(source)`, and only the most frequent start/end activities. Maximal filtering; `hasNoise` variants still guarantee nothing about fitness. |

**2. Base cases.** IMf adds two threshold-dependent base cases:

- `BaseCaseFinderEmptyTracesFiltering`: if `0 < #emptyTraces < #traces × threshold`,
  the empty traces are **noise** — drop them and recurse, *without* wrapping the
  result in `xor(·, tau)`. At `threshold = 0` the condition is unsatisfiable, so
  empty traces always become `xor(·, tau)` as in IM.
- `BaseCaseFinderSingleActivityFiltering`: when the sublog has exactly one
  activity, estimate the geometric-distribution stop probability
  `p = #traces / (#activityInstances + #traces)`; if
  `0.5 − threshold ≤ p ≤ 0.5 + threshold`, return a plain leaf `a` instead of a
  self-loop. At `threshold = 0` this requires `p = 0.5` exactly, i.e. exactly one
  occurrence per trace — which the unfiltered `BaseCaseFinderSingleActivity`
  would have caught anyway.

**3. Log splitting: the threshold is *not* read.** `MiningParametersIMInfrequent`
does not override any `splitLog*` method. **[impl]** This contradicts a common
reading of the IMf paper, and is worth stating explicitly:

> **Noise filtering in this implementation changes cut detection and base cases
> only. Log splitting is identical in IM and IMf.**

The splitters named `…Filtering` (`LogSplitterXorFiltering`,
`LogSplitterSequenceFiltering`) filter *non-fitting behaviour relative to the
chosen cut* — a trace that does not fit the cut perfectly still has to go
somewhere — and they do that the same way at every threshold, including 0.

**4. Fall-throughs: read, but dead.** `FallThroughActivityOncePerTraceConcurrent`
has a noise-tolerant branch, but both IM and IMf construct it with `strict = true`
(IMf inherits `getFallThroughs()` unchanged), so only the exact
`#emptyTraces == 0 && count(a) == #traces` branch can fire. The tolerant branch is
reachable only from the life-cycle variants.

---

## C. The recursion

```
mineEfficientTree(log, params, canceller):
    tree = mineNode(log)
    EfficientTreeReduce.reduce(tree, ForPetriNet(collapsed=false))   # see C.6
    return tree

mineNode(log):
    info = logInfo(log)                       # DFG + start/end + msd, recomputed per node
    for f in baseCaseFinders:  if t = f(log, info): return t
    for f in cutFinders:       if c = f(log, info) and c.isValid(): break
    if c:   sublogs = split(log, info, c);  return build(c.operator, map(mineNode, sublogs))
    for f in fallThroughs:     if t = f(log, info): return t
```

Cut validity, uniformly: **operator set, ≥ 2 parts, no part empty.**

### C.1 Log info, recomputed at every node

Per recursion node, one pass over the sublog yields:

- **activities** as a *multiset* (cardinality = occurrence count),
- **directly-follows edges** with counts (consecutive event pairs within a trace),
- **start activities** multiset (first event of each non-empty trace),
- **end activities** multiset (last event of each non-empty trace),
- **number of empty traces**,
- **minimum self-distance** per activity: the smallest gap (in positions) between
  two occurrences of the same activity in one trace, minimised over the whole log,
- **minimum-self-distance-between**: the multiset of activities lying strictly
  between two occurrences of `a` at that minimal gap — reset whenever a strictly
  smaller gap is found, accumulated when an equal gap is found,
- `numberOfTraces`, `numberOfEvents`, `numberOfActivityInstances` (equal to
  `numberOfEvents` when life cycles are ignored).

### C.2 Base cases

**IM**, in order:

| # | Condition | Result |
|---|---|---|
| 1 | 1 activity, 0 empty traces, `#instances == #traces` | `leaf(a)` |
| 2 | 1 activity, 0 empty traces | `loop(a, tau, tau)` — the semi-flower |
| 3 | 0 activities | `tau` |
| 4 | `#emptyTraces > 0` | `xor( mineNode(log without empty traces), tau )` |

Note #3 before #4: a log consisting **only** of empty traces has zero activities
and yields `tau`, not `xor(tau, tau)`.

**IMf** prepends four and keeps IM's four, giving the order:
`EmptyLog, EmptyTracesFiltering, EmptyTraces, SingleActivityFiltering,
SingleActivity, SemiFlowerModel, EmptyLog, EmptyTraces`. **[impl]** The
duplication of `EmptyLog`/`EmptyTraces` is harmless but must be preserved —
in IMf, empty-log and empty-trace handling happens **before** any single-activity
test, which is the opposite of IM.

### C.3 Cut finders, in order

**1. Exclusive choice (xor).** Connected components (undirected) of the DFG. Valid
iff ≥ 2 components.
*→ `xor`, split by `LogSplitterXorFiltering`.*

**2. Sequence.** Strongly connected components of the DFG → condense. If exactly
one SCC, no cut. Merge condensed nodes that are **pairwise mutually unreachable**
(these would be a xor, not a sequence step) into single nodes; rebuild the
condensed graph; sort its nodes by reachability. **[impl]** Then apply the
"pivot merge" (`CutFinderIMSequenceStrict.merge`, dated 2015-08-04 / 2016-07-11 in
the source): identify optional sub-sequences and merge them, so that
`{⟨a,b,c⟩, ⟨c⟩}` yields `{a,b}{c}` rather than `{a}{b}{c}` — fewer introduced taus,
higher precision. If the merged partition is not valid, fall back to the unmerged
one.
*→ `sequence`, split by `LogSplitterSequenceFiltering`. **Child order is semantically
significant** and is the reachability order.*

**3. Parallel with minimum self distance.** As #4, but additionally merges each
activity with every activity in its minimum-self-distance-between multiset.
**[impl]** This is the IM extension for loops whose DFG is indistinguishable from a
parallel construct; it is tried **before** plain parallel, so a log where both apply
gets the MSD answer.

**4. Parallel.** Requires at least one start and one end activity (noise filtering
can remove all of them). Start every activity in its own component; for every pair
`(a,b)`, if the DFG lacks `a→b` **or** lacks `b→a`, merge them — i.e. only pairs
with edges in *both* directions may stay apart. Then `ensureStartEndInEach`:
every part of a parallel cut must contain a start and an end activity, so parts are
classified into has-both / has-start-only / has-end-only / has-neither; if no part
has both, **no cut**; otherwise start-only and end-only parts are zipped pairwise
into new parts, and every leftover is folded into **part 0**. **[impl]** Which part
is "part 0" is hash-iteration order in ProM (hazard D3).
*→ `concurrent` (Promenade `parallel`), split by `LogSplitterConcurrent`.*

**5. Loop.** Requires start and end activities. All start and all end activities are
merged into one component — the **body**. Then, for every DFG edge `s→t`:
if `s` is neither start nor end and `t` is not a start, merge `s,t`;
if `s` is a start but not an end, merge `s,t`.
The activities at the ends of cross-component edges are the sub-start / sub-end
activities. A redo part is only legitimate if every one of its sub-end activities
has an edge to **every** start activity, and every sub-start activity is reachable
from **every** end activity; any violation merges that activity back into the body.
Finally the body component is moved to position 0.
*→ `loop`, split by `LogSplitterLoop`.*

### C.4 Log splitting

| Cut | Splitter | Semantics |
|---|---|---|
| xor | `LogSplitterXorFiltering` | Each trace goes to the part holding the **plurality** of its events (first maximum wins in part order); events outside that part are dropped. Empty traces are copied into **every** sublog. Trace count is *not* preserved per sublog. |
| sequence | `LogSplitterSequenceFiltering` | Each trace is cut into `k` consecutive segments. For part `i` (except the last) the cut point minimises a running cost: `−1` per event in `σᵢ`, `+1` per event in a not-yet-consumed part, `0` for events of already-consumed parts; the earliest position of least cost wins. The last part takes the remainder. Each segment then drops events outside its own part. |
| parallel | `LogSplitterConcurrent` | Straight projection: sublog `i` is the whole log with all events outside `σᵢ` removed. Trace count preserved; empty traces are produced where a trace had no `σᵢ` events. |
| loop | `LogSplitterLoop` | Each trace is chopped into maximal runs of one part. Body sublog gets the run before the first redo; redo sublogs get their runs as separate traces. Non-body sublogs drop traces with no events of that part. **Trace counts grow.** |

`LogSplitterInterleavedFiltering` / `LogSplitterOr` are wired up but unreachable —
no IM/IMf cut finder emits `interleaved` or `or`.

### C.5 Fall-throughs, in order

Reached only when **no** cut is valid.

1. **Once-per-trace activity → parallel.** Activities sorted **ascending by
   occurrence count**; the first `a` with `#emptyTraces == 0 && count(a) == #traces`
   is pulled out as `parallel(mine({a}-projection), mine(rest-projection))`.
   **[impl]** "Ascending" and the hash-order tie-break are both implementation
   choices, not paper statements (hazard D4).
2. **Leave-out-one activity → parallel.** Needs ≥ 3 activities. For each `a`,
   restrict the DFG to `Σ∖{a}` and try `xor → sequence → parallel → loop` on it;
   if some `a` makes a valid cut appear, split parallel on `{a} | Σ∖{a}` and
   recurse. **[impl]** ProM evaluates the candidates on a thread pool and takes
   the **first to finish**, so *which* `a` wins is a race (hazard D5).
3. **Strict tau loop.** Needs ≥ 2 activities. Split every trace at each position
   where the previous event is an end activity **and** the current one is a start
   activity. If any trace was split → `loop(mine(split log), tau, tau)`.
4. **Tau loop.** Same, but splits at every start activity that is not the first
   event of the current segment (no end-activity requirement). Applies only if
   the split produced strictly more traces.
5. **Flower model.** Always succeeds: `loop(xor(a₁ … aₙ), tau, tau)`, or
   `loop(a, tau, tau)` for a single activity. **This is what guarantees
   termination** together with the fact that every cut and every fall-through
   strictly reduces either the activity set or the trace length.

### C.6 The reduction pass — do not skip this

`mineEfficientTree` finishes with
`EfficientTreeReduce.reduce(tree, new EfficientTreeReduceParametersForPetriNet(false))`.
**[impl]** The reduced tree is what the user sees, so parity means parity *after*
reduction. In order:

1. Replace every operator subtree that **can only produce tau** with `tau`.
2. Remove **superfluous taus** under `xor` / `sequence` / `parallel`.
3. Loop the following per-operator rules to a fixpoint:
   - `xor`: `SingleChild`, `XorTauTau` (drop a second tau child when another child
     can already produce tau), `SameOperator` (flatten nested xor),
     **`XorTauTauLoop2flowerRevert`** — rewrite `xor(tau, loop(A,tau,tau))` into
     `loop(tau, A, tau)`.
   - `sequence`, `parallel`: `SingleChild`, `TauChildOfSeqAndInt` (drop tau
     children when ≥ 2 children), `SameOperator`.
   - `loop`: `LoopLoop` (collapse nested loops) only — the `ForPetriNet` parameter
     object **removes** the `LoopTau` rule that the plain parameters would apply.

`SingleChild` — an operator with exactly one child is replaced by that child — is
the rule that does most of the visible work, because the cut finders regularly
produce single-child operators.

### C.7 Tree shape

- Leaf: an activity label, or `tau`.
- `xor`, `sequence`, `concurrent`: n-ary, n ≥ 1 (n = 1 removed by reduction).
- **`loop` is ternary**: `(body, redo, exit)`. The miner always constructs the exit
  child as `tau`; with `LoopTau` disabled, no rule introduces a non-tau exit. When
  a loop cut has more than one redo part, the redos are wrapped in an `xor` first.
- **Duplicate activity labels cannot occur.** Every cut partitions the activity
  set, so each activity reaches exactly one leaf. There is no duplicate-label
  handling to port because the algorithm cannot produce duplicates.

---

## D. Determinism hazards — the list to test against

ProM is deterministic-per-JVM in most places but *arbitrary* in several, and two
of those are semantically meaningful. This is where differential testing will
find mismatches that are nobody's bug.

| # | Source | Effect | Semantically meaningful? |
|---|---|---|---|
| D1 | Activity ids follow **first-occurrence order** | node order of every component structure | Indirectly — it is the tie-break for D3/D4 |
| D2 | SCCs returned in a hash set (`THashSet<TIntSet>`) | vertex order of the condensed graph for the sequence cut | **No** — the reachability sort should impose a total order afterwards. *To be verified empirically.* |
| D3 | `IntComponents.getComponents()` iterates a trove hash map | order of parts in xor / parallel / loop-redo partitions; **and which part is "part 0"** in `ensureStartEndInEach` | Child order: no (canonicalise). Part 0: **yes** |
| D4 | `sortByCardinality` ties broken by hash key order | which once-per-trace activity is pulled out first | **Yes** |
| D5 | `FallThroughActivityConcurrent` runs candidates on a thread pool, first finisher wins | which activity is left out | **Yes — a genuine race** |
| D6 | `Collections.sort` with a comparator that never returns 0 | sequence order | No, if D2 holds |

**Mitigations:**

- The oracle harness must set `setUseMultithreading(false)` — otherwise D5 makes
  the reference itself non-reproducible run-to-run. That is a *precondition* for
  Phase 3, not an optimisation.
- Rust picks the **lowest activity id** as an explicit, documented tie-break
  wherever ProM is arbitrary (D3 part-0, D4 ties). Documented as a known
  deviation rather than reverse-engineered from trove's hash function — chasing
  trove hash order would be both fragile and closer to "copying the expression".
- Canonicalisation for tests sorts children of `xor` and `parallel`, and the redo
  branches of a multi-redo `loop`, but **never** the children of `sequence` or the
  body/redo/exit roles of a `loop`.

---

## E. Phase 2 — language-independent specification

Normative shape for `inductive-miner-core`. `L` is a multiset of traces over
activity ids; `θ ∈ [0,1]` is the noise threshold; `V ∈ {IM, IMf}`.

```
discover(L, V, θ):
    θ ← 0 if V = IM
    T ← mine(L)
    return reduce(T)

mine(L):
    I ← info(L)                          # dfg, start, end, #ε, msd, counts

    for b in baseCases(V):
        if t ← b(L, I): return t

    for c in cutFinders(V):
        if valid(k ← c(L, I)): 
            return build(k.op, [mine(s) for s in split(L, I, k)])

    for f in fallThroughs():
        if t ← f(L, I): return t

    unreachable                          # flower always fires

baseCases(IM)  = [singleActivity, semiFlower, emptyLog, emptyTraces]
baseCases(IMf) = [emptyLog, emptyTracesNoise, emptyTraces, singleActivityNoise]
                 ++ baseCases(IM)

cutFinders(IM)  = [xor, sequence, parallelMsd, parallel, loop]
cutFinders(IMf) = cutFinders(IM) ++ [ λ(L,I). firstValid(cutFinders(IM),
                                              L, filterNoise(I, θ)) ]

fallThroughs()  = [oncePerTraceStrict, leaveOutActivity,
                   tauLoopStrict, tauLoop, flower]

build(loop, [b, r₁…rₙ]) = loop(b, n = 1 ? r₁ : xor(r₁…rₙ), tau)
build(op,   cs)         = op(cs)
```

Contracts each detector must satisfy:

```
detector      precondition            partition                      splitter    operator
────────────────────────────────────────────────────────────────────────────────────────
xor           —                       connected components of DFG    xorFilter   xor
sequence      >1 SCC                  SCC-condense, xor-condense,    seqFilter   sequence
                                      reachability order, pivot-
                                      merge                          
parallelMsd   start≠∅ ∧ end≠∅         parallel components, msd-      project     parallel
                                      merged, start/end-repaired
parallel      start≠∅ ∧ end≠∅         parallel components,           project     parallel
                                      start/end-repaired
loop          start≠∅ ∧ end≠∅         body = start∪end closure,      loopSplit   loop
                                      redos validated against all
                                      start/end activities
```

`valid(k) ⟺ k ≠ ⊥ ∧ |k.parts| ≥ 2 ∧ ∀p ∈ k.parts. p ≠ ∅`.

### Documented deviations from ProM (to keep updated)

| # | Deviation | Why |
|---|---|---|
| 1 | Arbitrary choices resolved by lowest activity id, not trove hash order | D3, D4 — reproducible and not a re-expression of ProM's data structures |
| 2 | `leaveOutActivity` scans candidates in ascending activity-id order, single-threaded | D5 is a race; a deterministic rule is strictly better |
| 3 | No life-cycle model | Inert for IM/IMf by construction |
| 4 | Event order is `trace_idx, event_idx` (log order), not timestamp order | Decision below |

### Decisions taken (2026-08-17)

**Licence.** `inductive-miner-core` is **MIT**, like the other Promenade plugin
crates. The implementation is independent and the algorithm is published; the
plugin README credits Leemans, cites both DOIs, and states that behaviour was
verified against ProM's L-GPL implementation without deriving from its source.
The residual risk described in [licensing.md](./licensing.md) is accepted.

**Loop arity.** The core uses the **standard process-tree definition**:
`↺(M₁, …, Mₙ)`, `n ≥ 2` — first child is the body, the rest are redo branches.
ProM's ternary `loop(body, redo, exit)` is an implementation extension, and
`↺(B, R, τ) ≡ ↺(B, R)`, so the always-tau exit child is not represented. The
oracle asserts the exit child is tau on every discovered tree; if that ever fails,
the run is an error rather than a silent re-interpretation. Because ProM already
wraps multiple redo parts in an `xor` before constructing the loop, IM/IMf output
is always exactly two children — which is also what the existing pm4py-based
`ProcessTree → AcceptingPetriNet` action expects.

**Event order.** `ORDER BY trace_idx, event_idx` — log order, matching ProM's use
of XES file order, and working on logs with no timestamps at all. This differs
from `dfg-rs`, `alpha-miner-rs` and `heuristics-miner-rs`, which order by
timestamp and drop rows with a null timestamp. Rather than fork the shared
worker or change those three, the scan ordering becomes a **manifest-declared
option** on the kernel, defaulting to today's timestamp behaviour so existing
packages are unaffected.

### Three things the host boundary had to learn (2026-08-17)

Found by running the finished plugin in the app against the reference, not by
the crate's tests — each is invisible from inside the algorithm:

1. **Activity numbering is part of the behaviour.** Three tie-breaks in this
   algorithm fall back on the activity id (D3, D4, and the leave-out-activity
   candidate order), so a different numbering is a different — still valid —
   model. The host numbered activities most-frequent-first; ProM numbers them in
   order of first appearance. On `mini.xes` at threshold 1 that was
   `→(A,X,C,B,D)` against ProM's `→(A, ×(B, →(X,C)), D)`. Now declared as
   `scan.activityIds: "firstAppearance"`. **This is the one that would have
   quietly invalidated the parity claim**: every differential case passed, and
   the shipped plugin still disagreed with ProM.
2. **Empty traces are invisible in a row-based transport.** A case with no
   events contributes no `(case, activity)` rows, so the kernel cannot
   distinguish it from a case that does not exist — and an empty trace is
   exactly what makes a block optional. Now declared as
   `scan.includeEmptyTraces`, which emits one synthetic row per empty case.
3. **A sandboxed view is handed its payload once.** Unrelated to this algorithm
   but exposed by it: the host sent an inline artifact's value only in the
   frame's `init` message, so a recomputed artifact left its viewer drawing the
   old result. Fixed in `PluginPanel`.

---

## F. What is deliberately not ported

Swing/UITopia, `PluginContext`, ProM connections, the XES importer, `DfgMsd`
import/export, ProcessTree visualisation, `EfficientTree2AcceptingPetriNet`
(separate Promenade action), Java serialisation, ProM logging, the package
manager, the `withoutlog` DFG-based miner, life-cycle and partial-trace variants,
and the SAT/IMc probability machinery.
