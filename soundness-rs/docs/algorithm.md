# Algorithm

## The definition being checked

A Petri net `N` is a **workflow net** (van der Aalst, *The Application of Petri
Nets to Workflow Management*, JCSC 8(1), 1998) when

1. it has one source place `i` with no incoming arc,
2. one sink place `o` with no outgoing arc, and
3. every place and transition lies on a path from `i` to `o`.

A workflow net is **sound** when, starting from `[i]`,

1. **option to complete** — every reachable marking can still reach `[o]`,
2. **proper completion** — no reachable marking strictly covers `[o]`, and
3. **no dead transitions** — every transition is enabled in some reachable
   marking.

Soundness is equivalent to the short-circuited net `N` (an extra transition
from `o` back to `i`) being live and bounded, which is the formulation Woflan
(Verbeek, Basten & van der Aalst, *Diagnosing Workflow Processes using Woflan*,
The Computer Journal 44(4), 2001) is built on. This plugin checks the three
requirements directly instead, because directness is what produces a usable
witness: "marking `M` is reachable and has no successor" is a bug report, and
"the short-circuited net is not live" is not.

Promenade's `AcceptingPetriNet` carries an explicit initial and final marking
rather than implying `[i]` and `[o]`, so all three are evaluated against the
declared markings. On a genuine workflow net these coincide with `[i]`/`[o]`
and the check is exactly the textbook one.

## Why the search terminates

Soundness quantifies over *reachable* markings, and the reachable set of a
Petri net can be infinite. A coverability graph is finite, but its ω-markings
over-approximate: a marking that exists only with ω can produce a deadlock no
real firing sequence ever reaches. Answering a soundness question directly
from one would manufacture failures.

So the useful half of the Karp–Miller construction (*Parallel Program
Schemata*, JCSS 3(2), 1969) is the covering test, not the ω-graph:

> if `M →σ M'` with `M' ≥ M` and `M' ≠ M`, then σ can be repeated forever,
> each round strictly adding tokens — the net is unbounded.

The search is therefore a breadth-first walk of the reachability graph in which
every newly generated marking is tested against its own ancestors in the search
tree. The parent chain is a real firing sequence from the initial marking,
which is what makes a covering pair a proof rather than a heuristic. Three
outcomes, and no fourth:

| outcome | what it means | what may be concluded |
|---|---|---|
| **unbounded** | an ancestor was covered | the net is unsound, with the prefix and the pump that show it |
| **complete** | the frontier emptied without any covering pair, so the reachability set is finite and fully enumerated | every requirement is decided *exactly* |
| **truncated** | the state limit was reached first | only what the partial graph actually witnessed |

Termination on an unbounded net is Dickson's lemma: every infinite firing path
contains a covering pair, so one appears at finite depth. The state limit is a
guard against a *large bounded* net — parallel branches multiply — not against
divergence.

## What a partial search is allowed to say

The distinction the report never blurs:

| | complete | truncated / unbounded |
|---|---|---|
| a deadlock was reached | **fail** | **fail** — the state is genuinely reachable |
| a marking covering the final one was reached | **fail** | **fail** — same reason |
| no counterexample found | **pass** | **unknown** |
| a transition never fired | **fail** | **unknown** — it may fire past the limit |

A truncated search can convict. It can never acquit.

## Computing each requirement

With a complete graph in hand:

- **option to complete** — a backward breadth-first closure from the state
  holding the final marking. Every state outside that closure is a
  counterexample; those with no successors are reported as *deadlocks*, those
  with successors as markings that *can never finish* (the net keeps running
  and the case is already lost).
- **proper completion** — every state whose marking is `≥` the final marking
  and not equal to it.
- **no dead transitions** — the set of transitions never enabled during the
  walk.

Each reported marking carries the parent-chain trace, which is a *shortest*
firing sequence because the walk is breadth-first.

## Verdict

`Unsound` if any requirement failed or any structural error was raised —
a net that is not a workflow net is not a sound workflow net, which is also
pm4py's reading in `check_soundness`. `Sound` if all four passed. `Undecided`
otherwise. The per-requirement outcomes are reported either way, so a net that
is not a workflow net still gets a full behavioural diagnosis rather than a
refusal.

## The invariants

`crates/soundness-core/tests/invariants.rs`, gated in `package.sh`. Geometry
and verdicts have the same problem — they look right until they are not — so
what is asserted is properties over randomised inputs, not fixtures:

1. **A block-structured net is never accused.** Random process trees are
   converted to nets by the textbook construction, so every one of them is
   sound. Not one may come back `Unsound`; each whose state space fits in the
   budget must come back `Sound`. A false accusation is the one failure that
   would make the whole plugin worse than not having it.
2. **A complete search agrees with an independent reference** — a second,
   deliberately naive reachability implementation sharing no code with the
   first beyond `enabled`/`fire`.
3. **Every witness replays.** A reported firing sequence must fire from the
   initial marking, land in the marking the report states, and have the
   property it was reported for: a deadlock witness must genuinely have no
   enabled transition, an improper one must genuinely cover the final marking.
4. **An unboundedness proof pumps** — replaying `prefix` then `pump` k times
   stays firable and strictly gains tokens every round.
5. **A dead transition is dead in the reference too.**

The corpus is checked for shape as well: a run in which too few nets were
bounded, or too few unbounded, fails, because a generator that had drifted
would otherwise satisfy every assertion above while testing nothing.

This is also how the one real bug found during development surfaced: a state
popped from the frontier was marked *expanded* before its successors were
generated, so returning at the state limit mid-expansion left a state with no
outgoing edges — indistinguishable, downstream, from a deadlock. The
truncation test caught it on the first run.

## References

- van der Aalst, W.M.P. (1998). *The Application of Petri Nets to Workflow
  Management*. Journal of Circuits, Systems and Computers 8(1), 21–66.
  [doi:10.1142/S0218126698000043](https://doi.org/10.1142/S0218126698000043)
- van der Aalst, W.M.P. (1997). *Verification of Workflow Nets*. ICATPN 1997,
  LNCS 1248, 407–426.
- Verbeek, H.M.W., Basten, T. & van der Aalst, W.M.P. (2001). *Diagnosing
  Workflow Processes using Woflan*. The Computer Journal 44(4), 246–279.
- Karp, R.M. & Miller, R.E. (1969). *Parallel Program Schemata*. Journal of
  Computer and System Sciences 3(2), 147–195.
