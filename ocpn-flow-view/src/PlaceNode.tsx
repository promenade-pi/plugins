import type { CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { OcpnPlaceKind } from './types';
import { BOUNDARY_D, BOUNDARY_LABEL_MAX_W, PLACE_R, type FlowDirection } from './layout';

export interface PlaceNodeData {
  kind: OcpnPlaceKind;
  objectType: string;
  color: string;
  selected: boolean;
  direction: FlowDirection;
  theme: Record<string, string>;
  [key: string]: unknown;
}

/** Normal places retain Petri-net notation. Source/sink places use the same
 * labelled, filled play/stop markers as the OC-DFG React Flow renderer.
 *
 * A boundary place's label is positioned out of flow so its circle always
 * sits exactly at the node's own origin, which is where ELK routed the arcs
 * to. Which side it takes is whichever side the flow does *not* leave by:
 * under the circle when the net runs left to right, and above a source /
 * below a sink when it runs top to bottom — otherwise a vertical source
 * place's outgoing arcs would be drawn straight through its own label. */
export function PlaceNode({ data }: NodeProps & { data: PlaceNodeData }) {
  const boundary = data.kind !== 'normal';
  const d = boundary ? BOUNDARY_D : PLACE_R * 2;
  const vertical = data.direction === 'DOWN';
  const labelAbove = vertical && data.kind === 'source';
  return (
    <div
      style={{ position: 'relative', width: boundary ? '100%' : d, height: d, cursor: 'pointer' }}
      title={boundary ? `${data.objectType} ${data.kind}` : data.objectType}
    >
      <div
        style={{
          position: 'absolute', left: '50%', top: 0, transform: 'translateX(-50%)',
          width: d, height: d, borderRadius: '50%',
          border: boundary ? `1.5px solid ${data.theme.text}` : `2px solid ${data.color}`,
          background: boundary ? data.color : (data.selected ? data.color : data.theme['bg-soft']),
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxSizing: 'border-box',
          boxShadow: data.selected ? `0 0 0 2px ${data.theme.accent}` : undefined,
        }}
      >
        <Handle type="target" position={vertical ? Position.Top : Position.Left} style={handleStyle} />
        {data.kind === 'source' && <PlayGlyph color={data.theme.text} />}
        {data.kind === 'sink' && <StopGlyph color={data.theme.text} />}
        <Handle type="source" position={vertical ? Position.Bottom : Position.Right} style={handleStyle} />
      </div>
      {boundary && (
        <span style={{
          position: 'absolute', left: '50%', transform: 'translateX(-50%)',
          ...(labelAbove ? { bottom: BOUNDARY_D + 5 } : { top: BOUNDARY_D + 5 }),
          color: data.theme.text, fontSize: 12, fontWeight: 600, lineHeight: 1.1,
          maxWidth: BOUNDARY_LABEL_MAX_W, textAlign: 'center',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {data.objectType}
        </span>
      )}
    </div>
  );
}

const handleStyle: CSSProperties = { width: 1, height: 1, opacity: 0, border: 'none' };

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
