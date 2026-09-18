# Organizational Model Mining

Takes a social network and gives it structure: who belongs with whom, what
that group does, and whether the group holds together at all.

## Why the input is a network, not a log

The network already states which relation is being clustered, and the answer
means different things for different ones:

- a **similar-task** network gives **roles** — people who do the same kind of
  work, whether or not they ever meet;
- a **handover** or **working-together** network gives **organisational
  units** — people who share the work itself, whatever each of them does in it.

Both are in Song & van der Aalst, both are useful, and collapsing them into
one word would be the plugin lying about what it just produced. It reads the
metric off the network and labels the result accordingly.

It also means this plugin never touches an event log. Everything it needs —
the relation, the weights, each person's activity mix — is in the network, and
the network is where the decisions about resources and thresholds were already
made and recorded.

## Clustering

**Hierarchical** by default: start with everyone alone and repeatedly merge
the two closest, recording every merge. Three reasons over k-means or a
modularity method:

- It is **deterministic**. No seed, no restart, no "run it again and get a
  different org chart".
- It needs only a distance between two people, which is exactly what a social
  network is. k-means would need coordinates, which people do not have.
- The merge sequence *is* a dendrogram, so the cut is a slider over one
  computation rather than a re-run — and the view can show what the next merge
  would have joined, which is how you tell a decisive cut from an arbitrary one.

Cut by **number of groups** or by **similarity threshold**; both read off the
same recorded dendrogram, so at equivalent settings they produce identical
groups rather than merely similar ones.

**Linkage** decides how far apart two groups are. Average is balanced;
complete judges a group by its least similar pair and so resists loose ones;
single joins on the strongest single link and will happily chain a whole
organisation into one group through a series of near neighbours.

**Connected components** is the honest floor: everyone linked above the
threshold, transitively. A different question, answered exactly.

## Distance

Weights mean "more is closer" in every metric, but they live on three scales
(`share`, `ratio`, `similarity`), so they are mapped to a similarity in [0,1]
first — a correlation by `(w+1)/2`, the others by dividing by the largest
weight observed — and `distance = 1 - similarity`.

A pair with **no edge at all** sits at distance 1. That is a real modelling
choice: an absent relation is read as a maximally weak one rather than as
missing data, which is what makes clustering well-defined on the sparse
networks real logs produce. The model reports `sparsity` — the share of pairs
that were never related — so you can see how much of the result rests on it.

A directed network is symmetrised: `a → b` and `b → a` are averaged.
Membership of a group is not directional, only the relation that suggested it.

## Reading the result

A clustering always returns the number of groups it was asked for, whether or
not they mean anything, so three numbers exist to check that:

- **cohesion vs separation**, per group: mean similarity inside against mean
  similarity to everyone outside. A group whose separation beats its cohesion
  is marked *loose* rather than presented as a finding.
- **mean silhouette**, over the whole model: how much closer people are to
  their own group than to the nearest other one. Raise the group count until
  it stops improving — that is what it is for.
- **singletons**: people the network could not place. Reported, never quietly
  folded into a neighbour.

Each group is named after its members' dominant activities. It is a label, not
a claim: "Review, Approve +2" says what the group does most, and the activity
bars underneath say in what proportion.

## What this is not

It assigns every person to exactly one group. Someone who genuinely holds two
roles cannot be expressed, and no amount of tuning will show it — that needs
overlapping clustering, which this does not do.
