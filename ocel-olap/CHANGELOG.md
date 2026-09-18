# Changelog

## 0.1.0

First release — the four multi-dimensional operations of Khayatbashi, Miri and
Jalali (CAiSE Forum 2025) on an object-centric event log.

- **Drill down an object type** — split a type into sub-types named after an
  attribute's values. An object whose attribute has no value keeps the parent
  type, so nothing is placed in a category the data never claimed.
- **Roll up an object type** — the exact inverse.
- **Unfold an event type** — split an activity by the kind of object it
  touches, optionally restricted to one relation qualifier.
- **Fold an event type** — the exact inverse.

Each produces a new `ObjectCentricEventLog`, so every discovery, view and
metric in the workspace can be run on the result and compared with the
original.

The plugin is pure SQL: four SQL Profile v1 programs and a manifest, no kernel
and no Python. Object-type and activity pickers are populated from the log
itself, so the parameters are chosen rather than typed.

**`check.mjs`** gates packaging. It runs each program through the host's own
parser and compiler and then executes it against real DuckDB, asserting that
each program writes all six OCEL relations, that only the intended column ever
changes, that a time-dependent attribute is read at its earliest value, and —
the one that matters — that **rolling up undoes drilling down and folding
undoes unfolding, exactly, over the whole log**.
