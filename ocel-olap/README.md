# Object-Centric OLAP

The four multi-dimensional operations on an object-centric event log:

```
object-type dimension      Order ──drill down "priority"──▶ (Order, gold), (Order, standard)
                                 ◀────── roll up ─────────

event-type dimension       pay ──unfold by "Customer"──▶ (pay, Customer), pay
                               ◀──────── fold ─────────
```

An OCEL has two dimensions a cube would call hierarchies — the types of the
objects, and the types of the events. Analysing one is not a matter of
filtering it down but of **changing what counts as a type**, and then running
the same discovery again to see what moved.

Each operation produces a new `ObjectCentricEventLog`. Nothing is removed: the
same events, objects and relations come out, with one column renamed. Every
OCEL plugin in the workspace — discovery, the inspector, the metro map, the
replay — reads the result unchanged, which is the point of doing this to the
log rather than inside one algorithm.

## The operations

**Drill down an object type.** Splits one type into sub-types named after an
attribute's values. An object whose attribute has no value **keeps the parent
type**: inventing an "(Order, unknown)" would put objects in a category the
data never claimed, and would not be reversible. A time-dependent attribute
(OCEL 2.0 records value *histories*) is read at its **earliest** value — an
object cannot belong to two types at once, and the first value is the only
choice that does not depend on when the extract was taken.

**Roll up an object type.** The inverse, and inverse exactly: a drilled log
rolled up on the same type is the log it was drilled from, relation for
relation.

**Unfold an event type.** Splits one activity by the kind of object it
touches: `pay` performed on a `Customer` becomes `(pay, Customer)`, while the
same activity with no such object keeps its name. That separation is what stops
a discovered model from merging two genuinely different pieces of work into one
node. An optional qualifier restricts which relations count — "the customer it
was paid *for*", not every customer mentioned.

**Fold an event type.** The inverse, exactly.

## Why this and not a filter

A filter answers "what happens to gold orders?" by throwing the others away,
and the answer cannot be compared with anything. Drilling down answers it by
keeping the whole log and letting the *model* separate them — the discovered
net has both sub-types in it, side by side, with the shared activities still
shared. That comparison is the analysis.

## What it is made of

Four SQL Profile v1 programs and a manifest. No kernel, no Python, no wasm: the
operations are relational rewrites of the log's own tables, so they run in the
host's relational runtime, and what the plugin can touch is exactly the six
relations of an OCEL.

`check.mjs` runs each program through the host's own parser and compiler and
then executes it against real DuckDB over hand-built logs, asserting the
round-trip identities and that nothing but the renamed column moves. It gates
packaging.

## Limits

- **The tuple notation is the data.** A sub-type is literally named
  `(Order, gold)`, which is what makes rolling up possible without a side
  table — and means an object type genuinely named like a tuple would be
  rolled up too.
- **One attribute, one type, per run.** Drilling down two types is two runs,
  which is also two artifacts and two provenance entries.
- Drilling down on an attribute with hundreds of values produces hundreds of
  object types. The picker shows how many objects carry each attribute, which
  is the number to look at first.

## Reference

Khayatbashi, S., Miri, N. & Jalali, A. (2025). *Advancing Object-Centric
Process Mining with Multi-Dimensional Data Operations.* CAiSE Forum 2025.
[arXiv:2412.00393](https://arxiv.org/abs/2412.00393)

## Building

```bash
./package.sh
```
