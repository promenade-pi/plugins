# The rules

Each rule below is one of Murata's classical reductions (§5 of *Petri nets:
properties, analysis and applications*, 1989) with the extra precondition that
makes it safe for a **labelled, accepting** net. The classical rules are stated
for plain nets, where fusing two transitions costs nothing and there is no
final marking to preserve. Both of those cost something here, and both are
where the bugs were.

Rules are applied to a fixpoint: fusing one pattern creates the next, which is
why a chain of gateway taus collapses to nothing rather than to half of itself.

## Silent no-ops

A silent transition whose input and output multisets are equal leaves the
marking exactly as it was and records nothing. Removing it can only shorten a
firing sequence, never change one.

A *visible* transition like that is not touched: it produces an event, which is
the whole point of it.

## Fusion of series transitions (FST)

A place `p` with exactly one producer `t₁` and one consumer `t₂`, where `p` is
`t₁`'s only output and `t₂`'s only input, and at least one of the two is
silent. The pair can only ever fire one after the other, so they become one
transition carrying whichever label there was.

`p` must be unmarked in both the initial and the final marking: a token sitting
there is a state the merged transition cannot represent.

## Fusion of series places (FSP)

A silent transition `t` that is the only consumer of `p` and the only producer
of `q`, moving one token from one to the other. A token in `p` can go nowhere
but `q`, at no cost to the trace, so the two are one place; their markings add.

**`p` must not carry the final marking.** Tokens flow one way — a token in `q`
can never go back to `p` — so merging would let `q`'s tokens satisfy a final
condition stated about `p`. A net that deadlocks one place short of the finish
would come back accepting the empty trace. This was the second defect the
invariants caught.

## Fusion of duplicates (FPT, FPP)

Two transitions with the same label, inputs and outputs are one transition: a
trace cannot tell which fired.

Two places connected to exactly the same transitions with exactly the same
weights hold counts that move together, so they are one place holding the sum —
**provided `F(p) − M₀(p) = F(q) − M₀(q)`**. Without that condition the merge
changes what "finished" means: their counts differ by a constant, and the merged
place's acceptance condition is about the total. Two identically wired places,
one marked at the start and the other required at the end, made a deadlocked net
accept the empty trace. This was the first defect the invariants caught.

## Self-loop places (ESP)

A place whose only connection is one transition, in both directions with the
same weight, holds a count that never changes. If it starts with enough tokens
it can never block that transition, so it constrains nothing *about firing*.

It can still constrain **finishing**, and that is the extra condition:
`M₀(p) = F(p)` is required. The count is constant, so a final marking asking
for anything else is a condition the net can never meet — and removing the
place would turn a net that can never finish into one that finishes
immediately. That was the fourth defect the invariants caught, at 1 200 cases
rather than 300.

An *unmarked* self-loop place is a real constraint — it blocks the transition
forever — and stays.

## Redundant places

The literature calls these implicit places: a place that is never the reason a
transition cannot fire. The general characterisation is a linear program over
the marking equation (Colom & Silva, 1990), and it is about **firing**.

An accepting net asks a second question the classical definition does not:
whether the marking reached *is* the final marking. Dropping a place drops its
share of that test — "and this place is empty" — so a net that deadlocked one
place short of finishing can come back accepting. The invariants caught exactly
that, and the rule here is narrower than the literature's as a result:

> `p` goes when some other place `q` constrains at least as much *and* carries
> the same count at a fixed offset: `Pre(p, t) ≤ Pre(q, t)` and the same effect
> on every firing, with `M₀(p) − M₀(q) = F(p) − F(q) ≥ 0`.

Then `M(p) = M(q) + offset` in every reachable marking, so

- `p` never blocks: `M(p) ≥ M(q) ≥ Pre(q, t) ≥ Pre(p, t)`;
- acceptance is unchanged: `M(p) = F(p)` exactly when `M(q) = F(q)`.

No solver, no tolerance, no state space. What it gives up is the implicit places
that are only *behaviourally* redundant — those need the LP, and for an
accepting net they need an acceptance argument the LP does not make.

## Two structural guards

Both exist because of what the *reader* does, not what the net means:

- the initial marking must never become empty, and
- the final marking must never become empty,

because `soundness-core`'s normaliser — which every consumer of this payload
goes through — treats a net that declares no marking as one whose markings were
lost, and puts a token in every source or sink place. A reduction that emptied
a marking would hand the next reader a different net than the one it reduced.
This was the third defect the invariants caught.

## What the invariants establish

`crates/net-reduce-core/tests/invariants.rs`, on randomised block-structured
nets and randomised arbitrary ones:

1. the language is identical — every trace of one net is a trace of the other,
   enumerated by `playout-core`'s extensive play-out;
2. every rule preserves it *on its own*, so a failure names the rule;
3. a sound net stays sound, and an unsound one stays unsound
   (`soundness-core`), whenever both searches finish;
4. reduction never grows a net, and running it twice changes nothing;
5. every visible activity survives.

A net whose language is infinite cannot be enumerated, so those cases are
reported as *not compared* rather than quietly passed — and the tests assert
that enough cases were genuinely compared, which is what stops the whole thing
from becoming a test that checks nothing.
