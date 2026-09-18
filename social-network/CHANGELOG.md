# Changelog

## 0.2.1 — 2026-09-18

- Corrected the `homepage` and `repository` URLs. The plugins live in one
  repository, [`promenade-pi/plugins`](https://github.com/promenade-pi/plugins),
  not one repository per plugin under a `promenade-lab` organisation that was
  never created. Metadata only — no functional change.

## 0.2.0 — 2026-09-16

- The payload now carries the activity dictionary and, per person, their
  activity mix (`activities`, `nodes[].profile` — most frequent first, capped
  at 64 entries). A network said how strongly two people were related but not
  what either of them *does*, which is what a consumer needs to name a group
  of them. The Organizational Model plugin labels its roles from exactly this.
  The similarity metrics still compare complete profiles internally; only what
  is written out is capped.

## 0.1.0 — 2026-09-16

- Initial release. Five organisational relations over a traditional event
  log's resources, as one `SocialNetwork` artifact type:
  **handover of work**, **subcontracting**, **working together** and
  **reassignment** in one action, **similar task** (Pearson, cosine or
  Euclidean over activity profiles) in a second.
- Succession is generalised by distance and decay (`maxDistance`, `beta`), so
  a handover survives an automated step between two people; `multipleTransfers`
  chooses between "how many cases they collaborate on" and "how much".
- Two views: a weight-aware node-link graph (stress, force or circle layout,
  written in-package so the layouts can use the weights and be checked) and an
  adjacency matrix, which is the one that still reads past forty people.
- Both actions declare `requires: ['event.resource']`, so neither is offered
  for a log that names nobody.
