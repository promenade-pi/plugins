# How the plan is built

The plugin is in two halves that never touch each other's business. A Rust
kernel builds a **plan** — where every platform sits and where every route
runs, in plan coordinates, with a duration attached to each platform. The view
turns durations into heights and draws it. Nothing in the plan knows how many
world units a second is worth, which is why switching the depth axis between
linear and logarithmic cannot move anything sideways.

## Stage 1 — the graph (`lib.rs`)

An OC-DFG in, per object type: how often each activity occurs, how often each
hand-off happens, and its mean wait in seconds.

Activities are cut to the most frequent `Platforms`. Hand-offs are then cut by
**coverage**: strongest first until they account for the requested share of
everything that actually happened, rather than at an arbitrary count. Whatever
the cut, every surviving platform keeps its strongest arriving and departing
hand-off, so abstraction can never leave a platform unreachable.

## Stage 2 — order and depth (`rank.rs`)

**Feedback arcs** first, by the greedy-sequence heuristic (Eades, Lin & Smyth):
it produces a linear order, and every arc running backwards in that order is a
feedback arc. Acyclicity is therefore structural — the heuristic only decides
how few arcs pay for it — and those arcs become the drawing's rework.

**Rank** is the longest path in hand-offs on what is left. **Depth** is the
longest path in *seconds*.

A measured wait of zero still descends, by a hairline, so that the strict
ordering every later stage relies on is a fact rather than a hope. The hairline
is deliberately far too small to see — a hundred-thousandth of the map's own
depth spread over its longest chain. Making a descent *visible* is the view's
job, and doing it here instead would write a number into the payload the log
does not support. An earlier draft used two percent for this, which on the
worked example reported a fifty-five-second hand-off as nine minutes.

## Stage 3 — lanes (`order.rs`)

Before anything is ordered, a hand-off that spans more than one rank is split
by **dummy nodes**, one per rank it crosses. This matters more than it sounds:
because the dummies take part in the lane ordering, a long route is given lanes
of its own to travel through, and a horizontal run can never be drawn over a
platform that is not one of its endpoints. That is structural, not checked.

Then the standard layered-drawing pair. Barycentre sweeps decide the *order*
within each rank, which is what removes crossings. An **isotonic projection**
decides the coordinates, which is what makes a route that could be straight
actually be straight: subtracting the index turns "strictly increasing with a
gap of at least one lane" into plain "non-decreasing", pool-adjacent-violators
solves that exactly, and adding the index back restores the gap. No pass can
swap two platforms in a rank behind the crossing-minimisation's back.

The fit is weighted, and dummies weigh more than platforms — a bend in a dummy
chain is a bend in a route, while a real platform's own lane is arbitrary.

## Stage 4 — the router (`router.rs`)

Route overlap is a **global** property of a drawing, so nothing here repairs it
locally. Six independent "nudge on collision" heuristics is what the metro-map
plugin's router looked like before it was rewritten, and each one fixed a
symptom by perturbing the others' inputs.

Instead there is one shared occupancy model per corridor, and two things that
share a corridor and overlap along it are given different tracks by
construction — interval-graph colouring with variable band widths.

* A **column** corridor carries the lateral moves at one rank boundary. Its
  claims are in *lane index* space rather than plan units, which is what breaks
  the circular dependency between the column pitch and the row pitch.
* A **row** corridor carries the horizontal runs in one lane, and it spans the
  whole diagram. Defining it that way, rather than as two half-columns meeting
  at a rank boundary, is the difference between "no two routes share a line"
  being true and being nearly true — a route turns at its own allocated column
  offset, so the point where one route's run ends is *not* where another's
  begins, and two half-corridors assumed to meet cleanly in fact overlap by
  that difference. The first version of this router had exactly that bug, and
  the invariant check found it immediately.
* Every segment claims a band even when its two ends sit at the same height, so
  two routes stepping sideways by a hair at the same column cannot land on the
  same line.

A platform's **fan** — everything attached to it on one side — is allocated
inside the platform's own disc, and the disc is then grown to whatever the fan
needs. A busy interchange is a bigger platform, which is the grammar anyway.

Lanes are then spaced by what they actually hold, so one crowded corridor does
not push every other lane apart with it.

What is left over — routes *crossing* each other — is not a defect. A metro map
crosses lines constantly; what it never does is run two lines along the same
piece of track.

## Stage 5 — depth, in the view (`view-src/src/depth.ts`)

Seconds to world height, and the only place that decides it.

A raw curve maps a duration to a height, linear or logarithmic. Then a
**monotone refinement** walks the hand-offs in topological order and pushes a
platform down until it is at least one gap below every platform that hands off
to it: without it, two steps a few seconds apart render at the same height
under a logarithmic curve at the deep end, and a route between them is drawn
dead level with no readable direction of travel.

The gap is a fraction of the drawing's depth, capped again by the longest chain
of hand-offs, because the two requirements pull against each other — a descent
has to be visible, and every descent in the longest chain has to fit in one
drawing. Everything is then rescaled so the drawing is exactly as deep as the
relief slider asked for, however far the refinement had to push.

Finally the axis is graduated through the **refined** mapping, by interpolating
between the platforms' own duration-and-height pairs. A tick reading "2 d" sits
where two days actually is in this particular drawing, refinement included,
rather than where it would have been in a drawing nobody is looking at.

## What is asserted, and where

Geometry is not verified by looking at it. A rendered picture can hide two
routes sharing a line for part of their length, and ten rounds of "fixed" line
overlaps can all pass a visual check and all still be wrong.

`cargo test -p station-map-core` runs `check::violations` over the worked
example and 250 randomised graphs — several object types over the same
activities, cycles, self-loops, hand-offs that skip ranks, and a third of them
with no timing at all — at three abstraction settings each. It asserts:

* no two routes lie on the same line and overlap;
* no segment is accidentally diagonal (which would also *disable* the rule
  above, since it can only compare axis-aligned segments — a drawing full of
  near-diagonals would pass by never being tested);
* no platform overlaps another;
* no route is drawn across a platform it does not touch;
* no shaft stands on a platform;
* every forward hand-off descends;
* and no route is drawn a longer way round than its own endpoints justify,
  measured against the diagram's own size. That last one is the check on the
  *displacement*: satisfying "no overlap" by sending a route the long way round
  the diagram is not success, and the overlap rule alone would report it as
  one.

`npm run check` in `view-src` covers what the Rust cannot see: that every
hand-off descends by a visible amount at every scale and relief setting, that
the refinement stays inside its budget, that the drawing is exactly as deep as
asked, that the axis is monotone and inside the drawing, that chamfering never
wanders from the path it is cutting, and that a vertical descent really is
vertical.

`package.sh` runs both and stops on either.
