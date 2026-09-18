# The Fuzzy Miner, as implemented here

Reference: Günther & van der Aalst, *Fuzzy Mining – Adaptive Process
Simplification Based on Multi-Perspective Metrics*, BPM 2007. The behaviour
below was reconstructed against ProM's Fuzzy Miner plugin through the Python
port at [`fnc11/FuzzyMiner`](https://github.com/fnc11/FuzzyMiner), whose
`FMRepository`, `ClusterUtil` and `Attenuation` modules are a direct
transcription of the Java original.

## The shape of the thing

The Fuzzy Miner has two halves that are usually described as one algorithm, and
separating them is the whole design:

| | what it does | cost | who drives it |
|---|---|---|---|
| **Mining** | measure the log; produce a complete weighted graph | O(events × distance) | the action's parameters |
| **Simplification** | drop, thin and fold that graph into something readable | O(n²) | the sliders |

The mined artefact — the `FuzzyModel` — is *not* simplified. Every activity and
every ordered pair carries its numbers, and the sliders re-derive the picture
from them. That is why the rail feels immediate in ProM, and why it does here.

## Mining (Rust, `src/lib.rs`)

### The scan

One ordered pass over `(case, activity, timestamp, resource)`. For each event,
the preceding `SCAN_DISTANCE` (= 5) events in the same case are its *look-back
window*; each one contributes to the pair (predecessor, current) at the
distance it sits at.

Accumulators are kept **per distance**, un-attenuated. That is the one
structural departure from the reference, and it is deliberate: Promenade caches
the scan and keys that cache on the log and the activity limit only, so
anything that changed the scan's own arithmetic would be silently ignored when
a parameter moved. Folding the distances down at `finalize` time instead makes
the attenuation function, its radical and the maximal event distance all
**cheap** parameters — you can move them and see the answer.

### Attenuation

How much a relation at distance *k* counts, for *k* ≥ 1:

- **Nth root** (default, radical 2.7): `1 / radical^(k-1)`.
- **Linear**: `(radical - k + 1) / radical`, floored at 0.

Distance 1 is always 1.0 under both.

### The metrics

**Unary — frequency significance.** How often the activity occurs.

**Unary — routing significance** (derivative). For activity *i*, with `S` the
normalised binary significance and `C` the normalised aggregate correlation:

```
in  = Σ_{x≠i} S[x][i] · C[x][i]
out = Σ_{x≠i} S[i][x] · C[i][x]
routing = |in − out| / (in + out)
```

A pure split or join scores 1, a pass-through 0. This is what keeps a rare but
structurally decisive activity on the map.

**Binary — frequency significance.** The attenuated observation count of the
relation.

**Binary — distance significance** (derivative). With `s`, `t` the normalised
significance of the two activities and `l` the normalised significance of the
relation between them:

```
distance = 1 − ((s − l) + (t − l)) / (s + t)
```

A weak relation between two important activities scores low — the signature of
a long-distance shortcut rather than a real hand-off. Zero where there is no
relation at all.

**Binary correlation — proximity.** `1 / (t₂ − t₁)` in milliseconds, `1.0` for
two events sharing a timestamp. Deliberately not a smooth decay: the raw values
are tiny, and normalisation is what gives them a usable range. This is the
reference's formula, kept as-is.

**Binary correlation — endpoint.** Levenshtein similarity of the two *activity
names*, as `(len − distance) / len` over the longer string — ProM's own string
measure, not the edit-ratio most libraries return.

Because that value is constant per pair, its attenuated sum divided by the same
attenuated count is the constant again. So it is built directly at `finalize`
rather than accumulated, which saves an n×n×distance array for no loss of
fidelity.

**Binary correlation — originator.** The same similarity, over the two events'
`org:resource` values. This needs a per-event resource column, which the host's
WASM scan ABI now supplies when an action declares `kernel.scan.resource` — see
`app/src/worker/wasm-plugin-worker.ts`.

### Normalisation

Each metric is scaled so its maximum equals its **weight** (0 excludes it
entirely). Correlation metrics are first divided by the summed attenuation
factors that produced them — ProM's "compensate frequency" step, without which
a frequent pair would look more correlated purely for being frequent. The
included metrics of each kind are then summed and the total scaled to 1.

### Not implemented

Two of the reference's seven correlation metrics are missing:

- **data-type correlation** — how many non-standard attribute *keys* the two
  events share;
- **data-value correlation** — how similar the *values* of their shared keys
  are.

Both need each event's whole attribute bag inside the kernel. Promenade keeps
those in a long-format `event_attributes` relation, and pushing them across the
scan boundary is a much larger and more expensive ABI question than the single
dictionary-encoded resource column originator correlation needed. Their absence
narrows the correlation signal on attribute-rich logs; on a log with only the
XES core attributes — which is most of them — they contribute nothing anyway.

The reference's per-metric **invert** flags are likewise not exposed. Every
metric here is used the way its default configuration uses it.

## Simplification (TypeScript, `view-src/src/filters.ts`)

Three filters, always in this order. Each reads the previous one's output.

### 1. Conflict resolution

For every unordered pair {A, B} with relations in *both* directions, compute
each direction's **relative importance** — the share of A's outgoing weight and
of B's incoming weight it accounts for:

```
rel(A,B) = sig[A][B] / Σ_{i≠A} sig[A][i]  +  sig[A][B] / Σ_{i≠B} sig[i][B]
```

Then:

- both above the **preserve threshold** (0.6) → real concurrency, keep both;
- otherwise, `min/max` below the **ratio threshold** (0.7) → one direction
  clearly dominates, drop the weaker;
- otherwise → unimportant in both directions, drop both.

Relative importance is read off the *unfiltered* matrices, so the outcome does
not depend on the order pairs happen to be visited in.

### 2. Edge filter

Per activity, not globally — a global threshold silences a quiet part of the
process entirely, whereas ranking an activity's own relations against each
other keeps every surviving activity connected to something.

**Fuzzy edges** (default) scores each relation
`significance × ratio + correlation × (1 − ratio)` with the **utility ratio**
(0.75), separately for the activity's incoming and outgoing sets, and keeps
everything at or above `max − (max − min) × cutoff` with the **edge cutoff**
(0.2). *Interpret absolute* merges the two ranges into one; *ignore self-loops*
leaves self-loops out of the ranking so a dominant one cannot suppress an
activity's real relations.

**Best edges** keeps only the single strongest predecessor and successor.

### 3. Node aggregation

Activities below the **node cutoff** are *victims*. Each joins the cluster of
whatever it correlates with most (read from the pre-edge-filter matrices — the
edge filter may have cut every relation it had, and it still has to go
somewhere), or opens a new cluster. Then:

- **merge** — a cluster merges into a neighbouring cluster only when *every*
  neighbour on that side is a cluster too. A single real activity upstream
  stops the merge: it is the boundary the diagram can still be read against.
- **remove isolated** — a cluster with no predecessors and no successors leaves
  entirely, taking its activities with it.
- **remove singular** — a cluster of one is dissolved. Where that would sever a
  path, the relation is redrawn straight from predecessor to successor with the
  mean of the two it replaces.

Relations are then lifted into the post-clustering index space; where two
collapse onto the same pair the stronger one wins, and relations internal to a
cluster disappear into it.

### Deviations from the reference

Two, both fixes for behaviour that is clearly unintended in the Python port:

1. `get_most_correlated` initialises its winner to `0` rather than to "none",
   so an activity correlating with nothing is adopted by whatever activity 0
   maps to. Here that case means "no neighbour", and opens a fresh cluster —
   which is what the surrounding code already handles.
2. Both filters skip relations whose significance is zero when testing against
   a limit, so a non-existent relation cannot slip past a limit that has itself
   gone negative on a row with no relations at all.

## Verification

- `cargo test` — metric invariants: unit-interval bounds across every
  attenuation/distance combination, case-boundary isolation, distance ordering,
  weight exclusion, ProM's string-similarity and attenuation constants.
- `view-src/npm run check` — filter-chain invariants over 5 hand-written cases
  and 400 randomised models: no edge points at an undrawn node, no activity is
  both drawn and clustered, no cluster of one survives, no duplicate edges, no
  cluster self-loops, every drawn activity cleared the cutoff. The suite
  reports its own coverage (how many random models actually produced clusters,
  merges and removals) so it cannot pass vacuously.

Both run in `package.sh`, so neither can be skipped by accident.
