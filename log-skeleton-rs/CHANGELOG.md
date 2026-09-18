# Changelog

## 0.1.0

First release.

- **Discover log skeleton** — the six kinds of fact Verbeek and de Carvalho's
  skeleton is made of: equivalence, always-before, always-after,
  never-together, directly-follows, and the set of occurrence counts each
  activity was seen with.
- **Classify against a skeleton** — case by case: which facts were broken, by
  how many cases, and which cases broke the most. This is what the skeleton is
  for; the paper entered the Process Discovery Contest with it as a classifier
  rather than as a model.
- Two views: the facts (with the occurrence counts first, since that is the
  part a reader can check against what they know) and the classification.
- The noise threshold, the relation switches and the size cap are all `cheap`
  parameters, so the scan is read once and the skeleton re-derived on every
  change.
- **Four of the six relations are DECLARE templates under another name**, and
  are evaluated by that plugin's crate rather than restated here — two
  implementations of "every `a` is eventually followed by `b`" is two chances
  to disagree. `docs/relations.md` has the correspondence, and an invariant
  checks it.
- **Executable invariants** gating the package, the first of which is the
  skeleton's defining property: *a skeleton accepts the log it came from*, on
  hundreds of randomised logs. Plus the counters' arithmetic against a naive
  count, the DECLARE correspondence, noise monotonicity, and that a skeleton
  rejects traces built to break it — a classifier that accepts everything is
  not a classifier.

### Host requirement

Needs the host's generic `inputValues` for wasm actions (Promenade ≥ the change
that shipped with the DECLARE plugin): the classifier scans a log *and* reads a
skeleton from its second input.
