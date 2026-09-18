# Changelog

## 0.1.1

- A crash while *rendering* a view no longer leaves a blank panel. The boot
  guard only ever covered start-up: `root.render()` returns before React has
  rendered anything, so an exception thrown during the render landed outside
  it, and React's answer to an uncaught render error is to unmount the tree.
  Inside a sandboxed frame that is invisible — the frame's console is not the
  host's — so the panel simply showed nothing. Both views now say what went
  wrong instead.

## 0.1.0

First release — the declarative paradigm, which this workspace had nothing of.

- **Discover DECLARE model** — eighteen templates (existence, absence, exactly
  one, init, end; responded existence, response, precedence, succession; their
  alternating and chain variants; not co-existence, not succession, not chain
  succession) measured over every ordered pair of activities, filtered by
  support and confidence, with redundant rules pruned.
- **Check DECLARE rules** — any model against any log: which rules were broken,
  how often relative to how often they applied, and which cases broke them.
- Two views: the rules as a filterable, sortable list of sentences, and the
  violations ranked by how often a rule was broken when it applied.
- **Support and confidence are both reported**, and they answer different
  questions: a rule about an activity that occurs twice in a million cases has
  a support of 0.999998 and a confidence of whatever those two cases did. A
  rule the log never activates scores zero confidence rather than one, so the
  default threshold drops it instead of filling the model with empty truths.
- Both thresholds, the family switches and pruning are `cheap` parameters: the
  scan is cached, so moving a slider re-mines the model without re-reading the
  log.
- **Executable invariants** gating the package: every template checked against
  a literal transcription of its definition on randomised traces; the counters'
  derived arithmetic against a naive per-trace count; and a discovered model
  fed back through the conformance checker, which must report exactly the
  violations discovery measured.

### Host requirement

Needs the host's generic `inputValues` for wasm actions (Promenade ≥ the change
that added it to `wasmActionRuntime`): "Check DECLARE rules" scans a log *and*
reads a model from its second input, which the wasm ABI previously had no way
to deliver.
