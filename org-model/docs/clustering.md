# How the clustering works

## From weights to distances

The kernel builds a symmetric similarity matrix over the network's people:

| `weightKind` | mapped to similarity by |
|---|---|
| `similarity` | `(w + 1) / 2` — a correlation is already on a fixed scale |
| `share`, `ratio` | `|w| / max |w|` |

Then `distance = 1 - similarity`. Two things are worth stating plainly because
both change the answer:

**A correlation is not rescaled by the largest one observed.** Dividing it
would make one pair's similarity depend on the rest of the network, which is
exactly what a correlation is not. A share or a ratio has no such fixed scale,
so for those the largest observed weight is the only sensible unit.

**An absent edge is distance 1**, not missing data. Every real log produces a
sparse network, and a clustering that treated absence as unknown would have
nothing to say about most pairs. The consequence is that sparsity inflates
distances uniformly, which is why the model reports it.

## Agglomeration

Everyone starts in their own cluster. Repeatedly: find the closest two by the
chosen linkage, merge them, record `(a, b, distance, size)`. After `n-1`
merges everyone is in one cluster and the record is a dendrogram.

Linkage between two clusters, over all cross pairs:

- **average** — the mean distance. Balanced, and the default.
- **complete** — the largest. Judges a cluster by its worst pair, so it
  resists loose groups and tends to produce compact ones of similar size.
- **single** — the smallest. Joins on one strong link, which chains: a series
  of near neighbours becomes one long group even when its ends have nothing to
  do with each other.

Linkage is recomputed from the members rather than updated by a
Lance-Williams recurrence. The number of *people* is what bounds this, and the
Social Network plugin already caps that at a few hundred; the straightforward
version is the one whose correctness is visible from reading it, and cutting
is a separate cheap step afterwards.

Ties take the first pair in index order, so two runs on the same network
produce the same dendrogram.

## Cutting

Cutting replays the recorded merges and stops:

- **by count** — when the number of live clusters reaches the requested one;
- **by threshold** — at the first merge whose distance exceeds it. A merge
  exactly *at* the threshold still joins: the threshold is the greatest
  distance two people may be and still share a group.

Because both replay the same sequence, they are two readings of one
computation, not two algorithms — at equivalent settings they return
identical groups. This is what makes the count a slider: every cut from 1 to
n comes out of the run you already did.

A cut is also **monotone** by construction, and the property is asserted over
randomised networks: lowering the group count may join two groups but can
never split one. Without that the slider would reshuffle people rather than
aggregate them, and the dendrogram drawn beside it would be a lie.

## Connected components

Union-find over every pair at or above the threshold. No dendrogram, no
linkage — the answer to "who is transitively linked at this strength", which
is a different question from "what are the natural groups" and is sometimes
the one being asked.

## Quality

**Cohesion** is the mean similarity between two members; **separation** the
mean similarity from a member to everyone outside. A group of one has no
internal pair, so its cohesion is reported as 1 — vacuously, and `size` sits
next to it to say so.

**Mean silhouette** is computed per person as `(b - a) / max(a, b)`, where `a`
is the mean distance to their own group and `b` the mean distance to the
nearest other group, then averaged. Someone alone in their group contributes
**0** rather than the perfect score a naive formula yields: neither well nor
badly placed is the honest reading of a group of one.
