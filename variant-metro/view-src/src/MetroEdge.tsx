import type { EdgeProps } from '@xyflow/react';
import { CHAMFER_CUT, CHAMFER_ROUND, chamferCorners, offsetPolyline, roundedPathFromPoints, trimEnds, STROKE_W, type Point } from 'metro-layout';

export interface MetroEdgeData {
  /** Already-final polyline in canvas pixels, any local fan-out offset at
   * the endpoints included (see `route.ts#chainXs`) — nothing left for this
   * component to shift sideways itself. */
  points: Point[];
  /** Track-aware corner limit supplied by the router. */
  safeChamferCut?: number;
  /** Independent corner limits prevent a distant tight bend changing this one. */
  cornerCuts?: number[];
  color: string;
  objectType: string;
  /** True for an object type's very first edge (leaving its source) or
   * very last edge (arriving at its sink) — see `plugin.tsx`. Not related
   * to `kind: 'loop'` in the payload (a genuine redo/rework edge, which
   * routes backward in rank but otherwise draws exactly like any other
   * edge — its own geometry already reads as "goes back up the page",
   * dashing it too was redundant). */
  dashed: boolean;
  faded: boolean;
  sourceRadius: number;
  targetRadius: number;
  /** Frequency label (OC-DFG basis, "show numbers" on) — drawn mid-polyline. */
  label?: string;
  /** Where to draw the label — a de-overlapped position from `plugin.tsx`.
   * Falls back to this edge's own polyline midpoint. */
  labelPos?: Point;
  theme?: Record<string, string>;
  /** Animate a dash pattern travelling source→target, for the "animate
   * flow" toggle. Off by default. */
  animate?: boolean;
  /** Whether this edge carries at least one variable arc in the source
   * OCPN — drawn as two parallel rails (the double-line notation used
   * elsewhere for variable arcs) instead of one solid line, so the fact is
   * visible on the map rather than silently absorbed into an ordinary
   * single-token line. See `metro-map-core`'s `OutEdge.variable`. */
  variable?: boolean;
  [key: string]: unknown;
}

const ARROW_SIZE = 14;
const HIT_WIDTH = 16;
// Total rail footprint (2 * RAIL_OFFSET + RAIL_STROKE_W ≈ 9px) stays well
// inside one track's `LINE_SPACING` gap (15px, see `plugin.tsx`), so
// doubling a variable arc's line can never visually reach a neighbouring
// track — the routing guarantee the paper argues for is about track
// allocation, not about how wide a single track's own line is drawn.
//
// The gap that actually has to read as background between the two rails is
// `2 * RAIL_OFFSET - RAIL_STROKE_W`. At the original 2.5/2 that was only 3px
// — inside typical anti-aliasing/compression noise, so a variable arc read
// as "a slightly thick line" rather than "two lines" almost everywhere
// except a long, dead-straight run. 3.5/2 leaves a 5px gap instead, which
// stays legible at normal zoom and after a screenshot's own compression.
const RAIL_OFFSET = 3.5;
const RAIL_STROKE_W = 2;

/** The point half-way along a polyline by arc length. */
function midpoint(points: Point[]): Point {
  if (points.length < 2) return points[0] ?? { x: 0, y: 0 };
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    segs.push(d);
    total += d;
  }
  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    if (acc + segs[i] >= total / 2) {
      const t = segs[i] === 0 ? 0 : (total / 2 - acc) / segs[i];
      return { x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t };
    }
    acc += segs[i];
  }
  return points[points.length - 1];
}

