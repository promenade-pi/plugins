# Split Miner

An event log in, a BPMN process model out — the miner that is neither
restricted to block-structured models nor willing to produce deadlocking ones,
which is why it became the benchmark other discovery algorithms are measured
against.

Against the two Promenade already had:

| | produces | structure | soundness |
|---|---|---|---|
| **Inductive Miner** | process tree | block-structured by construction | sound, always |
| **Heuristics Miner** | causal net / Petri net | unrestricted | no guarantee |
| **Split Miner** | BPMN | unrestricted | deadlock-free; sound when acyclic |

Split Miner's own contribution is the order it does things in. It detects
concurrency *before* filtering and prunes it out of the directly-follows graph,
so causality and concurrency are never confused; its filter keeps every
activity attached to its most frequent predecessor and successor whatever the
threshold does, so raising the threshold simplifies the model instead of
breaking it apart; and it derives split and join gateways from the concurrency
relations rather than guessing them from arc counts.

## Two knobs

**η, the filter percentile** — how much of the directly-follows graph to keep.
Lower keeps more arcs: higher fitness, lower precision, a busier diagram. It is
the primary control, and it is cheap, so it drives from a slider.

**ε, the parallelism threshold** — how unbalanced two activities' orderings may
be and still count as concurrent. 0 demands they be seen in both orders exactly
equally often; 1 accepts any pair seen both ways at all.

The defaults, 0.4 and 0.1, are the values the paper's own hyper-parameter
optimisation across twelve real-life logs settled on.

## Split Miner 2.0

Most techniques treat A and B as concurrent when sometimes A finishes first and
sometimes B does. But activities have duration, and two that overlap every time
while always finishing in the same order look, to that test, exactly like a
sequence. Split Miner 2.0 reads concurrency from the overlap itself.

It needs a log that records when activities start as well as when they finish.
On a log without that it has nothing to measure, and it says so rather than
reporting "no concurrency found". It can also tell an inclusive choice from a
parallel one — branches that sometimes run together and sometimes replace each
other become an OR-split — and it repairs the loop shape that makes a cyclic
model finish with work still outstanding.

## What it produces

A `Bpmn` artifact — the same type the BPMN 2.0 plugin renders, exports as BPMN
2.0 XML, and converts to an accepting Petri net or a process tree. Install that
plugin alongside this one to see the diagram.

To check the deadlock-freedom claim on your own log, run the chain:

```text
  Split Miner  ->  Replace OR-joins  ->  BPMN -> Petri net  ->  Check soundness
```

The middle step is needed because the join rule falls back to an inclusive
gateway wherever a region is not acyclic and homogeneous, and an inclusive
gateway has no Petri net translation. On BPI Challenge 2012 that chain replaces
all 13 OR-joins and reports a sound workflow net.

## Provenance

This is an independent implementation from the published papers. The authors'
own implementation is GPL and was deliberately not read or translated — see
[docs/licensing.md](docs/licensing.md), which also lists the four places the
papers leave a decision open and what this one decided.

## Building

```bash
./package.sh
```

`cargo test --release` runs first and blocks packaging on failure: 6,000
randomised logs through both variants, checked for valid BPMN, gateway
discipline, no dead activities, determinism, and — for the models that convert
to a Petri net — soundness, judged by the Soundness Checker plugin's own core
rather than by this crate.
