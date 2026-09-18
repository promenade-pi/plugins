/**
 * Edge geometry for a layout that is already positioned.
 *
 * The action emits every edge as a polyline through node centres — its own
 * node and one point per virtual node on the route. The view's only job is to
 * turn that into an SVG path, and to trim the two end segments back to the
 * node borders so an arrowhead lands on the box rather than under it.
 *
 * Three renderings are offered because they answer different questions.
 * `polyline` draws exactly the segments the action measured, so what is on
 * screen is what `edgeLength` and `edgeOrthogonality` were computed from.
 * `curved` is the spline-drawing step the reference implementation finishes
 * with. `orthogonal` snaps each segment to the grid, which reads well but
 * deliberately no longer matches the orthogonality metric.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the segment from `inside` to `outside` leaves `inside`'s box. */
export function clipToRect(box: Rect, inside: Point, outside: Point): Point {
  const dx = outside.x - inside.x;
  const dy = outside.y - inside.y;
  if (dx === 0 && dy === 0) return { ...inside };
  const halfW = box.width / 2;
  const halfH = box.height / 2;
  // Largest t in [0, 1] that is still on the border of the box.
  const scaleX = dx === 0 ? Infinity : halfW / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : halfH / Math.abs(dy);
  const t = Math.min(scaleX, scaleY, 1);
  return { x: inside.x + dx * t, y: inside.y + dy * t };
}

/** Drops points that repeat, and collinear midpoints, so paths stay short. */
export function simplify(points: Point[], epsilon = 0.5): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - point.x) < 1e-6 && Math.abs(last.y - point.y) < 1e-6) {
      continue;
    }
    out.push(point);
  }
  if (out.length < 3) return out;
  const kept: Point[] = [out[0]];
  for (let i = 1; i < out.length - 1; i++) {
    const a = kept[kept.length - 1];
    const b = out[i];
    const c = out[i + 1];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const span = Math.hypot(c.x - a.x, c.y - a.y);
    if (span > 0 && Math.abs(cross) / span < epsilon) continue;
    kept.push(b);
  }
  kept.push(out[out.length - 1]);
  return kept;
}

function fmt(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

export function polylinePath(points: Point[]): string {
  if (points.length < 2) return '';
  return `M ${fmt(points[0].x)} ${fmt(points[0].y)}` +
    points.slice(1).map((p) => ` L ${fmt(p.x)} ${fmt(p.y)}`).join('');
}

/**
 * Catmull-Rom through every point, converted to cubic Bezier segments.
 *
 * Pass-through rather than approximating, because the interior points are
 * routing decisions the layout made: a spline that merely drifts near them
 * can wander back through a rank the router kept clear.
 */
export function curvedPath(points: Point[], tension = 0.5): string {
  if (points.length < 2) return '';
  if (points.length === 2) return polylinePath(points);
  let path = `M ${fmt(points[0].x)} ${fmt(points[0].y)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1 = {
      x: p1.x + ((p2.x - p0.x) / 6) * tension * 2,
      y: p1.y + ((p2.y - p0.y) / 6) * tension * 2,
    };
    const c2 = {
      x: p2.x - ((p3.x - p1.x) / 6) * tension * 2,
      y: p2.y - ((p3.y - p1.y) / 6) * tension * 2,
    };
    path += ` C ${fmt(c1.x)} ${fmt(c1.y)}, ${fmt(c2.x)} ${fmt(c2.y)}, ${fmt(p2.x)} ${fmt(p2.y)}`;
  }
  return path;
}

/**
 * Axis-aligned route: each segment leaves vertically, steps across at the
 * midpoint, and arrives vertically. A horizontal segment stays horizontal.
 */
export function orthogonalPath(points: Point[]): string {
  if (points.length < 2) return '';
  const route: Point[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    if (Math.abs(from.x - to.x) < 0.5 || Math.abs(from.y - to.y) < 0.5) {
      route.push(to);
      continue;
    }
    const midY = (from.y + to.y) / 2;
    route.push({ x: from.x, y: midY }, { x: to.x, y: midY }, to);
  }
  return polylinePath(simplify(route));
}

export type EdgeStyle = 'polyline' | 'curved' | 'orthogonal';

export function edgePath(points: Point[], style: EdgeStyle): string {
  const clean = simplify(points);
  if (style === 'curved') return curvedPath(clean);
  if (style === 'orthogonal') return orthogonalPath(clean);
  return polylinePath(clean);
}

/**
 * Trims the route's first and last segment back to the node borders.
 *
 * Only the two ends: interior points are virtual nodes, which are drawn as
 * dots at most and should be passed through, not routed around.
 */
export function trimToNodes(points: Point[], source?: Rect, target?: Rect): Point[] {
  if (points.length < 2) return points;
  const out = points.map((p) => ({ ...p }));
  if (source) out[0] = clipToRect(source, points[0], points[1]);
  if (target) {
    const last = points.length - 1;
    out[last] = clipToRect(target, points[last], points[last - 1]);
  }
  return out;
}

/** Total drawn length, for the on-screen readout of a filtered subgraph. */
export function pathLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

/** Stroke width from frequency, on a log scale with a legible floor. */
export function strokeWidth(freq: number, maxFreq: number, backbone: boolean): number {
  const base = backbone ? 2.6 : 1.3;
  if (!(maxFreq > 0) || !(freq > 0)) return base;
  const share = Math.log1p(freq) / Math.log1p(maxFreq);
  return base + share * (backbone ? 3.4 : 2.2);
}
