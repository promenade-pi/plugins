import { Handle, Position, type NodeProps } from '@xyflow/react';
import { SILENT_H, SILENT_W, TRANS_H, TRANS_W } from './layout';

export interface TransitionNodeData {
  activity: string | null;
  highlight: 'error' | 'warning' | null;
  /** Never enabled in any reachable marking. Drawn struck through whether or
   *  not a finding is selected — a dead transition is a property of the net,
   *  not of what the reader happens to be looking at. */
  dead: boolean;
  /** Position in the selected witness's firing sequence, 1-based. */
  step: number | null;
  role: string;
  theme: Record<string, string>;
  [key: string]: unknown;
}

export function TransitionNode({ data }: NodeProps & { data: TransitionNodeData }) {
  const accent =
    data.highlight === 'error' ? data.theme.danger : data.highlight === 'warning' ? data.theme.warn : null;
  const silent = data.activity == null;
  const border = accent ?? (data.dead ? data.theme['text-dim'] : data.theme.border);

  return (
    <div title={data.role} style={{ position: 'relative' }}>
      {data.step != null && (
        <span style={{
          position: 'absolute', top: -9, left: -9, zIndex: 2,
          minWidth: 16, height: 16, borderRadius: 8, padding: '0 4px', boxSizing: 'border-box',
          background: data.theme.accent, color: data.theme.bg,
          fontSize: 10, fontWeight: 700, lineHeight: '16px', textAlign: 'center',
        }}>{data.step}</span>
      )}
      {silent ? (
        <div style={{
          width: SILENT_W, height: SILENT_H, boxSizing: 'border-box',
          // The one-pixel background-coloured edge keeps converging arcs from
          // visually fusing into the tau bar.
          border: `1px solid ${data.theme.bg}`,
          background: accent ?? data.theme['text-dim'],
          opacity: data.dead ? 0.4 : 1,
        }}>
          <Handle type="target" position={Position.Left} style={handleStyle} />
          <Handle type="source" position={Position.Right} style={handleStyle} />
        </div>
      ) : (
        <div style={{
          width: TRANS_W, height: TRANS_H, boxSizing: 'border-box', borderRadius: 6,
          border: `${accent ? 2 : 1.5}px solid ${border}`,
          background: accent ? `${accent}1f` : data.theme.bg,
          color: data.dead ? data.theme['text-dim'] : data.theme.text,
          textDecoration: data.dead ? 'line-through' : 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '0 8px', fontSize: 11, fontWeight: 500, textAlign: 'center',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          <Handle type="target" position={Position.Left} style={handleStyle} />
          {data.activity}
          <Handle type="source" position={Position.Right} style={handleStyle} />
        </div>
      )}
    </div>
  );
}

const handleStyle = { width: 1, height: 1, opacity: 0, border: 'none' } as const;
