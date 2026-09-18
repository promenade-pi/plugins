# Reading the station

Everything in the drawing means one thing, and only one thing.

## The two horizontal axes

**Left to right is process order.** A platform is to the right of every
platform it can only happen after. That ordering is the longest path through
the hand-offs, so the leftmost column is where lifecycles begin and the
rightmost is where they end.

**Front to back separates lanes.** It has no meaning of its own. It exists so
two branches of the process can run past each other without their routes being
drawn on top of one another — exactly what the lateral axis of a metro map is
for. Nothing should ever be read from how far back a platform is.

## The vertical axis is elapsed time

A platform's height is **how long into the process it happens** — the
accumulated elapsed time from the start of a lifecycle, in seconds.

It is a *longest* path, not an average one: a platform has one depth, and it is
the deepest of the paths that reach it. A case cannot arrive at "Receive
Payment" before the slowest thing it was waiting for arrives.

The axis on the left is graduated in real durations and banded into SECONDS /
MINUTES / HOURS / DAYS. By default the axis is **logarithmic**, because on a
real process a single two-day wait would otherwise press every minute-scale
step into one floor. `Logarithmic depth` in the toolbar switches it to
`Linear depth`, which reads literally: twice the wait, twice the drop. The
platforms do not move in plan either way — only their heights change — which is
what makes the two readings comparable.

## Waiting is a descent

Because height is elapsed time, a wait is a drop, and the drop is drawn as one
of three things depending on how far it falls:

| Drawn as | When | Reads as |
| --- | --- | --- |
| A slope in the track | a small fraction of the drawing's depth | one continuous run |
| A **staircase** | a middling drop | a step down between two levels |
| A translucent **lift shaft** | a large drop | the thing the diagram is pointing at |

The shafts are amber whatever route is inside them, because the glass means
*waiting* — which is what the depth axis measures — and a fifth colour that
meant something other than an object type would break the legend.

### The cars only go down

A shaft has a lift car in it, carrying one passenger per object type on that
hand-off, in that type's own colour. It falls at a constant speed, so a longer
wait is a visibly longer journey and not merely a longer shaft; it waits at the
bottom; and then it **beams back to the top with a flash**.

It is never drawn rising. Height here is elapsed time, so a car climbing its
shaft would be a case travelling backwards through the process — the one
reading this diagram must never allow. The flash exists to make the return read
as a cut rather than as motion. Turn the cars off with `Traffic`.

## Platforms

A platform is an activity. Its size means **how shared it is**: the more object
types interchange there, the larger it is, with the number of occurrences
modulating it. A platform is also grown to fit whatever is attached to it, so a
busy interchange is a big disc for that reason too.

A **pin** marks a platform where lifecycles begin or end.

## Routes

One coloured line per object type per hand-off, running on a shared grey
trackbed where several travel together. Width is frequency by default, on a
square-root scale — a route ten times as busy as its neighbour is not drawn ten
times as wide, or the neighbour disappears.

Clicking an object type in the legend follows that lifecycle alone and dims the
rest. Clicking a platform opens its Inspector; `Escape` clears both.

**Rework** — a hand-off that runs back against process order — rises rather
than descends, and is drawn on the same track system as everything else rather
than in a channel of its own. A case going back to an earlier step is going
back up the building.

## The two numbers on the diagram

Only the hand-off that **set** a platform's depth carries a duration chip, and
that chip is its own measured mean wait. Every other route arriving at the same
platform descends *further* than it waited, because the platform has one depth
and it is the deepest of the paths reaching it — so labelling those drops as
waits would put a number on the diagram that the log does not support. Select
the platform and the Inspector states both figures.

The wait is a **mean**. That is what an object-centric directly-follows graph
carries; it is not a median, and it is not a distribution.

## When to use something else

Press **Flat**. The depth axis collapses and the camera looks straight down,
leaving an ordinary 2D metro map of exactly the same routes. If a connection is
hard to trace in three dimensions, that is the answer — not squinting.

And if the diagram has more than a dozen or so platforms, reduce
`Platforms` and `Route coverage` on the action until it does. This is a
schematic for a highly abstracted process. At forty platforms the depth axis
stops being readable and the ordinary Metro Map plugin is the better drawing.
