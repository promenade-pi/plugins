# How alignment-based conformance checking works

## The synchronous product

A state is `(marking, position in trace)`. From `(m, i)`:

| Move | Condition | Effect | Cost |
|---|---|---|---|
| sync | some enabled transition's label equals `trace[i]` | fire it, `i → i+1` | 0 |
| log | `i < len(trace)` | `i → i+1`, nothing fires | 1 |
| model (visible) | any other enabled transition | fire it, `i` unchanged | 1 |
| model (silent) | an enabled transition with no label | fire it, `i` unchanged | 0 |

Start: `(initial marking, 0)`. Goal: any `(final marking, len(trace))`.
Dijkstra finds the cheapest path — the optimal alignment. Reconstructing it
walks the predecessor pointers back from the goal state.

A silent move costs nothing because, by definition, it is never observed in
a log — assuming it happened is not a deviation, it's exactly what an
unlabelled transition is for (an optional or structuring step the process
tree needed but the log can't show).

## Why Dijkstra, not A*

The reference implementation (ProM, pm4py) uses A* guided by a heuristic
from the marking equation, solved as an LP relaxation, to stay fast on
industrial-scale search spaces. That needs an LP solver and a proof the
heuristic is admissible — real additional machinery. Plain Dijkstra (A* with
a zero heuristic) is still exact and needs neither; it can simply visit more
states before converging on a model with heavy concurrency. A 300,000-state
cap reports a variant as unreachable rather than hanging the worker if that
ever matters in practice.

## Why per variant, not per case

The state space depends only on the model and the trace — two cases with the
identical activity sequence have the identical optimal alignment. Grouping
first and aligning once per distinct sequence (see the host's Cases &
Variants view for the same grouping) is the difference between a search that
finishes instantly and one that repeats itself hundreds of thousands of times
on a large log.

## Fitness

```
fitness(variant) = 1 − cost(variant) / (len(variant) + model_only_cost)
```

`model_only_cost` is the cheapest way to reach the final marking from the
initial one with no log at all (the same Dijkstra search, called once with
an empty trace) — visible transitions cost 1, silent ones cost 0. The
denominator is the alignment's own worst case: skip every log event (cost =
trace length), then take the cheapest model-only path to the end. Dijkstra
can never do worse than that, so `fitness` always lands in `[0, 1]` without
needing a separate upper-bound proof.

The log-wide `mean_fitness` is the case-weighted average of every aligned
variant's fitness — a variant with 10,000 cases counts ten thousand times as
much as one with a single case, which is what "how well does this log fit
the model" should mean.

## Precision

Fitness asks whether the model can explain the log. Precision asks the
opposite question: does the model also allow behaviour the log never shows —
is it *too* permissive? A model with a single place connected to every
transition fits any log perfectly and explains nothing.

This uses the standard "escaping edges" idea (Muñoz-Gama & Carmona), scoped
down to what a per-variant alignment already computes, rather than building
a full log prefix-automaton:

1. Replay every variant's optimal alignment, marking by marking.
2. At every marking reached immediately before a **sync** move — a state the
   log's own replay genuinely stood at, not one only a model move passed
   through — record which activity the log actually took from there.
3. At that same marking, count every *visible* transition the model had
   enabled (a silent transition is never something the log could have chosen
   instead, so it is not counted as an option).
4. `precision = (Σ activities actually used) / (Σ transitions enabled)`,
   summed across every distinct marking visited this way — not averaged per
   marking, so a marking with many unused options weighs in proportion to
   how much unused behaviour it actually represents.

A marking is counted once (a `HashSet` of activities used, not a multiset),
so precision measures how much of the model's *state space* the log
explores, independent of how often each case passes through it — the same
"structural, not frequency-weighted" spirit as `mean_fitness` is
deliberately the opposite of (case-weighted, on purpose, since fitness is a
per-case question). A model with no enabled visible transitions anywhere
(e.g. every transition is silent) reports `precision = 1.0`: there is
nothing to be imprecise about.

---

# How token-based replay works

A different algorithm answering the same question, in the same package
because it takes the same two inputs and shares the same scan.

## One walk, four counters

Start with the initial marking (counting each of its tokens as **produced**).
Then, for each event of the trace, in order:

| Situation | What happens |
|---|---|
| a transition with that label is enabled | fire it |
| none is, but firing only **silent** transitions can enable one | fire that silent path, then it |
| none is, and no silent path reaches one | **force** the cheapest candidate: put a token into each empty input place, counting each as **missing**, then fire |
| no transition has that label at all | count one **missing** against one **consumed**, fire nothing |

Firing consumes one token from each input place (**consumed**) and produces
one into each output place (**produced**). At the end, silent transitions may
fire once more to reach the final marking; each final-marking token present
is consumed, each absent one is **missing**; everything still in the net is
**remaining**.

    fitness = 0.5 · (1 − missing/consumed) + 0.5 · (1 − remaining/produced)

Half the score is how little had to be invented, half is how little was left
behind. A zero denominator means nothing of that kind ever happened, which is
perfect agreement rather than a division to guard downstream.

## Why the silent search exists

Without it the technique is unusable on anything the Inductive Miner
produces. A process-tree-derived net routes almost entirely through
unlabelled transitions — a tau opens an XOR branch, another closes a loop —
and none of them appears in a log, by definition. Forcing them would report
a missing token for every routing decision the model makes correctly.

So before a transition is declared un-enabled, a breadth-first search fires
*only* silent transitions, looking for a marking that enables it; the
shortest such path wins, since firing fewer unobserved steps is the more
conservative explanation of the same event. The search is bounded (4,000
markings, and a token ceiling so a silently-producing loop cannot run away).
Hitting the bound falls back to forcing and is counted — `tau_search_exhausted`
says how many cases it happened to, which makes the reported fitness a lower
bound for those cases rather than a wrong number.

## Where it is optimistic, and why that is fine

The walk commits to a transition at every step and never backtracks. With
duplicate labels, or heavy concurrency, an unlucky commitment can lead to
deviations an alignment would have avoided — so token-based fitness is not a
lower bound on, nor directly comparable with, alignment fitness. This is a
property of the technique, not of this implementation, and it is why both
actions exist.

What it buys is that the cost is linear in the log and the diagnosis is
*located*: every missing and remaining token is attributed to the place it
happened in. "Fitness is 0.81" tells you how much the model disagrees with
the log; "place p7 had 4,300 tokens invented for it" tells you where to look.

## Both aggregates are reported

`fitness` pools every case's counters and takes the ratio once — the figure
ProM's "Replay a Log on Petri Net for Conformance Analysis" reports, and the
one to compare against a published number. `trace_fitness` is the
case-weighted mean of the per-case ratios, so one long badly-fitting case
cannot dominate it. A mean of ratios is not the ratio of sums; picking one
silently would make the output unreproducible against the other.
