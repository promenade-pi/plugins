# Changelog

## 0.1.1 — 2026-09-17

- The README now gives the chain that checks the deadlock-freedom claim on a
  real log: the OR-joins have to be replaced before the BPMN converts to a
  Petri net, which BPMN 2.0 0.6.0 can now do. No change to the miner.

## 0.1.0 — 2026-09-17

First release.

- **Split Miner** (Augusto, Conforti, Dumas, La Rosa & Polyvyanyy, KAIS 2019):
  directly-follows graph and loop detection, the concurrency oracle and its
  pruning, the connectivity-preserving filter, and split and join gateway
  discovery — producing a `Bpmn` artifact.
- **Split Miner 2.0** (Augusto, Dumas & La Rosa, 2021) as a variant: the
  refined directly-follows relation, the life-cycle overlap oracle, the
  loop-edge repair for improper completion, and OR-split detection. Asked for
  on a log with no start events, it says so rather than reporting no
  concurrency.
- Join typing computes the paper's "acyclic homogeneous SESE region" as a
  dominance/post-dominance pair, with the region boundary checked against the
  model's back edges.
- An independent implementation from the papers; the authors' GPL code was not
  read or translated (`docs/licensing.md`).
