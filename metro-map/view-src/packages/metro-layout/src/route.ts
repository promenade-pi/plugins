/**
 * Octilinear ("metro map") pixel layout and edge routing.
 *
 * `rank`/`lane` from the Rust algorithm are an integer grid; this module is
 * the only place that turns them into pixels and draws only 0°/90°/45°
 * polyline segments — no ELK, no curve fitting, no external layout crate.
 * Every segment is either vertical (a lane holding straight) or a lane shift
 * with equal horizontal and vertical travel (`Math.abs(dx)` in both axes),
 * which is what keeps every turn exactly 45°.
 *
 * Every edge touches its own true node position at both ends — nodes never
 * move to accommodate an edge. What *can* shift is where, exactly, an edge's
 * drawn line sits relative to that node's centre: a node with only one edge
 * on a given side has that edge pass through dead-centre; a node with
 * several edges converging on the same side (several lines terminating at
 * the same station, say) fans them out to distinct, evenly spaced points
 * instead of forcing them all through one pixel — the same way a real
 * transit map draws several tracks touching the same platform at slightly
 * different points, never literally merged into one line right at the
 * station. This fan-out amount (`startOffset`/`endOffset`, computed by the
 * caller from how many edges actually share that node — see `plugin.tsx`)
 * is folded into the *same* diagonal that handles any rank/lane shift, so
 * there is ever at most one bend near a node, not two independent diagonals
 * stacked on top of each other. Stacking a separate "bundling funnel"
 * diagonal on top of the lane-shift diagonal — the previous design — could
 * send a path in one horizontal direction and then partway back in the
 * other, which is exactly the "goes back, then down, then up again" zigzag
 * reported against it.
 */

// Wide enough that two adjacent lanes' station/terminus labels (up to ~110px
// wide) don't overlap each other — the actual complaint behind "push paths
// to the side in the layout so you have space for the labels": nothing was
// reserving room for a label past its own node's immediate footprint.
export const COL_W = 104;
export const BASE_ROW_H = 110;
export const STROKE_W = 4;
// Spacing between sibling edges fanning out at a node they share (several
// edges terminating at, or leaving from, the very same node). Local to that
// node only — not a global per-object-type offset — so a lone edge with no
// siblings there gets exactly 0 and passes through dead-centre.
export const LOCAL_FAN_SPACING = 22;
export const CORNER_RADIUS = 13;
// A bare 90° turn is replaced by two 45° turns with a short straight
// diagonal between them (the octilinear "never a right angle" look the
// manifest promises). `CHAMFER_CUT` is how far back along each arm the
// corner is cut — equal on both arms, so the connector is exactly 45°;
// `CHAMFER_ROUND` is the tiny easing left on the two new corners, kept well
// below the cut so a visible straight 45° stretch always remains.
export const CHAMFER_CUT = 28;
export const CHAMFER_ROUND = 5;
// Straight run reserved on the *departure* side of a shifting diagonal, even
// for the one edge whose own shift is what sized the row in the first
// place. Without this, an edge whose shift dominates its row got a gap sized
// to fit the diagonal exactly (`lead = 0` on both ends) — no vertical
// settling at all, so it met its node at a steep angle instead of coming in
// straight, and a direct diagonal run right into an arrowhead. Doubled from
// this router's first version, which still left the straight run too short
// to read cleanly against a real diagram's density.
export const MIN_LEAD = 52;
// The *arrival* side's own reservation — deliberately bigger than
// `MIN_LEAD`, see `routeHop`'s asymmetric split. Sized generously enough
// that even the one hop whose shift is what grew its row in the first place
// (the tightest case there is — every other hop sharing that row gets more,
// not less) still settles into a visibly long straight run right before its
// node, not just a bare minimum sliver.
export const ARRIVAL_LEAD = 100;

export interface Point {
  x: number;
  y: number;
}

export interface RankLane {
  rank: number;
  lane: number;
}

/**
 * One hop's required horizontal travel — a rank/lane shift, a bundling
 * offset changing, or (usually) both folded into the same move. Row heights
 * are sized off this total, not the raw lane shift alone, so a row still
 * reserves enough room for `MIN_LEAD` + `ARRIVAL_LEAD` even when the shift
 * is small but an offset change makes up the rest.
 */
