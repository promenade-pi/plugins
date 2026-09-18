# Changelog

## 0.2.3

Documentation only. The host no longer quantises timestamps to milliseconds at
import — it preserves the source's microseconds — so the notes that explained
the tied-timestamp repair in terms of a millisecond grid were describing a
constraint that is gone. The repair itself is unchanged: it divides the gap it
actually measures, which never depended on the source's resolution.

One consequence worth knowing: a log whose source had sub-millisecond
timestamps used to arrive with ties that were not in the file, and this plugin
reported them. Those reports were real observations of Promenade's own
rounding, not of the data.

## 0.2.2

The skipped-checks section now shows each skipped check's reason, not just its
name. A check that was not evaluated and a check that passed are different
statements, and the note is the only thing that distinguishes them.

## 0.2.1

**A new check: `TEMPORAL-ASSERTED-ORDER`**, and `TEMPORAL-PRECISION-LOSS` is now
skipped rather than passed on a log whose order was asserted.

Found while verifying 0.2.0 against Sepsis Cases: applying the tied-timestamp
repair made `TEMPORAL-PRECISION-LOSS` pass. It should not have. The repair
spreads tied events by small offsets, and those offsets are exactly what the
precision check looks for the absence of — so a log whose precision was just as
lost as before came back clean, and the repair appeared to have restored
something it cannot restore.

The precision of the source is not recoverable from a repaired log (the group
each event belonged to is gone once its timestamp moved), so the check now
reports `skipped` with the reason and points at the source log. Alongside it,
`TEMPORAL-ASSERTED-ORDER` reports, for as long as the operation is in the plan,
that this log's event order is asserted rather than recorded.

This needed a fact no plugin could previously see, so the host gained one:
`ctx.meta` reports what the catalog records *about* each input — its metadata,
its storage kind, and for a derived log the active operations of its
transformation plan. It is not inferable from the data: a repair with room to
step by a whole millisecond produces timestamps indistinguishable from genuine
millisecond data.

The tied-timestamp repair is no longer offered on a log that already carries
one.

## 0.2.0

**A new check: `TEMPORAL-TIED-TIMESTAMPS`.** Events that share a timestamp with
another event in the same case, reported together with the number of cases
whose event order is therefore undetermined. No existing check covered this:
`TEMPORAL-PRECISION-LOSS` reports the cause (a rounded timestamp column) without
saying how much order was lost, and `TEMPORAL-BATCH-ARTEFACT` only fires when a
single timestamp value dominates at least a fifth of the log — neither notices
the ordinary case of many small ties spread across cases.

**Fixed: `TEMPORAL-UNSORTED-EVENTS` compared across case boundaries.** The
chronological-order check diffed timestamps over the whole event table after
sorting by trace, so the first event of every case was compared against the
last event of the previous one. Any log whose cases overlap in time — nearly
all of them — reported violations that were not violations. The comparison is
now scoped within a case; OCEL, which has no case notion, keeps its global
comparison.

**One-click repairs.** Findings that have a deterministic repair now carry one,
applied through the host's new `promenade.deriveLog()` capability: the repair
is appended to a derived log whose source is the analysed log, at its correct
position in the pipeline, and the source is never modified. Repairs are opt-in
per finding and individually revocable; there is no bulk action. Covered:
duplicate, dangling and self-referencing relations; empty cases; orphan
objects; events without objects; sentinel values; attribute and qualifier
spelling variants; always-empty attributes; potential PII; unsafe type names;
implausible timestamps; singleton object types; one-off activities; and tied
timestamps.

`ATTR-NUMERIC-AS-STRING` deliberately has no repair: the relational layer
stores every attribute value as text, so there is no column type to cast to.
`SPEC-DUP-EVENT-ID` and `SPEC-DUP-OBJECT-ID` have none either — collapsing a
double import and suffixing two genuinely distinct records are opposite
repairs, and the report cannot tell which one applies.

The repair for tied timestamps asserts an order rather than recovering one, and
says so at every point it appears.

## 0.1.1

Changelog starts here; version 0.1.0 was not individually tracked.

Data-quality analysis for XES and OCEL logs: specification, integrity,
temporal, structural, qualifier, attribute and portability findings,
following the check catalogue of Ocelot's Quality linter.
