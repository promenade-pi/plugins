import { useEffect, useMemo, useState } from 'react';
import { metricLabel, weightLabel, type SocialNetworkPayload } from './types';
import { useParams, useSize, useTheme } from './bootstrap';
import { resourceColor } from './palette';

interface Params { order: 'weight' | 'name' | 'events' }

/**
 * The same network as an adjacency matrix.
 *
 * Past about forty people a node-link diagram stops being readable at any
 * layout quality — the edges cross more than they connect. A matrix does not
 * degrade: every pair has a cell whether or not it has a relation, nothing
 * overlaps, and the ordering does the work a layout would. It is also the
 * only view in which "who does this person *not* work with" is visible,
 * which is half of what an organisational question usually is.
 *
 * Rows are the source of the relation and columns the target, so an
 * asymmetric metric reads as an asymmetric picture; an undirected one is
 * mirrored explicitly rather than drawn as a triangle, because a half-filled
 * square reads as missing data.
 */
export function MatrixView({ payload }: { payload: SocialNetworkPayload }) {
  const theme = useTheme();
  const size = useSize();
  const p = useParams<Params>({ order: 'weight' });
  const [hover, setHover] = useState<{ row: number; col: number } | null>(null);

  useEffect(() => { try { promenade.ready(); } catch { /* host not listening */ } }, []);

  const fg = theme.text ?? '#1c2027';
  const dim = theme['text-dim'] ?? '#697386';
  const bg = theme.bg ?? '#fff';
  const border = theme.border ?? '#e3e6ea';
  const accent = theme.accent ?? '#0072B2';
  const danger = theme.danger ?? '#d33';

  const order = useMemo(() => {
    const idx = payload.nodes.map((_, i) => i);
    const n = payload.nodes;
    if (p.order === 'name') {
      return idx.sort((a, b) => payload.resources[a].localeCompare(payload.resources[b]));
    }
    if (p.order === 'events') return idx.sort((a, b) => n[b].events - n[a].events);
    return idx.sort((a, b) =>
      (n[b].outWeight + n[b].inWeight) - (n[a].outWeight + n[a].inWeight)
      || n[b].events - n[a].events);
  }, [p.order, payload.nodes, payload.resources]);

  const cells = useMemo(() => {
    const m = new Map<number, { weight: number; raw: number }>();
    const key = (r: number, c: number) => r * payload.nodes.length + c;
    for (const e of payload.edges) {
      m.set(key(e.from, e.to), { weight: e.weight, raw: e.raw });
      // An undirected pair is stored once by the kernel; the matrix shows
      // both halves so the square is complete.
      if (!payload.directed) m.set(key(e.to, e.from), { weight: e.weight, raw: e.raw });
    }
    return m;
  }, [payload.edges, payload.directed, payload.nodes.length]);

  const n = order.length;
  const maxAbs = Math.max(1e-9, ...payload.edges.map((e) => Math.abs(e.weight)));

  // The label gutter has to fit the names, and the cells have to stay square
  // and big enough to hit with a pointer.
  const gutter = Math.min(150, Math.max(70, size.w * 0.18));
  const available = Math.min(size.w - gutter - 24, size.h - gutter - 96);
  const cell = n > 0 ? Math.max(6, Math.min(26, available / n)) : 10;
  const grid = cell * n;
  const font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  const hovered = hover
    ? cells.get(order[hover.row] * payload.nodes.length + order[hover.col])
    : undefined;

  return (
    <div style={{ width: '100%', height: '100%', background: bg, color: fg, font, overflow: 'auto' }}>
      <div style={{
        display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap',
        padding: '10px 14px 8px', borderBottom: `1px solid ${border}`,
      }}>
        <b style={{ fontSize: 13 }}>{metricLabel(payload.metric)}</b>
        <span style={{ color: dim, fontSize: 11.5 }}>
          {n} people · rows hand over to columns
          {!payload.directed && ' (symmetric)'}
        </span>
      </div>

      <svg width={gutter + grid + 16} height={gutter + grid + 16} style={{ display: 'block' }}>
        {/* Column names, rotated so a long name does not force a wide cell. */}
        {order.map((r, i) => (
          <text key={`c${r}`}
                transform={`translate(${gutter + i * cell + cell / 2},${gutter - 6}) rotate(-60)`}
                fontSize={Math.min(11, cell * 0.85)}
                fill={hover?.col === i ? resourceColor(payload.resources[r]) : dim}
                textAnchor="start">
            {payload.resources[r].length > 18 ? `${payload.resources[r].slice(0, 17)}…` : payload.resources[r]}
          </text>
        ))}
        {order.map((r, i) => (
          <text key={`r${r}`} x={gutter - 6} y={gutter + i * cell + cell / 2 + 3}
                fontSize={Math.min(11, cell * 0.85)}
                fill={hover?.row === i ? resourceColor(payload.resources[r]) : dim}
                textAnchor="end">
            {payload.resources[r].length > 18 ? `${payload.resources[r].slice(0, 17)}…` : payload.resources[r]}
          </text>
        ))}

        {order.map((rowRes, row) => order.map((colRes, col) => {
          const v = cells.get(rowRes * payload.nodes.length + colRes);
          const t = v ? Math.abs(v.weight) / maxAbs : 0;
          const on = hover && (hover.row === row || hover.col === col);
          return (
            <rect key={`${row}-${col}`}
                  x={gutter + col * cell} y={gutter + row * cell}
                  width={Math.max(1, cell - 1)} height={Math.max(1, cell - 1)}
                  fill={v ? (v.weight < 0 ? danger : accent) : fg}
                  fillOpacity={v ? 0.12 + t * 0.88 : (on ? 0.06 : 0.03)}
                  onMouseEnter={() => setHover({ row, col })}
                  onMouseLeave={() => setHover(null)}>
              <title>
                {payload.resources[rowRes]} {payload.directed ? '→' : '↔'} {payload.resources[colRes]}
                {'\n'}{v ? `${v.weight.toFixed(4)} ${weightLabel(payload.weightKind)} (raw ${v.raw.toLocaleString()})`
                         : 'no relation'}
              </title>
            </rect>
          );
        }))}

        {/* The diagonal, marked rather than filled: a person's relation to
            themselves is either dropped by the miner or meaningless here. */}
        {order.map((_, i) => (
          <rect key={`d${i}`} x={gutter + i * cell} y={gutter + i * cell}
                width={Math.max(1, cell - 1)} height={Math.max(1, cell - 1)}
                fill="none" stroke={border} strokeWidth={0.8} />
        ))}
      </svg>

      <div style={{ padding: '7px 14px', borderTop: `1px solid ${border}`, color: dim, fontSize: 11 }}>
        {hover
          ? <>
              <b style={{ color: fg }}>{payload.resources[order[hover.row]]}</b>
              {payload.directed ? ' → ' : ' ↔ '}
              <b style={{ color: fg }}>{payload.resources[order[hover.col]]}</b>
              {' — '}
              {hovered
                ? `${hovered.weight.toFixed(4)} ${weightLabel(payload.weightKind)}`
                : 'no relation'}
            </>
          : `Darker is stronger. ${payload.stats.edgesBeforePruning.toLocaleString()} pairs have a relation at all.`}
      </div>
    </div>
  );
}
