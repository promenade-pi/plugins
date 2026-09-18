# Changelog

## 0.2.1 — 2026-09-18

- Corrected the `homepage` and `repository` URLs. The plugins live in one
  repository, [`promenade-pi/plugins`](https://github.com/promenade-pi/plugins),
  not one repository per plugin under a `promenade-lab` organisation that was
  never created. Metadata only — no functional change.

## 0.2.0 — 2026-08-21

- Adds **Heuristics Miner → Petri net**, producing an `AcceptingPetriNet` with
  silent routing transitions that preserve the Causal Net's inferred AND/XOR
  split and join groups. The result works with the Petri-net renderer, PNML
  export, and alignment-based conformance actions.

## 0.1.1 — 2026-08-16

- Ships this changelog as its own tab in the plugin's detail panel.

## 0.1.0 — 2026-08-16

- Initial release: Flexible Heuristics Miner, dependency-threshold based,
  tolerant of noisy/infrequent behaviour that would throw off Alpha Miner's
  exact footprint relations. Outputs a Causal Net.
