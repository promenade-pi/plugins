# Log Quality

`Log Quality` produces a structured report for traditional XES-derived logs and
OCEL 2.0 logs.  Its categories and stable check identifiers are based on the
Ocelot **Quality** linter: specification, referential integrity, temporal
plausibility, structural smells, qualifier consistency, attribute quality and
portability.

The action reports a count, impact and deterministic sample of affected IDs for
every failing check. Checks that cannot be evaluated after Promenade's
normalising import (for example XML/SQLite source-schema checks) are deliberately
not claimed. Attribute profiling can be disabled for a faster report.

The report is an independent `LogQualityReport` artifact, so it keeps its
provenance and can be compared across transformed versions of the same log.

## Repairs

A finding with a deterministic repair carries a button for it. Applying one
does not touch the analysed log: the operation is appended to a **derived log**
whose source is that log, through the host's `promenade.deriveLog()`
capability. Clicking several fixes builds one repaired log with several steps,
each of which can be switched off again in the transformation editor.

Order is decided by the host, not by click order, because the repairs interact:
canonicalising spellings before deduplicating is what makes the duplicates
visible, clearing sentinel values before removing always-empty attributes is
what makes them empty, and the timestamp assertion runs after every filter,
because "in order of appearance" is a statement about the events that survived.

Repairs are opt-in per finding. There is deliberately no "fix everything"
button: several findings have two defensible repairs (a duplicate identifier is
either a double import or two distinct records) and one of them — the timestamp
assertion — adds a claim rather than removing a defect.

### Tied timestamps

`TEMPORAL-TIED-TIMESTAMPS` reports events that share a timestamp with another
event in the same case, and how many cases therefore have an undetermined
event order. Its repair spreads each tied group across the interval to the next
*distinct* timestamp instead of stepping every tie by a fixed millisecond. The
fixed-step recipe is what most analysts do by hand, and it is unsafe: two
genuine events one millisecond apart are perfectly representable, and a group of
three ties stepped by a millisecond each walks straight over the second of them.
Dividing the gap that is actually there needs no assumption about the resolution
the source used. The engine-level test lives in
`app/test/transform/repair.test.ts`.
