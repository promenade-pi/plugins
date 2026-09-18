# Changelog

## 0.1.0

Initial release.

- **Compare event logs** — two-input action over `ObjectCentricEventLog`,
  producing an `EventLogComparison` report:
  - strict equality across every relation, with sampled differing tuples;
  - structural equivalence via bounded 1-WL colour refinement + a capped
    backtracking search, with an explicit `undetermined` verdict when the budget
    is reached;
  - reciprocal coverage (events, objects, event types, object types) and
    per-type count deltas;
  - suspected automatic renames (normalisation + Jaro–Winkler + edit distance)
    on object-type, event-type and attribute names.
- Sandboxed, dependency-free report view.
