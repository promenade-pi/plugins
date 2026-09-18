# Resource Behavior

The organisational plugins beside this one answer questions about *relations* —
who hands work to whom, who belongs with whom. This one answers questions about
one person at a time: how much they do, how fast, how specialised, whether they
batch their work or juggle several things at once, and whether they slow down
when they are busy.

## What needs a lifecycle and what does not

Half of these metrics are about durations, and a log with one timestamp per
event has none: a `complete` event says when work finished, not how long it
took. The scan uses the host's `activityLifecycle` classifier, pairs `start`
with `complete`, and measures real work items.

On a log without lifecycle values nothing pairs, and the duration metrics are
**absent rather than approximated** — the duration columns are not drawn at
all, and the header says why. The tempting alternative, treating the gap since
the previous event in the case as service time, conflates queueing with
working: it would report someone as slow because a case sat in a tray over the
weekend. The counting metrics need no lifecycle and are always computed, so
the plugin is still useful on such a log; it just says which half is missing.

## The metrics

Always available:

| | |
|---|---|
| Events, cases, per day | volume, and a rate that ignores the days they were not working |
| Spread | normalised entropy of their activity mix: 0% a specialist, 100% a generalist |
| Mostly | the activity they do most, and its share |
| With | distinct other people met on a shared case |
| Batched | share of their events in a run of the same activity done back to back |

With a lifecycle:

| | |
|---|---|
| Service, Waited | mean time working an item, and mean time it sat queued before they started |
| Utilised | busy time over the span between their first and last event, overlaps counted once |
| Juggling | share of busy time with more than one item in progress |
| Load ⇢ time | correlation between how many items they had open when one started and how long it took |

That last one is the Nakatumba & van der Aalst effect: people work more slowly
when they have more in progress. It is reported per person and pooled, and the
scatter beside the table shows the shape — a correlation alone cannot
distinguish a trend from two clusters.

## Attribution, and what is not counted

A work item whose `start` and `complete` name *different* people is attributed
to **neither**. The interval belongs to whoever was working and the log does
not say when it changed hands; splitting it would be invention and giving it
to the finisher would be a guess. These are counted as `transferredItems` and
shown, as are items started and never finished, and events with no timestamp.

Items are paired first-in-first-out within one case and activity, so a loop
that runs the same activity twice produces two items and the earlier start
belongs with the earlier completion.

## The views

**Resource profiles** — the table, one row per person, with a proportional bar
behind each cell so one column is scannable. The bars are for reading down a
column, not across: these are unlike quantities and comparing a utilisation to
a batching share means nothing. Underneath, the workload-versus-speed scatter,
on a logarithmic duration axis because service times on a real log span four
orders of magnitude and a linear axis puts all but the slowest handful on the
floor.

**Workload timeline** — one row per person, one column per bucket, shaded by
volume. This answers what a table cannot: when somebody joined, when they
stopped, whether a team's load moved between people over the year, whether a
quiet person is quiet throughout or simply absent for half of it. Square-root
shading by default, because one automated resource performing a third of the
log is normal and on a linear scale it flattens everyone else to white.

The timeline bucket widens automatically when the log spans more columns than
are worth drawing; the effective width is reported rather than assumed.

## What this is not

It says nothing about whether any of this is good. A high utilisation may be
efficiency or overload; heavy batching may be sensible grouping or a queue
nobody is clearing. These are measurements, and the interpretation needs
somebody who knows the process.
