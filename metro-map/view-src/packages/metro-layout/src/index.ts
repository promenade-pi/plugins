/**
 * `metro-layout` — the schematic layout shared by the Metro Map and Variant
 * Metro plugins.
 *
 * The Rust side of these two plugins already shares one implementation
 * (`plugins/metro-map/crates/metro-map-core`, which Variant Metro path-depends
 * on) for rank, lane and waypoints. Everything *after* that — re-laying out
 * the filtered subgraph, allocating tracks, routing the lines and refining the
 * drawn geometry — used to exist twice, as a copy in each plugin's `view-src`,
 * and the copies drifted: the Variant Metro one never received gateway-aware
 * routing, per-corner chamfer limits, or the drawing-refinement pass at all.
 * This package is the TypeScript counterpart of `metro-map-core`, so that
 * cannot happen again.
 *
 * The pipeline, in the order a view runs it:
 *
 *   relayoutVisible   ranks and orders the *visible* subgraph
 *   toRoutingNode     turns a payload node into the router's footprint view
 *   peakTrackDemand   how wide a lane pitch this graph actually needs
 *   routeAll          one orthogonal route per edge, with track allocation
 *   refineDrawing     final pixel-level geometry, invariants intact
 *   chamferCorners    render-time corner softening (per corner)
 */

export { relayoutVisible, type Relayout } from './relayout';
export { toRoutingNode } from './nodeGeometry';
export {
  routeAll,
  peakTrackDemand,
  findOverlaps,
  countCrossings,
  type REdge,
  type RNode,
  type RouteOptions,
  type RouteResult,
  type Overlap,
} from './router';
export { refineDrawing, nodeIntersections, type Drawing } from './geometry';
export {
  chamferCorners,
  offsetPolyline,
  roundedPathFromPoints,
  trimEnds,
  laneX,
  CHAMFER_CUT,
  CHAMFER_ROUND,
  COL_W,
  STROKE_W,
  type Point,
} from './route';
export {
  stationSize,
  stationDiameter,
  STATION_BOX_W,
  STATION_BOX_H,
  GATEWAY_D,
  BOUNDARY_D,
} from './sizes';
export type {
  StationStyle,
  LayoutNode,
  LayoutStation,
  LayoutGateway,
  LayoutBoundary,
  LayoutEdge,
} from './types';
