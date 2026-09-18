import { BaseEdge, type EdgeProps } from '@xyflow/react';

export interface OcpnEdgeData {
  path: string;
  color: string;
  variable: boolean;
  [key: string]: unknown;
}

/** Follows ELK's own routed section exactly (`layout.ts`'s
 * `pathFromSection`) rather than React Flow's default handle-to-handle
 * bezier — the whole point of asking ELK for `SPLINES` routing is to get
 * its bend points, not to recompute a path from just the two endpoints. */
export function OcpnEdge({ data, markerEnd }: EdgeProps & { data: OcpnEdgeData }) {
  return (
    <BaseEdge
      path={data.path}
      markerEnd={markerEnd}
      style={{
        stroke: data.color,
        strokeWidth: 1.5,
        strokeDasharray: data.variable ? '5 3' : undefined,
      }}
    />
  );
}
