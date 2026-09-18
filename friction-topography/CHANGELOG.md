# Changelog

## 0.1.11 — 2026-09-18

- Corrected the `homepage` and `repository` URLs. The plugins live in one
  repository, [`promenade-pi/plugins`](https://github.com/promenade-pi/plugins),
  not one repository per plugin under a `promenade-lab` organisation that was
  never created. Metadata only — no functional change.

## 0.1.10

- **Switching palette no longer stalls the view.** `paintSurface` and
  `paintEmissive` fill two 1024x1024 canvases (2048 on `high`) a pixel at a
  time in JS, and they were keyed on the palette — so light -> dark -> light
  paid for two full repaints and threw the first away, which is exactly the
  round trip anyone makes when comparing the two schemes. Measured at
  175-490ms per switch on a 700-case log, and it scales with the texture
  rather than the data, so `high` detail costs four times that.
- The rasters are now cached per palette, invalidated when the height field,
  the contour levels or the detail actually change. Returning to a palette
  you have already used costs nothing: measured 35ms, the idle frame gap.
  The first visit to each still pays for its paint.

## 0.1.9

- **Flow marks no longer go missing in the light scheme.** A mark rides 4mm
  above its ribbon and neither writes depth. Additive blending is
  order-independent, so in the dark scheme a mark always shows; the light
  scheme's normal blending is not, and three sorts transparent objects by
  distance — effectively arbitrary for near-coplanar geometry — so some marks
  were painted over by their own ribbon and some were not. They now carry an
  explicit `renderOrder` and always draw last.
- **A lost GPU device no longer leaves a frozen canvas.** `WebGPURenderer`
  is bound to its canvas for life, and nothing threw or unmounted when its
  device went away: React kept running, so the HTML labels went on tracking
  the camera over a picture that would never update again — "only the labels
  move". The device's `lost` promise now switches the view to WebGL 2, which
  rebuilds the renderer, and the backend line says it recovered.

## 0.1.8

- **The light scheme's flow ribbons are translucent again.** The dark scheme
  blends its ribbons *additively*, which is what makes them glow through one
  another and fade out across their width for free — black outer rails add
  nothing. None of that survives on a white ground, so the light scheme fell
  back to a near-opaque normal blend (0.92) with no falloff, no glow, and
  ribbons 15% wider to compensate. The result read as strips of tape laid
  over the terrain, hiding it.
- The light analogue of "adds light" is "lays down translucent ink": the
  core drops to 0.7 so crossings build up and the terrain stays visible, the
  glow comes back as the colour washed most of the way to *white* rather than
  to black, and both schemes now draw the same ribbon width. The self-loop
  rings and the variant path were carrying the same "light is heavier" bias
  and were softened with them.

## 0.1.7

- **The palette follows Promenade's appearance setting.** `palette` gains an
  `auto` value and defaults to it, resolving from the host's own `--bg`
  token (perceptual luminance, re-evaluated when the user switches
  System/Light/Dark). A light app no longer opens a black panel in the
  middle of itself. The light scheme itself is not new — `relief` has always
  been there — it was simply unreachable unless you went looking for the
  Palette control, and `topographic` was hardcoded as the default.
- Picking `topographic` or `relief` explicitly still pins it, which is what
  you want for a printed figure.

## 0.1.6 — 2026-09-04

- Fixed the "Labels" toggle in the Elevation panel: it changed `showLabels`
  in the view's params like every other toggle there, but nothing ever read
  that value — the station name pills were built unconditionally, so
  checking or unchecking the box had no visible effect. It now actually
  gates the per-activity name labels (station and summit alike); the queue
  and rework callouts and the elevation axis are a separate concern and
  stay visible either way, matching the control's own title, "Station
  labels".

## 0.1.5 — 2026-09-04

- Found the actual cause of the labels (and the elevation axis) jumping on
  hover, confirmed by direct instrumentation rather than guesswork: the
  `Controls` component's effect that constructs `OrbitControls` depended on
  `onInteract`, a callback passed down as an inline arrow function
  (`onInteract={() => setHovered(null)}` in `plugin.tsx`) that gets a new
  identity on every render — including the renders hovering itself triggers.
  Every hover was therefore disposing and reconstructing the entire
  `OrbitControls` instance, discarding its internal damping state each time.
  Neither of 0.1.2's placement fix nor 0.1.3's camera-quantisation fix was
  wrong, but neither touched this: both addressed real, separate sources of
  drift, while this one fired on every single hover regardless. `onInteract`
  is now read through a ref that updates every render but is never an effect
  dependency, so the controls are constructed once and never rebuilt just
  because the mouse crossed a label. Verified via `view-src/harness/
  debug-crowd.html`, a purpose-built dense 16-activity synthetic log added
  this session specifically because the plugin's small default fixture never
  had enough label crowding to expose this: 24 labels sampled before and
  after six hover cycles land within 2px of where they started, versus a
  uniform ~40px shift on every hover before this fix.

## 0.1.4 — 2026-09-04

- Fixed a missing `normal` attribute on the flow-ribbon geometry
  (`ribbonGeometry` in `viz.ts`), the source of a `THREE.TSL: Vertex
  attribute "normal" not found on geometry` console warning. Harmless on the
  hardware this was developed on (logged once, at first compile), it flooded
  the console on at least one real GPU/driver combination - visible in a
  user's report as hundreds of repeated shader-`build` stack frames, one per
  animation frame, meaning that machine was rebuilding the ribbons' entire
  node-material graph from scratch on every single draw call rather than
  compiling it once. That is expensive enough to visibly destabilise frame
  timing, and is the most likely real explanation for reports of the camera
  and labels jittering that 0.1.2/0.1.3's fixes did not fully resolve on that
  hardware, even though neither reproduced on the machine those fixes were
  verified against. The ribbon is unlit (`meshBasicMaterial`), so the actual
  direction of the added normal is never visible; a uniform up-vector is
  enough to give the WebGPU node-material system something to build once and
  cache.

## 0.1.3 — 2026-09-04

- Fixed the real cause of the camera snapping back to the default angle for
  no apparent reason on a heavy log: a second, resize-triggered re-fit effect
  had no guard against `fit` changing by a hair for reasons that were not "the
  panel got resized" - the Inspector's activity list, the "Fly to bottleneck"
  button and the rest of the chrome can each nudge the canvas by a few pixels
  as they arrive over the several seconds a big log's queries and layout take,
  and every such nudge is technically a different floating-point aspect
  ratio. `fit` is now quantised to 5% steps before it reaches that effect, and
  the effect additionally ignores any resulting change smaller than that.
  This is almost certainly what actually produced the "labels jump on hover"
  reports on real, slow-to-load logs: a full-scene camera reset that happened
  to land while the mouse was hovering something, not a label-layout bug -
  0.1.2's label-placement fix stands, verified stable, but was treating a
  symptom of this.

## 0.1.2 — 2026-09-04

- Shrank the physical plate: `EXTENT`/`RIM_START` (`field.ts`) and `PLAN_FIT`
  (`path.ts`) were tuned around a wide skirt of flat, unused terrain — content
  used only about two thirds of the plate's radius, the rest was dead plate.
  The rim now tapers in the outer ~10% instead of the outer ~28%, so the same
  station spacing (unchanged) fills far more of a visibly smaller pedestal.
- Fixed the axis-pole framing fix from 0.1.1, which had a units bug:
  `AXIS_HALF` multiplied `PLAN_FIT` (already an absolute world-unit reach) by
  `EXTENT` again, a length-times-a-length that happened to look plausible only
  because `EXTENT` was close to 1 — it under-corrected the gap it was meant to
  close.
- Fixed a residual jitter in the label layout: even with hover no longer
  driving priority (0.1.1), OrbitControls' damping never fully stops, so the
  projected anchors drift by sub-pixel amounts indefinitely — enough, at a
  label sitting on a collision boundary, to flip its chosen position from one
  frame to the next and cascade through the whole shared placement pass,
  which read as every label (axis ticks included) jittering at once. Label
  placement now prefers each label's own last position and only abandons it
  once it genuinely stops fitting, which is immune to that flip regardless of
  its exact cause.

## 0.1.1 — 2026-09-04

- Fixed a selection bug: starting an orbit drag on the terrain (anywhere, not
  just a station) immediately cleared whatever was selected, because picking
  ran on `pointerdown` — the same event that begins a drag. A click is now
  told apart from a drag by on-screen movement and elapsed time between down
  and up, tracked independently of where the pointer ends up.
- Fixed a feedback loop where hovering a station label made every label on the
  map jitter. Hovering used to raise that station's priority and append its
  friction value to the label text, which could resize and reposition it out
  from under the pointer — triggering the opposite hover state next frame, and
  back again. Layout now reacts only to clicks (a discrete, non-continuous
  event with nothing to feed back into); hover still highlights the station's
  ring in 3D.
- The Elevation toolbar and the Friction Topography panel are now collapsible,
  to reclaim screen space without losing your place.
- Tightened the camera framing and moved the elevation axis in from the
  plate's physical corner to just outside the guaranteed station radius,
  cutting the empty margin that used to sit between the axis and the nearest
  peak.

## 0.1.0 — 2026-09-03

First release. Experimental: the terrain's geometry is settled and covered by
executable invariants, the parameter set and the drill-down tabs are not.

- A performance overlay in which elevation *is* a friction statistic, over an
  ordinary ELK layered ground plan. Median wait, p90 wait, mean wait, total
  wait or rework probability; switching between them re-queries nothing and
  moves no station.
- Volume carves valleys along routed flows, suppressed by friction so a busy
  bottleneck stays a ridge instead of being flattened by its own traffic.
- Contour lines and a graduated elevation pole at the same values, through the
  same elevation curve.
- Rework drawn as a switchback flying over the terrain, with direction taken
  from each activity's median position in a case rather than from the layout
  engine's arbitrary cycle break.
- Clicking a peak opens the wait distribution (with batching detection),
  concurrency over the log's calendar, splits by predecessor / resource / hour
  / weekday / case attribute, the variants through the step, and the
  individual worst-waiting cases.
- Selecting a case or a variant lights its route across the terrain and shows
  the same journey as a climb profile, steepest riser marked.
- Rendered through three.js `WebGPURenderer` (React Three Fiber), which targets
  WebGPU and falls back to WebGL 2; the backend in use is shown and can be
  pinned to WebGL 2.
- Works on a `TraditionalEventLog` and on an `ObjectCentricEventLog`, where the
  lifecycles are the objects'.
