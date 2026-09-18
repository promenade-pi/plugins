# Changelog

## 0.2.1

- Corrected the `homepage` and `repository` URLs. The plugins live in one
  repository, [`promenade-pi/plugins`](https://github.com/promenade-pi/plugins),
  not one repository per plugin under a `promenade-lab` organisation that was
  never created. Metadata only — no functional change.

## 0.2.0

Lift cars.

Each shaft now runs a car — five boxes and a couple of pegs, instanced so the
whole diagram costs five draw calls however many shafts it has — carrying one
passenger per object type on that hand-off, in that type's own colour.

A car **only ever descends**. It falls at a constant speed (so a longer wait is
visibly a longer journey, not just a longer shaft), waits at the bottom, and
then **beams back to the top with a flash** rather than climbing. That is not a
shortcut: on this diagram height is elapsed time, so a car rising through its
shaft would be a case travelling backwards through the process, which is the
one thing the drawing must never appear to say. The flash is what makes the
return read as a cut rather than as motion.

Also in this release, all of it in service of the cars being legible:

* Shafts have a minimum radius, and it is set in the **kernel** rather than the
  view — the shaft's radius is what the invariants hold clear of every
  platform, so a view quietly drawing them wider would be drawing something
  unverified. Columns are spaced for it automatically.
* A shaft is capped by a machine room and a pit, and carries a hoist cable.
* A car hangs off the *front* of that cable rather than being centred on it.
  Centred, the cable and the descending routes slice it in half and its cream
  back panel — the thing that makes the passengers readable — ends up behind
  them.
* Cars turn about their own axis to face the camera, so the open front stays
  towards whoever is looking.
* Column pitch is now per-column rather than one global maximum. Spacing every
  rank boundary for the busiest one turned a ten-platform map into forty plan
  units of mostly empty corridor, and a route drawn at its honest width arrived
  on screen as a hairline.
* The corridor allocator centres each *group* of overlapping claims rather than
  a whole corridor at once. The global version dragged quiet stretches of a
  lane off their own centre line, which grew a platform's disc to cover an
  offset it never needed until the disc reached across a corridor and a route
  was drawn through it. `cargo test` caught it; nothing in the picture did.

**wasm change: Remove and reinstall the plugin rather than updating in place.**

## 0.1.0

First release.

A 3D "station atlas" view of an object-centric process: activities are circular
platforms, object types are coloured routes, horizontal position is process
order, and vertical position is accumulated elapsed time — so waiting is a
literal descent, drawn as a translucent lift shaft for a long wait, a staircase
for a shorter one, and a slope for a hand-off that barely waits.

* One action, `Discover station map`, with a Rust/WebAssembly kernel. It scans
  an OC-DFG (`core.discover.ocdfg`, run internally) out of an object-centric
  event log and converts it to a station plan.
* The plan's geometry is proved rather than eyeballed. `cargo test -p
  station-map-core` asserts, over the worked example and 250 randomised graphs
  at three abstraction settings, that no two routes share a line, that no
  platform overlaps another, that no route is drawn across a platform it does
  not touch, that every forward hand-off descends, that no segment is
  accidentally diagonal, and that no route takes a longer way round than its
  own endpoints justify. Packaging fails if any of that is false.
* The view's own invariants (`npm run check` in `view-src`) cover the third
  dimension: that every hand-off descends by a visible amount at every scale
  and relief setting, that the drawing is exactly as deep as the relief slider
  asked for, and that the depth axis is monotone and stays inside the drawing.
* Interactive rather than a fixed picture: orbit, a **flat** mode that collapses
  the depth axis into an ordinary 2D metro map, a linear/logarithmic depth axis,
  a relief slider, route-width by frequency, and a legend that follows one
  object type's lifecycle. Switching the depth axis never moves a platform in
  plan.
* Rendered with three.js `WebGPURenderer`, falling back to WebGL 2.

Known and deliberate: the wait behind a descent is a **mean**, because that is
what an OC-DFG carries. And a platform has one depth — the deepest of the paths
reaching it — so a route may be drawn descending further than its own hand-off
waited. Only the hand-off that set the depth carries a duration label, and the
Inspector explains the difference for the selected platform.
