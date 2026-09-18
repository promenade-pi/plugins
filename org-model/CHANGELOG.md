# Changelog

## 0.1.0 — 2026-09-16

- Initial release. Clusters a `SocialNetwork` into an `OrganizationalModel`:
  groups of people, each named by the work its members do, each reported with
  its cohesion against its separation so a group that does not hold together
  says so.
- Hierarchical clustering (average, complete or single linkage) with the cut
  as a parameter — by number of groups or by similarity threshold, both read
  off one recorded dendrogram, so the two agree wherever they mean the same
  thing. Connected components is offered as the exact answer to a different
  question.
- The view draws that dendrogram with the cut across it, so the next merge
  that *would* have happened is visible — the difference between a decisive
  cut and an arbitrary one.
- A similar-task network yields roles; every other relation yields
  organisational units. The model reads which off the network rather than
  calling both the same thing.
