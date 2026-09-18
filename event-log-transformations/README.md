# Event Log Transformations

Tools for reshaping and comparing object-centric event logs.

The first action is **Compare event logs**. Select two `ObjectCentricEventLog`
artifacts — click the one you consider the *baseline* first — and run it. The
artifact you get back is a report, not a picture-only diff.

## What it reports

1. **Strict equality** (Definition 1 of the transformation-calculus draft). Every
   relation — events, objects, E2O, O2O, event attributes, object attributes — is
   compared as a set of tuples. Equal iff identifiers, type names, timestamps,
   attribute values and both relations all match. A sample of the differing
   tuples is kept for each relation.

2. **Structural equivalence** (Definition 2). Two logs are structurally
   isomorphic if a bijection on event ids, object ids, event types and object
   types exists that preserves event types, object types, timestamps, attribute
   values and both relations — semantic labels are *preserved*, not arbitrarily
   renamed.

   Deciding this is graph-isomorphism-hard in general, but φ must preserve
   labels, timestamps and attribute values, which nearly pins it down. The
   plugin runs a **1-dimensional Weisfeiler–Leman colour refinement** seeded on
   those preserved features:

   - equal colour-class histograms + a colour-determined mapping that checks out
     ⇒ **equivalent**;
   - unequal histograms ⇒ **not equivalent** (the diverging classes are
     reported);
   - equal histograms but ambiguous classes (the logs have non-trivial
     automorphisms) ⇒ a **capped backtracking search** within the classes;
   - search budget exhausted ⇒ **undetermined** — never guessed.

   `Treat type names as renameable` drops object-/event-type names from the
   colour seed, so an automatic rename is not by itself a structural difference.

3. **Coverage** (shown when they are not equivalent). Jaccard and reciprocal
   coverage of event ids, object ids, event types and object types, plus
   per-activity and per-object-type count deltas, with bars.

4. **Suspected automatic renames.** For names in one log but not the other, a
   normalisation pass (lower-case, strip non-alphanumerics) and a Jaro–Winkler
   score flag pairs that look like the same thing relabelled — the kind of
   change a SQLite export makes when it sanitises a table name. Edit distance is
   reported alongside.

## Scope and honesty

The structural verdict is a **bounded approximation**. Colour refinement is
sound (it never calls two non-isomorphic logs equivalent by histogram alone),
and the backtracking search is exhaustive *within its node budget*; beyond that
budget the verdict is `undetermined`. This is not a complete isomorphism
decision and not an identifier-aware conformance alignment.

## Building

```bash
./package.sh
```

The archive contains only the manifest, the pure-Python comparison code and the
dependency-free sandboxed report view. The only declared Python dependency is
`pyarrow` (how SQL results become DataFrames); it is always present in the
Promenade Python runtime anyway.
