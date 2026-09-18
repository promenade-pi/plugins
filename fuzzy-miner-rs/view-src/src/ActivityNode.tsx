import { Handle, Position, type NodeProps } from '@xyflow/react';
import { ACTIVITY_COLORS, ON_FILL, ON_FILL_DIM, shade } from './palette';
import { format3 } from './types';

export const ACTIVITY_W = 148;
export const ACTIVITY_H = 46;

export interface ActivityNodeData extends Record<string, unknown> {
  label: string;
  significance: number;
  count: number;
  selected: boolean;
  faded: boolean;
}

/**
 * A primitive activity: the original's square node, its fill stepping through
 * the blue palette with significance and the significance printed underneath
 * so the number the sliders act on is always visible.
 */
export function ActivityNode({ data }: NodeProps & { data: ActivityNodeData }) {
  return (
    <div
      title={`${data.label}\nsignificance ${format3(data.significance)}\n${data.count} events`}
      style={{
        width: ACTIVITY_W, height: ACTIVITY_H, boxSizing: 'border-box',
        background: shade(ACTIVITY_COLORS, data.significance),
        border: `${data.selected ? 2 : 1}px solid ${data.selected ? '#0b2b33' : 'rgba(11,43,51,.45)'}`,
        borderRadius: 3, padding: '5px 8px',
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 1,
        opacity: data.faded ? 0.32 : 1,
        cursor: 'pointer', overflow: 'hidden',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div style={{
        color: ON_FILL, fontSize: 11, fontWeight: 600, lineHeight: 1.2,
        overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box',
        WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
      }}>
        {data.label}
      </div>
      <div style={{ color: ON_FILL_DIM, fontSize: 9.5, fontVariantNumeric: 'tabular-nums' }}>
        {format3(data.significance)}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}
