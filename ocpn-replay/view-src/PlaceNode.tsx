import type { CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { OcpnPlaceKind } from './types';
import { BOUNDARY_D, PLACE_R } from './layout';

export interface PlaceNodeData {
  kind: OcpnPlaceKind;
  objectType: string;
  color: string;
  theme: Record<string, string>;
  /** live token count across every object currently in this place */
  tokens: number;
  /** distinct objects holding a token here */
  objects: number;
  [key: string]: unknown;
}

const handleStyle: CSSProperties = { width: 1, height: 1, opacity: 0, border: 'none' };

/** A place is a Petri-net circle; source/sink keep the play/stop markers of the
 * OC-DFG renderer. A filled ring + count badge shows the live marking. */
export function PlaceNode({ data }: NodeProps & { data: PlaceNodeData }) {
  const boundary = data.kind !== 'normal';
  const d = boundary ? BOUNDARY_D : PLACE_R * 2;
  const marked = data.tokens > 0;
  return (
    <div style={{ display: 'grid', justifyItems: 'center', gap: boundary ? 5 : 0, position: 'relative' }} title={boundary ? `${data.objectType} ${data.kind}` : data.objectType}>
      <div
        style={{
          width: d, height: d, borderRadius: '50%',
          border: boundary ? `1.5px solid ${data.theme.text}` : `2px solid ${data.color}`,
          background: boundary ? data.color : (marked ? data.color : data.theme['bg-soft']),
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxSizing: 'border-box',
          boxShadow: marked ? `0 0 0 3px ${data.color}44` : undefined,
          transition: 'background 120ms, box-shadow 120ms',
        }}
      >
        <Handle type="target" position={Position.Left} style={handleStyle} />
        {data.kind === 'source' && <PlayGlyph color={data.theme.text} />}
        {data.kind === 'sink' && <StopGlyph color={data.theme.text} />}
        <Handle type="source" position={Position.Right} style={handleStyle} />
      </div>
      {marked && !boundary && (
        <span
          title={`${data.tokens} token${data.tokens === 1 ? '' : 's'} · ${data.objects} object${data.objects === 1 ? '' : 's'}`}
          style={{
            position: 'absolute', top: -8, right: -8, minWidth: 16, height: 16, padding: '0 3px',
            borderRadius: 8, background: data.theme.text, color: data.theme.bg,
            fontSize: 10, fontWeight: 700, lineHeight: '16px', textAlign: 'center',
            boxShadow: `0 0 0 1.5px ${data.theme.bg}`,
          }}
        >
          {data.tokens > 99 ? '99+' : data.tokens}
        </span>
      )}
      {boundary && (
        <span style={{ color: data.theme.text, fontSize: 12, fontWeight: 600, lineHeight: 1.1, maxWidth: 130, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {data.objectType}
        </span>
      )}
    </div>
  );
}

function PlayGlyph({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 25 25" style={{ pointerEvents: 'none' }}>
      <path d="M5 3 L22 12.5 L5 22 Z" fill={color} />
    </svg>
  );
}

function StopGlyph({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 25 25" style={{ pointerEvents: 'none' }}>
      <rect x="4" y="4" width="17" height="17" fill={color} />
    </svg>
  );
}
