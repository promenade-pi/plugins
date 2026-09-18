# Social Network Mining

The organisational perspective: not what the process does, but who does it
with whom. Every metric here produces the same thing — one weighted graph over
the people named in the log — from a different reading of the same events.

## The five relations

| Relation | Reads as | Direction |
|---|---|---|
| Handover of work | a did something, then b did the next thing | a → b |
| Subcontracting | a … b … a — work went out and came back | a → b |
| Working together | a and b appear in the same case | undirected |
| Reassignment | a and b both did the *same* activity, a first | a → b |
| Similar task | a and b do the same *kind* of work | undirected |

The first four are in one action (`metric`); similar task is its own, because
it is the only one that does not look inside a case at all. Two people who
never share a case score 0 on working-together and can score 1.0 on similar
task — which is the difference between finding routes and finding roles.

## What the weights mean

The view says this per network, and so does the payload's `weightKind`:

- **share** — the pair's fraction of every transfer counted. Sums to 1 across
  the network, so two logs of different sizes are comparable.
- **ratio** — working together, as Jaccard over the two people's case sets:
  how much of the work either touched they touched together.
- **similarity** — a correlation or cosine over activity profiles, already in
  its own scale. Can be negative: two people whose work is anti-correlated.

`raw` is kept beside every weight — the count before normalisation, so a
number can be checked against the log by hand.

## Two parameters that change what is being measured

`maxDistance` and `beta` turn "directly followed by" into "followed by within
n steps, discounted per step". At 1 the relation is strict succession. Higher
matters on a real log, where an automated step sits between two people and
would otherwise hide the handover entirely.

`multipleTransfers` decides whether a pair who transfer ten times in one long
case count ten times or once. Off — once per case — is the default, and the
weight then reads as *how many cases they collaborate on*. On, it reads as
*how much*, and one pathological case can dominate the network.

## Events with nobody named

An event with no resource is dropped from the sequence rather than breaking
it, so a → (nobody) → b is still a handover from a to b. Treating "nobody" as
a participant would invent a person and route half the network through them.
The count is always reported, in the view and in `stats`, so the omission is
never silent. The same is true of people dropped by the resource limit.

Both actions declare `requires: ['event.resource']`, so neither is offered for
a log that names nobody — an organisational miner that runs and returns
nothing is worse than one that is visibly not applicable.

## The views

**Social network** — a node-link graph. Edge thickness is weight, node area is
that person's share of the log's events, and distance is relatedness. The
layouts are in this package rather than delegated to a layout engine, because
the two that matter need the weights: a network laid out weight-blind puts the
pair who transfer once as far from each other as the pair who transfer a
thousand times, which is the one thing the picture exists to show. `stress` is
majorization over weighted graph distances; `force` is Fruchterman-Reingold;
both are deterministic, and both are gated on invariants (`npm run check`):
every node on the canvas, no two circles overlapping, the same input giving
the same coordinates, and a strong edge drawn shorter than a weak one.

**Social matrix** — the same network as an adjacency matrix. Past about forty
people a node-link diagram stops being readable at any layout quality; a
matrix does not degrade, and it is the only view in which "who does this
person *not* work with" is visible.

## What this is not

It says nothing about control flow — for that, discover a model. It does not
mine an organisational *model*: grouping the similar-task network into roles,
and the resource-behaviour metrics (workload, utilisation, multitasking), are
separate work on top of this artifact type.
