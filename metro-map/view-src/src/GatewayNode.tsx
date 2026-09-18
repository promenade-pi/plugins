import { Handle, Position, type NodeProps } from '@xyflow/react';
import { GATEWAY_D } from 'metro-layout';

export interface GatewayNodeData {
  gatewayType: 'and' | 'xor';
  direction: 'split' | 'join' | 'both';
  color: string;
  faded: boolean;
  theme: Record<string, string>;
  [key: string]: unknown;
}

/** A small diamond interchange marker — "×" for a choice (XOR), "+" for
 * genuine parallelism (AND), read directly off the OCPN's own branching
 * places/silent transitions rather than invented from frequency alone. */
export function GatewayNode({ data }: NodeProps & { data: GatewayNodeData }) {
  const glyph = data.gatewayType === 'xor' ? '×' : '+';
  return (
    <div
      title={`${data.gatewayType.toUpperCase()} ${data.direction}`}
      style={{
        width: GATEWAY_D, height: GATEWAY_D, transform: 'rotate(45deg)', boxSizing: 'border-box',
        border: `2px solid ${data.color}`, background: data.theme.bg, display: 'grid', placeItems: 'center',
        opacity: data.faded ? 0.2 : 1, transition: 'opacity 120ms',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ ...handleStyle, transform: 'rotate(-45deg)' }} />
      <span style={{ transform: 'rotate(-45deg)', color: data.color, fontWeight: 700, fontSize: 13, lineHeight: 1 }}>
        {glyph}
      </span>
      <Handle type="source" position={Position.Bottom} style={{ ...handleStyle, transform: 'rotate(-45deg)' }} />
    </div>
  );
}

const handleStyle = { width: 1, height: 1, opacity: 0, border: 'none' } as const;
