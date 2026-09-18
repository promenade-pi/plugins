import { Handle, Position, type NodeProps } from '@xyflow/react';
import { TRANS_H, TRANS_W } from './layout';

export type FireState = 'idle' | 'fire' | 'silent' | 'logmove';

export interface TransitionNodeData {
  activity: string | null;
  fireState: FireState;
  theme: Record<string, string>;
  [key: string]: unknown;
}

const handleStyle = { width: 1, height: 1, opacity: 0, border: 'none' } as const;

function accent(state: FireState, theme: Record<string, string>): string | null {
  if (state === 'fire') return theme.accent;
  if (state === 'silent') return theme['text-dim'];
  if (state === 'logmove') return theme.danger;
  return null;
}

/** Labelled transition: rounded rectangle. Silent (tau): the small filled bar.
 * A firing this frame gets a coloured ring — accent for an observed activity,
 * dim for a silent move, danger for a log move the model could not replay. */
export function TransitionNode({ data }: NodeProps & { data: TransitionNodeData }) {
  const ring = accent(data.fireState, data.theme);
  const glow = ring ? `0 0 0 3px ${ring}, 0 0 12px 2px ${ring}66` : undefined;

  if (data.activity == null) {
    return (
      <div
        style={{
          width: 24, height: TRANS_H, borderRadius: 3,
          background: ring ?? data.theme['text-dim'],
          boxShadow: glow, transition: 'box-shadow 120ms, background 120ms',
        }}
      >
        <Handle type="target" position={Position.Left} style={handleStyle} />
        <Handle type="source" position={Position.Right} style={handleStyle} />
      </div>
    );
  }
  return (
    <div
      style={{
        width: TRANS_W, height: TRANS_H, borderRadius: 6,
        border: `1.5px solid ${ring ?? data.theme.border}`,
        background: data.fireState === 'idle' ? data.theme.bg : `${ring}1f`,
        color: data.theme.text,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, fontWeight: 500, padding: '0 8px', boxSizing: 'border-box',
        textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        boxShadow: glow, transition: 'box-shadow 120ms, background 120ms, border-color 120ms',
      }}
      title={data.activity}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      {data.activity}
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </div>
  );
}
