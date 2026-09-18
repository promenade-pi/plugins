# Algorithm

## The templates

Each rule is a template applied to one or two activities. `a` is the first
activity named, `b` the second; positions are within one case.

| Template | Holds when | Activated by |
|---|---|---|
| `existence` | `a` occurs at least once | every case |
| `absence` | `a` never occurs | every case |
| `exactlyOne` | `a` occurs exactly once | every case |
| `init` | the case starts with `a` | every case |
| `end` | the case ends with `a` | every case |
| `respondedExistence` | if `a` occurs, `b` occurs (either order) | `a` |
| `response` | every `a` is followed, at any distance, by a `b` | `a` |
| `precedence` | every `b` has an `a` somewhere before it | `b` |
| `succession` | both of the above | `a` or `b` |
| `altResponse` | every `a` has a `b` before the next `a` | `a` |
| `altPrecedence` | every `b` has an `a` before it with no other `b` in between | `b` |
| `altSuccession` | both | `a` or `b` |
| `chainResponse` | every `a` is *immediately* followed by `b` | `a` |
| `chainPrecedence` | every `b` is *immediately* preceded by `a` | `b` |
| `chainSuccession` | both | `a` or `b` |
| `notCoExistence` | `a` and `b` never both occur | `a` or `b` |
| `notSuccession` | no `a` is ever followed by a `b` | `a` |
| `notChainSuccession` | no `a` is ever immediately followed by a `b` | `a` |

"Activated by" is what makes confidence different from support: a case with no
`a` cannot break a `response(a, b)`, so it is not counted in the denominator.

Two choices worth stating, because both are ambiguous in the usual prose:

- **A constraint never relates an activity to itself.** `response(a, a)` would
  demand an `a` after the last `a`, which no finite case can satisfy; the whole
  diagonal is left out of both the counting and the candidates.
- **Trace-level, not event-level.** A rule holds or fails for a whole case. The
  classical definitions are LTL formulas over the trace, and this is what they
  evaluate to.

`crates/declare-core/tests/invariants.rs` checks every one of these against a
literal transcription of the definition — nested loops over the trace, no
indexing, no cleverness — on randomised traces.

## Discovery in one pass

The scan reads each case once and keeps counters; the thresholds are applied
afterwards, which is why moving a slider re-mines the model without re-reading
the log.

The counters are:

```
traces                  cases seen
with[a]                 cases containing a
both[a][b]              cases containing both
exactlyOne[a] init[a] end[a]
violated[t][a][b]       violations of template t, among cases containing both
```

A case with *p* distinct activities out of *n* would seem to say something
about all *n*² ordered pairs, but for the pairs with a missing activity it says
the same thing every time, and that is derivable:

```
activated(response,   a, b) = with[a]
violated (response,   a, b) = (with[a] − both[a][b]) + violated[response][a][b]
                               ^ an a with no b at all      ^ an a that came last
activated(precedence, a, b) = with[b]
violated (precedence, a, b) = (with[b] − both[a][b]) + violated[precedence][a][b]
activated(succession, a, b) = with[a] + with[b] − both[a][b]
violated (succession, a, b) = (with[a] − both) + (with[b] − both) + violated[succession][a][b]
```

so the inner loop runs over the *p*² pairs actually present rather than all
*n*², and stays that size however large the alphabet is. The three sets in each
sum are disjoint, so no case is ever counted twice — which
`the_counters_arithmetic_is_the_counting_it_replaces` checks against a naive
per-case count on random logs.

`succession` gets a counter of its own rather than being derived from
`response` and `precedence`, because a case can break both and the two
violation counts would then double-count it.

## Support, confidence, and what a model is

```
support    = (traces − violated) / traces
confidence = (activated − violated) / activated        ... 0 when activated = 0
```

A violation implies an activation, which is what makes the second formula
well-formed. The zero for a never-activated rule is a deliberate departure from
"vacuously true": such a rule has a support of 1.0 and says nothing at all, and
a model full of them is what a naive discovery produces.

## Pruning

Implication between templates over the same pair, in the same direction:

```
chainResponse   → altResponse   → response   → respondedExistence
chainPrecedence → altPrecedence → precedence
chainSuccession → altSuccession → succession → response, precedence
notCoExistence  → notSuccession → notChainSuccession
exactlyOne, init, end → existence
```

plus one cross-direction rule: `precedence(a, b)` implies
`respondedExistence(b, a)` — if every `b` has an `a` before it, then a `b`
guarantees an `a`. Leaving that out leaves a redundant rule in every model with
a precedence in it.

A candidate is dropped when any other candidate that cleared the thresholds
reaches it through one or more of these steps — including candidates that are
themselves dropped, since implication is transitive. The invariant states the
property that matters: **the pruned model implies everything the unpruned model
said**, checked by taking the closure of the survivors and requiring every
removed rule to be in it.

## Checking

A model and a log, case by case: for each rule, was it activated, and did it
hold. The only subtlety is an activity the model names and the log never
records — treated as an activity that did not occur (so rules demanding it are
broken and rules forbidding it hold), and named in `unknownActivities` so a
mismatch of vocabulary cannot be mistaken for a finding about the process.

The check kernel keeps the traces rather than counters, because the model
arrives with the parameters — there is nothing to count until it does. Traces
are stored flat, one `u32` per event.

## What is not here

- **Branched templates** (`choice`, `exclusive choice`, and the *n*-ary forms
  of the others).
- **Data-aware / MP-DECLARE**: conditions on attributes, not just on activities.
- **Event-level diagnostics**: which event broke the rule, rather than which
  case. The classical definitions are trace-level, and the answer to "where" is
  usually the activation, which the Trace Explorer can find from the rule.
- **A DECLARE map**: the notation's decorated-edge diagram. It is unreadable
  past about twenty constraints and a discovered model has hundreds; the view
  keeps the notation's symbol next to each sentence instead.
