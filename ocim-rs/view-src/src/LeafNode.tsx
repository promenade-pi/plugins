import type { CSSProperties } from 'react';
import { Handle, Position } from '@xyflow/react';
import { neededColumns, TABLE_ROW_H, type TypeFlag } from './layout';

export interface LeafNodeData {
  label: string | null; // null = tau (silent step)
  types: TypeFlag[];
  showInteractionTable: boolean;
  compactSilent: boolean;
  selected: boolean;
  dimmed: boolean;
  theme: Record<string, string>;
  horizontal: boolean;
  color: string; // activity color, unused for tau
  typeColor: (t: string) => string;
  [key: string]: unknown;
}

// `box-sizing: border-box` on every cell so TABLE_ROW_H is the actual
// rendered row height including its border, not the content-box height
// plus border on top — the same content-box vs border-box mismatch that
// made the operator-node ring's edges fall short of the true circle
// (see the earlier gap fix); a table's rows would just silently overflow
// the leaf box here rather than break edge anchoring, but the fix is the
// same discipline.
const headerCellStyle = (theme: Record<string, string>): CSSProperties => ({
  boxSizing: 'border-box',
  height: TABLE_ROW_H,
  lineHeight: `${TABLE_ROW_H - 2}px`,
  padding: '0 4px',
  background: theme['bg-soft'] ?? '#eef0f3',
  color: theme['text-dim'] ?? '#6b7280',
  fontSize: 9,
  fontWeight: 700,
  border: `1px solid ${theme.border ?? '#dfe3ea'}`,
  whiteSpace: 'nowrap',
});

const flagCellStyle = (theme: Record<string, string>): CSSProperties => ({
  boxSizing: 'border-box',
  height: TABLE_ROW_H,
  lineHeight: `${TABLE_ROW_H - 2}px`,
  padding: '0 4px',
  textAlign: 'center',
  fontSize: 9,
  fontWeight: 800,
  color: theme.text ?? '#20242b',
  border: `1px solid ${theme.border ?? '#dfe3ea'}`,
});

export function LeafNode({ data }: { data: LeafNodeData }) {
  const target = data.horizontal ? Position.Left : Position.Top;
  const source = data.horizontal ? Position.Right : Position.Bottom;
  const opacity = data.dimmed ? 0.15 : 1;

  if (data.label == null) {
    // Sized by the layout (`TAU_COMPACT_SIZE` vs `OP_SIZE`), never hidden:
    // a tau is what makes an XOR branch optional or a loop 0..* vs 1..*
    // rather than mandatory, so dropping it from the tree would misrepresent
    // the model rather than just declutter the drawing. `compactSilent`
    // only shrinks and mutes the box React Flow already sized for it.
    return (
      <div
        title="silent step (τ)"
        style={{
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          position: 'relative',
          borderRadius: data.compactSilent ? 4 : 8,
          background: 'transparent',
          border: `${data.compactSilent ? 1 : 1.5}px dashed ${data.theme['text-dim'] ?? '#9aa1ac'}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: data.theme['text-dim'] ?? '#9aa1ac',
          fontSize: data.compactSilent ? 0 : 14,
          opacity: data.compactSilent ? opacity * 0.55 : opacity,
          transition: 'opacity 150ms',
        }}
      >
        <Handle type="target" position={target} style={{ opacity: 0 }} />
        {!data.compactSilent && 'τ'}
        <Handle type="source" position={source} style={{ opacity: 0 }} />
      </div>
    );
  }

  const cols = data.showInteractionTable ? neededColumns(data.types) : { div: false, con: false, def: false };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        borderRadius: 7,
        background: data.selected ? (data.theme['accent-soft'] ?? '#e8efff') : (data.theme.bg ?? '#fff'),
        border: `1.5px solid ${data.color}`,
        boxShadow: data.selected ? `0 0 0 2px ${data.color}55` : '0 1px 2px rgba(0,0,0,.08)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '4px 8px',
        gap: 4,
        cursor: 'pointer',
        boxSizing: 'border-box',
        position: 'relative',
        opacity,
        transition: 'opacity 150ms',
      }}
    >
      <Handle type="target" position={target} style={{ opacity: 0 }} />
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: data.theme.text ?? '#20242b',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: '100%',
        }}
      >
        {data.label}
      </div>
      {data.showInteractionTable && data.types.length > 0 && (
        <table style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={headerCellStyle(data.theme)}>Type</th>
              {cols.div && <th style={headerCellStyle(data.theme)}>Div</th>}
              {cols.con && <th style={headerCellStyle(data.theme)}>Con</th>}
              {cols.def && <th style={headerCellStyle(data.theme)}>Def</th>}
            </tr>
          </thead>
          <tbody>
            {data.types.map((t) => (
              <tr key={t.type}>
                <td
                  title={t.type}
                  style={{
                    boxSizing: 'border-box',
                    height: TABLE_ROW_H,
                    lineHeight: `${TABLE_ROW_H - 2}px`,
                    padding: '0 5px',
                    background: data.typeColor(t.type),
                    color: '#fff',
                    fontSize: 9,
                    fontWeight: 700,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxWidth: 110,
                    border: `1px solid ${data.theme.border ?? '#dfe3ea'}`,
                  }}
                >
                  {t.type}
                </td>
                {cols.div && <td style={flagCellStyle(data.theme)}>{t.divergent ? 'X' : ''}</td>}
                {cols.con && <td style={flagCellStyle(data.theme)}>{t.convergent ? 'X' : ''}</td>}
                {cols.def && <td style={flagCellStyle(data.theme)}>{t.deficient ? 'X' : ''}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Handle type="source" position={source} style={{ opacity: 0 }} />
    </div>
  );
}
