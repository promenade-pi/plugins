# metro-layout

The schematic metro-map layout shared by two view plugins:

- `run.promenade.metro-map` — Metro Map (OCPN and OC-DFG bases)
- `org.promenade.variant-metro` — Metro map with variant slider

It is the TypeScript counterpart of the `metro-map-core` crate. The crate
produces rank, lane and waypoints at discovery time; this package is
everything the *view* then does with them.

## Why it exists

The Rust half was shared from the start — Variant Metro path-depends on
`../../../crates/metro-map-core`. The TypeScript half was not: each plugin
carried its own copy of `relayout.ts`, `router.ts` and `route.ts`, and the
copies drifted. By the time they were reunited, the Variant Metro copy was
missing gateway-aware routing, per-corner chamfer limits, and the entire
drawing-refinement pass — it had no `geometry.ts` at all, so arcs there could
still be drawn through the node footprints and stop captions that the Metro
Map plugin had detoured around since 0.17.6.

Sharing the algorithm is only half of it. The two plugins' *invariants* are
now shared too: `npm run check` here is the same suite each plugin's own
`npm run check` runs first, and each plugin's `package.sh` gates on it.

## The pipeline

| step | what it decides |
| --- | --- |
| `relayoutVisible` | rank and lane order for the **visible** subgraph, as a monotone refinement of the discovered model's own order (or fresh from the visible topology, when stability is off) |
| `toRoutingNode` | a payload node's drawn footprint, as the router sees it |
| `peakTrackDemand` | how wide a lane pitch the busiest column actually needs |
| `routeAll` | one orthogonal route per edge; interval-partitioned track allocation per lane column and row channel, so two lines of different object types can never come out collinear-and-overlapping |
| `refineDrawing` | final pixel geometry — source-tail alignment, detours around obstructed nodes, per-corner chamfer limits |
| `chamferCorners` | the render-time 45° corner softening `MetroEdge` applies |

## What it deliberately does not own

`metro-layout` reads the smallest shape it needs (`LayoutNode`, `LayoutEdge`
in `src/types.ts`); each plugin keeps its own richer payload types, which are
structurally assignable to these. Anything that is a *product decision* rather
than geometry stays in the plugin: the Metro Map plugin's arc-count complexity
filter, the Variant Metro plugin's variant slider, colours, labels, and every
React component except the footprint constants in `src/sizes.ts` — those live
here because the router and the renderer must never disagree about how big a
node is.

## Consuming it

```json
"dependencies": { "metro-layout": "file:../../metro-map/view-src/packages/metro-layout" }
```

The package ships TypeScript source, not a build output: both consumers bundle
with esbuild and typecheck with the same `tsc`, so there is no build step to
keep in sync and no chance of a stale artifact.

## Checks

```bash
npm run check
```

27 graphs — hand-built shapes plus 25 randomised ones — asserting that no two
segments of different object types are collinear and overlapping, in **both**
the router's own polyline and the chamfered geometry that is actually drawn.
Crossing counts are reported as metrics, not gated.
