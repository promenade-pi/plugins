# Log Skeleton

The facts a log never broke — and a way to decide whether a new case belongs.

> Verbeek, H.M.W. & de Carvalho, R.M. (2018). *Log skeletons: a classification
> approach to process discovery.* arXiv:1806.08247

A log skeleton is not a model you walk through. There are no paths, no
gateways and nothing to replay. It is a list of facts that held in **every**
case of a log:

```
“confirm order” and “pay order” happen the same number of times      equivalence
“pay order” never happens before “confirm order” has happened        always before
“place order” is always followed by “confirm order” later on         always after
“cancel order” and “deliver” never both happen                       never together
“pick item” is always immediately followed by “pack item”            directly follows
“place order” happens 1 time per case                                how often
```

The paper's contribution is what you do with that: given a new case, does it
break any of them? That question has a yes/no answer, no search and no cost
function — which is how the skeleton won the Process Discovery Contest while
everything else was drawing diagrams.

## Two actions

**Discover log skeleton** records every fact that held. With no noise allowed —
the paper's own setting — a fact is kept only if not one case broke it, which
is what makes the result usable as a classifier rather than as a summary. The
noise threshold lets a rule through that a handful of cases break, and drops the
rarest occurrence counts so one freak case cannot widen the model.

**Classify against a skeleton** takes a log and a skeleton and reports, case by
case, which facts were broken. The headline is the share of cases that fit.

## Its relationship to DECLARE

Four of the six relations are DECLARE templates under another name:

| Log skeleton | DECLARE |
|---|---|
| always after `(a, b)` | `response(a, b)` |
| always before `(a, b)` | `precedence(b, a)` |
| never together `(a, b)` | `notCoExistence(a, b)` |
| directly follows `(a, b)` | `chainResponse(a, b)` |

So this plugin **evaluates them with the DECLARE plugin's crate** rather than
restating the semantics — two implementations of "every `a` is eventually
followed by `b`" is two chances to disagree, and an invariant checks the
correspondence (including `alwaysBefore(a, b) = precedence(b, a)`, which is the
one an author gets backwards).

The other two are the skeleton's own and cannot be expressed in DECLARE at all:
**equivalence** counts occurrences, and **how often** records the set of counts
an activity was ever seen with. They are also where most of the classifying
power is.

Use DECLARE when you want rules with support and confidence, graded by how often
they applied. Use the skeleton when you want a decision.

## What it guarantees

- **A skeleton accepts the log it came from.** At no noise, every case of the
  source log fits. That is the defining property, and the first invariant.
- **Every relation means what it says**, checked against a literal reading of
  its definition and against `declare-core` for the four shared ones.
- **Noise only widens the rules** and only narrows the counts, which is what a
  threshold is for.
- **It rejects what it should**: traces built to break a skeleton are reported
  as non-fitting, every time.

## Limits

- **Trace-level.** A fact holds or fails for a whole case; the report names the
  case, not the offending event.
- **No "sometimes" relations.** The skeleton is about what always happened.
  DECLARE's support and confidence are the graded version.
- Discovery is quadratic in the number of activities, which is what the activity
  limit is for.

## Building

```bash
./package.sh
```

Runs the Rust tests and the invariants first (`SKELETON_CHECK_CASES` raises the
case count), then `wasm-pack`, then the view bundles.
