/**
 * Plan geometry: the vocabulary the 2D ground plan is expressed in, and the
 * polyline resampling the terrain and the streams both need.
 *
 * Split out of `layout.ts` so that nothing which only needs the geometry has
 * to import elkjs. `layout.ts` pulls in `elk-worker.min.js`, which inspects
 * the global environment at load time; the invariant check
 * (`field.check.ts`) runs under plain node, where that has nothing to inspect.
 */
/**
 * How far from the plate's centre the outermost station may sit, in the same
 * absolute world units as `EXTENT` and `RIM_START * EXTENT` (`field.ts`) -
 * not a fraction of either. `layout.ts` fits every plan inside it;
 * `field.check.ts` generates its stations inside it, because a station the
 * real view can never place is not a case the terrain owes any ordering
 * guarantee to. `checkPlanFitInsideRim` ties this to `RIM_START * EXTENT` so
 * the two can't drift into stations sitting where the rim has already begun
 * to taper.
 */
export const PLAN_FIT = 0.76;

export interface Point { x: number; y: number }

export interface PlanNode {
  activity: string;
  /** Plan coordinates, normalised to -1..1 on the longer side. */
  x: number;
  y: number;
  /** Layer index, left to right. */
  rank: number;
}

export interface PlanEdge {
  source: string;
  target: string;
  key: string;
  /** Polyline in the same normalised plan coordinates, source to target. */
  points: Point[];
  /** `true` when the flow returns to an earlier layer: rework. */
  backward: boolean;
}

export interface Plan {
  nodes: PlanNode[];
  edges: PlanEdge[];
  byActivity: Map<string, PlanNode>;
  rank: Map<string, number>;
  /** Aspect ratio (width / height) of the laid-out plan, before normalising. */
  aspect: number;
}

/**
 * Resamples a polyline to roughly even spacing, with rounded corners.
 *
 * Streams are drawn as ribbons lying on the terrain, and a ribbon built on
 * unevenly spaced samples has visibly uneven width where the samples bunch up.
 * Rounding the corners also matters: a hard bend in a wide ribbon self-
 * intersects on the inside of the turn.
 */
export function smoothPath(points: Point[], step = 0.02, rounding = 0.35): Point[] {
  const chamfered = roundCorners(points, rounding);
  const out: Point[] = [];
  let carry = 0;
  out.push(chamfered[0]);
  for (let i = 1; i < chamfered.length; i++) {
    const a = chamfered[i - 1];
    const b = chamfered[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;
    let travelled = carry;
    while (travelled + step <= length) {
      travelled += step;
      out.push({ x: a.x + (dx * travelled) / length, y: a.y + (dy * travelled) / length });
    }
    carry = travelled - length;
    if (carry < 0) carry = 0;
  }
  const last = chamfered[chamfered.length - 1];
  const tail = out[out.length - 1];
  if (!tail || Math.hypot(tail.x - last.x, tail.y - last.y) > 1e-6) out.push(last);
  return out.length >= 2 ? out : chamfered;
}

/** Replaces each interior vertex with a quadratic arc through its corner. */
function roundCorners(points: Point[], amount: number): Point[] {
  if (points.length < 3 || amount <= 0) return points;
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const here = points[i];
    const next = points[i + 1];
    const inLen = Math.hypot(here.x - prev.x, here.y - prev.y);
    const outLen = Math.hypot(next.x - here.x, next.y - here.y);
    const back = Math.min(inLen * 0.5, outLen * 0.5) * amount * 2;
    if (back < 1e-6) { out.push(here); continue; }
    const a = {
      x: here.x + ((prev.x - here.x) / inLen) * back,
      y: here.y + ((prev.y - here.y) / inLen) * back,
    };
    const b = {
      x: here.x + ((next.x - here.x) / outLen) * back,
      y: here.y + ((next.y - here.y) / outLen) * back,
    };
    const steps = 5;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const mt = 1 - t;
      out.push({
        x: mt * mt * a.x + 2 * mt * t * here.x + t * t * b.x,
        y: mt * mt * a.y + 2 * mt * t * here.y + t * t * b.y,
      });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Drops consecutive duplicate points, which break tangent computation. */
export function dedupe(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue;
    out.push(p);
  }
  return out.length >= 2 ? out : points.slice(0, 2);
}