export interface Hop {
  sourceRank: number;
  dx: number;
}

/** A rank transition that no drawn node touches on either side collapses to
 * this instead of a full `BASE_ROW_H` — the complexity slider filters the
 * view without re-running the Rust layout, so a filtered map can leave long
 * runs of ranks with nothing on them; without collapsing, those became huge
 * blank vertical bands and `fitView` zoomed the whole map down to a sliver. */
const COLLAPSED_ROW_H = 14;

/**
 * One row-transition's required height, indexed by the *source* rank.
 * `occupiedRanks` (ranks that hold at least one drawn node) is optional —
 * when given, a transition between two empty ranks with no edge shift over
 * it shrinks to `COLLAPSED_ROW_H`.
 */
export function computeRowGaps(hops: Hop[], maxRank: number, occupiedRanks?: Set<number>): number[] {
  const needAtRank = new Map<number, number>();
  for (const hop of hops) {
    const need = Math.abs(hop.dx);
    if (need === 0) continue;
    needAtRank.set(hop.sourceRank, Math.max(needAtRank.get(hop.sourceRank) ?? 0, need + MIN_LEAD + ARRIVAL_LEAD));
  }
  const gaps: number[] = [];
  for (let r = 0; r < maxRank; r++) {
    const touchesNode = !occupiedRanks || occupiedRanks.has(r) || occupiedRanks.has(r + 1);
    const base = touchesNode ? BASE_ROW_H : COLLAPSED_ROW_H;
    gaps.push(Math.max(base, needAtRank.get(r) ?? 0));
  }
  return gaps;
}

/** Cumulative y of each rank's centre line, `y[0] = 0`. */
export function rankY(gaps: number[]): number[] {
  const y = [0];
  for (const g of gaps) y.push(y[y.length - 1] + g);
  return y;
}

export function laneX(lane: number, pitch: number = COL_W): number {
  return lane * pitch;
}

/**
 * The full chain of x-positions an edge's polyline passes through: its own
 * node centres at both ends, offset by `startOffset`/`endOffset` (the local
 * fan-out at each end — 0 for a node with no sibling edges there), and every
 * intermediate dummy waypoint at its plain, unoffset lane position — a dummy
 * waypoint is never shared with another edge, so there's no fan-out to apply
 * there.
 */
export function chainXs(chain: RankLane[], startOffset: number, endOffset: number, pitch: number = COL_W): number[] {
  return chain.map((n, i) => {
    if (i === 0) return laneX(n.lane, pitch) + startOffset;
    if (i === chain.length - 1) return laneX(n.lane, pitch) + endOffset;
    return laneX(n.lane, pitch);
  });
}

/**
 * One hop's polyline between two adjacent ranks (or the same rank), from
 * explicit pixel x-positions rather than raw lane numbers — the caller
 * (`chainXs`) has already folded in whatever local fan-out offset applies at
 * each end, so this function only ever needs to know "start here, end
 * there," and it produces at most one diagonal bend to cover the whole
 * distance between them.
 *
 * A `loop`-kind edge's `source` is the *later* rank (the back edge points
 * upward) — everything below assumes forward motion (`y[sourceRank + 1]`
 * etc.), so a backward pair is solved as the forward pair and reversed,
 * rather than duplicating the geometry with subtracted signs. Without this,
 * a loop edge whose source sat at the diagram's very last rank indexed
 * `y[]` one past its end (`undefined`), and every coordinate downstream of
 * that turned into `NaN`/`undefined`, breaking the whole view's rendering
 * — not just that one edge.
 */
