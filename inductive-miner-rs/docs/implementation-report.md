# Implementation report

## Algorithm implemented

Leemans, Fahland & van der Aalst's **Inductive Miner**, both variants that
ProM's `inductiveminer2` package offers without a life-cycle or partial-trace
model:

- **IM** — fitness-guaranteeing. The noise threshold is forced to 0.
- **IMf** — infrequent-behaviour tolerant. ProM's own default selection, at a
  default threshold of 0.2, and the default here.

Not implemented, and deliberately: `IMlc` / `IMflc` (life-cycle), the
partial-trace variants, the DFG-based `InductiveMinerWithoutLog`, and the
SAT-based `IMc` probability machinery. These are different algorithms sharing a
name, not options of the same one.

Output is a `ProcessTree`. Petri-net conversion is a separate action on the
artifact, which is also how ProM splits it.

## Reference

| Repository | Commit | Published as |
|---|---|---|
| `promworkbench/InductiveMiner` | `de00027ca901b6bab5b7765d07c096aee58841eb` | `InductiveMiner` 6.14.5 |
| `promworkbench/InductiveMinerDeprecated` | `794e47ad99672dcbe643af193b7e9b6b548beba3` | `InductiveMinerDeprecated` 6.14.12 |

The second is not optional: the process-tree representation and the whole
tree-reduction stage live there, and the reduced tree is what a user sees.

The oracle runs those packages' **published jars** headless, with
`setUseMultithreading(false)`. That flag is a precondition, not a tuning knob:
ProM's "leave out an activity" fall-through races its candidates on a thread
pool and keeps whichever finishes first, so with the pool on, the reference is
not reproducible against itself.

**Licensing.** Both packages are L-GPL, declared through ProM's packaging
metadata rather than by any file in either repository — there is no LICENSE
file and not one source header. A translation could not be MIT; an independent
implementation of a published algorithm can be. See
[licensing.md](./licensing.md), including the honest limit: this is a clean
reimplementation, not a certified clean-room.

## Important semantic decisions

**Cut detection order** — `xor, sequence, parallel-with-minimum-self-distance,
parallel, loop`, first valid wins. The MSD variant *before* plain parallel is
load-bearing: a small loop and a concurrency produce the same directly-follows
graph, and asking the MSD detector second would read every such loop as
parallelism.

**Noise filtering is a fallback, not preprocessing.** IMf appends one extra cut
finder *after* the five. The five run on the unfiltered graph; only if all fail
is a filtered copy built and the same five re-run. A naive "filter, then cut"
implementation is a different algorithm — and it is the reading most people
start from.

**Log splitting never reads the threshold.** IMf overrides no splitter. Noise
affects cut detection and base cases only.

**The filter is per-source and relative**, and an activity's end-cardinality
counts as one of its outgoing options. It runs *after* start/end activities have
been thinned, so it measures against already-reduced counts. Two ProM behaviours
are reproduced deliberately rather than corrected:

- Its activity loop runs `0 .. numberOfActivities-1` over *global* ids, so
  deeper in the recursion, where ids are sparse, only activities numbered below
  the count get filtered at all. This is a large part of what IMf does on real
  logs; a "fixed" filter discovers visibly different models.
- Its `DfgCutFinderSimple`, used by the leave-out-activity fall-through, returns
  the exclusive-choice cut unconditionally, making its three subsequent
  detectors unreachable. The real test is whether the graph disconnects.

**Empty traces** are a base case, `×(discover(rest), τ)` — except in IMf, where
too few of them are treated as noise and dropped without the `×(·, τ)` wrapper.
A log of nothing but empty traces has zero activities and yields `τ`.

**Loops** are ternary internally, `(body, redo, exit)`, because the reduction
rules are defined over that shape. The exit child is always τ for these
variants — asserted on every oracle run — and `↺(B,R,τ) ≡ ↺(B,R)`, so the
artifact carries the standard process-tree loop.

**Classifiers** are entirely the host's business. Promenade's classifier
redefines a log's `activity` column, so the plugin sees event classes and never
XES. The golden tests exercise `concept:name` and `concept:name + lifecycle`
through ProM's own classifier implementation.

