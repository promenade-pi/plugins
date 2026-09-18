# Phase 0 — Licence gate

**Verdict: do not translate the Java source. Clean-reimplement from the papers,
use ProM only as a black-box oracle.**

The relevant ProM code is **L-GPL**. That is not compatible with shipping an
MIT-licensed Rust crate that is a translation of it. It *is* compatible with
writing an independent implementation of the published algorithm and testing it
against ProM's observable output.

## What was inspected

| Repository | Commit | Published as |
|---|---|---|
| `promworkbench/InductiveMiner` | `de00027ca901b6bab5b7765d07c096aee58841eb` (2023-11-09) | `InductiveMiner` 6.14.5 |
| `promworkbench/InductiveMinerDeprecated` | `794e47ad99672dcbe643af193b7e9b6b548beba3` (2023-11-09) | `InductiveMinerDeprecated` 6.14.12 |

`InductiveMinerDeprecated` matters because it is not optional: the `inductiveminer2`
package imports `EfficientTree`, `InlineTree`, `EfficientTreeReduce` and
`CutFinderIMSequenceReachability` from it. The process-tree representation and
**the whole tree-reduction stage** live there, not in `inductiveminer2`.

## Is there a LICENSE / COPYING file?

**No.** Neither repository contains a `LICENSE`, `COPYING` or `NOTICE` file
anywhere in the tree. Verified by a case-insensitive filename search across both
checkouts.

## Are there licence headers in the source?

**No.** Not one of the 146 `.java` files in `InductiveMiner/src` begins with a
comment block, and a case-insensitive grep for `licen[sc]e|copyright|GPL` across
`src/` returns only two hits, both false positives (the substring `gPl` inside
the class name `InductiveMinerWithoutLo**gPl**ugin`).

So the source tree itself carries **no** licence statement at all.

## Where the licence actually comes from — package infrastructure

It is inherited from the ProM packaging build, exactly as the brief suspected.

`InductiveMiner/build.xml`:

```xml
<property name="author"       value="SJJ Leemans" />
<property name="organization" value="Queensland University of Technology" />
<property name="license"      value="L-GPL" />
```

Ant substitutes this into the generated `packages.xml`, which is what the ProM
Package Manager reads. The published entry, confirmed live against the ProM
package repository (`http://www.promtools.org/prom6/packages/InductiveMiner/packages.xml`):

```xml
<package name="InductiveMiner" version="6.14.5" os="all"
         org="Queensland University of Technology" license="L-GPL"
         author="SJJ Leemans" ... />
```

`InductiveMinerDeprecated` declares **L-GPL** the same way. For contrast, the
`ProM-Framework` package declares `license="ProM"`, and promtools.org states the
framework core is GPL while packages "may use a license that suits them best" —
i.e. package licences are *not* guaranteed GPL-compatible and each must be
checked individually. Here both packages we care about say L-GPL.

**Three caveats, stated rather than glossed over:**

1. **No version.** "L-GPL" does not say 2.1 or 3.0. The strong-copyleft fallback
   reading is the safe one to plan against.
2. **The declaration is outside the licensed work.** A build property and a
   repository index are weak evidence compared with a LICENSE file. It is the
   author's clear published intent, but it is not a licence grant attached to the
   files.
3. **No CLA, no contributor list, single declared author.** Low risk of divided
   ownership, which is the one thing that makes this simpler than it could be.

## Third-party dependencies inside the algorithmic path

Only the ones whose *implementation* would otherwise be copied or translated:

| Dependency | Used for | Licence | Needed in Rust? |
|---|---|---|---|
| GNU Trove (`gnu.trove.*`) | every primitive collection: `TIntSet`, `MultiIntSet`, `TIntIntHashMap` | LGPL 2.1 | **No** — replaced by `Vec`/`FixedBitSet`/`HashMap`. But see "hash iteration order" below. |
| Guava (`com.google.common`) | `Ints.max`, `MoreExecutors` | Apache 2.0 | No |
| Apache commons-lang3 | `ArrayUtils.remove` in reduce params | Apache 2.0 | No |
| OpenXES (`org.deckfour.xes`) | `XLog`, `XEventClassifier` | GPL-family | **No** — Promenade never hands the miner XES. |
| Sat4j | `IMc` probabilistic variant only | EPL / LGPL | No — that variant is out of scope |
| ProM-Framework | `PackageManager.Canceller` only | "ProM" (GPL core) | No — one boolean callback |
| rsyntaxtextarea | Swing UI only | modified BSD | No |

Nothing in the third-party set forces anything on a Rust reimplementation. The
constraint is entirely the L-GPL on Leemans' own two packages.

