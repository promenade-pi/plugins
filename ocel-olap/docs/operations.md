# The operations

Each is one SQL Profile v1 program in `sql/`, reading the six logical relations
of an `ObjectCentricEventLog` and writing all six back. The host compiles them
into a single `WITH … SELECT` per output and writes the result as a new log —
no plugin code runs at all.

## Drill down — `sql/drill-down.sql`

```
objects.object_type = '(' || object_type || ', ' || <attribute value> || ')'
```

for objects of the named type that have a value, and unchanged for everything
else. Three decisions:

1. **No value means no sub-type.** The object stays on the parent type. An
   invented `(Order, unknown)` would be indistinguishable from a real value
   when rolling up, which would make the operation lossy.
2. **A value history is read at its earliest entry**
   (`QUALIFY ROW_NUMBER() OVER (PARTITION BY object_id ORDER BY ts NULLS FIRST, value) = 1`).
   OCEL 2.0 attributes can change over time; a type cannot.
3. **Everything else passes through**, including the attribute rows the
   sub-type was derived from. The log keeps saying what it said.

## Roll up — `sql/roll-up.sql`

```
CASE WHEN object_type LIKE '(' || :objectType || ', %)' THEN :objectType ELSE object_type END
```

The inverse. It is exact because drilling down never invents a sub-type for an
object with no value — so nothing has to be guessed on the way back.

## Unfold — `sql/unfold.sql`

An event of the named activity is renamed when it has at least one
event-to-object relation to an object of the named type, optionally restricted
to one qualifier:

```
matched  = DISTINCT event_id from event_object ⨝ objects WHERE object_type = :objectType
events.activity = '(' || activity || ', ' || :objectType || ')'   for activity = :activity AND matched
```

Events of that activity with no such relation keep their name, which is what
makes the unfolded log distinguish the two groups.

## Fold — `sql/fold.sql`

```
CASE WHEN activity LIKE '(' || :activity || ', %)' THEN :activity ELSE activity END
```

The inverse, exact for the same reason.

## What the checks establish

`check.mjs` asserts, against real DuckDB:

- every program declares all six OCEL relations, so the result is a mountable
  log rather than a fragment;
- drilling down splits exactly the named type, by the named attribute, and
  leaves valueless objects on the parent;
- the earliest value of a time-dependent attribute is the one used;
- unfolding renames exactly the matching events, and a qualifier restricts
  which relations count;
- **roll up ∘ drill down = identity** and **fold ∘ unfold = identity**, over
  every relation of the log, not just the one that was rewritten;
- an operation with nothing to do returns the log unchanged.

## Parameters come from the log

The object-type, attribute, activity and qualifier pickers are `optionsFrom`
queries against the log's own tables, so a parameter is chosen from what is
there rather than typed from memory. The roll-up and fold pickers list only
the tuple-style names that exist, so they offer exactly what can be collapsed.
