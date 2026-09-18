import { chamferCorners, CHAMFER_CUT, type Point } from './route';
import { countCrossings, findOverlaps, type Overlap, type REdge, type RNode, type RouteResult } from './router';

/** Final pixel constraints. Ranking and layer ordering are already settled. */
export interface Drawing {
  points: Map<string, Point[]>;
  nodeX: Map<string, number>;
  chamferCuts: Map<string, number[]>;
}

function compact(ps: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of ps) {
    if (out.length && Math.hypot(p.x - out[out.length - 1].x, p.y - out[out.length - 1].y) < 0.01) continue;
    while (out.length > 1) {
      const a = out[out.length - 2], b = out[out.length - 1];
      const cross = (b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x);
      const dot = (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y);
      if (Math.abs(cross) > 0.01 || dot < 0) break;
      out.pop();
    }
    out.push({ ...p });
  }
  return out;
}

/**
 * Segment versus the open interior of a box, including diagonal segments.
 * Written as two unrolled slab tests rather than a loop over an array of
 * `[start, delta, min, max]` tuples: this is the innermost call of the whole
 * refinement and the tuple array was being allocated millions of times.
 */
function hitsBox(a: Point, b: Point, x: number, y: number, w: number, h: number): boolean {
  let low = 0, high = 1;
  const dx = b.x - a.x;
  if (Math.abs(dx) < 1e-9) { if (a.x <= x - w || a.x >= x + w) return false; }
  else {
    const t0 = (x - w - a.x) / dx, t1 = (x + w - a.x) / dx;
    low = Math.max(low, Math.min(t0, t1));
    high = Math.min(high, Math.max(t0, t1));
    if (low >= high) return false;
  }
  const dy = b.y - a.y;
  if (Math.abs(dy) < 1e-9) { if (a.y <= y - h || a.y >= y + h) return false; }
  else {
    const t0 = (y - h - a.y) / dy, t1 = (y + h - a.y) / dy;
    low = Math.max(low, Math.min(t0, t1));
    high = Math.min(high, Math.max(t0, t1));
    if (low >= high) return false;
  }
  return high > low;
}

export function nodeIntersections(nodes: RNode[], edges: REdge[], points: Map<string, Point[]>, nodeX: Map<string, number>, rowY: Map<number, number>, margin = 0): Array<{ edge: string; node: string }> {
  const hits: Array<{ edge: string; node: string }> = [];
  // Resolve each node's box (and its optional stop caption) once per call
  // instead of once per edge, and give every node the axis-aligned bound of
  // the two together. A polyline whose own bound misses that one cannot
  // possibly clip either box, which is what makes the dense maps cheap —
  // the slab test below is unchanged, it just runs far less often.
  const boxes = nodes.map(n => {
    const cx = nodeX.get(n.id)!, cy = rowY.get(n.rank)!;
    const w = n.halfW + margin, h = n.halfH + margin;
    const lw = n.labelHalfW != null ? n.labelHalfW + margin : 0;
    const lcy = cy + n.halfH + 12, lh = 8 + margin;
    return {
      n, cx, cy, w, h, lw, lcy, lh,
      minX: cx - Math.max(w, lw), maxX: cx + Math.max(w, lw),
      minY: cy - h, maxY: n.labelHalfW != null ? lcy + lh : cy + h,
    };
  });
  for (const e of edges) {
    const ps = points.get(e.id) ?? [];
    if (ps.length < 2) continue;
    let eMinX = Infinity, eMaxX = -Infinity, eMinY = Infinity, eMaxY = -Infinity;
    for (const p of ps) {
      if (p.x < eMinX) eMinX = p.x;
      if (p.x > eMaxX) eMaxX = p.x;
      if (p.y < eMinY) eMinY = p.y;
      if (p.y > eMaxY) eMaxY = p.y;
    }
    for (const box of boxes) {
      const n = box.n;
      if (n.id === e.source || n.id === e.target) continue;
      if (box.maxX <= eMinX || box.minX >= eMaxX || box.maxY <= eMinY || box.minY >= eMaxY) continue;
      for (let i = 1; i < ps.length; i++) {
        if (hitsBox(ps[i - 1], ps[i], box.cx, box.cy, box.w, box.h)
          || (n.labelHalfW != null && hitsBox(ps[i - 1], ps[i], box.cx, box.lcy, box.lw, box.lh))) {
          hits.push({ edge: e.id, node: n.id });
          break;
        }
      }
    }
  }
  return hits;
}

