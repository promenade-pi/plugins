# How the terrain is built

Elevation is the only thing this view adds to a process model, so it is worth
being precise about where it comes from. The pipeline is five stages with five
different costs, deliberately separated (`view-src/src/plugin.tsx`):

```
SQL      -> TopographyData    seconds on a large log; only the filters and
                              the time window invalidate it
filter   -> FilteredModel     microseconds
ELK      -> Plan              tens of ms; only the graph's *shape* does
field    -> HeightField       tens of ms; the friction metric does
geometry -> meshes            per frame; the vertical scale does
```

The useful consequence is that switching the friction metric — the thing an
analyst does most — touches neither the database nor the layout.

## 1. The ground plan

ELK's layered algorithm, direction `RIGHT`, run synchronously in the plugin
frame. The frame's CSP has no `worker-src` and falls back to `default-src
'none'`, so `new Worker(...)` throws however it is constructed, blob URL
included; `elk-worker.min.js` detects that it is not inside a real Worker and
exports a `Worker`-shaped class that dispatches through `setTimeout`, which
`elk-api.js` accepts as its `workerFactory`.

Not a free 3D graph layout, on purpose. Letting a force-directed solver spend
the z axis on aesthetics would leave nothing to read the friction off, and two
analysts looking at the same log would get two different maps.

A long, thin process — which is what layered layout of a mostly sequential
process always produces — is rotated to run across the plate's diagonal. The
square's diagonal is 41% longer than its side, so this buys real room; and it
is a rigid rotation, not a stretch, so no distance on the map changes and
nothing about the terrain's meaning does either.

**Rework direction comes from the log, not from the layout.** ELK breaks a
cycle by reversing whichever arc its greedy heuristic reaches first, which on an
order-to-delivery process routinely nominates the busiest forward hand-off as
the back edge — and then the map labels the main line "rework". Instead, each
activity's *median position within a case* is queried alongside everything
else, and a flow counts as rework when it lands somewhere the process has
usually already been.

## 2. The friction field

Two parts, both in `view-src/src/field.ts`.

**Regional.** A Shepard interpolation of the activities' friction: a convex
combination, so it can never exceed the slowest activity in the log. That
property is worth more than it sounds — it means the terrain cannot grow a
mountain where no activity is slow, and every summit on the map corresponds to
something in the data.

**Local.** Shepard alone lets a slow step that happens to sit among fast ones be
dragged down below a fast step surrounded by slow ones, which inverts the one
comparison the view exists to support. This is not hypothetical: the randomised
cases in `field.check.ts` found it on the first run. One compact correction bump
per station, of exactly the amount the regional field is off by, fixes it
without inventing any maximum away from a station.

Stations closer together than a fraction of the correction radius are merged
first, keeping the higher friction. Two stations at the same spot genuinely
share one piece of ground, and asking one bump to be at two heights at once is
unsatisfiable — the correction passes oscillate and end up digging a pit exactly
where the slower of the two should be. The layout never places stations that
close; this is a guard, and keeping the *higher* friction is the safe direction,
because the alternative hides a bottleneck.

## 3. Valleys

For every sample of every routed flow, a Gaussian brush is splatted into a
buffer and the maximum kept — an approximation of distance-to-polyline that
costs O(radius²) per sample instead of O(cells) per edge.

Carve depth is `CARVE × volume × (1 − friction)`. The last factor is the rule
that keeps a bottleneck visible, and it is the one a plausible-looking parameter
tweak breaks; breaking it silently turns the view into a volume map with a
colour ramp. `checkBottleneckSurvivesItsOwnTraffic` in the invariant suite exists
for exactly that.

## 4. The elevation curve

`linear` reads literally. `compressed` raises the altitude ratio to the power
0.55–0.65, the vertical exaggeration every relief map of a real landscape
applies, and it is the default because on a real log the literal reading is
frequently unusable: one rare exception path with a three-day wait sets the
scale and presses the entire routine process into a flat black plain.

The transform is strictly increasing, so no peak overtakes another and the
ordering invariants hold for both curves. The elevation axis is graduated
*through the same curve*, so the numbers beside the pole stay correct — their
spacing simply is not even, exactly as on a log-scaled axis. Contour lines are
drawn at those same values, which is why they are passed as explicit levels
rather than as one interval: even value steps land at uneven height steps, and
a contour at a meaningless number is worse than no contour at all.

One height mapping, `altitudeOf()`, is shared by the pole, the contours and the
mesh. It uses the *nominal* summit rather than the observed maximum, because
everything that has to agree with the surface — a graduated tick, a draped
ribbon — computes its altitude from a friction value without having a grid to
look at.

## 5. Surface and geometry

The mesh is built by hand rather than by displacing a `PlaneGeometry`, so that
y is height and nothing downstream has to remember a rotated frame. Its
vertices land exactly on the field's cells.

Colour ramp, contour lines, hillshade and the cool cast in the riverbeds are
painted per-texel into a canvas. `flipY` is turned off on both textures: it
defaults to true, which is right for an image whose first row is meant to be the
top of the surface, but this canvas's first row is grid row zero — where the
mesh's own `uv.y = 0` is. Left flipped, every contour line and every glow lands
on the mirror image of the peak it belongs to, and the result looks like
plausible terrain while being wrong. (It shipped that way for one afternoon.)

## The invariants

`view-src/src/field.check.ts`, run by `npm run check`, which `package.sh` gates
the build on. Roughly 950 assertions over hand-picked fixtures and 50
randomised plans — half with arbitrary station placement, half with the minimum
separation a layered layout actually guarantees. What they hold the terrain to:

| Invariant | Why it matters |
| --- | --- |
| Every height finite, non-negative, bounded; the rim window closes to zero | A surface cut off mid-slope at the plate edge claims the process continues past the edge of the picture. |
| The summit is one of the log's slowest steps | The headline reading. |
| No decisively slower step is drawn below a faster one | The comparison the whole view exists for. |
| The global maximum belongs to a station | A peak with nothing under it is a false finding, and an extremely convincing-looking one. |
| Raising one activity raises its own ground, leaves other stations anchored, dips nothing more than cosmetically | Without this, "compare the map before and after the change" quietly stops working, because every reading depends on every other. |
| A busy route sits below its own banks, and more volume cuts deeper | The valley claim. |
| A busy bottleneck stays a clear peak at every volume | The `1 − friction` rule. |
| Bit-identical output for identical input | A screenshot in a report can be reproduced. |
| Activity elevations agree across detail levels | Detail is resolution, not shape. |
| `PLAN_FIT` stays inside the rim window's flat radius | Two constants in two files that must not drift; the randomised ordering check caught them apart once already. |
| Graduations are round numbers, ascending, and few enough to read | An axis is only useful if its labels are. |
| The elevation curve is strictly increasing and invertible | A display setting must not change which step is slowest. |
| `filterModel` never strands an activity it kept | A summit nothing flows to is a map that lies. |

## Verifying it by hand

The view runs in an opaque-origin sandboxed iframe, where a driver's synthetic
pointer events never arrive and the DOM cannot be inspected — an in-app
screenshot proves the panel *renders* and nothing more. `view-src/harness/`
loads the same bundle in an ordinary same-origin page backed by a **real**
DuckDB-Wasm holding a synthetic log in the host's own physical table layout, so
every statement in `query.ts` is genuinely executed:

```
npm run harness                      # stage it into the app's dev server
node harness/drive.js --out /tmp/s   # drive it in headless Chrome, screenshot
npm run harness:rm                   # remove it
```

`drive.js` exists because a hidden or backgrounded tab performs no rendering
lifecycle at all: no `requestAnimationFrame`, and — decisively — no
`ResizeObserver` deliveries, which is what React Three Fiber gates renderer
creation on. In an unattended browser pane the canvas is therefore never even
sized, and the view looks broken when nothing is wrong with it. Headless
Chrome's page is visible as far as the platform is concerned.

The synthetic log is built with a known shape — one severe queue, a rework
loop, batched dispatch at 11:00 and 17:00, and one picker 3.4× slower than the
others — so the panel's claims can be checked against ground truth rather than
merely read. Both bugs the harness found on its first run were of the silent
kind: `sum()` over `BIGINT` widens to `HUGEINT`, which has no columnar form the
host's Arrow bridge can carry, so every total read zero; and the mirrored
texture above.
