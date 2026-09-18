import { BaseEdge, type EdgeProps } from '@xyflow/react';

export interface BpmnEdgeData {
  path: string;
  color: string;
  label?: string | null;
  [key: string]: unknown;
}

/** Follows ELK's own routed section exactly (`layout.ts`'s `pathFromSections`)
 * rather than React Flow's default handle-to-handle bezier, the same
 * reasoning as `ocpn-flow-view`'s `OcpnEdge`. */
export function BpmnEdge({ data, markerEnd }: EdgeProps & { data: BpmnEdgeData }) {
  return <BaseEdge path={data.path} markerEnd={markerEnd} style={{ stroke: data.color, strokeWidth: 1.5 }} />;
}