**Tree reduction is applied top-down**, matching ProM's array sweep. Not
cosmetic: at `×(τ, ↺(↺(S,τ,τ),τ,τ))` the root rule reverts the flower first and
parks the inner loop in a redo position where nothing collapses it. Reducing
children first yields a different — equally correct — tree. This was the last
mismatch in the differential suite.

## Test results

```
Hand-written reference cases:       364      (per construct, per boundary)
Generated differential cases:   208,000
  small profile, seeds 1–9        168,000
  wide profile,  seeds 11–14       40,000
Golden real-log cases:               24      (3 logs × 2 classifiers × 4 settings)
Mismatches unresolved:                0
```

Generated cases come from three sources, because they find different things:
arbitrary small logs (which drive the recursion into the fall-throughs, where
the undocumented behaviour is), random sound process trees simulated into logs
(deep nesting that random logs never reach), and a wide profile with up to 16
activities, 40 traces and 25-event traces.

Golden logs: `running-example`, `reviewing` and `receipt` from the pm4py test
corpus. The logs are downloaded, never committed; what is in the repository is
`tests/golden-logs.txt`, the canonical trees.

**The mismatch history is the useful part**, since a suite that was green from
the start would only mean it was weak:

| after | mismatches / 8,000 | cause found |
|---|---|---|
| first complete implementation | 412 | — |
| tie-breaks resolved descending | 152 | ProM's collections enumerate activity ids descending; ascending was a guess |
| parallel branch ordering | 51 | which branch absorbs components that cannot start or end on their own |
| filter fixes | 2 | filtering against unfiltered end counts; and ProM's id-range bug |
| top-down reduction | **0** | rule application order |

Every one was a misreading of the reference, not a nondeterminism to be excused
away. None were resolved by loosening canonicalisation: children of `xor` and
`parallel` are sorted, sequence order and loop roles never are.

Three further defects were found only by running the finished plugin in the app,
and are invisible from inside the crate — see [prom-reference.md](./prom-reference.md).
The worst was activity numbering: every differential case passed while the
shipped plugin still disagreed with ProM, because the host numbered activities
by frequency and three of this algorithm's tie-breaks read the activity id.

## Performance

Native, against the reference on the same logs and machine (both figures include
JSON parsing, so read the ratio, not the absolute):

| shape | traces | events | variants | Rust | ProM |
|---|---|---|---|---|---|
| many traces, few variants | 200,000 | 1,579,974 | 3 | 196 ms | 4,210 ms |
| many variants | 20,000 | 150,687 | 18,083 | 39 ms | 566 ms |
| many activities (200) | 20,000 | 249,261 | 3,014 | 80 ms | 10,458 ms |
| deep recursion (60 levels) | 5,000 | 300,000 | 1 | 35 ms | 1,044 ms |
| noisy (5%), IMf | 50,000 | 400,000 | 29 | 47 ms | 611 ms |

No pathological shape turned up. Cost tracks **trace variants**, not traces,
which is why 1.6 M events over three behaviours costs less than 150 K events
over 18,000.

### Large alphabets, and where the activity limit comes from

The limit was originally 2,000, picked by analogy with the other plugins rather
than measured. Measuring it showed the guess was wrong in both directions:

| log | activities | events | time | peak memory |
|---|---|---|---|---|
| pure sequence | 2,000 | 40,000 | 36 ms | 8 MB |
| pure sequence | 5,000 | 100,000 | 250 ms | 20 MB |
| pure sequence | 10,000 | 200,000 | 1.1 s | 49 MB |
| random traces | 1,000 | 1,900 | 1.4 s | 78 MB |
| random traces | 2,000 | 1,900 | 5.6 s | 188 MB |

**Alphabet size is not the cost driver; missing structure is.** A well-structured
log of 10,000 activities is comfortable; an unstructured one of 2,000 already
takes seconds with fewer than 2,000 events, because once no cut applies the
fall-throughs peel one activity per recursion level and each level runs a
quadratic parallel-cut test. The limit is a crude proxy for that, but it is the
only one available before the log is read. Raised to 10,000 with a default of
2,000, which clears any realistic log.

Measuring also exposed a needless quadratic: the sequence cut stored its
transitive closure as `Vec<Vec<bool>>` *plus* a backward copy, when "b reaches a"
is the forward relation read the other way round. One bitset instead of two byte
matrices cut peak memory at 10,000 activities from **463 MB to 49 MB** and
runtime from 1.57 s to 1.07 s.

