/**
 * Drawn footprints, in pixels. These live here rather than beside the React
 * components that render them because the router and the geometry checks
 * need them just as much as the renderer does — and the one thing that must
 * never drift is the renderer's idea of how big a node is versus the
 * router's. A component imports its own size from here and re-exports it.
 */
import type { StationStyle } from './types';

/** Dot diameter for the `'dots'` style — grows for a shared interchange. */
export function stationDiameter(objectTypeCount: number): number {
  return 26 + Math.min(objectTypeCount - 1, 3) * 8;
}

/** Labelled-rectangle box for the `'labels'` style. */
export const STATION_BOX_W = 132;
export const STATION_BOX_H = 34;

/** Gateway diamond, drawn as a square rotated 45°. */
export const GATEWAY_D = 20;

/** Source/sink marker disc. */
export const BOUNDARY_D = 24;

/** The node's drawn footprint (excluding the label that sits *beside* a dot).
 * Used by the router to trim arrowheads back to the shape edge and by each
 * plugin's `plugin.tsx` to place the node. */
export function stationSize(style: StationStyle, objectTypeCount: number): { w: number; h: number } {
  if (style === 'labels') return { w: STATION_BOX_W, h: STATION_BOX_H };
  const d = stationDiameter(objectTypeCount);
  return { w: d, h: d };
}
