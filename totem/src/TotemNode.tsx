import type { CSSProperties } from 'react';
import { Handle, Position } from '@xyflow/react';

const centerHandleStyle: CSSProperties = {
  opacity: 0, top: '50%', left: '50%', transform: 'translate(-50%, -50%)', pointerEvents: 'none',
};

export interface TotemNodeData {
  label: string;
  color: string;
  selected: boolean;
  [key: string]: unknown;
}

/** A plain colored box per object type — the TOTeM notation has no internal
 * node structure to draw, unlike a place/transition net. */
export function TotemNode({ data }: { data: TotemNodeData }) {
  return (
    <div
      style={{
        padding: '9px 16px',
        borderRadius: 6,
        background: data.color,
        border: data.selected ? '2px solid var(--accent, #2563eb)' : '1px solid rgba(0,0,0,.15)',
        boxShadow: data.selected
          ? '0 0 0 3px var(--accent-soft, rgba(37,99,235,.25))'
          : '0 1px 3px rgba(0,0,0,.12)',
        fontSize: 13,
        fontWeight: 600,
        color: '#1a1a1a',
        whiteSpace: 'nowrap',
        cursor: 'grab',
      }}
    >
      {/* One source + one target handle, both centered and invisible — the
          edge computes its own boundary attachment point per-render (see
          `floating.ts`), so these exist only so React Flow has a valid
          connection endpoint on this node, not to fix which side it's on. */}
      <Handle type="target" position={Position.Top} style={centerHandleStyle} />
      <Handle type="source" position={Position.Top} style={centerHandleStyle} />
      {data.label}
    </div>
  );
}
