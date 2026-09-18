import { Handle, Position, type NodeProps } from '@xyflow/react';
import { BOUNDARY_D, BOUNDARY_LABEL_MAX_W, type FlowDirection } from './layout';

export interface BoundaryNodeData {
  objectType: string;
  kind: 'source' | 'sink';
  color: string;
  selected: boolean;
  direction: FlowDirection;
  theme: Record<string, string>;
  [key: string]: unknown;
}

/** Start/end markers mirror the familiar OC-DFG notation: a coloured circle
 * labelled with its object type, containing a play or stop glyph.
 *
 * The label is positioned out of flow so the circle always sits exactly at
 * the node's own origin, which is where ELK routed the arcs to. Which side
 * it takes is whichever side the flow does *not* leave by: under the circle
 * when the flow is horizontal, and above a source / below a sink when it is
 * vertical — otherwise a top-to-bottom source's outgoing arcs would be drawn
 * straight through its own label. */
export function BoundaryNode({ data }: NodeProps & { data: BoundaryNodeData }) {
  const isSource = data.kind === 'source';
  const vertical = data.direction === 'DOWN';
  const labelAbove = vertical && isSource;
  return (
    <div style={{ position: 'relative', width: '100%', height: BOUNDARY_D, cursor: 'pointer' }} title={`${data.objectType} ${data.kind}`}>
      <div style={{
        position: 'absolute', left: '50%', top: 0, transform: 'translateX(-50%)',
        width: BOUNDARY_D, height: BOUNDARY_D, borderRadius: '50%', boxSizing: 'border-box',
        border: `1.5px solid ${data.theme.text}`, background: data.color,
        display: 'grid', placeItems: 'center',
        boxShadow: data.selected ? `0 0 0 3px ${data.theme.accent}` : undefined,
      }}>
        {isSource && <Handle type="source" position={vertical ? Position.Bottom : Position.Right} style={handleStyle} />}
        {!isSource && <Handle type="target" position={vertical ? Position.Top : Position.Left} style={handleStyle} />}
        {isSource
          ? <svg width="13" height="13" viewBox="0 0 25 25" aria-hidden="true"><path d="M5 3 L22 12.5 L5 22 Z" fill={data.theme.text} /></svg>
          : <svg width="13" height="13" viewBox="0 0 25 25" aria-hidden="true"><rect x="4" y="4" width="17" height="17" fill={data.theme.text} /></svg>}
      </div>
      <span style={{
        position: 'absolute', left: '50%', transform: 'translateX(-50%)',
        ...(labelAbove ? { bottom: BOUNDARY_D + 5 } : { top: BOUNDARY_D + 5 }),
        color: data.theme.text, fontSize: 12, fontWeight: 600, lineHeight: 1.1,
        maxWidth: BOUNDARY_LABEL_MAX_W, textAlign: 'center',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {data.objectType}
      </span>
    </div>
  );
}

const handleStyle = { width: 1, height: 1, opacity: 0, border: 'none' } as const;
