# Petri Net Reduction

Takes the scaffolding out of an accepting Petri net without changing what it
does.

A net that came from a conversion or a discovery algorithm is bigger than the
process it describes. The structure-free BPMN mapping writes one place per
sequence flow and a silent transition per gateway pair; a block-structured
construction brackets every operator with taus. None of it is wrong — it is how
the construction works — and all of it is in the way afterwards: a state-space
search pays for every extra place, an alignment for every silent step, and a
person reading the picture pays most of all.

## What it promises

**The same language.** The reduced net produces the same sequences of visible
activities, and the same ones reach the final marking. Not "the same liveness
properties", not "roughly the same" — the same traces.

That promise is the whole plugin, so it is what the build checks. Both nets'
languages are enumerated with the **play-out** plugin's extensive mode and
compared trace for trace, on hundreds of randomised nets; soundness is compared
with the **soundness checker**. Two other plugins' crates, neither of which has
any reason to agree with this one, and `package.sh` will not build an archive
if they disagree.

## The rules

| Rule | What goes |
|---|---|
| Silent no-ops | A silent transition whose inputs and outputs are the same |
| Fusion of series transitions | A silent step between two transitions, where the place between them belongs to no one else |
| Fusion of series places | Two places joined by a silent step that is the only way out of one and the only way into the other |
| Fusion of duplicates | Two transitions with the same label, inputs and outputs; two places wired identically |
| Self-loop places | A place a transition borrows a token from and returns, that starts with enough tokens |
| Redundant places | A place another place already constrains, in a way that says the same about finishing |

Each is switchable, and the report names how often each fired.

## What it will not do

- **It never removes an activity.** Every visible label survives, always — that
  is an invariant, not a policy.
- **It is not simplification in the modelling sense.** Nothing here drops a
  path, a loop or an exception branch to make a picture calmer. If the net is
  complicated because the process is, it stays complicated.
- **The general implicit-place test is not implemented.** That test is a linear
  program, and — more to the point — it is about *firing*, while an accepting
  net also asks whether the marking reached is the final one. What is
  implemented is the subset that preserves both. See
  [docs/rules.md](docs/rules.md).

## References

Murata, T. (1989). *Petri nets: properties, analysis and applications.*
Proceedings of the IEEE 77(4), 541–580. §5 is the six classical rules.
[doi:10.1109/5.24143](https://doi.org/10.1109/5.24143)

Berthelot, G. (1986). *Transformations and decompositions of nets.* Advances in
Petri Nets, LNCS 254, 359–376.

Colom, J.M. & Silva, M. (1990). *Improving the linearly based characterization
of P/T nets.* Advances in Petri Nets, LNCS 483.

## Building

```bash
./package.sh
```

Runs the unit tests and the invariants first (`REDUCE_CHECK_CASES` raises the
case count), then `wasm-pack`, then packages
`dist/run.promenade.net-reduce-<version>.pmplugin`.
