/**
 * The layout's own view of a metro map — deliberately the *smallest* shape
 * these algorithms actually read, not either plugin's full payload type.
 *
 * Both consumers keep their own richer `MetroMapPayload`/`MmNode`/`MmEdge`
 * (the Metro Map plugin's carries `revealOrder` and variable arcs, the
 * Variant Metro plugin's carries per-variant attribution); those are
 * structurally assignable to the interfaces below, so neither has to convert
 * anything to call in here, and neither can drag its own extras into the
 * layout by accident.
 */

/** How activities are drawn, which is what decides their footprint. */
export type StationStyle = 'dots' | 'labels';

interface LayoutNodeBase {
  id: string;
  /** Layer index from the discovered model (`metro-map-core`). */
  rank: number;
  /** Horizontal position in lane units from the same model. */
  lane: number;
}

export interface LayoutStation extends LayoutNodeBase {
  kind: 'station';
  /** One entry per object type running through this stop; its length is what
   * grows an interchange dot. */
  objectTypes: string[];
}

export interface LayoutGateway extends LayoutNodeBase {
  kind: 'gateway';
  objectType: string;
}

export interface LayoutBoundary extends LayoutNodeBase {
  kind: 'source' | 'sink';
  objectType: string;
}

export type LayoutNode = LayoutStation | LayoutGateway | LayoutBoundary;

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  objectType: string;
}