export function routeHop(sourceRank: number, targetRank: number, x0: number, x1: number, y: number[]): Point[] {
  if (targetRank < sourceRank) {
    return routeHop(targetRank, sourceRank, x1, x0, y).reverse();
  }
  const y0 = y[sourceRank];
  if (targetRank === sourceRank) {
    return [{ x: x0, y: y0 }, { x: x1, y: y0 }];
  }

  const y1 = y[sourceRank + 1];
  if (x0 === x1) {
    return [{ x: x0, y: y0 }, { x: x1, y: y1 }];
  }

  const gap = y1 - y0;
  const diagLen = Math.abs(x1 - x0);
  // Departure gets just enough straight run to leave its node cleanly;
  // arrival always gets at least `ARRIVAL_LEAD`, since `computeRowGaps`
  // reserved `MIN_LEAD + ARRIVAL_LEAD` of spare room for whichever hop's
  // shift is what sized this row (every other hop sharing the row gets
  // more, not less). A symmetric 50/50 split (this router's first version)
  // starved the arrival side exactly when it mattered most: a large shift
  // crammed into one row — a loop edge jumping several lanes to reach a
  // gateway high above it, say — left so little room per side that the
  // "straight run" was a sliver, and the edge read as coming in at a steep
  // angle rather than settling into the node from directly above. Real
  // transit maps commit to that the other way around: a line can wander
  // right after leaving a station, but always meets the next one
  // straight-on. Capping departure's share at `MIN_LEAD` and handing
  // arrival everything past that reproduces exactly that asymmetry.
  const room = Math.max(0, gap - diagLen);
  const leadOut = Math.min(MIN_LEAD, room);

  return [
    { x: x0, y: y0 },
    { x: x0, y: y0 + leadOut },
    { x: x1, y: y0 + leadOut + diagLen },
    { x: x1, y: y1 },
  ];
}

/**
 * `routeHop` for a whole chain of hops — a real edge's source, its dummy
 * Sugiyama waypoints (see `types.ts`'s `MmEdge.waypoints` and
 * `metro-map-core`'s dummy-chain construction), and its target — stitched
 * into one continuous polyline. Without dummy waypoints reserving lane
 * space, a long edge's drawn path could run straight through whatever real,
 * unrelated station happened to sit at the ranks in between. Each hop only
 * ever spans one rank, so `routeHop` always takes its simple two-rank
 * branch.
 */
export function routeThroughWaypoints(chain: RankLane[], xs: number[], y: number[]): Point[] {
  let points: Point[] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const hop = routeHop(chain[i].rank, chain[i + 1].rank, xs[i], xs[i + 1], y);
    points = points.length === 0 ? hop : points.concat(hop.slice(1));
  }
  return points;
}

/**
 * Pulls a polyline's final point back by `radius` along its last segment's
 * own direction, and/or its first point forward by `radius` along its first
 * segment's direction. A node is drawn as a filled circle/diamond of some
 * real size, not a mathematical point — leaving the path's endpoint exactly
 * at the node's centre means an arrowhead there sits *under* the node
 * artwork, invisible. Trimming to the node's outer edge is what a
 * conventional diagram renderer does automatically when it draws edges
 * between shape boundaries instead of raw coordinates; this router computes
 * shape boundaries itself, so it has to do the same trim explicitly.
 */
export function trimEnds(points: Point[], startRadius: number, endRadius: number): Point[] {
  if (points.length < 2) return points;
  let out = points;
  if (endRadius > 0) {
    const n = out.length;
    const end = out[n - 1];
    const prev = out[n - 2];
    const dx = end.x - prev.x;
    const dy = end.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const trim = Math.min(endRadius, len - 1);
    out = [...out.slice(0, n - 1), { x: end.x - (dx / len) * trim, y: end.y - (dy / len) * trim }];
  }
  if (startRadius > 0) {
    const start = out[0];
    const next = out[1];
    const dx = next.x - start.x;
    const dy = next.y - start.y;
    const len = Math.hypot(dx, dy) || 1;
    const trim = Math.min(startRadius, len - 1);
    out = [{ x: start.x + (dx / len) * trim, y: start.y + (dy / len) * trim }, ...out.slice(1)];
  }
  return out;
}

/**
 * A "turn-back" route for any edge whose target is at or above its source —
 * a genuine rework loop, or an OC-DFG activity that directly follows itself
 * (`source === target`). It always leaves the source from the *bottom* and
 * enters the target from the *top*, sweeping out to a side corridor
 * (`sideX`) and back — the same convention every forward edge follows, so
 * the whole map reads consistently top-to-bottom. All segments are
 * axis-aligned; `roundedPathFromPoints` eases the four corners.
 *
 * `sBottom` / `tTop` are the y of the source's bottom edge and the target's
 * top edge; for a self-loop they are the same node's two edges.
 */
