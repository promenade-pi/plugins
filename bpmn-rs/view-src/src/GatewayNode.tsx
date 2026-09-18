import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { BpmnNodeKind } from './types';

export interface GatewayNodeData {
  kind: Extract<BpmnNodeKind, 'exclusiveGateway' | 'parallelGateway' | 'inclusiveGateway'>;
  selected: boolean;
  theme: Record<string, string>;
  [key: string]: unknown;
}

const handleStyle = { width: 1, height: 1, opacity: 0, border: 'none' } as const;

const GLYPH: Record<GatewayNodeData['kind'], string> = {
  exclusiveGateway: '✕',
  parallelGateway: '+',
  inclusiveGateway: '○',
};

const TITLE: Record<GatewayNodeData['kind'], string> = {
  exclusiveGateway: 'Exclusive gateway (XOR)',
  parallelGateway: 'Parallel gateway (AND)',
  inclusiveGateway: 'Inclusive gateway (OR)',
};

/** The classic BPMN diamond, drawn as a square rotated 45°. The glyph inside
 * is counter-rotated back to upright — a rotated ✕/+/○ would misread. */
export function GatewayNode({ data }: NodeProps & { data: GatewayNodeData }) {
  return (
    <div title={TITLE[data.kind]} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        style={{
          position: 'absolute', inset: 6, transform: 'rotate(45deg)',
          border: `1.5px solid ${data.selected ? data.theme.accent : data.theme.border}`,
          background: data.selected ? data.theme['bg-soft'] : data.theme.bg,
          boxShadow: data.selected ? `0 0 0 2px ${data.theme.accent}` : undefined,
          cursor: 'pointer',
        }}
      />
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 16, fontWeight: 700, color: data.theme.text, pointerEvents: 'none',
      }}>
        {GLYPH[data.kind]}
      </div>
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </div>
  );
}
