import { Handle, Position, type NodeProps } from '@xyflow/react';
import { silentSize, TRANS_H, TRANS_W, type FlowDirection } from './layout';

export interface TransitionNodeData {
  activity: string | null;
  selected: boolean;
  direction: FlowDirection;
  color: string;
  theme: Record<string, string>;
  [key: string]: unknown;
}

export function TransitionNode({ data }: NodeProps & { data: TransitionNodeData }) {
  const vertical = data.direction === 'DOWN';
  if (data.activity == null) {
    return <div title="silent transition" style={{
      ...silentSize(data.direction), boxSizing: 'border-box',
      // The one-pixel background-coloured edge keeps converging arcs from
      // visually fusing into the tau bar, without returning to a wide gutter.
      border: `1px solid ${data.theme.bg}`, background: data.theme['text-dim'],
    }}>
      <Handle type="target" position={vertical ? Position.Top : Position.Left} style={handleStyle} />
      <Handle type="source" position={vertical ? Position.Bottom : Position.Right} style={handleStyle} />
    </div>;
  }
  return <div title={data.activity} style={{
    width: TRANS_W, height: TRANS_H, boxSizing: 'border-box', borderRadius: 6,
    border: `1.5px solid ${data.selected ? data.theme.accent : data.color}`,
    background: data.selected ? data.theme['accent-soft'] : data.theme.bg,
    color: data.theme.text, display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '0 8px', fontSize: 11, fontWeight: 500, textAlign: 'center',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  }}>
    <Handle type="target" position={vertical ? Position.Top : Position.Left} style={handleStyle} />
    {data.activity}
    <Handle type="source" position={vertical ? Position.Bottom : Position.Right} style={handleStyle} />
  </div>;
}

const handleStyle = { width: 1, height: 1, opacity: 0, border: 'none' } as const;
