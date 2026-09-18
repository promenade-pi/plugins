# How each metric is computed

All five run over the same scan: one pass in timestamp order, building one
`(activity, resource)` sequence per case, with unattributed events dropped
(see the README). Everything below operates on those sequences.

## Handover of work

For each case, for each position `i` and each distance `d` in `1..maxDistance`:

    handover[r(i)][r(i+d)] += beta^(d-1)

At `maxDistance = 1` this is exactly "a is directly followed by b". Beyond it,
a transfer survives intervening steps at a discount — which is what makes the
metric usable on a log where an automated task sits between two people.

## Subcontracting

For each case, for each `i`, and each pair of distances `d1`, `d2` within
`maxDistance`, where `r(i) == r(i+d1+d2)` and `r(i+d1) != r(i)`:

    subcontracting[r(i)][r(i+d1)] += beta^(d1+d2-2)

The work has to come back. `a → b → c` is a handover twice and a
subcontract never.

## Working together

Per case, the set of distinct resources; every unordered pair in it counts
once. The weight is Jaccard over the two people's case sets:

    weight(a,b) = joint / (cases(a) + cases(b) - joint)

Not a share of the whole network: a ratio is supposed to be independent of
the rest of the graph, and normalising it again would make the number for one
pair move when an unrelated pair changes.

The pair is stored once, not twice — the relation has no direction. The matrix
view mirrors it explicitly, because a half-filled square reads as missing data
rather than as symmetry.

## Reassignment

Per case, positions grouped by activity; within one activity's group, every
earlier/later pair of *different* resources counts once:

    reassignment[earlier][later] += 1

Two people doing the same activity in one case is the signal — work handed
back to be redone, or passed up.

## Similar task

Each resource gets a vector over activities: how many times they performed
each. Then every unordered pair is compared:

- **Pearson** — the original paper's choice. Compares the *shape* of two
  people's work, so someone doing a tenth as much of exactly the same mix
  still scores 1.0. Undefined (and so emitted as no edge) for a resource who
  only ever performs one activity, since a constant vector has no variance.
- **Cosine** — agrees with Pearson on direction, not on centring. Never
  negative on count data, which makes it the easier one to threshold.
- **Euclidean** — a distance, reported as `1/(1+d)` so that larger still means
  more similar. The only one of the three that treats sheer volume as a
  difference: a busy person and a quiet one doing identical work score low.

## Normalisation, and `multipleTransfers`

The four succession metrics divide by the total, so the network's weights sum
to 1 (`weightKind: "share"`). Working together and similar task are already
per-pair quantities and are left alone (`"ratio"`, `"similarity"`).

With `multipleTransfers` off — the default — a pair is counted **once per
case**, but at its *best* weight rather than at 1.0. Collapsing to "it
happened" would throw away the distance discount while still claiming to
respect `beta`; taking the maximum keeps the two parameters meaning what they
say.

## Self-loops

`ignoreSelfLoops` (default on) drops `a → a`. A person following their own
step is usually continuing work rather than transferring it, and on a real log
the self-loop is often the largest weight in the network — which flattens
everything else once the weights are normalised. The count of what was dropped
is reported rather than silently removed; turning the option off shows how
much of the process each person carries alone.

## Bounds

`maxResources` (default 200) keeps the most active people and drops the rest
*entirely*: their events are treated exactly like events with no resource, and
both `resourcesOmitted` and the raised `eventsWithoutResource` say so. The
alternative — an "other" node — would be a person who does not exist with a
larger degree than anyone who does.

The host separately caps the resource dictionary it hands to the kernel at
4096 distinct values; past that the tail arrives as "no resource". A log with
more distinct resources than that is using the field as an identifier rather
than as an organisational attribute, and no social network over it would mean
anything.

## What a network carries besides its edges

Each node reports the person's own involvement — events, cases, distinct
activities — and their **activity profile**: `(activity index, times
performed)`, most frequent first, indexing the `activities` dictionary beside
it. The profile is capped at 64 entries per person.

This is what makes the network describable rather than only measurable. An
edge says two people are related; the profile says what either of them does,
which is what a consumer needs to give a group of them a name — see the
Organizational Model plugin, which labels each discovered role by its
members' dominant work.

The cap applies only to what is written out. Similar task compares complete
profiles: truncating the input would change the similarity, while truncating
the output only shortens a label.
