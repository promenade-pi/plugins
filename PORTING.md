# Porting a ProM plugin to Rust/WASM

Written after porting ProM's Inductive Miner (`inductive-miner-rs`), which
reached exact behavioural parity with the reference over ~208,000 differential
cases. This is the account of what actually mattered, including the parts that
went wrong. It is aimed at whoever — human or model — does the next one.

The short version: **the algorithm is the easy part.** The hard parts are
proving you matched the reference, and the host boundary, where three defects
survived 208,000 passing tests.

---

## 0. The licence gate — and where the licence actually is

Do this before reading source with the intent to translate.

**The licence is usually not in the repository.** ProM packages typically have
no `LICENSE` file and no source headers. `promworkbench/InductiveMiner` has
neither: 146 `.java` files, not one header, no COPYING. The licence lives in the
packaging build:

```bash
grep -i 'license' build.xml            # <property name="license" value="L-GPL" />
curl -sL http://www.promtools.org/prom6/packages/<Package>/packages.xml
```

Ant substitutes that property into the published `packages.xml`, which is what
the ProM Package Manager reads. Check the live repository too — that is the
declaration that was actually published.

**Check every package you will depend on, not just the obvious one.** ProM's
framework is GPL; individual packages "may use a license that suits them best"
and are *not* guaranteed GPL-compatible. Each must be checked.

**What follows from L-GPL:** a translation is a derivative work and cannot be
MIT. An independent implementation of a published algorithm can be — algorithms
are not copyrightable, their expression is. So:

- Papers and the algorithm's own DOIs are the source. ProM often cites them
  itself (`getDoi()`).
- The reference is a **black box**: run its published jar, never vendor or
  translate it.
- Structure your implementation differently (different data model, different
  recursion shape, no transliterated identifiers, no copied comments).

**State the limit honestly.** If you read the source to determine behaviour —
and you will have to, because the parts that decide parity appear in no paper —
that is a *clean reimplementation*, not a certified clean-room. Say so in a
`docs/licensing.md`, credit the author, cite the DOIs, and let the project owner
decide whether the crate is MIT or LGPL. Do not make that call silently.

## 1. Find the real algorithm, and the package it hides in

**Separate ProM integration from algorithm early.** Write the table before
writing code: entry points, dialogs, parameter classes, the algorithm driver,
the framework types. In the Inductive Miner the whole algorithm reduced to one
function whose only ProM dependency was a `Canceller` interface — one boolean
callback. That is typical.

**Follow the imports out of the package.** `inductiveminer2` imports its tree
representation *and its entire output-reduction stage* from a second repository
(`InductiveMinerDeprecated`). Missing that would have meant comparing against
a tree the user never sees. Whatever shapes the final output often lives
somewhere else — look for `*Reduce*`, `*Simplify*`, `*Postprocess*`,
`Efficient*`, and anything the plugin calls *after* the algorithm returns.

**Enumerate variants before choosing.** ProM's dialog offered seven; they are
different algorithms sharing a name, not options. Find the default (the dialog's
`setSelectedIndex`) — it is what users actually run. Port the ones you name and
say which you did not.

**Read the parameter classes as a list, not as prose.** Cut detectors, base
cases, fall-throughs are usually *ordered lists* in a variant class. The order
is the algorithm. Copy the order into your spec verbatim, with the class names,
before you understand why.

## 2. Build the oracle first — and make it a batch process

Do this **before** writing the implementation. It is the riskiest piece; if it
turns out infeasible, the whole strategy changes.

**Assemble a headless classpath from published jars.** No Ant, no ProM GUI. The
plugin repositories ship prebuilt jars in `latestrelease/`, and the ProM package
repository serves the framework and libraries. `inductive-miner-rs/tools/oracle/setup.sh`
is a working template.

**One process, NDJSON over stdin.** One JSON request per line in, one response
per line out. 208,000 cases run in ~20 seconds. A process per case would be
208,000 × ~0.4 s of JVM startup — about a day.

**Make the reference deterministic, and treat that as a precondition.** ProM's
Inductive Miner races one fall-through's candidates on a thread pool and keeps
whichever finishes first; without `setUseMultithreading(false)` the reference is
not reproducible *against itself*. Look for `ExecutorService`, `JobList`,
`AtomicBoolean found`. You cannot find this from the outside — read for it.

**Define one canonical output string.** Compact, diffable, human-readable:
`seq('a',xor('b',tau))`. Sort the children of commutative operators only. Emit
both raw and canonical, so you can see whether a mismatch is real or ordering.

**Assert your assumptions in the oracle.** The port assumed a loop's third child
was always tau; the oracle checked it on every single run and would have flagged
the one case where it was not. Assumptions that are only in your head are not
tested.

## 3. Implement — including the reference's bugs

**Split the crate now, not later.** A pure core (no wasm, no host types, no
serde-js), a CLI harness sharing the oracle's I/O contract, and a thin wasm
kernel. The CLI is what makes 208,000-case differential testing possible at all.

**Trace variants with multiplicities, not traces.** Every per-trace,
order-independent operation collapses. It turned 200,000 traces into 3 variants
on one benchmark. Verify order-independence before relying on it.

