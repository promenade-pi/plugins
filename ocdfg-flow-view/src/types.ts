/** Mirrors the inline OCDFG payload created by `core.discover.ocdfg`. */
export interface OcdfgNode {
  objectType: string;
  activity: string;
  count: number;
  starts: number;
  ends: number;
}

export interface OcdfgEdge {
  objectType: string;
  src: string;
  dst: string;
  freq: number;
  /** Mean wait between the two activities, in seconds. Added in
   * `core.discover.ocdfg` 0.2.0; null when the log has no usable
   * timestamps, and absent on an OCDFG produced before that. */
  avgSecs?: number | null;
}

export interface OcdfgPayload {
  objectTypes: string[];
  nodes: OcdfgNode[];
  edges: OcdfgEdge[];
  stats: { objectTypes: number; activities: number; edges: number };
}
