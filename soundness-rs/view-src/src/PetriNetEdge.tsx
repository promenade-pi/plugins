import { BaseEdge, type EdgeProps } from '@xyflow/react';

export interface PetriNetEdgeData { path: string; color: string; [key: string]: unknown; }

export function PetriNetEdge({ data, markerEnd }: EdgeProps & { data: PetriNetEdgeData }) {
  return <BaseEdge path={data.path} markerEnd={markerEnd} style={{ stroke: data.color, strokeWidth: 1.5 }} />;
}