**Reproduce bugs, do not fix them.** Parity means bug-parity. Two real examples:

- The noise filter loops `0 .. numberOfActivities-1` over *global* activity ids,
  so deep in the recursion, where ids are sparse, it filters almost nothing. A
  "corrected" filter discovers visibly different models.
- A helper returned its first cut unconditionally, making three subsequent
  detectors unreachable dead code. The real test was much simpler than it looked.

Mark each one `[impl]` in your spec with a sentence on why it is deliberate.
Otherwise the next reader "fixes" it.

**Write the spec as prose first, then implement from the prose.** Facts about
behaviour are not copyrightable; code is. This also forces you to notice what
you have not actually understood.

## 4. The differential loop — where the work really is

**The mismatch curve is the deliverable.** Ours:

```
412 / 8,000   first complete implementation
152           after fixing tie-break direction
 51           after fixing parallel-branch ordering
  2           after fixing two filter bugs
  0           after fixing reduction rule order
```

**If your first differential run passes, distrust the harness.** A suite green
from the start is measuring nothing. Check that it can fail: break something on
purpose and confirm it reports.

**Three generators, because they find different things.**

| generator | finds |
|---|---|
| hand-written per construct and boundary | regressions a human can read |
| random small logs over a tiny alphabet | fall-through behaviour — nonsense drives the recursion past every normal path |
| random sound models, simulated, rediscovered | deep nesting random logs never reach |

Add a "wide" profile (larger alphabets, longer traces) — it finds different
things again, and costs nothing.

**Never loosen canonicalisation to make a test pass.** Sort commutative
operators; never sequences, never a loop's body/redo roles. If you find yourself
widening the equivalence, you are deleting the finding.

**Reduce every mismatch to its smallest case, then bisect by hand.** Feed the
suspected sublog to *both* implementations directly. Our last two mismatches were
found by peeling one recursion level at a time until the two agreed, which
located the divergence exactly.

**When the reference's order is "arbitrary", measure it — do not guess and do
not emulate internals.** ProM's tie-breaks depend on `gnu.trove` hash iteration
order. Two dead ends and one good path:

- *Guessing* ascending ids: plausible, wrong, 260 mismatches.
- *Emulating* the hash table (prime capacity, probe sequence, rehash): I worked
  out that it was feasible and rejected it. Fragile, version-dependent, and it
  edges toward reproducing the implementation rather than the algorithm.
- *Probing*: a 20-line Java program that inserts keys and prints iteration
  order. Answer: **descending** for dense int sets, at every size from 2 to
  2,000. One-line change, 412 → 152 mismatches.

Write the probe. It takes five minutes and replaces an afternoon of reasoning.

**Rule application order can be semantic.** Tree reduction bottom-up "obviously"
seemed right — reduce children so parents see the reduced form. It is wrong:
ProM sweeps its node array from index 0, which is pre-order, and at one shape
the root rule fires first and parks a subtree where nothing else touches it.
Check how the reference *iterates*, not just what its rules say.

**Then lock it in.** Generate golden tests from oracle output into the crate's
own `tests/`, so the suite runs without Java. Regenerate deliberately via a
script and read the diff — every moved line is a claim.

## 5. The host boundary — a second implementation nobody tests

**This is the section to read twice.** Three defects lived here, invisible to
208,000 passing crate tests, and one of them would have silently invalidated the
entire parity claim.

1. **Activity numbering is behaviour, not plumbing.** The host numbered
   activities most-frequent-first; the reference numbers them in order of first
   appearance. Three of the algorithm's tie-breaks read the activity id, so the
   shipped plugin produced a *different, still valid* model from the one every
   test verified. Every case passed. The app disagreed.
2. **Empty traces vanish in a row-based transport.** A case with no events
   contributes no `(case, activity)` rows, so the kernel cannot tell it from a
   case that does not exist — and an empty trace is exactly what makes a block
   optional.
3. **Sandboxed views were handed their payload once, at frame creation.** Every
   live recompute left the viewer drawing the previous result: no error, no
   console message, just a picture that quietly stopped matching the parameters
   beside it.

**The rule that follows: differentially test the *shipped plugin*, not just the
crate.** Run the real thing in the app on a real log, take its output, and feed
the identical log to the oracle. If they disagree, the boundary is lying.

**Promenade-specific traps, concretely:**

- `wasm-plugin-worker.ts` defaults `params.maxActivities ?? 24`. Declare the
  parameter or your plugin silently sees **24 activities**.
- The scan is configurable per manifest and each option defaults to the old
  behaviour, so check whether you need it:
  `kernel.scan.order` (`timestamp` | `log`), `kernel.scan.includeEmptyTraces`,
  `kernel.scan.activityIds` (`frequency` | `firstAppearance`).
- These are read via `(manifest as any).kernel` and are **not validated**. A typo
  silently selects the default.
- `prepareKey` differs between an action's first run and its live recomputes, so
  every recompute currently discards the cached scan.
- The kernel gets integer activity ids. If your artifact payload needs labels,
  call `setActivityNames` — the worker passes them when the kernel exposes it.