export function refineDrawing(nodes: RNode[], edges: REdge[], routed: RouteResult, pitch: number): Drawing {
  const points = new Map([...routed.points].map(([id, ps]) => [id, compact(ps)]));
  const nodeX = new Map(nodes.map(n => [n.id, routed.nodeX.get(n.id) ?? n.lane * pitch]));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const edgeById = new Map(edges.map(e => [e.id, e]));
  const incoming = new Map<string, REdge[]>(), outgoing = new Map<string, REdge[]>();
  for (const e of edges) {
    incoming.set(e.target, [...(incoming.get(e.target) ?? []), e]);
    outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e]);
  }
  // Whether two edges are the same metro line depends only on the input
  // graph, which never changes here, yet `findOverlaps` asks it once per
  // candidate segment pair across tens of thousands of calls — so answer
  // each ordered pair once. The predicate is symmetric, hence the sorted
  // key: the two directions share an entry.
  const mergeMemo = new Map<string, boolean>();
  const mayMergeUncached = (a: string, b: string) => {
    const ea = edgeById.get(a)!, eb = edgeById.get(b)!;
    if (ea.objectType !== eb.objectType) return false;
    if ([ea, eb].some(e => byId.get(e.source)!.gateway || byId.get(e.target)!.gateway || byId.get(e.source)!.rank >= byId.get(e.target)!.rank)) return false;
    return ea.source === eb.source || ea.target === eb.target || ea.source === eb.target || ea.target === eb.source;
  };
  const mayMerge = (a: string, b: string) => {
    const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    let hit = mergeMemo.get(key);
    if (hit === undefined) { hit = mayMergeUncached(a, b); mergeMemo.set(key, hit); }
    return hit;
  };
  // `valid` is the inner loop of the whole refinement — thousands of
  // proposals — and each one used to clone the entire drawing just to
  // overlay a handful of moved edges on it. Keep one scratch copy that
  // tracks `points`, overlay, test, then put the originals back.
  const scratch = new Map(points);
  const commit = (id: string, ps: Point[]) => { points.set(id, ps); scratch.set(id, ps); };
  const valid = (changes: Map<string, Point[]>, xs = nodeX, repair = false): boolean => {
    const merged = scratch;
    const restore: Array<[string, Point[] | undefined]> = [];
    for (const [id, ps] of changes) { restore.push([id, merged.get(id)]); merged.set(id, ps); }
    const done = (ok: boolean) => {
      for (const [id, ps] of restore) { if (ps === undefined) merged.delete(id); else merged.set(id, ps); }
      return ok;
    };
    const changedEdges = edges.filter(e => changes.has(e.id));
    const hits = nodeIntersections(nodes, changedEdges, merged, xs, routed.rowY, 5);
    if (hits.length) {
      if (!repair) return done(false);
      const before = nodeIntersections(nodes, changedEdges, points, nodeX, routed.rowY, 5);
      if (hits.length >= before.length || hits.some(h => !before.some(b => b.edge === h.edge && b.node === h.node))) return done(false);
    }
    // Only overlaps that touch an edge this proposal moved can veto it, so
    // ask `findOverlaps` for exactly those rather than for every overlap in
    // the drawing and then discarding almost all of them.
    return done(findOverlaps(merged, mayMerge, 4, new Set(changes.keys())).length === 0);
  };

  // Align a short, unbranched source chain with its actual arrival port.
  // The whole connected tail moves together, including its source marker.
  // Shared stations, junctions, loops, rank and order are never changed.
  for (const e of edges) {
    const ps = points.get(e.id);
    if (!ps || byId.get(e.source)!.rank >= byId.get(e.target)!.rank) continue;
    const tail: string[] = [], tailEdges: REdge[] = [e];
    let id = e.source;
    while (byId.get(id)?.alignable && !tail.includes(id) && (outgoing.get(id)?.length ?? 0) === 1 && (incoming.get(id)?.length ?? 0) <= 1) {
      tail.push(id);
      const prev = incoming.get(id)?.[0];
      if (!prev) break;
      if (byId.get(prev.source)!.rank >= byId.get(id)!.rank || prev.objectType !== e.objectType) { tail.length = 0; break; }
      tailEdges.push(prev);
      id = prev.source;
    }
    if (!tail.length || (incoming.get(tail[tail.length - 1])?.length ?? 0) !== 0) continue;
    const x = ps[ps.length - 1].x;
    if (tail.some(id => Math.abs(nodeX.get(id)! - x) > pitch / 2)) continue;
    const xs = new Map(nodeX);
    for (const id of tail) xs.set(id, x);
    if (tail.some(id => nodes.some(n => n.id !== id && !tail.includes(n.id) && n.rank === byId.get(id)!.rank && Math.abs(xs.get(n.id)! - x) < n.halfW + byId.get(id)!.halfW + 10))) continue;
    const changes = new Map<string, Point[]>();
    for (const edge of tailEdges) {
      const old = points.get(edge.id)!;
      changes.set(edge.id, [{ x, y: old[0].y }, { x, y: old[old.length - 1].y }]);
    }
    if (!valid(changes, xs)) continue;
    // Moving the nodes must not put them over a different, unchanged line.
    if (nodeIntersections(nodes.filter(n => tail.includes(n.id)), edges.filter(e => !changes.has(e.id)), points, xs, routed.rowY, 5).length) continue;
    const merged = new Map([...points, ...changes]);
    if (countCrossings(merged) > countCrossings(points)) continue;
    for (const [id, ps] of changes) commit(id, ps);
    for (const id of tail) nodeX.set(id, x);
  }

  // A sink is an annotation at the end of its actual incoming line, not an
  // independent station that has to defend the nominal centre of its lane.
  // Track allocation can legitimately offset that final line in a busy
  // column. The old column/rank anchoring heuristic could then mistake an
  // unrelated segment for another line touching the sink and leave the
  // marker behind at the nominal x. Resolve the relationship by graph
  // identity here: centre the sink under the span of edges that really
  // target it, subject to the same node/label clearance constraints used by
  // the other final-geometry moves.
  for (const sink of nodes.filter((n) => n.labelHalfW != null)) {
    const arrivals = incoming.get(sink.id) ?? [];
    const arrivalXs = arrivals
      .map((edge) => {
        const ps = points.get(edge.id);
        return ps?.[ps.length - 1]?.x;
      })
      .filter((x): x is number => x != null);
    if (!arrivalXs.length) continue;
    const x = (Math.min(...arrivalXs) + Math.max(...arrivalXs)) / 2;
    if (Math.abs(nodeX.get(sink.id)! - x) < 0.01 || Math.abs(nodeX.get(sink.id)! - x) > pitch / 2) continue;
    const xs = new Map(nodeX);
    xs.set(sink.id, x);
    const ownReach = Math.max(sink.halfW, sink.labelHalfW ?? 0);
    const crowdsRow = nodes.some((n) => n.id !== sink.id && n.rank === sink.rank
      && Math.abs(xs.get(n.id)! - x) < ownReach + Math.max(n.halfW, n.labelHalfW ?? 0) + 10);
    if (crowdsRow) continue;
    const incident = new Set(arrivals.map((edge) => edge.id));
    if (nodeIntersections([sink], edges.filter((edge) => !incident.has(edge.id)), points, xs, routed.rowY, 5).length) continue;
    nodeX.set(sink.id, x);
  }

  // A dummy column may be shifted by track allocation into a real node.
  // Move only an obstructed interior vertical run, joining the existing
  // horizontal channel segments at its ends. Try nearest clear tracks first.
  for (const e of edges) {
    if (!points.has(e.id)) continue;
    let ps: Point[] = points.get(e.id)!;
    for (let i = 1; i + 2 < ps.length; i++) {
      const a = ps[i], b = ps[i + 1];
      if (Math.abs(a.x - b.x) > 0.01) continue;
      if (Math.abs(ps[i - 1].y - a.y) > 0.01 || Math.abs(ps[i + 2].y - b.y) > 0.01) continue;
      const hitIds = new Set(nodeIntersections(nodes, [e], new Map([[e.id, [a, b]]]), nodeX, routed.rowY, 5).map(h => h.node));
      const obstacles = nodes.filter(n => hitIds.has(n.id));
      if (!obstacles.length) continue;
      const corridorNodes = nodes.filter(n => routed.rowY.get(n.rank)! + n.halfH >= Math.min(a.y, b.y)
        && routed.rowY.get(n.rank)! - n.halfH <= Math.max(a.y, b.y));
      const candidates = corridorNodes.flatMap(n => [nodeX.get(n.id)! - Math.max(n.halfW, n.labelHalfW ?? 0) - 10, nodeX.get(n.id)! + Math.max(n.halfW, n.labelHalfW ?? 0) + 10]);
      for (const x0 of [...candidates]) for (let step = 1; step <= 4; step++) candidates.push(x0 - step * 15, x0 + step * 15);
      candidates.sort((x, y) => Math.abs(x - a.x) - Math.abs(y - a.x));
      // Two corridor nodes sharing a lane, or a ±15 step landing on a
      // neighbour's clearance, produce the same x many times over; a repeat
      // re-runs the identical validation for the identical verdict.
      const tried = new Set<number>();
      let accepted = false;
      for (const x of candidates) {
        if (tried.has(x)) continue;
        tried.add(x);
        // Widening a horizontal run can make it overlap another channel
        // track. Try nearby channel tracks as part of the same proposal;
        // validate the entire route before accepting either coordinate.
        for (const dy0 of [0, -15, 15, -30, 30]) {
          for (const dy1 of [0, -15, 15, -30, 30]) {
            // Never move an endpoint, or reverse a forward vertical run.
            // Both are decided before the polyline is copied — the copy is
            // the expensive part and neither test needs it.
            if ((i === 1 && dy0 !== 0) || (i + 2 === ps.length - 1 && dy1 !== 0)) continue;
            const next: Point[] = ps.map(p => ({ ...p }));
            next[i].x = x; next[i + 1].x = x;
            next[i - 1].y += dy0; next[i].y += dy0;
            next[i + 1].y += dy1; next[i + 2].y += dy1;
            if (byId.get(e.source)!.rank < byId.get(e.target)!.rank && next.some((p, k) => k > 0 && p.y < next[k - 1].y)) continue;
            if (!valid(new Map([[e.id, next]]), nodeX, true)) continue;
            ps = next; commit(e.id, next); accepted = true; break;
          }
          if (accepted) break;
        }
        if (accepted) break;
      }
      // A nearer candidate may clear one obstacle while another remains
      // on this run. Every accepted proposal strictly reduces its hits.
      if (accepted) i = 0;
    }
  }

  // Corner safety is local. A tiny gap in an unrelated column must not
  // remove the metro diagonals everywhere else in the drawing.
  const chamferCuts = new Map([...points].map(([id, ps]) => [id, ps.map(() => CHAMFER_CUT)]));
  for (let round = 0; round < 12; round++) {
    const drawn = new Map([...points].map(([id, ps]) => [id, chamferCorners(ps, chamferCuts.get(id)!)]));
    const conflicts = findOverlaps(drawn, mayMerge, 4).filter(o => o.axis === 'd');
    const nodeHits = nodeIntersections(nodes, edges, drawn, nodeX, routed.rowY, 2);
    const involved = new Set([...conflicts.flatMap(o => [o.a, o.b]), ...nodeHits.map(h => h.edge)]);
    let changed = false;
    let beforeAxis: Overlap[] | undefined;
    for (const id of involved) {
      const ps = points.get(id)!, cuts = chamferCuts.get(id)!;
      for (let i = 1; i + 1 < ps.length; i++) {
        const local = chamferCorners([ps[i - 1], ps[i], ps[i + 1]], cuts[i]);
        if (local.length !== 4) continue;
        const diagonal = [local[1], local[2]];
        const collides = conflicts.some(o => {
          if (o.a !== id && o.b !== id) return false;
          const other = o.a === id ? o.b : o.a;
          return findOverlaps(new Map([[id, diagonal], [other, drawn.get(other)!]]), () => false, 4).length > 0;
        });
        const hitsNode = nodeIntersections(nodes, [edgeById.get(id)!], new Map([[id, diagonal]]), nodeX, routed.rowY, 2).length > 0;
        if (collides || hitsNode) {
          const old = cuts[i];
          cuts[i] = round === 11 ? 0 : cuts[i] / 2;
          const candidate = chamferCorners(ps, cuts);
          // `drawn` only moves when a shortening is accepted just below, so
          // recompute this baseline then rather than once per corner.
          if (!beforeAxis) beforeAxis = findOverlaps(drawn, mayMerge, 4).filter(o => o.axis !== 'd');
          const proposed = new Map(drawn); proposed.set(id, candidate);
          const afterAxis = findOverlaps(proposed, mayMerge, 4).filter(o => o.axis !== 'd');
          // Shortening a diagonal lengthens its two straight arms. Do not
          // trade a diagonal overlap for a new horizontal/vertical one.
          if (afterAxis.some(o => !beforeAxis!.some(b => b.a === o.a && b.b === o.b && b.axis === o.axis))) {
            cuts[i] = old;
          } else {
            drawn.set(id, candidate); changed = true; beforeAxis = afterAxis;
          }
        }
      }
    }
    if (!changed) break;
  }
  return { points, nodeX, chamferCuts };
}
