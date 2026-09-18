import { Handle, Position } from '@xyflow/react';
import { typeColorOf, attrTypeColor, EVENT_TYPE_COLOR } from '../colors';

export const NODE_WIDTH = 250;
const HEADER_H = 40;
const ROW_H = 26;

export function nodeHeightOf(attributeCount: number): number {
  return HEADER_H + Math.max(attributeCount * ROW_H + 12, 18 + 12);
}

export interface TypeNodeData {
  name: string;
  attributes: Array<{ name: string; type: string }>;
  colorIndex?: number;
  kind: 'object' | 'event';
  [key: string]: unknown;
}

/** One box per object/event type — a colored header (rotating palette,
 * index-keyed for object types; always the same neutral tan for event
 * types) plus a list of declared-attribute badges. Ported from Ocelot's
 * `ObjectTypeNode`/`EventTypeNode`. */
export function TypeNode({ data }: { data: TypeNodeData }) {
  const c = data.kind === 'event' ? EVENT_TYPE_COLOR : typeColorOf(data.colorIndex ?? 0);
  return (
    <div style={{
      width: NODE_WIDTH, border: `1px solid ${c.border}`, borderRadius: 8,
      background: 'var(--bg, #fff)', overflow: 'hidden', fontSize: 12,
    }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <div style={{
        display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px',
        background: c.bg, borderBottom: `1px solid ${c.border}`, height: HEADER_H, boxSizing: 'border-box',
      }}>
        <TypeGlyph kind={data.kind} color={c.icon} />
        <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.name}</strong>
      </div>
      <div style={{ padding: data.attributes.length ? '6px 8px' : '10px 10px' }}>
        {data.attributes.length === 0 && (
          <div style={{ height: 18, background: 'var(--bg-sunken, #efeae0)', borderRadius: 4 }} />
        )}
        {data.attributes.map((a) => (
          <div key={a.name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 2px', minHeight: ROW_H - 6 }}>
            <span className="oc-badge" style={{ background: attrTypeColor(a.type) }}>{a.type}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TypeGlyph({ kind, color }: { kind: 'object' | 'event'; color: string }) {
  if (kind === 'event') {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill={color} aria-hidden="true">
        <path d="M9 1 2 9h4.5L6 15l7-8H8.5z" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.6" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="2.5" />
    </svg>
  );
}