- `payloadOf()` unwraps `{result, timing, …}`; your `finalize` return value *is*
  the artifact payload. Validate it against the host's contract
  (e.g. `validateProcessTree`) in a Node script before shipping — see
  `tools/wasmcheck.mjs`.

**Verify in the app with real interactions.** `form_input` sets a React
`<select>`'s value in a way React's value tracker ignores, so no change event
fires and nothing recomputes. Use real clicks and keystrokes, or you will
conclude a working feature is broken — or worse, that a broken one works.

## 6. Artifact contracts follow the domain, not the reference

ProM's loop node is ternary `(body, redo, exit)`; the standard process-tree
definition is n-ary with the body first. I initially proposed carrying ProM's
shape into the artifact. That was the wrong instinct: **the artifact type is a
contract between plugins, so it follows the domain's standard definition.**

Keep the reference's shape *internally* where its rules need it, and convert at
the output boundary — with an assertion that the conversion is lossless
(here: the exit child is always tau, checked on every oracle run).

## 7. Shipping

**Limits in a manifest are claims. Measure them.** I set an activity limit of
2,000 by analogy with the neighbouring plugins. Measuring showed it was wrong in
both directions: a well-structured log of 10,000 activities takes ~1 s, while an
*unstructured* one of 2,000 already takes seconds with fewer than 2,000 events
in it. Measure the shape that stresses the algorithm, not just the big one.

Measuring also exposed a needless quadratic — a transitive closure stored as a
byte matrix plus a redundant backward copy. One bitset instead: 463 MB → 49 MB.

**Never truncate silently.** If input exceeds a bound, report it in the result
(`activitiesDropped`) so a truncated run cannot be mistaken for a complete one.

**Bump the version on every packaged change.** I overwrote `0.1.0` in place
several times. The workspace ended up pinned to a stale build with no update
path, because the plugin manager compares *version strings* — it showed
"installed" and never offered the newer bytes. Once a version has been installed
anywhere, it is immutable.

**Say what the parameter does, in the parameter.** "Activity limit" was read as
an event limit and caused a real misunderstanding. Renamed to "Distinct
activities", with a description that opens by saying what it is *not*. When two
plugins expose similar-looking knobs that limit different quantities, make the
difference loud rather than harmonising the names.

## 8. Antipatterns, condensed

| Tried | What happened | Do instead |
|---|---|---|
| Guess the reference's arbitrary ordering | 260 mismatches | Write a probe program against the actual library |
| Emulate the reference's hash-table internals | Rejected: fragile, version-bound, closer to copying | Match the *observable* rule; document residual risk |
| Reduce the output tree bottom-up | Different (valid) trees | Check how the reference *iterates* its nodes |
| Carry the reference's internal node shape into the artifact | Would break the type's other consumers | Follow the domain's standard definition; convert at the boundary |
| Set a limit by analogy with a neighbouring plugin | Wrong in both directions | Measure, including the unstructured worst case |
| Trust 208,000 green crate tests | Three boundary defects survived them | Differentially test the shipped plugin in the app |
| Overwrite a version in place | Workspace stuck on stale build, no update path | Bump on every packaged change |
| `form_input` on a React select | Silently no-op; looked like a broken feature | Real clicks and keystrokes |
| One oracle process per test case | ~1 day instead of 20 s | Batch NDJSON over stdin |

## 9. Reusable assets

`inductive-miner-rs/tools/` is a working template, not an example:

| file | purpose |
|---|---|
| `oracle/setup.sh` | assembles the headless ProM classpath from published jars |
| `oracle/OracleMain.java` | NDJSON batch mode + real-XES mode with classifier selection |
| `gencases.py` | hand-written + random + model-simulated cases, two size profiles |
| `diff.sh`, `compare.py` | run both sides, classify and rank mismatches smallest-first |
| `goldenlogs.sh` | real XES logs through both sides, across classifiers and settings |
| `mkgolden.py`, `regolden.sh` | freeze oracle answers into crate tests |
| `wasmcheck.mjs` | drive the built kernel through the host ABI, validate the payload |
| `bench.py`, `wasmbench.mjs` | native and browser benchmarks |

Adapting them to another miner is mostly a matter of changing the ProM entry
point and the canonical-form renderer.

**What should become shared Rust infrastructure** (currently duplicated across
four plugins): the trace-variant log, the activity dictionary *with its
numbering rule made explicit*, the DFG, the `ProcessTree` mirror of the host
contract, and deterministic graph primitives (union-find with a stable
representative, connected components, iterative Tarjan, bitset reachability).

## 10. Definition of done

The port is not done when it compiles and returns something plausible. It is
done when:

- the licence position is written down and the risk named;
- the reference's exact variant and version are pinned, and its
  non-determinism is switched off;
- an oracle reproduces the reference on demand, in batch;
- the mismatch count reached zero *without* loosening the comparison, and the
  path to zero is recorded;
- golden tests run without the reference present;
- the **shipped plugin** — not the crate — was verified against the oracle on a
  real log inside the app;
- every deviation from the reference is listed, including the ones that are the
  reference's own arbitrariness.
