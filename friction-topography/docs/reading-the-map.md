# Reading the map

## The surface

| What you see | What it means |
| --- | --- |
| Dark, near-flat plain | Nothing much happens here, or nothing slow does. |
| Blue lowland, glowing channel | The routine path. Channel depth is flow volume. |
| Warm slope, then orange, then pale summit | Rising friction under the chosen elevation metric. The blue-to-warm crossover is deliberate: the eye reads a hue change as a category boundary, and there is one — below it a step is not a bottleneck, above it, it is. |
| Concentric contour rings | Isolines of the elevation metric, at the same values as the graduations on the axis pole. Dense rings mean a steep climb; widely spaced ones mean a gentle one. |
| A crinkled, gullied summit | Cosmetic, but not arbitrary: crinkle is proportional to altitude, so texture means height means friction. |
| Cyan / teal / amber ribbon | A directly-follows flow, coloured by how its duration ranks among the flows on the map. Width is volume. Marks travel along it, slower where the hand-off is slower. |
| Red hairpin trail flying over the terrain | Rework: a flow that returns to a step the process has usually already passed. It goes over the top rather than through, because that is what happened. |
| Red ring beside a station | Immediate self-repetition (A → A), which has no route to draw. |
| Warm illuminated trail with arrowheads | The selected case's or variant's actual journey. |
| Graduated pole at the plate's left corner | The elevation axis, in the metric's own units. It is a 3D object rather than a fixed scale bar down the side of the panel, because the moment the camera turns a flat scale bar stops corresponding to anything. |

Ring size at a station is how much traffic passes through it; ring colour is its
friction. So a large cool ring is a busy step that nobody waits at, and a small
hot ring is a rare step that is slow when it happens — a distinction worth
having before you act on either.

## The panel

Clicking a peak — on the terrain or on its label — opens it. This is where the
analysis is; the terrain's job is only to tell you *where* to click.

### Why

Generated sentences, each from a computed quantity that is also shown
elsewhere in the panel, each hedged where the statistic supports correlation
but not cause:

- **Share of all waiting.** Whether fixing this step would move the process at
  all. A 40-hour wait on 12 cases is a smaller problem than a 3-hour wait on
  4,000.
- **Concurrency.** How many cases were waiting here *at the same time*, with a
  chart of it over the log's calendar. This is the single most useful number
  in the panel and the one hardest to guess from a model: a high flat line
  means the step is permanently backed up and the fix is capacity; spikes mean
  arrivals are bursty and the fix is scheduling. Both look identical in the
  median.
- **Tail ratio.** p90 against the median. A 10× ratio means the median is not
  describing anybody's experience.
- **Rework.** Share of cases that come back.
- **Hand-off concentration.** Whether most of the wait arrives from one
  predecessor, and whether which predecessor a case came from changes its wait.
- **Arrival clustering.** Whether occurrences pile into particular hours, which
  is consistent with batching.
- **Resource spread.** Whether median wait differs sharply between resources —
  a workload or capability split rather than a routing one.

When none of these thresholds is met, it says so, rather than inventing a
narrative. A tool that reports a root cause it cannot see is worse than one
that says nothing: you stop checking it.

### Waits

The distribution of the wait before this step, on a log scale, with median and
p90 marked. The shape is the finding, and it is the thing a surface
fundamentally cannot show — a surface has one value per point and a
distribution does not:

- one hump → a queue,
- two humps → **batching**, some cases picked up at once and the rest waiting
  for the next run (the panel says so when it detects this),
- a long flat tail → a minority of cases being forgotten about.

### Splits

Median wait and share-of-wait, grouped by: which step the case arrived from,
the resource, hour of day, weekday, position in the case — and by the value of
any case or object attribute the log carries with between 2 and 40 distinct
values.

Two bars per row on purpose. The median says how bad it is for one case in
that group; the share says whether the group is big enough to matter.

### Variants

The paths that pass through this step, with case counts, median cycle time and
the median wait *at this step within that variant*. Selecting one lights its
route across the terrain, so its climb over this peak can be compared with the
routine valley beside it.

### Cases

The individual cases that waited longest here, worst first. Selecting one draws
its route on the terrain and its climb profile above the list, with the
steepest riser marked — the answer to "where did this case lose its time".

## Linked selection

Clicking a station publishes an `activity` selection on the host's selection
bus, so a Dotted Chart, a Performance Spectrum or a Petri net in the panel next
door highlights the same step. It listens on the same bus, so naming an
activity anywhere else moves this map's focus to that peak.
