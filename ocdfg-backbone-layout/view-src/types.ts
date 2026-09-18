/** Mirrors the `OCDFGBackboneLayout` payload produced by `plugin.py`. */

export interface LayoutNode {
  id: string;
  kind: 'activity' | 'start' | 'end' | 'virtual';
  label: string | null;
  activity: string | null;
  /** Set for start/end/virtual nodes; null for a shared activity. */
  objectType: string | null;
  objectTypes: string[];
  axis: number;
  rank: number;
  order: number;
  /** Centre coordinates, already laid out — the view never re-layouts. */
  x: number;
  y: number;
  width: number;
  height: number;
  count: number | null;
  /** The object type whose trunk owns this node, if any. */
  backboneOf: string | null;
}

export interface LayoutEdge {
  id: string;
  objectType: string;
  src: string;
  dst: string;
  kind: 'df' | 'start' | 'end';
  freq: number;
  avgSecs: number | null;
  backbone: boolean;
  /** Centres of src, every virtual node on the route, and dst. */
  waypoints: Array<{ x: number; y: number }>;
  via: string[];
  back: boolean;
  horizontal: boolean;
}

export interface LayoutAxis {
  objectType: string;
  axis: number;
  backbone: string[];
  trunk: string[];
  straightTrunk: string[];
  trunkX: number | null;
  activities: number;
  components: number;
  componentsLeft: number;
}

export interface LayoutMetrics {
  backEdges: number;
  horizontalEdges: number;
  backEdgeRate: number;
  crossings: number;
  edgeLength: number;
  edgeOrthogonality: number;
  nodeOrthogonality: number;
  balance: number;
  balanceDifference: number;
  balanceByObjectType: Record<string, number>;
  leftNodes: number;
  rightNodes: number;
  ranks: number;
  orderColumns: number;
  objectTypeCompactness: number | null;
  objectTypeInteractionPreservation: number | null;
}

export interface LayoutDiagnostics {
  rank?: {
    method?: string;
    objective?: string;
    edgeWeight?: string;
    allowHorizontalEdges?: boolean;
    solver?: string | null;
    optimal?: boolean;
    fallback?: string | null;
    objectiveValue?: number;
    heuristicObjective?: number;
    message?: string;
    rounds?: number;
    secs?: number;
    droppedChainConstraints?: Array<{ objectType: string; src: string; dst: string }>;
  };
  virtual?: { virtualNodes: number; unroutedEdges: number };
  balancing?: { balancing: string; imbalance: Record<string, number> };
  merge?: { axisOfType: Record<string, number>; main: string | null; mergeOrder: string[] };
  crossings?: { before: number; after: number; swaps: number };
  positioning?: {
    xlength: number; separationConverged: boolean; trunks: number; straightTrunks: number;
  };
  secs?: number;
  reason?: string;
}

export interface BackboneLayoutPayload {
  objectTypes: string[];
  mainObjectType: string | null;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  axes: LayoutAxis[];
  extent: { width: number; height: number };
  metrics: LayoutMetrics;
  params: Record<string, unknown>;
  diagnostics: LayoutDiagnostics;
  stats: {
    objectTypes: number; activities: number; edges: number; ranks: number;
    backEdges: number; crossings: number; virtualNodes: number;
  };
}
