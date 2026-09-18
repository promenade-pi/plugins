import { Handle, Position } from '@xyflow/react';
import { OP_GLYPH, OP_LABEL, OP_SIZE } from './layout';

const RING = 3;

export interface OperatorNodeData {
  operator: 'sequence' | 'xor' | 'parallel' | 'loop';
  relatedTypes: string[];
  typeColor: (t: string) => string;
  theme: Record<string, string>;
  horizontal: boolean;
  dimmed: boolean;
  [key: string]: unknown;
}

// van Detten's paper colors an operator's outline by the object type(s)
// its subtree actually touches, not by which operator it is — a solid ring
// when only one type is involved, a pie of even wedges (one per type) when
// several are. This is the same visual language as the leaf table's type
// column, so following a color from a leaf up to its ancestors is legible.
function ringBackground(colors: string[]): string {
  if (colors.length <= 1) return colors[0] ?? '#9aa1ac';
  const step = 100 / colors.length;
  return `conic-gradient(${colors.map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`).join(', ')})`;
}

export function OperatorNode({ data }: { data: OperatorNodeData }) {
  const target = data.horizontal ? Position.Left : Position.Top;
  const source = data.horizontal ? Position.Right : Position.Bottom;
  const colors = data.relatedTypes.length
    ? data.relatedTypes.map(data.typeColor)
    : [data.theme['text-dim'] ?? '#9aa1ac'];
  return (
    <div
      title={`${OP_LABEL[data.operator]}${data.relatedTypes.length ? ' — ' + data.relatedTypes.join(', ') : ''}`}
      style={{
        width: OP_SIZE,
        height: OP_SIZE,
        boxSizing: 'border-box',
        position: 'relative',
        borderRadius: '50%',
        background: ringBackground(colors),
        padding: RING,
        boxShadow: '0 1px 3px rgba(0,0,0,.12)',
        opacity: data.dimmed ? 0.15 : 1,
        transition: 'opacity 150ms',
      }}
    >
      <Handle type="target" position={target} style={{ opacity: 0 }} />
      <div
        style={{
          width: '100%',
          height: '100%',
          borderRadius: '50%',
          background: data.theme['bg-soft'] ?? '#f7f8fa',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 18,
          fontWeight: 700,
          color: data.theme.text ?? '#20242b',
        }}
      >
        {OP_GLYPH[data.operator] ?? '?'}
      </div>
      <Handle type="source" position={source} style={{ opacity: 0 }} />
    </div>
  );
}
