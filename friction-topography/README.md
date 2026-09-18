# Process Friction Topography

A performance overlay for an event log that makes waiting time part of the
model's geometry rather than a colour on top of it.

The ground plan is an ordinary layered process layout — the same shape a 2D
directly-follows graph would get, from the same ELK layered algorithm — so the
map stays comparable with the model you already know. The third dimension
carries one thing and one thing only: a friction statistic, chosen from a menu,
interpolated from the activities into a continuous surface.

That gives four readings that a 2D annotated model cannot give at all:

- **A valley is the routine path.** Flow volume carves a channel along each
  routed hand-off, deeper the busier it is. The high-volume path through the
  process is literally the path of least resistance, and a case that leaves it
  is visibly climbing out of the riverbed.
- **A ridge is a queue.** Carving is scaled by `1 - friction`, which is what
  keeps a busy bottleneck a *ridge* instead of letting its own traffic flatten
  it. Without that rule the busiest step in the process — very often the
  slowest one too — would dig its own valley and disappear.
- **A plateau is a slow region.** Because elevation is interpolated *between*
  activities, a whole sub-chain that is uniformly slow reads as high ground,
  while an isolated slow step reads as a spike. Those look different at a
  glance. Two red nodes do not.
- **A route is one case's actual journey.** Selecting a case (or a variant)
  lights its path across the terrain, so where it lost its time is where it
  climbs. The same journey is shown beside it as a staircase — the *climb
  profile* — because a near-vertical riser in a small chart is unmistakable in
  a way a bright line over a mountain is not.

Clicking a peak is where the analysis actually happens. See
[Reading the map](docs/reading-the-map.md) for the panel, and
[How the terrain is built](docs/how-the-terrain-is-built.md) for the geometry
and the guarantees it comes with.

## What it works on

A `TraditionalEventLog` or an `ObjectCentricEventLog`. It is a pure view: no
discovery action runs, nothing is written to the catalogue, and the log never
leaves the database — every number on the map is an aggregate computed by
`promenade.sql()`.

On an OCEL the lifecycles whose gaps define waiting time are the **objects'**,
not a synthesised case notion, and the panel says "objects" wherever it would
otherwise say "cases".

## Waiting time, defined once

Every statistic on the map and in the panel is built from one definition, in
one place (`entityStream()` in `view-src/src/query.ts`):

> the waiting time before an event is the gap since the previous event of the
> same case (or object).

An occurrence that *starts* a case has no observed waiting time and is
**excluded**, not counted as zero. Imputing zero would drag every entry
activity's median toward the floor and make the front of the process look
artificially frictionless — exactly the kind of averaged-away lie the terrain
exists to expose.

## Elevation metrics

| Metric | What it answers |
| --- | --- |
| Median waiting time | How long a typical case waits here. The default. |
| 90th-percentile wait | How bad it gets for the unlucky tenth. |
| Mean waiting time | Comparable with tools that report averages. |
| Total waiting time | Where the process's *aggregate* delay actually sits — a rare step with a huge wait sinks, a frequent step with a moderate one rises. |
| Rework probability | Share of cases that reach this step more than once. |

Switching metric never re-queries the log and never moves a station: all five
come from one pass, and the layout depends only on the graph's shape. The
mountains rise and fall while the map stays put, which is what makes two
readings comparable.

## Rendering

three.js `WebGPURenderer`, via React Three Fiber. It targets WebGPU where the
browser offers it and initialises its own WebGL 2 backend where it does not, so
progressive enhancement comes from the renderer rather than from two code
paths. Which one you actually got is printed at the bottom of the panel's
toolbar, and can be pinned to WebGL 2 there — a driver that reports WebGPU
support and then renders incorrectly is a real category of machine.

Every material in the scene is a standard one, and that is a constraint rather
than a preference: a hand-written GLSL `ShaderMaterial` compiles on exactly one
of the two backends. So the colour ramp, contour lines and hillshade are
painted into a canvas texture in JavaScript, and every glowing thing is
additively blended vertex colour. Both behave identically on both backends.

The plugin frame is sandboxed under `default-src 'none'`, so nothing is
fetched: no font file (labels are projected DOM, which also keeps them upright
and readable at any camera angle), no stylesheet, no texture.

## Controls

Drag to orbit, right-drag to pan, scroll to zoom. `Esc` clears the selection.

The panel's own toolbar carries the settings you need while looking at the map
— elevation metric, relief exaggeration, camera, the layer toggles. Those are
still host-owned parameters written back through `promenade.setParams()`, so a
slider position is saved with the view; they therefore also appear in the
Inspector, alongside the ones only it can render (the activity picker, the
object-type picker, the time range).

## Status

Experimental. The terrain's geometry is settled and covered by executable
invariants (`view-src/src/field.check.ts`, 950+ assertions over fixed and
randomised plans, gating the build), but the parameter set and the drill-down
tabs are still moving. Two things are known limitations rather than bugs:

- Waiting time is measured between *consecutive events*, so on a log with
  `start`/`complete` lifecycle pairs it mixes queueing with service time. A
  lifecycle-aware split is the obvious next step.
- The map is one log at a time. Comparing two time windows means opening the
  view twice; a differential terrain (elevation = the change) would be a better
  answer.
