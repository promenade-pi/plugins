# Changelog

## 0.3.0

Tracks the refactored reference implementation,
[`PappAron/ocel_repair`](https://github.com/PappAron/ocel_repair), which
identified the same evaluation defect this port reported and answered it more
directly than the recommendation here did.

**The GraphSAGE arm now trains on masked queries.** Each step hides that
batch's own positive links — and the object-object relations of the objects
involved, or the answer is still reachable in two hops — from the message-passing
graph before the forward pass. Without it the network satisfies its objective by
reading the answer off the adjacency it was handed, which is why 0.2.0 scored a
quarter of the co-occurrence baseline while converging cleanly. This single
change reverses that result.

- **Sampled softmax objective**, one positive against N sampled negatives as
  cross-entropy over temperature-scaled cosine scores, replacing the triplet
  margin as the default. The hinge stops caring once the margin is met, which is
  exactly where a ranking task still has its work to do. `tripletMargin`
  remains available and reproduces the paper's.
- **Negatives mix same-type and cross-type** (half each by default), never
  drawing an object the event already shows.
- **Candidate restriction at scoring time**, to the co-occurrence neighbourhood
  computed over the training partition, so both arms rank the same pool.
- **Best-checkpoint selection**: the parameters from the lowest-loss step, not
  the last one. With a sampled objective the final step is a sample like any
  other.
- Default width is now 128 and the objective's own parameters are exposed.

**A single-target protocol** for the simulator, now the default: exactly one
object hidden per test event whatever its size. That is what the notebook
actually evaluated, and it weights every test event equally instead of letting
an eight-object event count eight times.

**Both arms fit on the training partition by default.** Co-occurrence statistics
and GNN positives now come only from events with no held-out link. A gapped
event's surviving objects remain available as context for a prediction about it
— that is evidence an analyst has — but no longer inform the model that is
scored on it. `fitOn: allObserved` restores the previous behaviour.

- The co-occurrence arm's candidate universe is now every object that
  participates in some event, with candidates that never co-occurred tied at the
  bottom rather than reported as outside the pool. `cooccurring` keeps §4.1's
  C(e) exactly.
- Hits@3 is reported alongside Hits@1, Hits@5 and Hits@10.

Fixed, in the host rather than worked around here: an apostrophe inside a SQL
comment flipped the string-literal parity of the relational parameter scanner,
so `hash(id || ':partition:' || …)` in a later line was read as a parameter
reference and the action failed with `":partition" is not a declared parameter`.
The scanner now skips `--` comments, which `sqlProfile.ts`'s own masking always
did — the validator and the binder had disagreed about where the strings were.

## 0.2.0

Adds the paper's second reconstruction method, so both arms now compete on the
same gapped log and report through the same view.

- **Reconstruct relation gaps (GNN)** (`wasm`): a three-layer heterogeneous
  GraphSAGE network over the has / in / related channels, with the triplet
  margin objective, hard negatives of the positive's own object type, Adam and
  cosine annealing of §4.2/§5.3. Written in Rust and trained in the browser —
  there is no PyTorch in any Promenade runtime, and the model is transductive,
  so no pretrained network could be shipped even if there were. About two and a
  half minutes at the default width and the paper's 400 steps, with the loss and
  the positive/negative separation streamed to the progress bar as it runs.
- **Build the relation gap learning graph** (`pyodide`, internal): turns the two
  logs into the integer-indexed graph the kernel trains on. Hidden behind the
  GNN action, which runs it automatically.
- The evaluation view gained a **Training** section: loss and separation per
  step against the margin they have to clear, and whether the run converged.

Measured on the P2P log, the GraphSAGE arm scores well below the co-occurrence
baseline (Hits@1 0.079 against 0.304 at the paper's width and step count) while
converging cleanly on its own objective. The README explains why, and why that
is a finding about the paper's evaluation rather than a defect in the port: the
notebook leaves the held-out edges in the message-passing graph, so an event's
representation is built partly from the object it is asked to predict.

Fixed: the derived-pair warning could appear over three zero counts. The graph
stage now states the verdict explicitly instead of leaving the kernel to infer
it from a field that was not there, where a missing boolean read as "false".

## 0.1.1

- The per-object-type table's last column no longer reads as clipped in the
  docked inspector panel: the header is shortened to "Outside" (with the full
  wording as its tooltip) and the table fits the panel's width instead of
  overflowing it by a few pixels.

## 0.1.0

First release. Ports the pairwise association model of Áron Balázs Papp,
*Object-Centric Event Log Repair Through Graph Neural Networks* (ELTE, Data
Science Lab 1), §4.1 and §5.2.

- **Simulate relation gaps** (`relational`): derives a gapped copy of an OCEL
  2.0 log by holding out a seeded test partition and removing a fraction of
  each test event's objects. No event is ever emptied and every selected event
  loses at least one object. Selection is a seeded hash of the identifiers, so
  the same log, fractions and seed reproduce the same gapped log exactly.
- **Reconstruct relation gaps** (`pyodide`): estimates pairwise co-occurrence
  probabilities from the gapped log alone, ranks candidates for every hole and
  scores itself against the reference log. Reports Hits@1/5/10, MRR,
  precision/recall/F1 at K, the rank distribution, a per-object-type breakdown
  and a bounded walkthrough.
- **Relation gap evaluation** view: the metrics, the rank distribution, the
  per-type table and the worked examples, filterable by outcome.

Three corrections to the notebook this is ported from, each documented in the
README: co-occurrence statistics are estimated only from the gapped log rather
than from the complete one that the held-out links came from; a candidate the
pool never contained is reported as such instead of being scored as if it
ranked last; and both reconstruction arms are made to consume the same gapped
artifact, so their numbers are comparable.
