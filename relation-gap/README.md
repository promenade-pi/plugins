# OCEL Relation Gaps

Simulates and reconstructs missing event–object relations in an OCEL 2.0 log.

Real object-centric extracts arrive incomplete: a payment recorded without its
purchase order, a goods receipt that names one of the materials it delivered.
The links are not wrong, they are absent, and every object-centric analysis
downstream quietly treats the absence as a fact about the process. This plugin
makes that damage measurable — first by manufacturing it under controlled
conditions, then by trying to undo it and scoring the attempt.

Ported from Áron Balázs Papp, *Object-Centric Event Log Repair Through Graph
Neural Networks* (ELTE, Data Science Lab 1), and kept in step with its
refactored reference implementation,
[`PappAron/ocel_repair`](https://github.com/PappAron/ocel_repair). Both of the
paper's reconstruction methods are here — the pairwise association model of
§4.1/§5.2 and the heterogeneous GraphSAGE network of §4.2/§5.3 — scored against
the same gapped log, reported through the same view, in one package.

## The actions

### Simulate relation gaps

Takes an OCEL 2.0 log and derives a gapped copy of it. A seeded share of the
events becomes the test partition; within each of those, a fraction of the
participating objects is removed. Everything else — events, objects, O2O
relations, attributes — passes through untouched.

| Parameter | Default | Meaning |
| --- | --- | --- |
| Test partition | 0.3 | Share of events that lose objects |
| Drop rate | 0.3 | Share of a test event's objects to remove |
| Seed | 42 | Which events and objects, not how many |

Two guarantees hold at every setting: **no event is emptied**, and **every
selected event loses at least one object** — so k = max(1, min(n−1, ⌊n·d⌋)).
An event with two objects therefore loses exactly one at any drop rate, and an
event with a single object is never selected at all (removing its only object
leaves nothing to reconstruct *from*, which is a different repair problem).

Selection is a seeded hash of the identifiers rather than a random number
generator's stream position, so the same log, fractions and seed give the same
gapped log on any machine, in any order, however many times it is re-run.

### Reconstruct relation gaps

Takes the gapped log **and** the log it came from. Estimates pairwise
co-occurrence probabilities P̂(o′ | o) from the relations the gapped log still
has, scores every candidate object for each hole by

    s(o′) = Σ_{o ∈ O(e)} log( P̂(o′ | o) + ε ),   ε = 1e-9

and ranks. The reference log is opened for exactly one purpose — reading the
ground truth back out — and never contributes a count.

| Parameter | Default | Meaning |
| --- | --- | --- |
| Predictions kept | 10 | Size of the returned candidate set, and the K in precision/recall |
| Candidate pool | co-occurring | Whether objects with no co-occurrence evidence get a rank |
| Walkthrough length | 25 | Worked examples retained, spread across the partition |

Reports Hits@1/5/10, MRR, precision/recall/F1 of the top-K set, the rank
distribution, a per-object-type breakdown, and a bounded walkthrough of
individual predictions.

## Four departures from the original notebook

These are corrections, not preferences. Each changes what the numbers mean. The
first three were identified here; the reference implementation reached the same
conclusion about the third independently, and went further — see
[The GraphSAGE arm](#the-graphsage-arm).

**The statistics come only from the gapped log.** The notebook estimated its
co-occurrence table from the complete event log and then evaluated on holes
punched into that same data, so a pair it was asked to recover had already been
counted in the statistics used to recover it. Here the train partition is left
intact *inside the gapped log*, which is both the honest version and the
realistic one: an analyst holding a damaged extract has exactly this.

**A candidate outside the pool is reported, not silently scored zero.** A
co-occurrence model can only rank objects it has seen beside one of the
observed objects. The notebook gave anything else a reciprocal rank of 0, which
reads as "ranked last" but means "never considered" — a different claim, and
one that is not comparable with a method that ranks the whole object set. Both
readings are available as the **Candidate pool** parameter, and either way
`Outside pool` counts how many gaps the pool could not contain at all.

**Both arms consume the same artifact.** The notebook's two models used
different corruption rates, different candidate pools and different numbers of
held-out objects, and reported the results side by side in one table. Here the
gapped log is an artifact and both arms are scored against the same holes — which
is what made the comparison below possible, and what makes it mean something.

**Neither arm is fitted on the partition it is scored on.** Co-occurrence
statistics and GNN positives come only from events with no held-out link. A
gapped event's surviving objects stay available as *context* for a prediction
about that event — an analyst holding a damaged extract has exactly that — but
they no longer inform the model being scored. `fitOn: allObserved` restores the
older, more permissive behaviour; it raises every figure and is not comparable
with anything published.

## The co-occurrence arm against the paper

On `ocel2-p2p.sqlite` (14,671 events, 9,543 objects, 35,097 E2O relations) at
the paper's settings — 30% test partition, 30% drop rate, seed 42:

| | Hits@1 | Hits@5 | Hits@10 | MRR |
| --- | --- | --- | --- | --- |
| Paper, Table 1 | 0.2399 | 0.6195 | 0.7023 | 0.3909 |
| This plugin | 0.2889 | 0.6552 | 0.7568 | 0.4343 |

The gap is expected and is the point of the first correction above. The paper
estimated from a 70% training split; this estimates from the whole gapped log,
which holds the intact train partition *and* the surviving relations of gapped
events — more evidence, none of it leaked.

The per-type breakdown is where this stops being a single number. Materials
(Hits@1 = 0.77) and invoice receipts (0.70) are nearly always recoverable;
quotations (0.003) essentially never are, and 299 of their 638 gaps have no
candidate pool at all. A quotation's links are not reconstructible from
co-occurrence, and no aggregate metric says so.

## The GraphSAGE arm

"Reconstruct relation gaps (GNN)" implements §4.2/§5.3 — three heterogeneous
GraphSAGE layers over the `has` / `in` / `related` channels, summed aggregation,
Adam with cosine annealing — with the two changes the reference implementation
introduced after the paper. It is written in Rust and trains in the browser
under WebAssembly, because neither PyTorch nor `torch_geometric` runs in any
Promenade runtime and the model is transductive (one learned embedding per
object), so there is no pretrained network to ship.

### Masked query training, and why it decides everything

Every training step removes that batch's own positive links from the
message-passing graph before the forward pass, and with them the object-object
relations of the objects involved — otherwise the answer is still reachable in
two hops and the mask closes the front door while leaving the side one open.

Without this, the network can satisfy its objective by reading the answer off
the adjacency it was handed: an event is trivially close to the objects it is
connected to. It fits beautifully and learns nothing that transfers to a link it
cannot see. With it, the training condition *is* the evaluation condition.

This is not a detail. The first version of this port trained on the gapped graph
without masking and scored Hits@1 0.0785 — a quarter of the co-occurrence
baseline — while converging cleanly on its own loss. Adding the mask is the
difference between that and beating the baseline outright.

The objective changed with it: sampled softmax (one positive against N sampled
negatives, as cross-entropy over temperature-scaled cosine scores) rather than
the paper's triplet margin. A hinge stops caring once the margin is met, which
is exactly where a ranking task still has all its work left to do — being ahead
of one sampled negative is worth nothing if a hundred other candidates are ahead
too. Both are available; `tripletMargin` reproduces the paper's.

### What it scores

Single-target protocol, 30% test partition, seed 42, on the P2P log. Every arm
ranks the same candidates and is scored on the same held-out links.

| | Hits@1 | Hits@3 | Hits@5 | Hits@10 | MRR |
| --- | --- | --- | --- | --- | --- |
| Co-occurrence | 0.2897 | 0.4979 | 0.6208 | 0.7428 | 0.4239 |
| **GraphSAGE** | **0.5647** | **0.7174** | **0.7379** | **0.7462** | **0.6414** |
| *Reference implementation, co-occurrence* | *0.2895* | *0.5031* | *0.6049* | *0.6903* | *0.4161* |
| *Reference implementation, GNN* | *0.5351* | *0.6769* | *0.6871* | *0.6923* | *0.6036* |
| *Paper, Table 1, GNN* | *0.4950* | — | *0.6850* | *0.7750* | *0.5865* |

The reference rows are `PappAron/ocel_repair` run directly (`compare
data/ocel2-p2p.sqlite --epochs 400 --protocol single-target`) as a target to
port against, not as a quoted claim. The two implementations select their test
events differently — a seeded hash here, `random.sample` there — so they gap
4,346 and 4,401 events respectively and the figures are close rather than
identical.

The network beats the baseline on every metric, which is the reverse of what
0.2.0 measured and the same direction the reference reports. The margin is
largest exactly where it should be: Hits@1 nearly doubles while Hits@10 barely
moves, because both arms are bounded by the same candidate pool and what changed
is the sharpness of the ordering inside it, not its coverage.

One mismatch cost half of that and is worth recording. The evaluation graph must
drop the object-object relations of held-out objects too, because masked query
training hides them during training: leaving them in at scoring time presents
the network with a node shape it was never optimised for. With them in, this
port scored Hits@1 0.3065; with them out, 0.5647. Nothing else changed.

### What it costs

Measured in-browser, Apple silicon, the SIMD build. Cost grows with the square
of the width and linearly with the steps; masking adds an edge-list rebuild per
step, which is negligible beside the matrix products.

| Width | Steps | Time |
| --- | --- | --- |
| 128 | 400 (the default, and the paper's) | ~11.5 min |
| 64 | 400 | ~2.6 min |

## Checks

`package.sh` gates on two suites and will not produce an archive if either
fails. `cargo test` covers the network; `check.py` executes the real
`ablate.sql` in DuckDB, exactly as the host compiles it, and drives the real
`plugin.py` over the result — on hand-built logs and twelve randomised ones, at
the parameter extremes.

```sh
cargo test --release
python3 -m pip install duckdb pandas
python3 check.py
```

The claims they gate are listed in their module docstrings. On the network
side: *the gradient matches central differences*, compared as a whole vector
because an f32 finite difference carries enough noise to make a correct 2e-3
gradient look 6% wrong on its own; and *a link the structure determines is
always found first*, which fails at 300 steps and passes at 600 — the training
budget is part of the claim, not a detail. On the data side, two are worth
naming. *A gap with exactly one possible answer is always found*: on a log whose
objects co-occur in fixed disjoint groups, Hits@1 must be exactly 1.0 — the
end-to-end correctness claim, as opposed to the metric merely agreeing with
itself. And *shuffling the input rows changes no metric*, which caught a real
defect: summing log-probabilities over a Python set made the scores depend on
the interpreter's string hash seed, and Hits@1 moved in the third decimal
between runs over identical data.

## Packaging

```sh
./package.sh
```

One `.pmplugin` carrying four runtimes — `relational` for the simulator,
`pyodide` for the co-occurrence arm and for the GraphSAGE arm's hidden graph
stage, `wasm` for the network itself, and a sandboxed view for the report. They belong
together: a package may only publish an artifact type it declares itself, so
splitting them would leave the model arm unable to produce the evaluation type,
and the two arms are only comparable if they share one corruption seed, one
candidate pool and one protocol.
