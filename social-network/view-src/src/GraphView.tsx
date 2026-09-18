import { useEffect, useMemo, useState } from 'react';
import { layoutGraph, nodeRadius, type LayoutKind } from './layout';
import { prunedEdges, isolatedNodes } from './prune';
import { metricLabel, weightLabel, type SocialNetworkPayload } from './types';
import { useParams, useSize, useTheme } from './bootstrap';
import { resourceColor } from './palette';

interface Params { layout: LayoutKind; edgeShare: number; labels: boolean }

/**
 * The network, drawn.
 *
 * Three things carry meaning and nothing else does: an edge's thickness is
 * its weight, a node's area is how much of the log that person touched, and
 * distance is relatedness (see `layout.ts`). Colour is identity only, and
 * stable per person across both of this plugin's views (see `palette.ts`).
 */
export function GraphView({ payload }: { payload: SocialNetworkPayload }) {
  const theme = useTheme();
  const size = useSize();
  const p = useParams<Params>({ layout: 'stress', edgeShare: 1, labels: true });
  const [hover, setHover] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => { try { promenade.ready(); } catch { /* host not listening */ } }, []);

  const fg = theme.text ?? '#1c2027';
  const dim = theme['text-dim'] ?? '#697386';
  const bg = theme.bg ?? '#fff';
  const border = theme.border ?? '#e3e6ea';

  const width = size.w;
  const height = Math.max(240, size.h - 92);

  const edges = useMemo(
    () => prunedEdges(payload.edges, p.edgeShare),
    [payload.edges, p.edgeShare],
  );

  // A node's size is its share of the log's events — the honest measure of
  // "how much of this process goes through this person", and one that does
  // not change when the edge cut moves.
  const sizes = useMemo(() => {
    const max = Math.max(1, ...payload.nodes.map((n) => n.events));
    return payload.nodes.map((n) => n.events / max);
  }, [payload.nodes]);

  const positions = useMemo(
    () => layoutGraph(p.layout, {
      count: payload.nodes.length,
      edges: edges.map((e) => ({ from: e.from, to: e.to, weight: Math.abs(e.weight) })),
      size: sizes, width, height,
    }),
    [p.layout, payload.nodes.length, edges, sizes, width, height],
  );

  const isolated = useMemo(
    () => isolatedNodes(payload.nodes.length, edges),
    [payload.nodes.length, edges],
  );

  const maxWeight = Math.max(1e-9, ...edges.map((e) => Math.abs(e.weight)));
  const colorOf = (i: number) => resourceColor(payload.resources[i]);

  // Hovering or selecting a person dims everyone they have nothing to do with
  // — the fastest way to read one row out of a hairball.
  const focus = hover ?? selected;
  const neighbours = useMemo(() => {
    if (focus == null) return null;
    const set = new Set<number>([focus]);
    for (const e of edges) {
      if (e.from === focus) set.add(e.to);
      if (e.to === focus) set.add(e.from);
    }
    return set;
  }, [focus, edges]);
  const lit = (i: number) => !neighbours || neighbours.has(i);

  const pick = (i: number | null) => {
    setSelected(i);
    try {
      promenade.select(i == null ? [] : [{ kind: 'activity', id: payload.resources[i] }]);
    } catch { /* host not listening */ }
  };

  const font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  return (
    <div style={{ width: '100%', height: '100%', background: bg, color: fg, font, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap',
        padding: '10px 14px 8px', borderBottom: `1px solid ${border}`,
      }}>
        <b style={{ fontSize: 13 }}>{metricLabel(payload.metric)}</b>
        <span style={{ color: dim, fontSize: 11.5 }}>
          {payload.resources.length} people · {edges.length} of {payload.edges.length} relations shown
          {payload.stats.resourcesOmitted > 0 && ` · ${payload.stats.resourcesOmitted} omitted by the resource limit`}
          {payload.stats.eventsWithoutResource > 0
            && ` · ${payload.stats.eventsWithoutResource.toLocaleString()} events with nobody named`}
        </span>
      </div>

      <svg width={width} height={height} style={{ display: 'block' }}
           onClick={() => pick(null)}>
        <defs>
          <marker id="sn-arrow" viewBox="0 0 8 8" refX="7" refY="4"
                  markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" fill={dim} />
          </marker>
        </defs>

        {edges.map((e, i) => {
          const a = positions[e.from], b = positions[e.to];
          if (!a || !b) return null;
          const on = lit(e.from) && lit(e.to);
          const t = Math.abs(e.weight) / maxWeight;
          // The arrowhead has to stop at the node's edge, not at its centre,
          // or it disappears under the circle it points at.
          const dx = b.x - a.x, dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const rb = nodeRadius(sizes[e.to]) + 5;
          const ra = nodeRadius(sizes[e.from]) + 1;
          return (
            <line key={i}
              x1={a.x + (dx / len) * ra} y1={a.y + (dy / len) * ra}
              x2={b.x - (dx / len) * rb} y2={b.y - (dy / len) * rb}
              stroke={e.weight < 0 ? (theme.danger ?? '#d33') : dim}
              strokeWidth={0.6 + t * 4.5}
              opacity={on ? 0.2 + t * 0.55 : 0.06}
              markerEnd={payload.directed ? 'url(#sn-arrow)' : undefined}>
              <title>
                {payload.resources[e.from]} {payload.directed ? '→' : '↔'} {payload.resources[e.to]}
                {'\n'}{e.weight.toFixed(4)} {weightLabel(payload.weightKind)} (raw {e.raw.toLocaleString()})
              </title>
            </line>
          );
        })}

        {payload.nodes.map((n, i) => {
          const pos = positions[i];
          if (!pos) return null;
          const r = nodeRadius(sizes[i]);
          const on = lit(i);
          const alone = isolated.has(i);
          return (
            <g key={i} transform={`translate(${pos.x},${pos.y})`}
               style={{ cursor: 'pointer' }}
               onMouseEnter={() => setHover(i)}
               onMouseLeave={() => setHover(null)}
               onClick={(ev) => { ev.stopPropagation(); pick(selected === i ? null : i); }}>
              <circle r={r}
                      fill={colorOf(i)}
                      fillOpacity={on ? (alone ? 0.25 : 0.75) : 0.12}
                      stroke={selected === i ? fg : colorOf(i)}
                      strokeWidth={selected === i ? 2.5 : 1.2}
                      strokeOpacity={on ? 1 : 0.2} />
              <title>
                {payload.resources[i]}
                {'\n'}{n.events.toLocaleString()} events · {n.cases.toLocaleString()} cases
                {' '}· {n.activities} activities
                {payload.directed
                  ? `\nout ${n.outWeight.toFixed(4)} · in ${n.inWeight.toFixed(4)}`
                  : `\nrelated weight ${n.outWeight.toFixed(4)}`}
                {alone ? '\nno relation survives the current cut' : ''}
              </title>
            </g>
          );
        })}

        {/* Labels last, as their own pass: drawn inside each node's group
            they sit in document order, so a node laid out later covers the
            name of one laid out earlier. Nothing may be painted over a name
            — an unreadable label is worse than a crowded one. */}
        {p.labels && payload.nodes.map((_, i) => {
          const pos = positions[i];
          if (!pos) return null;
          const on = lit(i);
          return (
            <text key={`l${i}`} x={pos.x} y={pos.y + nodeRadius(sizes[i]) + 11}
                  textAnchor="middle" fontSize={10}
                  fill={on ? fg : dim} opacity={on ? 0.9 : 0.25}
                  style={{ pointerEvents: 'none' }}
                  stroke={bg} strokeWidth={2.5} paintOrder="stroke">
              {payload.resources[i].length > 16
                ? `${payload.resources[i].slice(0, 15)}…`
                : payload.resources[i]}
            </text>
          );
        })}
      </svg>

      <div style={{
        padding: '7px 14px', borderTop: `1px solid ${border}`, color: dim, fontSize: 11,
        display: 'flex', gap: 16, flexWrap: 'wrap',
      }}>
        <span>Thickness: {weightLabel(payload.weightKind)}</span>
        <span>Size: share of events</span>
        <span>Distance: relatedness</span>
        {focus != null && <span style={{ color: fg }}>Focused on {payload.resources[focus]}</span>}
      </div>
    </div>
  );
}