export function MetroEdge({ data }: EdgeProps & { data: MetroEdgeData }) {
  const points = trimEnds(chamferCorners(data.points, data.cornerCuts ?? Math.min(CHAMFER_CUT, data.safeChamferCut ?? CHAMFER_CUT)), data.sourceRadius, data.targetRadius);
  if (points.length < 2) return null;

  const end = points[points.length - 1];
  const prev = points[points.length - 2];
  const dx = end.x - prev.x;
  const dy = end.y - prev.y;
  const len = Math.hypot(dx, dy) || 1;
  const tx = dx / len;
  const ty = dy / len;
  const nx = -ty;
  const ny = tx;
  const bx = end.x - tx * ARROW_SIZE;
  const by = end.y - ty * ARROW_SIZE;
  const half = ARROW_SIZE * 0.42;
  const arrow = [
    `${end.x},${end.y}`,
    `${bx + nx * half},${by + ny * half}`,
    `${bx - nx * half},${by - ny * half}`,
  ].join(' ');

  // The line itself stops at the arrow's base, not its tip — with a
  // `butt` cap (not `round`) that leaves a clean, sharp arrowhead instead
  // of a soft blob of line-cap sitting on top of (and hiding) the triangle.
  const linePoints = [...points.slice(0, -1), { x: bx, y: by }];
  const path = roundedPathFromPoints(linePoints, CHAMFER_ROUND);
  // Two rails instead of one solid line: the offset is a pure rendering
  // step on the already-routed polyline (see `offsetPolyline`'s own doc
  // comment), so it cannot change which track this edge occupies.
  const railPaths = data.variable
    ? [RAIL_OFFSET, -RAIL_OFFSET].map((o) => roundedPathFromPoints(offsetPolyline(linePoints, o), CHAMFER_ROUND))
    : null;

  const opacity = data.faded ? 0.12 : 0.92;
  const mid = data.label ? (data.labelPos ?? midpoint(points)) : null;
  const labelW = data.label ? data.label.length * 6.2 + 8 : 0;
  return (
    <g opacity={opacity} style={{ cursor: 'pointer', transition: 'opacity 120ms' }}>
      <path d={roundedPathFromPoints(points, CHAMFER_ROUND)} fill="none" stroke="transparent" strokeWidth={HIT_WIDTH} />
      {railPaths ? (
        railPaths.map((rp, i) => (
          <path
            key={i} d={rp} fill="none" stroke={data.color} strokeWidth={RAIL_STROKE_W} strokeLinecap="butt"
            // Suppressed while animating: the flow pulse below draws its own
            // independent dash pattern travelling via stroke-dashoffset, and
            // two competing dash patterns on the same path beat against each
            // other as gaps drift in and out of phase — visible as a
            // flicker/shimmer, worst on exactly these (already dashed)
            // edges. A solid base line under the pulse has nothing to beat
            // against.
            strokeDasharray={data.dashed && !data.animate ? '8 4' : undefined}
          >
            <title>{data.objectType} (variable arc)</title>
          </path>
        ))
      ) : (
        <path
          d={path} fill="none" stroke={data.color} strokeWidth={STROKE_W} strokeLinecap="butt"
          // See the matching comment on the rail-paths branch above: a
          // static dash pattern here beats visually against the animated
          // flow pulse's own dash pattern, so it's suppressed while animating.
          strokeDasharray={data.dashed && !data.animate ? '8 4' : undefined}
        >
          <title>{data.objectType}</title>
        </path>
      )}
      {data.animate && !data.faded && (
        <path d={path} fill="none" stroke={data.theme?.bg ?? '#fff'} strokeWidth={STROKE_W + 1.5}
          strokeLinecap="round" strokeDasharray="0.1 13" opacity={0.95} style={{ pointerEvents: 'none' }}>
          <animate attributeName="stroke-dashoffset" from="13.1" to="0" dur="0.7s" repeatCount="indefinite" />
        </path>
      )}
      <polygon points={arrow} fill={data.color}>
        <title>{data.objectType}</title>
      </polygon>
      {mid && data.label && (
        <g transform={`translate(${mid.x}, ${mid.y})`}>
          <rect
            x={-labelW / 2} y={-8} width={labelW} height={16} rx={4}
            fill={data.theme?.['bg-soft'] ?? data.theme?.bg ?? '#fff'}
            stroke={data.theme?.border ?? 'transparent'} strokeWidth={0.75}
          />
          <text
            x={0} y={0} textAnchor="middle" dominantBaseline="central"
            fontSize={10} fontWeight={600} fill={data.theme?.text ?? '#111'}
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {data.label}
          </text>
        </g>
      )}
    </g>
  );
}
