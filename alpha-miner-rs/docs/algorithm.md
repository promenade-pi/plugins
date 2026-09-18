# How the Alpha Miner works

The algorithm derives four relations from the directly-follows counts, then
searches for **maximal pairs** of activity sets.

## Relations

| Relation | Meaning |
|---|---|
| `a > b` | `a` is directly followed by `b` at least *minFrequency* times |
| `a → b` | `a > b` and **not** `b > a` — causality |
| `a ∥ b` | `a > b` **and** `b > a` — parallelism |
| `a # b` | neither direction — unrelated |

## The search

For each pair `(A, B)` where every `a ∈ A` causes every `b ∈ B`, and the members
of each set are pairwise unrelated, a place is created. Only *maximal* pairs
survive.

> This is a search over the subset lattice, which is why the kernel is compiled
> rather than expressed as SQL.

```rust
if a_mask & bit == 0
    && (a_mask & !unrelated[x]) == 0
    && bits(b_mask).iter().all(|&b| causal[x] >> b & 1 == 1)
{
    expand(causal, unrelated, n, a_mask | bit, b_mask, seen);
}
```

## Known limitations

- short loops of length one or two are not representable
- invisible (silent) tasks are not discovered
- duplicate activities collapse into one transition

See the [original paper](https://doi.org/10.1109/TKDE.2004.47) for the full
treatment.
