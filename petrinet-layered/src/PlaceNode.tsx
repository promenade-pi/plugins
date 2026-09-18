import { Handle, Position, type NodeProps } from '@xyflow/react';
import { PLACE_D, type FlowDirection } from './layout';

export interface PlaceNodeData {
  initial: boolean;
  final: boolean;
  selected: boolean;
  direction: FlowDirection;
  theme: Record<string, string>;
  [key: string]: unknown;
}

/** Classical accepting-Petri-net notation: token in the initial marking,
 * double-lined place in the final marking. No OC-DFG play/stop glyphs. */
export function PlaceNode({ data }: NodeProps & { data: PlaceNodeData }) {
  const stroke = data.selected ? data.theme.accent : data.theme['text-dim'];
  const vertical = data.direction === 'DOWN';
  return (
    <div title={`${data.initial ? 'initial ' : ''}${data.final ? 'final ' : ''}place`} style={{ width: PLACE_D, height: PLACE_D, position: 'relative' }}>
      <Handle type="target" position={vertical ? Position.Top : Position.Left} style={handleStyle} />
      <div style={{
        width: PLACE_D, height: PLACE_D, borderRadius: '50%', boxSizing: 'border-box',
        border: `2px solid ${stroke}`, background: data.theme.bg,
        display: 'grid', placeItems: 'center',
      }}>
        {data.final && <span style={{ position: 'absolute', inset: 4, borderRadius: '50%', border: `1.4px solid ${stroke}` }} />}
        {data.initial && <span style={{ width: 7, height: 7, borderRadius: '50%', background: data.theme.text, zIndex: 1 }} />}
      </div>
      <Handle type="source" position={vertical ? Position.Bottom : Position.Right} style={handleStyle} />
    </div>
  );
}

const handleStyle = { width: 1, height: 1, opacity: 0, border: 'none' } as const;

