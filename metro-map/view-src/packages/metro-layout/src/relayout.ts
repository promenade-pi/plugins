import type { LayoutEdge, LayoutNode } from './types';

/**
 * The complexity slider filters the map but the Rust layout ran on the
 * *whole* graph — so a filtered subset keeps full-graph rank/lane
 * coordinates that are scattered, leaving huge empty bands (which `fitView`
 * shrinks to a sliver) or, once naively compacted, a single unreadable
 * column. This is a small self-contained Sugiyama pass that re-lays-out just
 * the visible subgraph: longest-path ranking, ALAP start markers, dummy
 * waypoints,
 * a few barycenter ordering sweeps, then order-preserving coordinate
 * relaxation (the same idea as `metro-map-core`, in miniature — the visible
 * subgraph is always small).
 */

export interface Relayout {
  rank: Map<string, number>;
  /** Real-node lane, centred on the diagram's mean. */
  lane: Map<string, number>;
  /** Regenerated dummy waypoints per edge id, in the edge's own
   * source→target order (may descend in rank for a loop edge). */
  waypoints: Map<string, Array<{ rank: number; lane: number }>>;
  /** Edge ids whose target end (resp. source end) sits on a shared
   * object-type trunk — the view's local end-fan must leave these alone,
   * the trunk lane already carries the separation. */
  bundledTargetEnds: Set<string>;
  bundledSourceEnds: Set<string>;
  /** Per-edge lateral offset (lane units) of that edge's target/source
   * trunk from the node's own lane. The view applies it to the endpoint of
   * a *dummyless* bundled edge (which has no waypoint chain to carry the
   * separation) and, clamped, as the arrowhead position for every bundled
   * edge so distinct object types keep distinct arrowheads. */
  targetTrunkDelta: Map<string, number>;
  sourceTrunkDelta: Map<string, number>;
  /** Per-node: the lane span [lo, hi] of the connected component it belongs
   * to, after packing. Loop edges route within their *own* component's span
   * rather than sweeping past every other (possibly far-off) component. */
  componentSpan: Map<string, { lo: number; hi: number }>;
  maxRank: number;
}

/** Lane-units between adjacent object-type trunks feeding/leaving one node.
 * Deliberately small (~0.16 lane ≈ 17px at the dot pitch, ~28px at the label
 * pitch): the lines just need to stay visibly separate as they run into the
 * station, and each keeps its *own* arrowhead. Wider than this and the
 * arrowheads spray across the whole node with an ugly gap between them, or
 * (once clamped back to the node) the approach fans in at a steep angle and
 * the outer arrowheads end up floating off the node entirely. Because the
 * view uses exactly `delta * pitch` for the arrowhead too (no separate
 * clamp), the parallel run and the arrowhead sit on the same x — the line
 * goes straight in, no fan. */
const TRUNK_SEP = 0.16;

interface Oriented {
  id: string;
  s: string; // lower-rank end
  t: string; // higher-rank end
  forward: boolean; // s === original source
  ot: string;
  source: string;
  target: string;
}

