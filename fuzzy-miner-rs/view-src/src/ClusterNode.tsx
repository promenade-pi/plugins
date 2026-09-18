import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CLUSTER_COLORS, ON_FILL, ON_FILL_DIM, shade } from './palette';
import { format3 } from './types';

export const CLUSTER_W = 158;
export const CLUSTER_H = 58;

export interface ClusterNodeData extends Record<string, unknown> {
  count: number;
  significance: number;
  members: string[];
  expanded: boolean;
  faded: boolean;
}

/**
 * An aggregation of activities the node cutoff dropped. The original draws
 * these as green octagons, and the shape carries real information: it is the
 * one node on the canvas whose label is a *summary* rather than something
 * that happened. Clicking it lists what went inside.
 */
export function ClusterNode({ data }: NodeProps & { data: ClusterNodeData }) {
  const clip = 'polygon(30% 0, 70% 0, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0 70%, 0 30%)';
  return (
    <div
      title={`Cluster of ${data.count}\nmean significance ${format3(data.significance)}\n\n${data.members.join('\n')}`}
      style={{ width: CLUSTER_W, height: CLUSTER_H, position: 'relative', cursor: 'pointer', opacity: data.faded ? 0.32 : 1 }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div style={{
        position: 'absolute', inset: 0,
        background: shade(CLUSTER_COLORS, data.significance),
        clipPath: clip,
        outline: data.expanded ? '2px solid #0b2b33' : 'none',
        outlineOffset: -2,
      }} />
      <div style={{
        position: 'absolute', inset: 0, clipPath: clip,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1,
      }}>
        <div style={{ color: ON_FILL, fontSize: 11, fontWeight: 600 }}>Cluster</div>
        <div style={{ color: ON_FILL, fontSize: 10 }}>{data.count} activities</div>
        <div style={{ color: ON_FILL_DIM, fontSize: 9.5, fontVariantNumeric: 'tabular-nums' }}>
          ~ {format3(data.significance)}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}
