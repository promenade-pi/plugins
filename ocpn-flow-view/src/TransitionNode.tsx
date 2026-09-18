import { Handle, Position, type NodeProps } from '@xyflow/react';
import { TRANS_H, TRANS_W, tauSize, type FlowDirection } from './layout';

export interface TransitionNodeData {
  activity: string | null;
  selected: boolean;
  direction: FlowDirection;
  [key: string]: unknown;
}

/** A labelled transition is a rounded rectangle; a silent (tau) transition
 * is the small filled bar convention the host view also uses — it has no
 * activity of its own, so a label would be misleading. */
export function TransitionNode({ data }: NodeProps & { data: TransitionNodeData }) {
  const vertical = data.direction === 'DOWN';
  if (data.activity == null) {
    const bar = tauSize(data.direction);
    return (
      <div
        style={{
          ...bar, borderRadius: 3,
          background: data.selected ? 'var(--accent, #4f7fff)' : 'var(--text-dim, #6b7280)',
        }}
      >
        <Handle type="target" position={vertical ? Position.Top : Position.Left} style={handleStyle} />
        <Handle type="source" position={vertical ? Position.Bottom : Position.Right} style={handleStyle} />
      </div>
    );
  }
  return (
    <div
      style={{
        width: TRANS_W, height: TRANS_H, borderRadius: 6,
        border: `1.5px solid ${data.selected ? 'var(--accent, #4f7fff)' : 'var(--border, #d0d5dd)'}`,
        background: data.selected ? 'var(--accent-soft, #e8eeff)' : 'var(--bg, #fff)',
        color: 'var(--text, #1c2027)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, fontWeight: 500, padding: '0 8px', boxSizing: 'border-box',
        textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}
      title={data.activity}
    >
      <Handle type="target" position={vertical ? Position.Top : Position.Left} style={handleStyle} />
      {data.activity}
      <Handle type="source" position={vertical ? Position.Bottom : Position.Right} style={handleStyle} />
    </div>
  );
}

const handleStyle = { width: 1, height: 1, opacity: 0, border: 'none' } as const;