export function relayoutVisible(
  nodesIn: LayoutNode[],
  edgesIn: LayoutEdge[],
  opts?: {
    /** See `ViewParams.preserveStability`. Default `true`: matches every
     * caller from before this option existed. When `false`, the two hints
     * below collapse to a constant, which turns the "floor" in the ranking
     * section into no floor at all (a plain longest-path over the *visible*
     * edges) and the initial layer order into a neutral one the
     * crossing-minimisation sweeps settle purely from what's on screen —
     * without touching either of those sections' own logic, since both
     * already do the real work from the visible topology alone and only
     * ever *start from* these hints. */
    preserveStability?: boolean;
  },
): Relayout {
  const preserveStability = opts?.preserveStability ?? true;
  // Guard against a malformed payload (e.g. an artifact produced by an
  // early build where a serde bug dropped node ids): everything downstream
  // assumes a real string id on every node and edge.
  const nodes = nodesIn.filter((n) => typeof n?.id === 'string');
  const idSet = new Set(nodes.map((n) => n.id));
  const edges = edgesIn.filter(
    (e) => typeof e?.id === 'string' && idSet.has(e.source) && idSet.has(e.target),
  );
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const rankHint = (id: string) => (preserveStability ? nodeById.get(id)?.rank ?? 0 : 0);
  // The *true* full-graph rank, regardless of mode — a fact about the
  // process, not a stability anchor. Used below only where relative time
  // order has to be respected even when there is nothing else (no visible
  // edge) to establish it; never as a floor on a node's own final rank
  // value, which is what `rankHint` (zeroed when not preserving stability)
  // controls instead.
  const fullRank = (id: string) => nodeById.get(id)?.rank ?? 0;

  // Connected components of the *visible* graph (undirected — only
  // reachability matters here). Meaningful only when `preserveStability` is
  // off: two nodes with no path between them through what is currently on
  // screen have no way to know, from the visible edges alone, which of them
  // the process actually reaches first — and simply zeroing out every rank
  // hint (which is otherwise the right thing for this mode to do) left them
  // in whatever order happened to fall out of an alphabetical id tie-break,
  // which is what let an early activity and a much later one land on the
  // same row, or in the wrong relative order entirely, the moment the
  // activities that used to connect them were filtered out. The *full*
  // model's own rank is still a fact regardless of what is hidden, so it is
  // used here to order components against each other — never to anchor a
  // node's exact position *within* its own component, which stays computed
  // fresh from the visible topology exactly as this mode intends.
  const compParent = new Map<string, string>();
  const compFind = (x: string): string => {
    let r = x;
    while ((compParent.get(r) ?? r) !== r) r = compParent.get(r)!;
    let c = x;
    while (c !== r) {
      const nx = compParent.get(c) ?? r;
      compParent.set(c, r);
      c = nx;
    }
    return r;
  };
  for (const n of nodes) compParent.set(n.id, n.id);
  for (const e of edges) {
    if (e.source === e.target) continue;
    const a = compFind(e.source);
    const b = compFind(e.target);
    if (a !== b) compParent.set(a, b);
  }
  const compOf = new Map<string, string[]>();
  for (const n of nodes) {
    const r = compFind(n.id);
    (compOf.get(r) ?? compOf.set(r, []).get(r)!).push(n.id);
  }
  const compMinRank = new Map(
    [...compOf.entries()].map(([r, ids]) => [r, Math.min(...ids.map(fullRank))] as const),
  );
  const compOrder = [...compOf.keys()].sort(
    (a, b) => compMinRank.get(a)! - compMinRank.get(b)! || a.localeCompare(b),
  );
  const compDense = new Map(compOrder.map((r, i) => [r, i]));
  const componentFloor = (id: string) => compDense.get(compFind(id)) ?? 0;

  // ------------------------------------------------------------- ranking
  // The filtered view is what people actually read, so the ranking is
  // refined for the *visible* subgraph — but as a monotone refinement of the
  // full-graph order, never a re-derivation from scratch — when
  // `preserveStability` is on:
  //
  //   floor  = the discovered model's own rank, dense-packed. Keeping it as
  //            a lower bound is what stops a late activity floating to the
  //            top the moment the slider hides its last visible predecessor
  //            (the "package delivered sits at the top" report).
  //   refine = every visible edge must strictly descend. Without this, two
  //            activities the full graph happened to co-rank stay on one row,
  //            which is doubly bad: the edge is drawn as a long horizontal,
  //            *and* the dummy-chain builder below skips a same-rank edge
  //            entirely, so the barycenter pass never even learns those two
  //            nodes are related and lets them drift lanes apart. That is
  //            exactly the "Bring to Loading → Load to Vehicle" case.
  //
  // Both together: correct, compact time order for what is on screen, while
  // adding detail only ever pushes a node further down — never reshuffles —
  // so the map stays stable as the slider moves.
  //
  // When `preserveStability` is off, the floor is *per component* instead
  // of per node — every node in one visible connected component starts
  // from the same value (its component's own position in the full-graph
  // order), and the refine step below still does all the real, fresh work
  // of spreading them out from there using only the visible edges. Nothing
  // about a node's position *within* its component is anchored to the full
  // graph in this mode; only which component comes before which is.
  const usedRanks = [...new Set(nodes.map((n) => rankHint(n.id)))].sort((a, b) => a - b);
  const denseOf = new Map(usedRanks.map((r, i) => [r, i]));
  const floorOf = (id: string) => (preserveStability ? denseOf.get(rankHint(id)) ?? 0 : componentFloor(id));

  // A total order over nodes, so the precedence graph below is acyclic even
  // where the model co-ranked two activities that reference each other.
  //
  // The final tie-break, when floor and lane hint both agree, used to be a
  // plain alphabetical comparison of node ids — a fine fallback when there
  // is nothing else to go on, but a real problem the moment there *is*
  // something else to go on: two nodes in the same component with no lane
  // hint (exactly what `preserveStability: false` gives every node) tie on
  // both of the first two keys, so id ends up deciding the order for the
  // *entire* component — and id has no relationship whatsoever to which of
  // two nodes a real edge says comes first. Whenever it disagreed, the edge
  // was silently dropped as a precedence constraint two lines below (the
  // `orderKey.get(source) >= orderKey.get(target)` gate), leaving its
  // target stuck at the component's shared floor rank instead of pushed
  // below its source — an object type's own end-of-life marker landing
  // beside its start marker instead of below wherever its last activity
  // actually is, is exactly this: a real "activity → end marker" edge whose
  // two ids happened to sort the wrong way.
  //
  // `topoPos` fixes the tie-break itself rather than special-casing the
  // symptom: a DFS-postorder-reversed topological sort over the visible
  // edges (self-loops aside) agrees with a real edge's own direction
  // everywhere except inside an actual cycle — which is the one case this
  // total order exists to fall back gracefully on in the first place, so a
  // cycle's back edge still resolves the same arbitrary-but-stable way it
  // always did (id, last).
  // Only edges the model's own full-graph rank already agrees run forward
  // feed this sort -- the same test the precedence loop below applies. A
  // genuine rework edge (`fullRank(source) > fullRank(target)`) is exactly
  // what turns this graph cyclic (Weigh -> Place in Stock -> Weigh, a real
  // and common shape once a station reappears in its own object type's
  // rework), and feeding it in here does not make the topological sort
  // "handle the cycle gracefully" the way the header comment intends --
  // it makes the sort's arbitrary resolution of that cycle contradict
  // fullRank's own already-settled judgement about a *different*, perfectly
  // acyclic edge nearby (Place in Stock -> Bring to Loading Bay), which is
  // precisely what let that edge get silently dropped as a ranking
  // constraint too, the very failure this tie-break exists to prevent.
  const topoAdj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.source === e.target || fullRank(e.source) > fullRank(e.target)) continue;
    (topoAdj.get(e.source) ?? topoAdj.set(e.source, []).get(e.source)!).push(e.target);
  }
  const topoPos = new Map<string, number>();
  {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const order: string[] = [];
    const visit = (id: string) => {
      if (done.has(id) || visiting.has(id)) return;
      visiting.add(id);
      for (const next of topoAdj.get(id) ?? []) visit(next);
      visiting.delete(id);
      done.add(id);
      order.push(id);
    };
    // Sorted so the result depends only on the graph, not on Map/array
    // iteration order.
    for (const n of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) visit(n.id);
    order.reverse();
    order.forEach((id, i) => topoPos.set(id, i));
  }
  const laneHintOf = (id: string) => (preserveStability ? nodeById.get(id)?.lane ?? 0 : 0);
  const orderKey = new Map(
    [...nodes]
      .sort((a, b) =>
        floorOf(a.id) - floorOf(b.id) ||
        laneHintOf(a.id) - laneHintOf(b.id) ||
        (topoPos.get(a.id) ?? 0) - (topoPos.get(b.id) ?? 0) ||
        a.id.localeCompare(b.id))
      .map((n, i) => [n.id, i]),
  );
  const precPred = new Map<string, string[]>();
  const precSucc = new Map<string, string[]>();
  for (const e of edges) {
    if (e.source === e.target) continue;
    // Only edges that already run forwards in the model's order constrain
    // the ranking; one that runs backwards is a genuine rework loop and is
    // routed as such, so it must not push its target down. Always checked
    // against the *true* full-graph rank (see `fullRank` above) — whether a
    // specific edge is a rework loop is a fact about the process, not
    // something `preserveStability` should change the answer to; `rankHint`
    // being zeroed for this mode is about not anchoring a node's own
    // position, not about forgetting which edges loop backward.
    if (fullRank(e.source) > fullRank(e.target)) continue;
    if ((orderKey.get(e.source) ?? 0) >= (orderKey.get(e.target) ?? 0)) continue;
    (precPred.get(e.target) ?? precPred.set(e.target, []).get(e.target)!).push(e.source);
    (precSucc.get(e.source) ?? precSucc.set(e.source, []).get(e.source)!).push(e.target);
  }

  const rank = new Map<string, number>();
  for (const n of [...nodes].sort((a, b) => (orderKey.get(a.id) ?? 0) - (orderKey.get(b.id) ?? 0))) {
    let r = floorOf(n.id);
    for (const p of precPred.get(n.id) ?? []) r = Math.max(r, (rank.get(p) ?? 0) + 1);
    rank.set(n.id, r);
  }

  // ALAP start markers. The pass above is as-soon-as-possible: a node lands
  // on its floor and is then pushed down only by its predecessors. A node the
  // *visible* subgraph gives no forward predecessor therefore never moves at
  // all — it sits on its floor whatever the rest of the drawing does.
  //
  // With `preserveStability` on that floor is the node's own model rank, and
  // the discovered model already puts an object type's start marker directly
  // above the activity it feeds, so this was invisible. With stability off
  // the floor is one shared value for the whole connected component, so every
  // such node collapses onto that single row: all six object types of a log
  // starting side by side on the top row, however far apart the activities
  // they actually feed are.
  //
  // A start marker is not a process step — it is an annotation saying "this
  // object type enters here" — so it has no rank of its own to defend and
  // belongs immediately above whatever it feeds. Pull it down to exactly
  // there. Two properties keep this safe:
  //
  //   - it only ever *lowers* a node (`Math.max` against the rank it already
  //     has), so the stability guarantee — adding detail pushes a node down,
  //     never reshuffles — is untouched, and with stability on a marker can
  //     still never rise above where the full model put it;
  //   - its one edge still strictly descends, because it stops one rank above
  //     the earliest of its successors, whose own rank does not move.
  //
  // Deliberately *not* every root. A station that became a root only because
  // the slider hid its predecessors still has a real position in the process,
  // and dragging it down to meet its successor moves a genuine hub through
  // rows that unrelated long edges are already routed past — which is not a
  // ranking question at all, and `logistics.check.ts` catches it as arcs
  // cutting through node footprints. Markers have no such claim.
  for (const n of nodes) {
    if (n.kind !== 'source') continue;
    if ((precPred.get(n.id) ?? []).length) continue;
    const succs = precSucc.get(n.id) ?? [];
    if (!succs.length) continue;
    let earliest = Infinity;
    for (const t of succs) earliest = Math.min(earliest, rank.get(t) ?? 0);
    rank.set(n.id, Math.max(rank.get(n.id) ?? 0, earliest - 1));
  }

  // Refining can leave gaps; close them so no empty band is drawn.
  const finalRanks = [...new Set(rank.values())].sort((a, b) => a - b);
  const compact = new Map(finalRanks.map((r, i) => [r, i]));
  for (const [id, r] of rank) rank.set(id, compact.get(r) ?? 0);
  const maxRank = Math.max(0, ...rank.values());

  const oriented: Oriented[] = [];
  for (const e of edges) {
    if (e.source === e.target || !nodeById.has(e.source) || !nodeById.has(e.target)) continue;
    const forward = (rank.get(e.source) ?? 0) <= (rank.get(e.target) ?? 0);
    oriented.push({
      id: e.id,
      s: forward ? e.source : e.target,
      t: forward ? e.target : e.source,
      forward,
      ot: typeof e.objectType === 'string' ? e.objectType : '',
      source: e.source,
      target: e.target,
    });
  }

  // Dummy chains for edges spanning more than one rank.
  const oSucc = new Map<string, string[]>();
  const oPred = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    (oSucc.get(a) ?? oSucc.set(a, []).get(a)!).push(b);
    (oPred.get(b) ?? oPred.set(b, []).get(b)!).push(a);
  };
  const dummyRank = new Map<string, number>();
  const dummyOf = new Map<string, string[]>(); // edge id -> dummy ids, low→high rank
  for (const e of oriented) {
    const r0 = rank.get(e.s)!;
    const r1 = rank.get(e.t)!;
    if (r1 - r0 <= 1) {
      if (r1 > r0) link(e.s, e.t);
      continue;
    }
    let prev = e.s;
    const ds: string[] = [];
    for (let r = r0 + 1; r < r1; r++) {
      const d = `__wp:${e.id}:${r}`;
      dummyRank.set(d, r);
      link(prev, d);
      prev = d;
      ds.push(d);
    }
    link(prev, e.t);
    dummyOf.set(e.id, ds);
  }

  // Layers, seeded by the payload's own lane order (keeps whatever crossing
  // minimisation the full-graph layout already found, where it still applies).
  let layers: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const n of nodes) layers[rank.get(n.id)!].push(n.id);
  for (const [d, r] of dummyRank) layers[r].push(d);
  const isDummy = (id: string) => typeof id === 'string' && id.startsWith('__wp:');
  const laneHint = (id: string) => (isDummy(id) || !preserveStability ? 0 : nodeById.get(id)?.lane ?? 0);
  for (const layer of layers) layer.sort((a, b) => laneHint(a) - laneHint(b) || String(a).localeCompare(String(b)));

  const pos = new Map<string, number>();
  for (const layer of layers) layer.forEach((id, i) => pos.set(id, i));

  const mean = (ids: string[]) =>
    ids.length ? ids.reduce((s, id) => s + (pos.get(id) ?? 0), 0) / ids.length : undefined;
  const desiredOf = (id: string) => {
    const up = mean(oPred.get(id) ?? []);
    const dn = mean(oSucc.get(id) ?? []);
    if (up != null && dn != null) return (up + dn) / 2;
    return up ?? dn ?? pos.get(id)!;
  };

  // ------------------------------------------------- crossing minimisation
  // Sugiyama phase 2 proper. The previous version ran six barycentre sweeps
  // and kept whatever the last one produced — but barycentre oscillates, so
  // it could (and did) end on an arrangement worse than one it had already
  // passed through, which is what left unrelated activities stranded far
  // apart horizontally. Now: median heuristic, then a transpose pass of
  // adjacent swaps that strictly reduce crossings, and the best arrangement
  // *measured* is the one kept.
  const crossingsBetween = (upper: string[], lower: string[]): number => {
    const idx = new Map(lower.map((id, i) => [id, i]));
    const seq: number[] = [];
    for (const u of upper) {
      const below = (oSucc.get(u) ?? [])
        .map((v) => idx.get(v))
        .filter((v): v is number => v !== undefined)
        .sort((a, b) => a - b);
      seq.push(...below);
    }
    let c = 0;
    for (let i = 0; i < seq.length; i++) {
      for (let j = i + 1; j < seq.length; j++) if (seq[i] > seq[j]) c++;
    }
    return c;
  };
  const totalCrossings = (ls: string[][]): number => {
    let c = 0;
    for (let r = 0; r < ls.length - 1; r++) c += crossingsBetween(ls[r], ls[r + 1]);
    return c;
  };
  const applyPositions = (ls: string[][]) => {
    for (const l of ls) l.forEach((id, i) => pos.set(id, i));
  };

  // Median of a node's neighbours in the adjacent layer — Eades & Wormald's
  // heuristic, which handles unevenly-branched nodes better than a mean.
  const medianOf = (id: string, neighbours: Map<string, string[]>): number => {
    const ps = (neighbours.get(id) ?? [])
      .map((n) => pos.get(n))
      .filter((v): v is number => v !== undefined)
      .sort((a, b) => a - b);
    if (ps.length === 0) return -1; // "no opinion" — keep where it is
    const m = ps.length >> 1;
    return ps.length % 2 === 1 ? ps[m] : (ps[m - 1] + ps[m]) / 2;
  };

  // A node's neighbours' slots in the adjacent layer, ascending.
  const neighbourPositions = (ids: string[] | undefined, at: Map<string, number>): number[] => {
    const out: number[] = [];
    for (const id of ids ?? []) {
      const i = at.get(id);
      if (i !== undefined) out.push(i);
    }
    return out.sort((a, b) => a - b);
  };
  // #{(a, b) in A x B : a > b} for two ascending arrays, in one walk.
  const greaterPairs = (a: number[], b: number[]): number => {
    let n = 0, j = 0;
    for (const x of a) {
      while (j < b.length && b[j] < x) j++;
      n += j;
    }
    return n;
  };

  let best = layers.map((l) => [...l]);
  let bestScore = totalCrossings(best);
  for (let sweep = 0; sweep < 16 && bestScore > 0; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? layers.map((_, i) => i) : layers.map((_, i) => i).reverse();
    for (const r of order) {
      const from = down ? oPred : oSucc;
      const keyed = layers[r].map((id, i) => ({ id, i, m: medianOf(id, from) }));
      // A node with no neighbour on that side keeps its slot rather than
      // being swept to one end.
      keyed.sort((a, b) => (a.m < 0 ? a.i : a.m) - (b.m < 0 ? b.i : b.m) || a.i - b.i);
      layers[r] = keyed.map((k) => k.id);
      applyPositions(layers);
    }
    // Transpose: repeatedly swap adjacent pairs while that strictly helps.
    // Decided by *difference*, never by recounting. Swapping two adjacent
    // nodes `v` and `w` in one layer moves no other node, so every crossing
    // that involves neither of them is identical before and after and
    // cancels in the comparison: only pairs with one edge at `v` and one at
    // `w` can change. So the verdict needs just those, read off the two
    // nodes' own neighbour positions in O(deg v + deg w) — where recounting
    // the whole layer pair costs O(E^2) in the edges between them, per
    // candidate swap. On the dense Order Management map (208 arcs over 18
    // activities, which become 480 dummy nodes in layers up to 66 wide)
    // that was 56,772 full recounts and ~99M inversion tests, and it was
    // essentially the entire cost of this function.
    //
    // Both directions are counted the same way. Above the layer, an edge
    // into `v` and an edge into `w` cross exactly when their sources sit in
    // the opposite order to their targets; below it, the same holds for the
    // two nodes' successors. A source feeding both `v` and `w` contributes
    // nothing either way (its own targets are emitted in layer order), so
    // strict inequality is what `greaterPairs` counts.
    for (let pass = 0; pass < 4; pass++) {
      let improved = false;
      for (let r = 0; r < layers.length; r++) {
        const l = layers[r];
        const above = r > 0 ? new Map(layers[r - 1].map((id, i) => [id, i] as const)) : null;
        const below = r + 1 < layers.length ? new Map(layers[r + 1].map((id, i) => [id, i] as const)) : null;
        // A swap moves two ids inside one layer, so only those two slots of
        // `pos` need rewriting; the index maps above read the layer arrays.
        const swap = (i: number) => {
          [l[i], l[i + 1]] = [l[i + 1], l[i]];
          pos.set(l[i], i);
          pos.set(l[i + 1], i + 1);
        };
        for (let i = 0; i + 1 < l.length; i++) {
          const v = l[i], w = l[i + 1];
          let keep = 0, swapped = 0;
          if (above) {
            const pv = neighbourPositions(oPred.get(v), above);
            const pw = neighbourPositions(oPred.get(w), above);
            keep += greaterPairs(pv, pw);
            swapped += greaterPairs(pw, pv);
          }
          if (below) {
            const sv = neighbourPositions(oSucc.get(v), below);
            const sw = neighbourPositions(oSucc.get(w), below);
            keep += greaterPairs(sv, sw);
            swapped += greaterPairs(sw, sv);
          }
          if (swapped < keep) { swap(i); improved = true; }
        }
      }
      if (!improved) break;
    }
    const score = totalCrossings(layers);
    if (score < bestScore) {
      bestScore = score;
      best = layers.map((l) => [...l]);
    }
  }
  layers = best.map((l) => [...l]);
  applyPositions(layers);
  // Two adjacent pass-through lines need only a fraction of a full lane
  // between them — a full 1.0 gap for every dummy pair blows a busy trunk
  // rank out to a dozen lanes wide while every other rank stays narrow.
  const gapsFor = (l: string[]) =>
    l.slice(0, -1).map((id, i) => (isDummy(id) && isDummy(l[i + 1]) ? 0.34 : 1));

  // Coordinate relaxation — real-valued, order-preserving.
  for (let sweep = 0; sweep < 60; sweep++) {
    const idx = sweep % 2 === 0 ? layers.map((_, i) => i) : layers.map((_, i) => i).reverse();
    let moved = 0;
    for (const r of idx) {
      const l = layers[r];
      if (l.length < 1) continue;
      const resolved = orderPreserving(l.map((id) => desiredOf(id)), gapsFor(l));
      l.forEach((id, i) => {
        const prev = pos.get(id) ?? 0;
        pos.set(id, resolved[i]);
        moved = Math.max(moved, Math.abs(resolved[i] - prev));
      });
    }
    if (moved < 1e-4) break;
  }

  // Object-type trunks. For every node fed by (or left toward) more than one
  // object type — or by two-plus edges of a single type — pull each type
  // onto its *own* lane, `TRUNK_SEP` apart, centred on the node's lane.
  // Same-type edges share one lane and overlap into a single line ("one
  // metro line"); distinct types stay on clearly spaced parallel lanes and
  // converge only over the final hop into the node — never merged onto one
  // vertical (the regression this fixes). The forced lane is applied to the
  // dummy chain: the target half snaps to the target trunk, the source half
  // to the source trunk, so sources at different ranks still join the trunk
  // at staggered heights (the gradual top-to-bottom merge).
  const trunkFor = (side: 'source' | 'target') => {
    const groups = new Map<string, Map<string, Oriented[]>>();
    for (const o of oriented) {
      if (nodeById.get(o[side])?.kind === 'gateway') continue;
      // Forward and backward (loop) edges of the same type into the same
      // node arrive from different directions — give them their own slot so
      // a rework loop's arrowhead never lands on the forward line's.
      const key = `${o.ot} ${o.forward ? 'f' : 'b'}`;
      const byType = groups.get(o[side]) ?? groups.set(o[side], new Map()).get(o[side])!;
      (byType.get(key) ?? byType.set(key, []).get(key)!).push(o);
    }
    const endRef = (o: Oriented) => {
      if (o.forward) {
        const ds = dummyOf.get(o.id);
        if (ds && ds.length) return ds[side === 'target' ? ds.length - 1 : 0];
      }
      return side === 'target' ? o.source : o.target;
    };
    const meanApproach = (grp: Oriented[]) =>
      grp.reduce((s, o) => s + (pos.get(endRef(o)) ?? 0), 0) / grp.length;
    const trunk = new Map<string, number>();
    const delta = new Map<string, number>();
    for (const [node, byType] of groups) {
      const base = pos.get(node);
      if (base == null) continue;
      const anyBundle = [...byType.values()].some((g) => g.length >= 2);
      if (byType.size < 2 && !anyBundle) continue;
      const types = [...byType.keys()].sort(
        (a, b) => meanApproach(byType.get(a)!) - meanApproach(byType.get(b)!) || a.localeCompare(b),
      );
      // Shrink the step for a busy node so the whole fan never spreads past
      // ~0.8 lane — the view uses this delta for the arrowhead verbatim, so
      // an over-wide fan would put the outer arrowheads off the station.
      const step = Math.min(TRUNK_SEP, 0.8 / Math.max(1, types.length - 1));
      types.forEach((t, i) => {
        const d = (i - (types.length - 1) / 2) * step;
        for (const o of byType.get(t)!) {
          trunk.set(o.id, base + d);
          delta.set(o.id, d);
        }
      });
    }
    return { trunk, delta };
  };
  const { trunk: targetTrunk, delta: targetTrunkDelta } = trunkFor('target');
  const { trunk: sourceTrunk, delta: sourceTrunkDelta } = trunkFor('source');
  const bundledTargetEnds = new Set([...targetTrunk.keys()]);
  const bundledSourceEnds = new Set([...sourceTrunk.keys()]);

  const forcedLane = new Map<string, number>();
  for (const o of oriented) {
    if (!o.forward) continue;
    const ds = dummyOf.get(o.id);
    if (!ds || ds.length === 0) continue;
    const tl = targetTrunk.get(o.id);
    const sl = sourceTrunk.get(o.id);
    const n = ds.length;
    ds.forEach((d, k) => {
      const frac = (k + 1) / (n + 1);
      if (tl != null && sl != null) forcedLane.set(d, frac >= 0.5 ? tl : sl);
      else if (tl != null && (k >= 1 || n === 1)) forcedLane.set(d, tl);
      else if (sl != null && (k <= n - 2 || n === 1)) forcedLane.set(d, sl);
    });
  }

  // ---- Connected-component packing -------------------------------------
  // The ordering + relaxation above runs in one global coordinate space, so
  // a small or disconnected component drifts wherever its own barycenter
  // pulls it — a two-node component can end up stranded far to one side, or
  // two components can land on overlapping x-ranges. Pack them instead:
  // every connected component gets its own horizontal band, laid side by
  // side left-to-right with a gap wide enough for its own loop corridors.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
    let c = x;
    while (c !== r) {
      const nx = parent.get(c) ?? r;
      parent.set(c, r);
      c = nx;
    }
    return r;
  };
  for (const n of nodes) parent.set(n.id, n.id);
  for (const e of edges) {
    const a = find(e.source);
    const b = find(e.target);
    if (a !== b) parent.set(a, b);
  }
  const compReal = new Map<string, string[]>();
  const compDummy = new Map<string, string[]>();
  const compLoops = new Map<string, number>();
  for (const n of nodes) (compReal.get(find(n.id)) ?? compReal.set(find(n.id), []).get(find(n.id))!).push(n.id);
  for (const o of oriented) {
    const r = find(o.source);
    const ds = dummyOf.get(o.id);
    if (ds && ds.length) (compDummy.get(r) ?? compDummy.set(r, []).get(r)!).push(...ds);
    if (o.source === o.target || (rank.get(o.target) ?? 0) <= (rank.get(o.source) ?? 0)) {
      compLoops.set(r, (compLoops.get(r) ?? 0) + 1);
    }
  }
  const laneAt = (id: string) => forcedLane.get(id) ?? pos.get(id) ?? 0;
  const comps = [...compReal.keys()].map((r) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const id of compReal.get(r) ?? []) {
      lo = Math.min(lo, pos.get(id) ?? 0);
      hi = Math.max(hi, pos.get(id) ?? 0);
    }
    for (const id of compDummy.get(r) ?? []) {
      lo = Math.min(lo, laneAt(id));
      hi = Math.max(hi, laneAt(id));
    }
    if (!isFinite(lo)) { lo = 0; hi = 0; }
    return { r, lo, hi, mid: (lo + hi) / 2, loops: compLoops.get(r) ?? 0 };
  });
  comps.sort((a, b) => a.mid - b.mid || String(a.r).localeCompare(String(b.r)));
  const corridorPad = (loops: number) => Math.min(2.6, 0.7 + loops * 0.4);
  const componentSpan = new Map<string, { lo: number; hi: number }>();
  let cursor = 0;
  for (const c of comps) {
    const pad = corridorPad(c.loops);
    const delta = cursor + pad - c.lo;
    for (const id of compReal.get(c.r) ?? []) pos.set(id, (pos.get(id) ?? 0) + delta);
    for (const id of compDummy.get(c.r) ?? []) {
      if (forcedLane.has(id)) forcedLane.set(id, forcedLane.get(id)! + delta);
      else pos.set(id, (pos.get(id) ?? 0) + delta);
    }
    c.lo += delta;
    c.hi += delta;
    cursor = c.hi + pad + 0.6;
  }

  // Two *different* real nodes at adjacent ranks share the channel between
  // those ranks for their own local approach/departure segments — a node's
  // arrival always bends within the channel just above it, a node's
  // departure within the channel just below it, which for two nodes at
  // ranks r and r+1 is the *same* channel. The router's own per-column
  // track allocation keeps every node's own edges from overlapping each
  // other, and keeps one node from drifting off its own drawn position —
  // but it cannot keep two *different* nodes' independent local segments
  // apart when the nodes themselves end up placed only a px or two apart,
  // since neither node's position may move once drawing starts. Nudging
  // that apart is a layout decision, not a routing one, so it belongs here,
  // once, right after lanes are otherwise finalized — entirely additive: it
  // only ever grows a gap that turned out too small, never touches ordering
  // that already had room, and dummy waypoints are untouched (the router's
  // own sweep already keeps those clear of real nodes since they, unlike a
  // node, are free to move).
  //
  // `MIN_ADJACENT_RANK_GAP` is deliberately conservative — this runs before
  // any router even exists to say how wide either node's own busy column
  // will need to be, so there is no way to compute the exact requirement
  // here. 0.5 lane units clears a typical multi-type station's own spread
  // at any pitch this view uses; reusing `orderPreserving` (rather than a
  // new ad hoc nudge) keeps this a proven, order-preserving minimal
  // adjustment, not another hand-rolled positioning heuristic.
  //
  // Exception: two nodes directly joined by a visible edge are not "two
  // different nodes' independent local segments" at all — they're the one
  // edge's own arrival and departure, the same line continuing straight
  // through. A degree-1 boundary marker above its sole successor is the
  // clearest case: the relaxation pass above already converges it onto
  // exactly its child's position (nothing else pulls on it), and this nudge
  // used to immediately shove it back apart anyway, purely because "two
  // real nodes closer than 0.5 lanes at adjacent ranks" doesn't distinguish
  // that from two unrelated nodes that really would collide. `adjacentEdge`
  // zeroes the required gap for exactly the pair an edge in `edges` connects
  // — every other consecutive pair keeps the normal minimum.
  {
    const MIN_ADJACENT_RANK_GAP = 0.5;
    const adjacentEdge = new Set<string>();
    const edgeKey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);
    for (const e of edges) {
      if (e.source === e.target) continue;
      adjacentEdge.add(edgeKey(e.source, e.target));
    }
    const byRank = new Map<number, string[]>();
    for (const n of nodes) {
      const r = rank.get(n.id) ?? 0;
      (byRank.get(r) ?? byRank.set(r, []).get(r)!).push(n.id);
    }
    for (let sweep = 0; sweep < 4; sweep++) {
      let moved = 0;
      for (let r = 0; r < maxRank; r++) {
        const ids = [...(byRank.get(r) ?? []), ...(byRank.get(r + 1) ?? [])];
        if (ids.length < 2) continue;
        ids.sort((a, b) => (pos.get(a) ?? 0) - (pos.get(b) ?? 0));
        const resolved = orderPreserving(
          ids.map((id) => pos.get(id) ?? 0),
          ids.slice(1).map((id, i) => (adjacentEdge.has(edgeKey(ids[i], id)) ? 0 : MIN_ADJACENT_RANK_GAP)),
        );
        ids.forEach((id, i) => {
          const prev = pos.get(id) ?? 0;
          pos.set(id, resolved[i]);
          moved = Math.max(moved, Math.abs(resolved[i] - prev));
        });
      }
      if (moved < 1e-6) break;
    }
  }

  const realPos = nodes.map((n) => pos.get(n.id) ?? 0);
  const shift = realPos.length ? realPos.reduce((a, b) => a + b, 0) / realPos.length : 0;

  for (const c of comps) {
    const span = { lo: c.lo - shift, hi: c.hi - shift };
    for (const id of compReal.get(c.r) ?? []) componentSpan.set(id, span);
  }

  const lane = new Map<string, number>();
  for (const n of nodes) lane.set(n.id, (pos.get(n.id) ?? 0) - shift);

  const waypoints = new Map<string, Array<{ rank: number; lane: number }>>();
  for (const [eid, ds] of dummyOf) {
    const pts = ds.map((d) => ({ rank: dummyRank.get(d)!, lane: (forcedLane.get(d) ?? pos.get(d) ?? 0) - shift }));
    const e = oriented.find((o) => o.id === eid)!;
    waypoints.set(eid, e.forward ? pts : [...pts].reverse());
  }

  return {
    rank, lane, waypoints, bundledTargetEnds, bundledSourceEnds,
    targetTrunkDelta, sourceTrunkDelta, componentSpan, maxRank,
  };
}

/**
 * Closest order-preserving arrangement of `desired` where consecutive
 * entries stay at least `gaps[i]` apart — unweighted pool-adjacent-violators
 * on the gap-shifted sequence, the same reduction `metro-map-core`'s
 * `resolve_order_preserving` uses (there with a fixed gap of 1).
 */
function orderPreserving(desired: number[], gaps: number[]): number[] {
  const cum = [0];
  for (let i = 0; i < gaps.length; i++) cum.push(cum[i] + gaps[i]);
  const y = desired.map((d, i) => d - cum[i]);
  const val: number[] = [];
  const wt: number[] = [];
  const len: number[] = [];
  for (const yi of y) {
    let v = yi;
    let w = 1;
    let n = 1;
    while (val.length && val[val.length - 1] > v) {
      const pv = val.pop()!;
      const pw = wt.pop()!;
      const pn = len.pop()!;
      v = (v * w + pv * pw) / (w + pw);
      w += pw;
      n += pn;
    }
    val.push(v);
    wt.push(w);
    len.push(n);
  }
  const out: number[] = [];
  for (let b = 0; b < val.length; b++) for (let k = 0; k < len[b]; k++) out.push(val[b]);
  return out.map((v, i) => v + cum[i]);
}
