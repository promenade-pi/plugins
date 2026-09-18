# Dotted Chart

Plots every event as a point in time, laid out one row per case (the
classic dotted chart), activity, resource or object type. Density in a row
is a first read on how busy that part of the process was, and where it
shifted over the log's time range; empty vertical bands read as downtime —
weekends, holidays, a queue nobody touched.

## Why this plugin exists

Every other example package in this repository demonstrates a producer —
discovery, conversion, conformance. This one demonstrates the other half of
the plugin surface: a *view* with no algorithm behind it, running entirely in
the host's sandboxed frame. It ships installed by default so that boundary is
something you can see working from the first import, not something you have
to go looking for in the registry.

## Parameters

| Parameter | Effect |
|---|---|
| Rows | What a horizontal line represents: **case** (one row per trace — the standard dotted chart), **activity**, **resource**, or **object type**. On an OCEL log, choosing an **Object case notion** makes every object of that type a row. |
| Object case notion (OCEL) | The object type to flatten within this view. Every linked event is plotted on its object's row; the most frequent type is selected for a new view. |
| Colour by | A separate dimension from rows: **activity**, **resource**, **lifecycle**, or **object type**. Colouring by something other than what defines the rows is often the more interesting read — e.g. rows by case, coloured by activity, shows *when in each case's life* each activity fell. |
| Time axis | **Actual** calendar time. **Relative**: time since each row's own first event, so every row starts at zero — this is what makes case *durations* comparable at a glance instead of buried in calendar dates. **Logical**: plain event order within the row, ignoring real gaps — useful when you want pure sequence, not timing. |
| Sort rows by | First event, last event, duration, or name — plus a descending toggle. Sorting by duration surfaces the longest-running cases at a glance; the classic dotted-chart "which cases dragged on" question. |
| Max points | Caps how many events are sampled from the log, in SQL, to keep the canvas responsive. |
| Time range | A host-side dual-handle slider uses the log's real first/last timestamps. The range is applied in SQL before sampling, so a narrow period retains the available point budget. |
| Dot size | Sets the point diameter from 1 to 10 screen pixels. |
| Activity legend | The chart header lists the most frequent colour values; click one or several entries to highlight their dots and fade the rest. |
| Show row IDs | Reserves a left label column for case or object rows. Dense logs show an evenly spaced, legible subset, including the first and last sorted row; vertical ellipses mark omitted rows. |
| Hover event details | Off by default. When enabled, hovering near a point shows its case, activity, timestamp and event ID. |

Rows and colour that don't apply to the current log type fall back
automatically — asking for resource-based rows on an object-centric log,
say, falls back to object type.

## Isolation

Runs behind an opaque origin: no host DOM, no storage, no credentialed
network, no panel handle. The only door to data is `promenade.sql()` — the
query does the grouping, the per-row first/last timestamps, and the
in-row event order, all in one pass, because shipping a million rows
across the boundary to throw most of them away would be the wrong division
of labour. `rowsBy`, `colorBy`, `sampleLimit` and the time range requery —
each names a SQL column, not just a display choice; the time axis and row
order are picked from data already in hand, so changing those is a plain
redraw. Colours for activity and object type come from the host's
shared registry, so they match every other panel; resource and lifecycle
get a small local palette instead, since the host has no shared domain for
either.

Written in plain JS against a `<canvas>` on purpose: the plugin boundary
must not presume React, and a bundle that ships its own framework must not
be the price of entry.
