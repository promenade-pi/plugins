import { Handle, Position, type NodeProps } from '@xyflow/react';
import { BOUNDARY_D } from 'metro-layout';

export interface BoundaryNodeData {
  objectType: string;
  kind: 'source' | 'sink';
  color: string;
  faded: boolean;
  /** Total starts (source) / ends (sink) — shown when `showNumber`. */
  count?: number;
  showNumber: boolean;
  theme: Record<string, string>;
  [key: string]: unknown;
}

/** Terminus markers, one per object type — the same notation
 * `ocdfg-flow-view` already validated: a coloured circle with a play glyph
 * where an object's line begins, a stop glyph where it ends. */
export function BoundaryNode({ data }: NodeProps & { data: BoundaryNodeData }) {
  const isSource = data.kind === 'source';
  return (
    <div
      style={{ display: 'grid', justifyItems: 'center', gap: 4, cursor: 'pointer', opacity: data.faded ? 0.2 : 1, transition: 'opacity 120ms' }}
      title={`${data.objectType} ${data.kind}`}
    >
      {!isSource && <Handle type="target" position={Position.Top} style={handleStyle} />}
      <div
        style={{
          width: BOUNDARY_D, height: BOUNDARY_D, borderRadius: '50%', boxSizing: 'border-box',
          border: `1.5px solid ${data.theme.text}`, background: data.color, display: 'grid', placeItems: 'center',
        }}
      >
        {isSource
          ? <svg width="11" height="11" viewBox="0 0 25 25" aria-hidden="true"><path d="M5 3 L22 12.5 L5 22 Z" fill={data.theme.text} /></svg>
          : <svg width="11" height="11" viewBox="0 0 25 25" aria-hidden="true"><rect x="4" y="4" width="17" height="17" fill={data.theme.text} /></svg>}
      </div>
      {isSource && <Handle type="source" position={Position.Bottom} style={handleStyle} />}
      <span style={{
        color: data.theme.text, fontSize: 10, fontWeight: 600, maxWidth: 88, textAlign: 'center',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        background: `${data.theme.bg}cc`, borderRadius: 3, padding: '1px 4px',
      }}>
        {data.objectType}
        {data.showNumber && data.count != null && (
          <span style={{ color: data.theme['text-dim'], fontWeight: 400 }}>{'  '}{data.count.toLocaleString('en')}</span>
        )}
      </span>
    </div>
  );
}

const handleStyle = { width: 1, height: 1, opacity: 0, border: 'none' } as const;
