# Metro Station

The metro-map metaphor taken into the third dimension, the way a station atlas
draws Shinjuku.

* **Coloured routes** are object types.
* **Circular platforms** are activities. A larger platform is a shared one —
  several object types interchange there.
* **Horizontal position** is process order.
* **Vertical position is accumulated elapsed time.** This is the whole point.
* A **wait is therefore a descent**: a translucent lift shaft for a long one, a
  staircase for a short one, a slope for a hand-off that barely waits at all.
* A **lift car** runs in each shaft, carrying one passenger per object type on
  that hand-off. It only ever descends, and beams back to the top with a flash
  — a car climbing the shaft would be a case travelling backwards through the
  process.
* **Route width** is frequency; **selecting a route** lights one object type's
  lifecycle and dims the rest.

Depth is a genuinely new axis rather than a second encoding of something the
drawing already says. Putting object types on separate floors — the obvious
alternative — would duplicate what colour is already doing and make a route
harder to follow, not easier; using depth for *time* adds a dimension of
analysis instead of a dimension of decoration.

## The risk, and what is done about it

Tracing an exact connection is harder in three dimensions than in two. That is
not a problem to be argued away, so this is built as a **mode** rather than as
the only way to read the diagram:

* **Flat** collapses the depth axis and looks straight down. What is left is an
  ordinary 2D metro map of exactly the same routes — the honest answer to "I
  cannot follow that line."
* **Orbit** it freely; the camera angle is a starting point, not a constraint.
* **Logarithmic or linear depth**, switchable. Linear reads literally. On a
  real process one two-day wait would otherwise press every minute-scale step
  into a single floor, so logarithmic is the default — and the axis is
  graduated through whichever curve is in force, so its numbers stay correct.
* Switching the depth axis **never moves a platform in plan**. The mountains
  rise and fall while the map stays put, which is the only reason two readings
  are comparable at all.

Best on a **highly abstracted** process — a dozen platforms or so. A station
atlas of sixty platforms is not an atlas.

## What it needs

An **Object-Centric Event Log**. "Discover station map" mines an OC-DFG from it
internally (`core.discover.ocdfg`) and converts that to the station plan in a
Rust/WebAssembly kernel; the OC-DFG is what supplies both the per-object-type
frequencies and the per-hand-off mean waits the depth axis is built from.

A log without usable timestamps still draws: depth falls back to counting
hand-offs, and the axis says so rather than pretending its numbers are seconds.

## Reading it honestly

Two things in this diagram are easy to over-read, and both are documented
rather than hidden.

**A platform has one depth, and it is the deepest of the paths that reach it.**
So a route can be drawn descending further than that hand-off actually waited —
it is arriving at a platform whose depth some *other*, slower path set. Only
the hand-off that set the depth is labelled with a duration, and that label is
its own measured mean wait. The Inspector spells out the difference for
whichever platform is selected.

**The wait is a mean**, because a mean is what an OC-DFG carries. It is not a
median and it is not a distribution.

## Documents

* [Reading the station](docs/reading-the-station.md) — the visual grammar in
  full, and what each piece of furniture means.
* [How the plan is built](docs/how-the-plan-is-built.md) — ranks, depth, lane
  order, and the router whose track allocation makes route overlap impossible
  by construction.

## Development

```
cargo test -p station-map-core     # the plan's invariants, fixed and randomised
cd view-src && npm run check       # the view's own: everything about depth
cd view-src && npm run harness     # then open /__ms-harness/ on the dev server
./package.sh                       # gated on both of the above
```
