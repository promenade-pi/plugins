# Changelog

## 0.3.1 — 2026-09-18

- Corrected the `homepage` and `repository` URLs. The plugins live in one
  repository, [`promenade-pi/plugins`](https://github.com/promenade-pi/plugins),
  not one repository per plugin under a `promenade-lab` organisation that was
  never created. Metadata only — no functional change.

## 0.3.0 — 2026-09-14

- Added **token-based replay** as a second action, producing a new
  `ReplayDiagnostics` artifact: token-based fitness (pooled and per-case),
  and missing/remaining tokens attributed to individual places. A linear
  walk with no state-space cap — it runs where an alignment gives up, and it
  localises a deviation to a place in the net rather than to a position in a
  move sequence.
- Silent transitions are never force-fired: a breadth-first search over
  silent transitions runs before a transition is declared un-enabled, and
  again at the end of the trace, so a process-tree-derived net replays as the
  model it is rather than as near-total deviation. The search is bounded by
  detour *depth* rather than only by a state valve — measured on BPI
  Challenge 2012 against a Heuristics Miner net, that is the difference
  between every case completing its search in milliseconds and most of them
  giving up after minutes, for identical output.
- New **Replay diagnostics** view: the net drawn with each place ringed and
  labelled by the tokens the replay had to invent or leave behind, plus
  per-activity and per-variant tables.
- The package is now called *Conformance Checking* rather than
  *Alignment-based Conformance* — it ships two techniques, only one of which
  is alignment-based. Same plugin id, same alignment action, same outputs.

## 0.2.1 — 2026-08-16

- Ships this changelog as its own tab in the plugin's detail panel.

## 0.2.0 — 2026-08-16

- Added **precision** (escaping edges) alongside fitness, computed in the
  same Dijkstra pass the alignment itself already runs — no extra search.
  See `docs/algorithm.md` for exactly what it does and does not account for.
- Alignment Explorer: fitness/precision summary cards, a case-weighted
  deviation summary (which activities are most often skipped or inserted),
  and a "worst fitness first" sort alongside the default "most frequent".

## 0.1.0 — 2026-08-16

- Initial release: alignment-based conformance checking via Dijkstra over
  the synchronous product of log and Petri net (sync/log/model moves).
  Fitness only.