**One non-obvious dependency that is *not* a licence problem but is a
correctness problem:** Trove's hash iteration order leaks into ProM's output in
at least two places (`THashSet<TIntSet>` in the SCC computation, `TIntLongHashMap.keys()`
as the tie-break in `sortByCardinality`). That is a differential-testing hazard,
documented in [prom-reference.md](./prom-reference.md), not a legal one.

## Can a derivative Rust implementation use MIT?

**A translation: no.** Porting Java to Rust produces a derivative work. Under
LGPL, a derivative of the library must itself be LGPL — the "you may link
freely" concession applies to *using* the library, not to *rewriting* it. An
MIT-licensed line-by-line port would be a licence violation regardless of how
much the syntax changed.

**An independent implementation of the algorithm: yes.** Algorithms and methods
of operation are not protected by copyright; only their expression is. The
Inductive Miner is a published, peer-reviewed algorithm with its own DOIs — the
ProM code even cites them in `getDoi()`:

- **IM** — Leemans, Fahland, van der Aalst, *Discovering Block-Structured Process
  Models from Event Logs — A Constructive Approach*, Petri Nets 2013.
  [10.1007/978-3-642-38697-8_17](https://doi.org/10.1007/978-3-642-38697-8_17)
- **IMf** — Leemans, Fahland, van der Aalst, *Discovering Block-Structured Process
  Models from Event Logs Containing Infrequent Behaviour*, BPM Workshops 2013 (2014).
  [10.1007/978-3-319-06257-0_6](https://doi.org/10.1007/978-3-319-06257-0_6)

## The strategy, and its honest limits

Adopted, per the brief's fallback instruction:

1. **The papers are the algorithmic source.** Every rule in the Rust
   implementation is traceable to a paper statement or to an observed input→output
   behaviour, and `prom-reference.md` records which.
2. **ProM is a black-box behavioural reference.** The oracle harness (Phase 3)
   runs the *published jar*; it does not embed, vendor or modify ProM source, and
   is a test fixture that is never shipped in the plugin package.
3. **The Rust implementation is independently structured.** Different data model
   (trace variants with multiplicities vs. ProM's per-trace `long[][]`), different
   recursion shape, no transliterated identifiers, no copied comments.
4. **Differential tests** establish behavioural parity, which is what actually
   matters to a user, without establishing textual derivation.

**The limit, stated plainly:** this is a *clean reimplementation*, **not a
certified clean-room**. The Java source was read in detail to determine what the
implementation actually does — several of its behaviours (the `EfficientTreeReduce`
pass, `CutFinderIMSequenceStrict.merge`, the exact ordering of fall-throughs) are
implementation choices that appear in **no** paper, and there is no way to reach
parity without knowing them. A strict clean-room would require a second person to
write the specification and a first person to never see the source.

What this means practically:

- Behaviour derived from the source is recorded as **specification prose in
  `prom-reference.md`**, then implemented from that prose. Facts about behaviour
  are not copyrightable; the code that embodies them is, and none of it is copied.
- The plugin's `README.md` and manifest must **credit Leemans and cite both
  DOIs**, and state that behaviour was verified against ProM's L-GPL
  implementation without deriving from its source.
- **Residual risk is not zero.** If the project wants it to be zero, the
  alternative is to license `inductive-miner-core` under LGPL-2.1 while the
  Promenade adapter stays MIT. That costs nothing technically — the crate
  boundary is already where it needs to be — and is a one-line change to
  `Cargo.toml`. **This is a decision for the project owner, not for me.**

## What can safely be built from the academic description alone

Effectively the whole algorithm skeleton, which is fully specified in the two
papers:

- the base cases (empty log, single activity, empty traces)
- the four cut detectors and their preconditions (exclusive choice, sequence,
  parallel, loop) as graph-theoretic definitions over the directly-follows graph
- log splitting per operator
- the flower-model fallback
- IMf's noise filter as *"remove an outgoing edge below `threshold ×` the
  strongest outgoing edge of the same source"*

What is **not** in the papers and had to be read out of the implementation —
these are the parts to document most carefully, and the parts differential
testing exists to check:

- the exact **ordering** of base-case finders, cut finders and fall-throughs
- IMf trying **unfiltered cut detection first**, filtering only on failure
- the minimum-self-distance extension to the parallel cut, and that it is tried
  **before** plain parallel
- `CutFinderIMSequenceStrict.merge` — the 2015/2016 "minimise introduced taus"
  optimisation on sequence cuts
- the `ensureStartEndInEach` repair of parallel components
- the four fall-throughs before the flower model, including the once-per-trace
  activity rule with its noise-dependent tolerance band
- the final `EfficientTreeReduce` pass with `EfficientTreeReduceParametersForPetriNet`
