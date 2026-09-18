# How each metric is computed

The scan delivers events in `(case, timestamp, position)` order, each carrying
a case, a lifecycle-classified activity, a resource and a timestamp. Events
with no resource or no timestamp are counted and dropped — every metric here is
a statement about a person at a time.

## Work items

The activity name arrives as `activity` + U+001F + `enqueue|start|complete`.
Within one `(case, base activity)` group, ordered by time:

- `enqueue` pushes onto a queue of waits;
- `start` takes the earliest pending enqueue as its waiting time;
- `complete` takes the earliest pending start and closes an item.

An item whose start and complete name different resources is discarded and
counted as `transferredItems`; starts never completed are counted as
`unfinishedItems`. A log where every event classifies as `complete` produces
no items at all, which is what `hasLifecycle: false` means.

## Durations

- **Service time** — `complete − start`, per item; mean and median.
- **Waiting time** — `start − enqueue`, where the log records it.
- **Busy time** — the *union* of a person's item intervals, from a boundary
  sweep. Overlapping work counted once.
- **Work time** — the *sum* of item durations. Larger than busy time exactly
  when someone multitasks, which is what makes the pair meaningful.
- **Utilisation** — busy time over the span from their first to their last
  event. Not over the whole log's span: someone who joined in November is not
  idle for the ten months before they arrived.
- **Multitasking** — the part of the union covered twice or more, over the
  union. Comes from the same sweep as busy time.

The sweep is checked against a brute-force coverage count on randomised
intervals, because it is the one piece of real geometry here.

## Workload against speed

For each item, its **workload** is how many of that person's other items were
already in progress at the moment it started. Then Pearson correlation between
workload and duration, per person and pooled over everyone.

This is one operationalisation of "how busy were they", chosen because it is
exactly computable from paired items. It is not the only one — items completed
in the preceding hour, or the queue length across the whole process, are others
— and it will differ from a paper that picked one of those. What it will not do
is depend on a window parameter nobody can justify.

The correlation is `null` when someone has fewer than three items, or when
either workload or duration never varies: a person who never had two things
open at once has no relationship to report, and reporting 0 would read as "no
effect" rather than "no evidence".

## Spread

Shannon entropy of the activity counts, divided by `ln(number of activities
they perform)`, so it lands in [0,1] regardless of how many activities that
is. 0 means they only ever do one thing. 1 means they spread evenly across
everything they touch. Someone doing one activity has an entropy of 0 by
definition, not by a special case.

## Batching

Within one person's own events in time order, a run is a maximal sequence of
the *same* activity where each consecutive pair is at most `batchWindowMins`
apart. `batchedShare` is the share of their events sitting in a run of two or
more; `meanBatchSize` averages the run lengths.

This is a statement about the window, not an absolute property, which is why
the window is a parameter and the description says so. A shorter window finds
fewer, tighter runs.

## Collaborators

Distinct other people who appear on a case this person also appears on. Note
this is co-appearance, not interaction: the Social Network plugin's
working-together metric is the weighted version of the same idea, and its
handover metric is the directional one.

## The timeline

Per-resource event counts over fixed-width calendar buckets, starting at the
bucket containing the log's first event. The requested width widens one step
at a time — hour, day, week, month — until the span fits 400 buckets, and the
effective width is reported. Every event lands in exactly one bucket; the
totals are asserted against the per-person event counts.