Browser runtime, through the full host ABI including chunking:

| shape | events | scan (cached) | discover |
|---|---|---|---|
| many traces, few variants | 1,600,000 | 19 ms | 2 ms |
| many variants | 147,007 | 2 ms | 8 ms |
| many activities (200) | 198,048 | 3 ms | 31 ms |
| deep recursion (60) | 300,000 | 2 ms | 0 ms |

Note the shape of that table: **the cached stage is the cheap one here**, the
reverse of the DFG, Alpha and Heuristics kernels. The manifest does not mark the
noise threshold `cheap`, and its description says a re-run is not instant.

## WASM bundle

| | |
|---|---|
| `.wasm` | 181.5 KB raw, **74.1 KB gzipped** |
| glue | 17.4 KB raw, 4.5 KB gzipped |
| `.pmplugin` package | 105,832 bytes (includes README and four doc pages) |
| initialisation | 27.8 ms, compile + instantiate |

## Known differences from ProM

Every one is a place where ProM's own answer is arbitrary, plus one where it is
not reproducible at all.

1. **The leave-out-activity fall-through is a thread race in ProM.** This is
   single-threaded and takes candidates in a fixed order.
2. **Arbitrary orderings follow descending activity index.** That is what ProM's
   collections are *observed* to produce for dense index sets — verified by
   probing the library directly, at sizes from 2 to 2,000 — but it is a property
   of a Java collection, not of the algorithm. Sparse enough index sets can
   diverge from it (17 of 500 randomly-sampled sparse subsets did). No such case
   appeared in 208,000 generated logs, and it is not chased further: emulating a
   hash table's internal layout would be fragile and would edge toward
   reproducing ProM's implementation rather than its algorithm.
3. **No life-cycle model.** Exact rather than approximate for IM and IMf: both
   map every event to `complete`, so the machinery is inert.
4. **Only IM and IMf.**
5. **Activity limit** of 10,000 (default 2,000), the host keeping the most
   frequent. ProM has no such limit. It is a ceiling for pathological input;
   a run that hits it reports `activitiesDropped` rather than looking complete.

## Future work — what should move into a shared Promenade Rust library

Four plugins now each carry their own copy of the same ideas.

**Ready to share, in rough order of value:**

1. **Trace-variant log.** `Vec<(Vec<ActivityId>, u64)>` with collapse-on-write.
   The single largest win here, and every miner wants it.
2. **Activity dictionary.** Name ↔ dense id, with the numbering rule made
   explicit — this report is evidence that the rule is semantic, not
   incidental, and it should not be re-decided per plugin.
3. **DFG.** `dfg-rs`, `alpha-miner-rs`, `heuristics-miner-rs` and this crate all
   build directly-follows counts with start/end multisets. Four
   implementations, four chances to disagree about what an edge is.
4. **ProcessTree.** The Rust mirror of the host's `ProcessTree` contract, with
   the flat-payload conversion and canonical rendering. A second tree-producing
   plugin should not re-derive the payload shape.
5. **Graph primitives.** Union-find with a stable representative, connected
   components, iterative Tarjan, transitive closure — all written here with
   determinism as the requirement, which is the part that is easy to get subtly
   wrong twice.

**Not yet:** `PetriNet` and `Marking` live host-side today and are only produced
by the pm4py path; a Rust owner should exist first.

**The differential-testing harness generalises.** The oracle pattern —
NDJSON in, canonical model out, one process for thousands of cases — would work
for Alpha and Heuristics against their ProM equivalents, and neither currently
has anything comparable. `tools/` here is a working template, and what was
learned doing it — including the dead ends — is written up for the next port in
[../PORTING.md](../../PORTING.md).

**Two host gaps this exposed and did not close:**

- `prepareKey` differs between an action's first run and its live recomputes
  (`id::500` versus `id:500`), so every recompute discards the cached scan. It
  costs 19 ms here; on a kernel with an expensive scan it is the whole live loop.
- The scan options added here (`order`, `includeEmptyTraces`, `activityIds`) are
  read with `(manifest as any).kernel` and are not validated. A typo in a
  manifest silently selects the default, which is exactly the class of failure
  the manifest validator exists to prevent.