/** Reserved *vertical* run right before a loop's arrowhead, so the line
 * meets the target straight down — not on the diagonal (which, after the
 * chamfer and the arrowhead eat into it, is what "joins the arrowhead too
 * long" looked like). Bigger than the chamfer + arrow together. */
export const LOOP_APPROACH = 52;
/** Vertical run right after a loop leaves its source. */
export const LOOP_EXIT = 30;

export interface LoopSpec {
  sx: number;
  sBottom: number;
  tx: number;
  tTop: number;
  /** x of the side corridor — must already clear every node box. */
  sideX: number;
  /** y of the horizontal segment below the source (staggered per loop). */
  downY: number;
  /** y of the horizontal segment above the target (staggered per loop). */
  upY: number;
}

/**
 * A "turn-back" route for any edge whose target is at or above its source —
 * a genuine rework loop. Leaves the source from the *bottom*, sweeps the
 * side corridor, enters the target from the *top* with a real vertical
 * approach. All segments are axis-aligned; the chamfer eases the corners.
 * `downY` / `upY` / `sideX` are all pre-staggered by the caller so several
 * loops sharing an endpoint never land on one line.
 */
export function loopRoute(s: LoopSpec): Point[] {
  const downY = Math.max(s.downY, s.sBottom + LOOP_EXIT);
  const upY = Math.min(s.upY, s.tTop - LOOP_APPROACH);
  return [
    { x: s.sx, y: s.sBottom },
    { x: s.sx, y: downY },
    { x: s.sideX, y: downY },
    { x: s.sideX, y: upY },
    { x: s.tx, y: upY },
    { x: s.tx, y: s.tTop },
  ];
}

/**
 * A self-loop (`source === target` — an OC-DFG activity that directly
 * follows itself) drawn as a compact bump on one side of the node rather
 * than a full sweep out to a side corridor: it never needs to clear any
 * other node, so there is no reason to make the map wider for it. Leaves
 * the node bottom, bulges `reach` px to `side` (+1 right / −1 left), comes
 * back into the node top.
 */
export function selfLoopRoute(cx: number, bottom: number, top: number, side: number, reach: number): Point[] {
  const x = cx + side * reach;
  return [
    { x: cx, y: bottom },
    { x: cx, y: bottom + 14 },
    { x, y: bottom + 14 },
    { x, y: top - 14 },
    { x: cx, y: top - 14 },
    { x: cx, y: top },
  ];
}

/**
 * Replaces every ~90° corner (a purely-vertical arm meeting a
 * purely-horizontal one) with two 45° corners joined by a short straight
 * diagonal: the corner point `C` becomes `a` (pulled back `cut` along the
 * vertical arm) and `b` (pulled back `cut` along the horizontal arm). Both
 * pull-backs are the same length, and the arms are axis-aligned and
 * perpendicular, so `a→b` travels equal x and y — exactly 45°. Corners that
 * are already 45° or shallower (a vertical arm meeting an existing diagonal,
 * a collinear pass-through) are left untouched. `cut` shrinks to a third of
 * the shorter arm so a tight lead-in never overshoots.
 */
