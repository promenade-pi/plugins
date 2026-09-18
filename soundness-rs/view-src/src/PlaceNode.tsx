import { Handle, Position, type NodeProps } from '@xyflow/react';
import { PLACE_D } from './layout';

export interface PlaceNodeData {
  initial: boolean;
  final: boolean;
  /** Set when the selected finding names this place. */
  highlight: 'error' | 'warning' | null;
  /** Tokens this place holds in the selected witness marking, or `null` when
   *  no witness is shown and the initial marking is what to draw. */
  witnessTokens: number | null;
  role: string;
  theme: Record<string, string>;
  [key: string]: unknown;
}

/** Classical accepting-Petri-net notation — token in the initial marking,
 *  double ring in the final one — with two additions the diagnosis needs: a
 *  coloured halo when a finding names this place, and the witness marking's
 *  own token count drawn inside it, because "where the tokens are when
 *  everything stops" is the whole content of a deadlock report. */
export function PlaceNode({ data }: NodeProps & { data: PlaceNodeData }) {
  const accent =
    data.highlight === 'error' ? data.theme.danger : data.highlight === 'warning' ? data.theme.warn : null;
  const stroke = accent ?? data.theme['text-dim'];
  return (
    <div title={data.role} style={{ width: PLACE_D, height: PLACE_D, position: 'relative' }}>
      <Handle type="target" position={Position.Left} style={handleStyle} />
      {accent && (
        <span style={{
          position: 'absolute', inset: -5, borderRadius: '50%',
          border: `2px solid ${accent}`, opacity: 0.45,
        }} />
      )}
      <div style={{
        width: PLACE_D, height: PLACE_D, borderRadius: '50%', boxSizing: 'border-box',
        border: `${accent ? 2.5 : 2}px solid ${stroke}`, background: data.theme.bg,
        display: 'grid', placeItems: 'center',
      }}>
        {data.final && <span style={{ position: 'absolute', inset: 4, borderRadius: '50%', border: `1.4px solid ${stroke}` }} />}
        <Tokens data={data} accent={accent} />
      </div>
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </div>
  );
}

/** With a witness selected the place shows *that* marking; without one it
 *  falls back to the net's own initial marking, which is what a Petri net is
 *  normally drawn with. */
function Tokens({ data, accent }: { data: PlaceNodeData; accent: string | null }) {
  const count = data.witnessTokens ?? (data.initial ? 1 : 0);
  const colour = data.witnessTokens != null ? (accent ?? data.theme.accent) : data.theme.text;
  if (count === 0) return null;
  if (count > 1) {
    return <span style={{ fontSize: 11, fontWeight: 700, color: colour, zIndex: 1 }}>{count}</span>;
  }
  return <span style={{ width: 7, height: 7, borderRadius: '50%', background: colour, zIndex: 1 }} />;
}

const handleStyle = { width: 1, height: 1, opacity: 0, border: 'none' } as const;
