# The relations

A skeleton is six kinds of fact. Four are DECLARE templates under another name
and are evaluated by `declare-core`; two are the skeleton's own.

| Fact | Holds when | DECLARE |
|---|---|---|
| `equivalence(a, b)` | `a` and `b` occur the same number of times | — |
| `alwaysBefore(a, b)` | every `a` has a `b` somewhere before it | `precedence(b, a)` |
| `alwaysAfter(a, b)` | every `a` has a `b` somewhere after it | `response(a, b)` |
| `neverTogether(a, b)` | `a` and `b` never both occur | `notCoExistence(a, b)` |
| `directlyFollows(a, b)` | every `a` is immediately followed by `b` | `chainResponse(a, b)` |
| counts | the set of occurrence counts `a` was seen with | — |

`alwaysBefore(a, b) = precedence(b, a)` is the one worth stating twice: "every
`a` has a `b` before it" and "`a` only happens after `b`" are the same sentence
read from opposite ends. The invariant checks it rather than the comment
asserting it.

## The one-activity-missing cases

This is where the six definitions genuinely differ, and where a wrong answer is
invisible in the output:

| | `a` occurs, `b` does not | `b` occurs, `a` does not | neither |
|---|---|---|---|
| equivalence | broken (1 vs 0) | broken | holds (0 = 0) |
| always before / after / directly follows | broken | holds (nothing to demand) | holds |
| never together | holds | holds | holds |

Discovery never evaluates these per trace. It counts them: `with[a] − both` is
"`a` occurred and `b` did not", and the whole log's violations follow from three
per-activity totals. The inner loop therefore runs over the pairs a trace
actually contains, and stays that size however large the alphabet is — the same
arithmetic `declare-core` uses, and checked the same way, against a naive count.

## The noise threshold

A fact is kept when the cases that broke it are at most `⌊noise × cases⌋`.

Occurrence counts work the other way round: the *rarest* counts are dropped
first, until dropping another would exceed the budget. That is deliberate —
more noise means a **narrower** set of allowed counts, because the point of the
threshold is that a single freak case should not widen the model. It is the one
place in the plugin where more tolerance makes a rule stricter, and the
invariant states it explicitly.

## Classification

A case fits when it breaks nothing. Each fact is checked as above, and each
count rule asks whether the case's number of occurrences is in the recorded set
— including zero, which is a real answer: a skeleton that never saw an activity
missing rejects a case that lacks it.

An activity the skeleton names and the log never records is treated as an
activity that occurred zero times, and named in `unknownActivities`, so a
mismatch of vocabulary cannot be mistaken for a finding about the process.
