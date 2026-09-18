# OCPN (React Flow)

A second view for `ObjectCentricPetriNet` artifacts: [React
Flow](https://reactflow.dev) for rendering, [elkjs](https://github.com/kieler/elkjs)
(`layered` algorithm) for layout. Ships alongside the host's own OCPN view
(`core.ocpnView`) so the two renderers can be compared side by side on the
same net.

## Layout

A tuned `layered` preset (`src/layout.ts`'s `ocpnLayoutOptions`) — `SPLINES`
routing, `NETWORK_SIMPLEX` layering and node placement,
greedy-switch crossing minimization, per-kind spacing (node/edge/component),
higher thoroughness. `elk.direction` is the one key the view varies, from
the "Flow direction" parameter (see below); every key is a real, documented
ELK layered option;
elkjs's JS API does not reject an unrecognised one at call time (silently a
no-op, not an error), so each was checked by observing it actually change
the rendered layout, not just by trusting the string.

**Deterministic input.** `src/canonical.ts` sorts places, transitions and
arcs into a fixed order (object type → role → id; activity → id;
source → target → object type → variable → id) before they ever reach ELK —
the OCPN artifact's own arrays are in whatever order the discovery run
happened to produce, which this view does not want to depend on for "does
it look the same every time I open it."

**ELK routes, this view draws exactly what it routed.** Edges are built
from every point in every section ELK's `SPLINES` routing actually returned
(`layout.ts`'s `pathFromSections`) — start point, every bend point, end
point, converted to a smooth cubic (uniform Catmull-Rom → Bézier, the
standard technique for a curve that passes through given points rather than
approximating them) instead of connecting them with straight segments. An
edge with more than one disconnected routed section is supported: each
becomes its own `M`-prefixed subpath in the same `d` string. This is not
React Flow's default handle-to-handle bezier, and was never meant to be —
the whole point of asking for `SPLINES` routing is to get real geometry back
and render it, not to recompute a path from just two endpoints.

### No Web Worker — by necessity, not choice

The host's own OCPN view (`app/src/ui/views/ocpnLayout.ts`) runs elkjs
through `elk-api.js` with a real `Worker`, off the main thread. That path is
unavailable here: the sandboxed view boundary's CSP has no `worker-src`,
which falls back to `default-src 'none'` — `new Worker(...)` throws
regardless of how it's constructed, blob URL included.

`elkjs/lib/elk-worker.min.js` — the actual layout engine — decides at load
time whether it's running inside a real Worker by checking `typeof document
=== 'undefined'`. A `document` exists in this frame (it's a normal, if
sandboxed, iframe document), so it takes the same branch Node does and
exports a `Worker`-shaped class that dispatches through `setTimeout` instead
of a thread. Handing that class to `elk-api.js` as its `workerFactory`
(`src/layout.ts`) gets the same promise-based `.layout()` API the host uses,
with no real Worker anywhere in the call chain — layout still runs
asynchronously relative to the rest of the frame's JS, just not on a second
thread.

## Notation

Follows the host view's conventions with one deliberate difference, per what
was asked for this plugin specifically: a **source** place shows a centred
▶ (Play) glyph, a **sink** place a centred ■ (Stop) glyph, in place of the
host view's double-ring marker — there is no room inside a 28px circle for
both a ring and a filled icon. A normal place stays an empty circle,
standard Petri net notation.

Everything else matches: places and arcs are outlined/coloured by object
type (`promenade.color('objectType', …)`); a silent (tau) transition is the
same small filled bar, not a labelled box; a variable arc is dashed. The
in-canvas legend (top-left, collapsible) doubles as the object-type
visibility and "show silent transitions" toggle — kept as local component
state rather than manifest-declared `params`, because the host's generic
param editor cannot render a usable control for an array param with no
static `enum`/`optionsFrom` (object types are only known once the artifact
is loaded, not at manifest-authoring time).

## Flow direction

The one manifest-declared `param` (Inspector panel) turns the whole net
between left-to-right and top-to-bottom. Nothing else about the layout
changes, so the two orientations are the same drawing seen along a different
axis. Source/sink places keep their label clear of the flow — under the
circle when running left to right, above a source and below a sink when
running top to bottom — and reserve the label's width in the vertical
layout, where markers sitting side by side in one layer would otherwise be
spaced on the 29px circle alone and collide by their text. A silent
transition's bar turns with the flow too — Petri-net notation draws it
across the direction of travel, which is the layer's axis, not the
direction's.

## React Flow is the interaction layer, not a second layout engine

`nodeOrigin={[0, 0]}` is set explicitly (matching ELK's own top-left `x`/`y`
convention, rather than relying on React Flow's default happening to agree).
Panning is drag-only (`panOnScroll={false}`); scrolling zooms instead.
`fitView` is not the boolean prop — it's called once, via `useReactFlow()`,
whenever a *new* ELK layout actually lands (an object-type or
silent-transition toggle), never on selection or hover, so clicking a node
never moves the viewport out from under you. Dragging/connecting nodes is
off (`nodesDraggable`/`nodesConnectable={false}`) — this is a viewer, not an
editor.

## Determinism & diagnostics

`src/debug.ts`'s `serializeElkInputForDebug()` dumps the canonical,
post-sort node/edge order as plain text — there is no test runner in this
package (see "Building" below), so the practical way to confirm two renders
of the same OCPN produce the same layout is to diff two calls to this by
hand rather than eyeball two screenshots.

A real Web Worker for layout (the host's own `core.ocpnView` uses one) is
not available here at all — see "No Web Worker" above — so there's no
"move this to a worker later" TODO to track; the synchronous shim already
is what this boundary allows.

## Boundary

Runs under the same sandboxed-view contract as every other third-party
view: opaque origin, no host DOM, no storage, no network. The net has no
table to query, so it arrives once as the artifact's own inline payload
(`promenade.artifact().value`), not through `promenade.sql()`. Selecting a
place or transition calls `promenade.select()`; an incoming host selection
highlights the matching node. Colours and theme tokens are pushed by the
host and re-applied live on change — this view never picks its own colour
for an object type or activity.

## Building

Unlike the hand-written-JS example plugins, this one bundles real npm
dependencies (React, React Flow, elkjs) — there is no way around a build
step for that. `npm install && ./package.sh` runs esbuild
(`bundle: true, format: 'iife', platform: 'browser'`) to produce one classic
script, then zips it with `manifest.json` into the `.pmplugin`. React Flow's
own stylesheet is pulled in via esbuild's `text` loader and injected through
a `<style>` tag at runtime — the frame's CSP (`style-src 'unsafe-inline'`,
no external loads) has no other way to get it into the document.
