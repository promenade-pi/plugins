import { Handle, Position, type NodeProps } from '@xyflow/react';
import { ACTIVITY_H, ACTIVITY_W, type FlowDirection } from './layout';

export interface ActivityNodeData {
  activity: string;
  count: number;
  objectTypes: Array<{ name: string; color: string }>;
  selected: boolean;
  direction: FlowDirection;
  theme: Record<string, string>;
  [key: string]: unknown;
}

export function ActivityNode({ data }: NodeProps & { data: ActivityNodeData }) {
  const theme = data.theme;
  const vertical = data.direction === 'DOWN';
  return (
    <div
      title={data.activity}
      style={{
        width: ACTIVITY_W, height: ACTIVITY_H, boxSizing: 'border-box', padding: '7px 9px',
        borderRadius: 7, border: `1.5px solid ${data.selected ? theme.accent : theme.border}`,
        background: data.selected ? theme['accent-soft'] : theme.bg,
        color: theme.text, boxShadow: data.selected ? `0 0 0 1px ${theme.accent}` : undefined,
        fontSize: 11, overflow: 'hidden', cursor: 'pointer',
      }}
    >
      {/* ELK supplies the precise routed geometry, but React Flow still
          requires endpoint handles before it mounts a custom edge. */}
      <Handle type="target" position={vertical ? Position.Top : Position.Left} style={handleStyle} />
      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
        {data.activity}
      </div>
      <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 5, color: theme['text-dim'] }}>
        <span>{data.count.toLocaleString()} objects</span>
        <span style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
          {data.objectTypes.slice(0, 5).map((type) => (
            <span key={type.name} title={type.name} style={{ width: 7, height: 7, borderRadius: '50%', background: type.color }} />
          ))}
        </span>
      </div>
      <Handle type="source" position={vertical ? Position.Bottom : Position.Right} style={handleStyle} />
    </div>
  );
}

const handleStyle = { width: 1, height: 1, opacity: 0, border: 'none' } as const;
