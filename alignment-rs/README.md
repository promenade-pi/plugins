# Conformance Checking

Replays a log against a Petri net, two ways. Both answer "does this model
explain this log"; they disagree about what the answer should cost and what
it should say.

| | Alignments | Token-based replay |
|---|---|---|
| Method | Dijkstra over the synchronous product | one linear walk per variant |
| Optimal | yes — the cheapest explanation | no, greedy and never backtracks |
| Fitness scale | alignment cost against a worst case | tokens missing and left over |
| Can give up | yes (state cap) | no |
| Reports | fitness, precision, the move sequence | fitness, missing/remaining tokens **per place** |
| Use it for | the number you publish | the place in the net to go and look at |

## Two-input actions

Unlike every other plugin here, these take two inputs — a log and a model.
The host resolves the model's transition labels into the log's own activity
id space and passes the whole model as part of `params` before calling
`finalize()`; nothing in `src/lib.rs` ever sees an activity name.

Both actions share one scan (one pass over the ordered event stream, building
one activity sequence per case) and one variant grouping, so their variant
tables line up row for row on the same pair of inputs. Only `finalize()`
differs, which is why this is one package with two kernel classes rather than
two packages.

## Alignments

Dijkstra's algorithm over the synchronous product (marking × trace position)
— exact, optimal alignments, the same guarantee ProM's own alignment plugin
gives. What it isn't: the ILP-heuristic-accelerated A* the reference
implementation uses to stay fast on very large search spaces, which needs a
marking-equation LP solver. Plain Dijkstra is simpler to get right and is
still exact; it can just explore more states before finding the optimum on a
heavily concurrent model. See `docs/algorithm.md`.

Bounded to 300,000 explored search states per variant, reported rather than
silently producing a wrong answer.

## Token-based replay

Rozinat & van der Aalst's technique: fire the trace through the net event by
event, and where a transition is not enabled, force it — put the tokens it
needs into the empty input places and count them as **missing**. Tokens still
in the net when the trace ends are **remaining**. Fitness is

    0.5 · (1 − missing/consumed) + 0.5 · (1 − remaining/produced)

Two numbers come back, because there are two defensible ways to aggregate:
`fitness` pools every case's counters and takes the ratio once (the figure
ProM reports), `trace_fitness` averages the per-case ratios (one equal vote
per case). Quietly picking one would make the result unreproducible against
the other.

The two fitness numbers are not comparable with the alignment's: they are
different quantities, not two estimates of one. Token-based replay is also
greedy — it commits at every step and never backtracks — so on a net with
duplicate labels or heavy concurrency an unlucky commitment can cost tokens
an alignment would not have spent. Use the alignment when the number itself
is the claim.

Silent transitions are never forced. Before declaring a transition
un-enabled, a breadth-first search fires *only* silent transitions looking
for a marking that enables it, and the same search runs once at the end to
reach the final marking. Without it every Inductive Miner model — which is
mostly silent routing — would replay as near-total deviation.

That search is bounded to twelve silent firings per detour, which is a
statement about what routing is rather than a resource limit: the unobserved
steps between two observed events are a handful of decisions. It is also what
makes it affordable — the expensive case is not the detour that exists but
the one that does not, since proving "no silent firing can enable this" means
exhausting the whole silent-reachable marking space. When a search does stop
at the bound the replay forces the transition anyway and reports how many
cases that happened to, so the fitness is a lower bound for them rather than
a wrong number.

Two things are outside the textbook and deliberate:

- An event whose activity has **no transition at all** in the model costs one
  missing token against one consumed. The textbook assumes the mapping is
  total; doing nothing instead would let a model missing half the log's
  activities score a perfect fitness. It is also counted separately
  (`unmapped`) rather than folded into the deviations the model does have a
  place for.
- Deviations are attributed **per place**, not only in total — that is the
  whole reason to run this beside an alignment, and it is what the Replay
  Diagnostics view draws on the net.

Both actions are bounded to 128 places (a 1-safe marking as a `u128` bitmask
in the alignment path), reported rather than silently truncated.
