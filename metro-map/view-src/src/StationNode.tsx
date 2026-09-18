import { Handle, Position, type NodeProps } from '@xyflow/react';
// Footprint constants live in `metro-layout` because the router and the
// geometry checks need exactly the numbers this component draws with.
import { STATION_BOX_H, STATION_BOX_W, stationDiameter } from 'metro-layout';
import type { StationStyle } from './types';

export interface StationNodeData {
  activity: string;
  objectTypes: Array<{ name: string; color: string }>;
  selected: boolean;
  faded: boolean;
  style: StationStyle;
  /** Observed frequency (OC-DFG basis) — shown under the name when `showNumber`. */
  count?: number;
  showNumber: boolean;
  theme: Record<string, string>;
  [key: string]: unknown;
}

function ringBackground(objectTypes: StationNodeData['objectTypes'], fallback: string): string {
  if (objectTypes.length <= 1) return objectTypes[0]?.color ?? fallback;
  return `conic-gradient(${objectTypes
    .map((t, i) => {
      const a = (i / objectTypes.length) * 360;
      const b = ((i + 1) / objectTypes.length) * 360;
      return `${t.color} ${a}deg ${b}deg`;
    })
    .join(', ')})`;
}

const fmt = (n: number) => n.toLocaleString('en');

/** A station shared by several object types gets a bigger, multi-coloured
 * ring — the same idea a real transit map uses for an interchange stop. In
 * the `'labels'` style it becomes a rounded rectangle carrying the name (and
 * count), but keeps the metro-map
 * multi-colour cue as its border. */
export function StationNode({ data }: NodeProps & { data: StationNodeData }) {
  const ring = ringBackground(data.objectTypes, data.theme.border);
  const showNum = data.showNumber && data.count != null;

  if (data.style === 'labels') {
    // The ring is drawn as a `background` behind an inset content div, not a
    // `border`/`border-image` on the box itself — `border-image` (needed for
    // the multi-colour conic-gradient ring) ignores `border-radius` in every
    // browser, so a shared, multi-type station rendered with square corners
    // while a single-type station (plain `border-color`, which does respect
    // radius) rendered rounded. This draws both the same way, so both round.
    return (
      <div
        title={data.activity}
        style={{
          width: STATION_BOX_W, minHeight: STATION_BOX_H, boxSizing: 'border-box',
          display: 'flex', borderRadius: 8, padding: 2, background: ring,
          boxShadow: data.selected ? `0 0 0 3px ${data.theme.accent}` : '0 1px 3px rgba(0,0,0,.12)',
          cursor: 'pointer', opacity: data.faded ? 0.2 : 1, transition: 'opacity 120ms',
        }}
      >
        <Handle type="target" position={Position.Top} style={handleStyle} />
        <div style={{
          flex: 1, minWidth: 0, boxSizing: 'border-box', borderRadius: 6,
          background: data.theme['bg-soft'] ?? data.theme.bg,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 1, padding: '4px 8px',
        }}>
          <span style={{
            color: data.theme.text, fontSize: 11, fontWeight: 700, lineHeight: 1.15, maxWidth: 116,
            textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {data.activity}
          </span>
          {showNum && (
            <span style={{ color: data.theme['text-dim'], fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
              {fmt(data.count as number)}
            </span>
          )}
        </div>
        <Handle type="source" position={Position.Bottom} style={handleStyle} />
      </div>
    );
  }

  const d = stationDiameter(data.objectTypes.length);
  return (
    <div
      style={{ display: 'grid', justifyItems: 'center', gap: 4, cursor: 'pointer', opacity: data.faded ? 0.2 : 1, transition: 'opacity 120ms' }}
      title={data.activity}
    >
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <div
        style={{
          width: d, height: d, borderRadius: '50%', boxSizing: 'border-box',
          background: ring, padding: 3,
          boxShadow: data.selected ? `0 0 0 3px ${data.theme.accent}` : undefined,
        }}
      >
        <div style={{ width: '100%', height: '100%', borderRadius: '50%', background: data.theme.bg }} />
      </div>
      <span
        style={{
          color: data.theme.text, fontSize: 11, fontWeight: 600, lineHeight: 1.15, maxWidth: 96,
          textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          background: `${data.theme.bg}cc`, borderRadius: 3, padding: '1px 4px',
        }}
      >
        {data.activity}
        {showNum && <span style={{ color: data.theme['text-dim'], fontWeight: 400 }}>{'  '}{fmt(data.count as number)}</span>}
      </span>
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
    </div>
  );
}

const handleStyle = { width: 1, height: 1, opacity: 0, border: 'none' } as const;