export function chamferCorners(points: Point[], cut: number | number[]): Point[] {
  if (points.length < 3 || (typeof cut === 'number' && cut <= 0)) return points;
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const c = points[i];
    const next = points[i + 1];
    const inV = Math.abs(prev.x - c.x) < 0.5 && Math.abs(prev.y - c.y) > 0.5;
    const inH = Math.abs(prev.y - c.y) < 0.5 && Math.abs(prev.x - c.x) > 0.5;
    const outV = Math.abs(next.x - c.x) < 0.5 && Math.abs(next.y - c.y) > 0.5;
    const outH = Math.abs(next.y - c.y) < 0.5 && Math.abs(next.x - c.x) > 0.5;
    const perpendicular = (inV && outH) || (inH && outV);
    if (!perpendicular) {
      out.push(c);
      continue;
    }
    const lenPrev = Math.hypot(prev.x - c.x, prev.y - c.y);
    const lenNext = Math.hypot(next.x - c.x, next.y - c.y);
    const d = Math.min(typeof cut === 'number' ? cut : cut[i] ?? 0, lenPrev / 3, lenNext / 3);
    if (d < 1) {
      out.push(c);
      continue;
    }
    out.push({ x: c.x + Math.sign(prev.x - c.x) * (inH ? d : 0), y: c.y + Math.sign(prev.y - c.y) * (inV ? d : 0) });
    out.push({ x: c.x + Math.sign(next.x - c.x) * (outH ? d : 0), y: c.y + Math.sign(next.y - c.y) * (outV ? d : 0) });
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Offsets a polyline perpendicular to its own direction by `offset` px,
 * using the standard mitre construction: at an interior vertex, the two
 * adjacent segments' unit normals are summed and rescaled so that the
 * result sits exactly `offset` away from *both* segments, not just one —
 * an endpoint (only one adjacent segment) simply takes that segment's own
 * normal. Used to draw a variable arc's two parallel "rails" without
 * touching the router's own track allocation: the offset here is a pure
 * rendering step, well inside one track's `LINE_SPACING` gap, so it can
 * never make two different object types' lines visually collide.
 *
 * This router's polylines only ever turn by 0°/45°/90° before chamfering
 * (and the chamfer only ever softens a 90° into two 45°s), so the mitre
 * scale factor is always bounded — nothing here needs a cap against a
 * near-180° reversal blowing the offset out to infinity, except the
 * defensive `lenSq` guard below for a genuinely degenerate input.
 */
export function offsetPolyline(points: Point[], offset: number): Point[] {
  if (points.length < 2) return points;
  const segNormal: Point[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dy = points[i + 1].y - points[i].y;
    const len = Math.hypot(dx, dy) || 1;
    segNormal.push({ x: -dy / len, y: dx / len });
  }
  return points.map((p, i) => {
    const n0 = segNormal[i - 1];
    const n1 = segNormal[i];
    if (n0 && n1) {
      const sx = n0.x + n1.x;
      const sy = n0.y + n1.y;
      const lenSq = sx * sx + sy * sy;
      if (lenSq < 1e-6) return { x: p.x + n1.x * offset, y: p.y + n1.y * offset }; // ~180° reversal
      const scale = (2 * offset) / lenSq;
      return { x: p.x + sx * scale, y: p.y + sy * scale };
    }
    const n = n0 ?? n1!;
    return { x: p.x + n.x * offset, y: p.y + n.y * offset };
  });
}

export function pathFromPoints(points: Point[]): string {
  if (points.length < 2) return '';
  return `M ${fmt(points[0])}` + points.slice(1).map((p) => ` L ${fmt(p)}`).join('');
}

/**
 * Same polyline, but every interior corner (a vertical run meeting a 45°
 * diagonal, or vice versa) is eased into a short quadratic-Bézier curve
 * instead of a sharp mitre — the smooth bends real transit maps use. Each
 * corner is trimmed back along both adjacent segments by `radius` (or half
 * that segment's own length, whichever is shorter, so a short lead-in never
 * produces a curve that overshoots past the corner or past the next one) and
 * replaced with `Q <corner> <trimmedPoint>`, the standard "round a polyline"
 * construction. A perfectly straight run (two collinear neighbours, e.g. a
 * multi-rank vertical pass-through) degenerates harmlessly to the same
 * straight line, since the control point then sits exactly on it.
 */
export function roundedPathFromPoints(points: Point[], radius: number): string {
  if (points.length < 2) return '';
  if (points.length === 2 || radius <= 0) return pathFromPoints(points);

  let d = `M ${fmt(points[0])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    const toPrev = { x: prev.x - corner.x, y: prev.y - corner.y };
    const toNext = { x: next.x - corner.x, y: next.y - corner.y };
    const lenPrev = Math.hypot(toPrev.x, toPrev.y) || 1;
    const lenNext = Math.hypot(toNext.x, toNext.y) || 1;
    const trim = Math.min(radius, lenPrev / 2, lenNext / 2);
    const a = { x: corner.x + (toPrev.x / lenPrev) * trim, y: corner.y + (toPrev.y / lenPrev) * trim };
    const b = { x: corner.x + (toNext.x / lenNext) * trim, y: corner.y + (toNext.y / lenNext) * trim };
    d += ` L ${fmt(a)} Q ${fmt(corner)} ${fmt(b)}`;
  }
  d += ` L ${fmt(points[points.length - 1])}`;
  return d;
}

function fmt(p: Point): string {
  return `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
}
