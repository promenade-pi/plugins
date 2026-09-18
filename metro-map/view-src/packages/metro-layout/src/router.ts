/**
 * Orthogonal edge router with explicit track allocation.
 *
 * This replaces six independent "nudge on collision" heuristics
 * (localOffsets / corridorOffsets / trunk deltas / component packing side
 * effects / loop staggering / assignPorts) that each fixed a symptom and
 * perturbed the others' inputs. Overlaps were only ever *heuristically
 * unlikely*, which is why they kept reappearing.
 *
 * The construction here is the standard one from the layered-drawing
 * literature (Sugiyama + orthogonal routing; see Hegemann & Wolff, "A Simple
 * Pipeline for Orthogonal Graph Drawing", and Nachmanson's notes on
 * Sugiyama's scheme): nodes sit on a grid of **rows** (ranks) and **lanes**.
 * Every edge is an alternating chain of axis-aligned segments. Each segment
 * is assigned to a *track*:
 *
 *   - a **vertical** segment belongs to a lane **column**; two verticals in
 *     one column may share a track only if their row spans are disjoint;
 *   - a **horizontal** segment belongs to the **channel** between two
 *     consecutive rows; two horizontals in one channel may share a track
 *     only if their x spans are disjoint.
 *
 * Track assignment is interval partitioning (the optimal greedy for interval
 * graphs), so two lines can never end up collinear-and-overlapping *by
 * construction* — there is nothing left to patch afterwards.
 *
 * Deliberate exception: segments of the **same object type** are allowed to
 * share a track. That is the metro-map "one line" semantic — several arcs of
 * one object type merging into a station should draw on top of each other,
 * not fan out. *Turn-back edges are excluded from that merge*: two rework
 * loops of one object type are separate excursions, not one continuous line,
 * so letting them share a corridor drew them on top of each other with their
 * flow animations running in opposite directions.
 *
 * Ordering note — the allocation is deliberately free of circular
 * dependencies. Column conflicts are decided on *row* spans (integers), not
 * pixels, so columns resolve without knowing y. Only then do horizontal
 * segments have real x spans; channel tracks resolve from those, which fixes
 * each channel's height, which finally yields y.
 */

import type { Point } from './route';

/** A node as the router needs it: grid position plus drawn half-extents. */
export interface RNode {
  id: string;
  rank: number;
  lane: number;
  halfW: number;
  halfH: number;
  /** Explicit process junction: branches must meet at the marker. */
  gateway?: boolean;
  /** A source or single-type station eligible for short source-chain alignment. */
  alignable?: boolean;
  /** Optional caption below a terminus, protected from unrelated lines. */
  labelHalfW?: number;
}

export interface REdge {
  id: string;
  source: string;
  target: string;
  objectType: string;
  /** Intermediate grid waypoints in source→target order (integer ranks). */
  waypoints: Array<{ rank: number; lane: number }>;
}

export interface RouteOptions {
  /** Lane index → nominal pixel x. */
  laneX: (lane: number) => number;
  /** Pixel gap between two parallel lines sharing a column or a channel. */
  spacing: number;
  /** Smallest vertical gap between two rows' node borders. */
  minChannel: number;
  /** Distance between two adjacent lane centres. A column's lines are never
   * allowed to spread wider than this, so two columns cannot bleed into one
   * another however busy they get — this is now an unconditional bound (no
   * gap floor overrides it, see the column-spread comment in `routeAll`),
   * so a caller that wants a *readable* gap even in the busiest column
   * should size `pitch` (and `laneX`'s own scale, consistently) up front
   * using `peakTrackDemand` rather than pass a fixed value regardless of
   * how many tracks the graph actually needs. */
  pitch: number;
}

export interface RouteResult {
  points: Map<string, Point[]>;
  /** Final pixel x of every node. Gateways may move within their lane band
   * to sit midway between their allocated incoming tracks. */
  nodeX: Map<string, number>;
  /** Pixel y of a row centre, by rank. */
  rowY: Map<number, number>;
  /** Pixel bounds of everything drawn (nodes and routed lines). */
  extent: { lo: number; hi: number };
  /** The largest number of tracks any single lane column or row channel
   * needed in this call. Reported so a caller can compare it against
   * `peakTrackDemand`'s own estimate, or re-derive `pitch` and re-route if
   * it turns out to need more room than assumed. */
  maxTracks: number;
  /** The largest render-time corner chamfer that cannot reach into a
   * neighbouring track — see the comment where this is computed, at the
   * end of `routeAll`. A caller should pass `Math.min(CHAMFER_CUT,
   * safeChamferCut)` to `chamferCorners`, never `CHAMFER_CUT` alone: a
   * fixed cut is exactly what let independently-chamfered edges on
   * adjacent tracks become collinear once their corners lined up at
   * roughly 45° to each other. */
  safeChamferCut: number;
}

/**
 * One axis-aligned piece of an edge, before its track is known. `at` is a
 * *row coordinate*: an integer is a row centre, `r + 0.5` is the channel
 * between rows `r` and `r + 1`.
 */
interface VSeg {
  kind: 'v';
  edgeId: string;
  /** Track-sharing group. Same object type merges into one metro line —
   * except for turn-back edges, which are separate excursions and get a
   * per-edge key so two loops never land on the same corridor. */
  mergeKey: string;
  /** Nominal column x (a lane centre, or a side corridor). */
  nominalX: number;
  from: number;
  to: number;
  /** Resolved after column allocation. */
  x: number;
}
interface HSeg {
  kind: 'h';
  edgeId: string;
  mergeKey: string;
  /** Channel row coordinate (always `r + 0.5`). */
  at: number;
  /** Resolved after column allocation. */
  x0: number;
  x1: number;
  /** Resolved after channel allocation. */
  y: number;
}

/** A point on an edge's chain: a row coordinate and a nominal column x. */
interface Stop {
  at: number;
  nominalX: number;
}

const lo = (a: number, b: number) => Math.min(a, b);
const hi = (a: number, b: number) => Math.max(a, b);

/**
 * Interval partitioning: assign each item the smallest slot index such that
 * no already-placed item in that slot overlaps it. Items are keyed by
 * `group`; two items of the same group never conflict (that is the
 * same-object-type merge), so a group is placed once and every member
 * inherits its slot.
 *
 * Returns slot index per group key. Optimal for interval graphs when items
 * are processed in order of interval start — which is what the sort does.
 */
function allocateSlots(
  items: Array<{ group: string; from: number; to: number }>,
  pad = 0,
  /** When set, only endpoints that land on a channel (a non-integer row
   * coordinate) are widened — an endpoint at a row centre is exact. */
  padOnlyFractional = false,
): Map<string, number> {
  // Collapse each group to the union span it needs. Conservative (a group
  // with a gap still blocks the gap) but it keeps the guarantee simple, and
  // a column/channel never holds more than a handful of object types.
  const spans = new Map<string, { from: number; to: number }>();
  for (const it of items) {
    const cur = spans.get(it.group);
    // A segment that *terminates in a channel* does not stop at the channel's
    // boundary — it runs to whichever track inside that channel it bends on,
    // and the channel is a band, not a line. So an endpoint landing on a
    // channel (a half-integer row coordinate) is widened to cover the band.
    // Without this, two verticals whose row spans merely touch at a channel
    // share a track and then overlap by the channel's full height in pixels.
    const rawFrom = lo(it.from, it.to);
    const rawTo = hi(it.from, it.to);
    const from = rawFrom - (padOnlyFractional && Number.isInteger(rawFrom) ? 0 : pad);
    const to = rawTo + (padOnlyFractional && Number.isInteger(rawTo) ? 0 : pad);
    if (!cur) spans.set(it.group, { from, to });
    else {
      cur.from = Math.min(cur.from, from);
      cur.to = Math.max(cur.to, to);
    }
  }

  const ordered = [...spans.entries()].sort(
    (a, b) => a[1].from - b[1].from || a[1].to - b[1].to || a[0].localeCompare(b[0]),
  );
  const slotEnd: number[] = []; // slot index -> highest `to` placed in it
  const out = new Map<string, number>();
  for (const [key, span] of ordered) {
    let slot = slotEnd.findIndex((end) => end <= span.from);
    if (slot === -1) {
      slot = slotEnd.length;
      slotEnd.push(span.to);
    } else {
      slotEnd[slot] = span.to;
    }
    out.set(key, slot);
  }
  return out;
}

/** Centred offsets for `n` slots at `gap` spacing: slot i → pixel delta. */
function slotOffset(i: number, n: number, gap: number): number {
  return (i - (n - 1) / 2) * gap;
}

export function routeAll(
  nodesIn: RNode[],
  edgesIn: REdge[],
  opts: RouteOptions,
): RouteResult {
  const nodes = new Map(nodesIn.map((n) => [n.id, n]));
  const { laneX, spacing, minChannel, pitch } = opts;

  const ranks = [...new Set(nodesIn.map((n) => n.rank))].sort((a, b) => a - b);
  const maxRank = ranks.length ? ranks[ranks.length - 1] : 0;
  const rowHalfH = new Map<number, number>();
  for (const n of nodesIn) rowHalfH.set(n.rank, Math.max(rowHalfH.get(n.rank) ?? 0, n.halfH));

  // Side corridors for turn-back edges sit clear of every node box, so a
  // loop can never run behind a station. Kept as the *global* fallback (used
  // for the overall drawn extent below, and if a component's own local
  // bounds ever come up empty), not as the corridor position itself — see
  // `localCorridorBounds`.
  let nodeLo = 0;
  let nodeHi = 0;
  for (const n of nodesIn) {
    nodeLo = Math.min(nodeLo, laneX(n.lane) - n.halfW);
    nodeHi = Math.max(nodeHi, laneX(n.lane) + n.halfW);
  }

  // A turn-back edge's corridor only ever needs to clear the nodes it could
  // actually run behind: the ones in its own connected component, at the
  // ranks its own excursion passes through. Using the *global* node extent
  // for this (as a single shared left/right corridor for the whole graph
  // once did) makes a short, purely local rework loop pay for the width of
  // the entire diagram — including a wholly unrelated, disconnected
  // component elsewhere on the same canvas, since ranks are shared canvas-
  // wide but a component's own nodes are not. Connectivity is by *any* edge
  // here (not just same-object-type, which only tracks metro-line merging
  // elsewhere in this file), since what matters is merely "could a node
  // this close, at a rank this excursion passes, plausibly be in the way?".
  const gParent = new Map<string, string>();
  const gFind = (x: string): string => {
    let r = x;
    while ((gParent.get(r) ?? r) !== r) r = gParent.get(r)!;
    let c = x;
    while (c !== r) { const nx = gParent.get(c) ?? r; gParent.set(c, r); c = nx; }
    return r;
  };
  for (const n of nodesIn) gParent.set(n.id, n.id);
  for (const e of edgesIn) {
    if (e.source === e.target || !nodes.has(e.source) || !nodes.has(e.target)) continue;
    const ra = gFind(e.source);
    const rb = gFind(e.target);
    if (ra !== rb) gParent.set(ra, rb);
  }
  const compOfNode = new Map(nodesIn.map((n) => [n.id, gFind(n.id)]));
  // A full lane pitch clear of the outermost node, so a corridor's own
  // spread can never reach the nearest lane column's spread.
  const localCorridorBounds = (compId: string, rankLo: number, rankHi: number): { lo: number; hi: number } => {
    let l = Infinity;
    let h = -Infinity;
    for (const n of nodesIn) {
      if (compOfNode.get(n.id) !== compId || n.rank < rankLo || n.rank > rankHi) continue;
      l = Math.min(l, laneX(n.lane) - n.halfW);
      h = Math.max(h, laneX(n.lane) + n.halfW);
    }
    return isFinite(l) ? { lo: l, hi: h } : { lo: nodeLo, hi: nodeHi };
  };

  // ---------------------------------------------------------------- stops
  // Every edge becomes an alternating vertical/horizontal chain. A bend
  // between two rows always happens in the channel between them.
  const stopsOf = new Map<string, Stop[]>();
  const turnBack = new Set<string>();
  for (const e of edgesIn) {
    const s = nodes.get(e.source);
    const t = nodes.get(e.target);
    if (!s || !t) continue;

    const chain: Stop[] = [];
    if (t.rank > s.rank) {
      // Forward: straight down the ranks, through its own waypoints.
      let grid = [
        { rank: s.rank, lane: s.lane },
        ...e.waypoints,
        { rank: t.rank, lane: t.lane },
      ];
      // An aligned, unobstructed pair needs no dummy detour. Track
      // allocation still separates any lines using this direct corridor.
      const directX = laneX(s.lane);
      if (!s.gateway && !t.gateway && Math.abs(directX - laneX(t.lane)) < 0.01
        && nodesIn.every((n) => n.id === s.id || n.id === t.id
          || n.rank <= s.rank || n.rank >= t.rank
          || Math.abs(laneX(n.lane) - directX) > n.halfW + spacing)) {
        grid = [{ rank: s.rank, lane: s.lane }, { rank: t.rank, lane: t.lane }];
      }
      for (let i = 0; i < grid.length; i++) {
        const x = laneX(grid[i].lane);
        if (i === 0) chain.push({ at: grid[i].rank, nominalX: x });
        else {
          const prev = chain[chain.length - 1];
          if (Math.abs(prev.nominalX - x) > 0.5) {
            const mid = (grid[i - 1].rank + grid[i].rank) / 2;
            chain.push({ at: mid, nominalX: prev.nominalX });
            chain.push({ at: mid, nominalX: x });
          }
          chain.push({ at: grid[i].rank, nominalX: x });
        }
      }
    } else {
      turnBack.add(e.id);
      // Turn-back (rework loop, or a self-loop): out the bottom, along a
      // side corridor, in the top. Same convention as every forward edge.
      const sx = laneX(s.lane);
      const tx = laneX(t.lane);
      const { lo: localLo, hi: localHi } = localCorridorBounds(
        compOfNode.get(e.source)!,
        Math.min(s.rank, t.rank),
        Math.max(s.rank, t.rank),
      );
      const side = (sx + tx) / 2 >= (localLo + localHi) / 2 ? localHi + pitch : localLo - pitch;
      chain.push({ at: s.rank, nominalX: sx });
      chain.push({ at: s.rank + 0.5, nominalX: sx });
      chain.push({ at: s.rank + 0.5, nominalX: side });
      chain.push({ at: t.rank - 0.5, nominalX: side });
      chain.push({ at: t.rank - 0.5, nominalX: tx });
      chain.push({ at: t.rank, nominalX: tx });
    }
    stopsOf.set(e.id, chain);
  }

  // ------------------------------------------------------------- segments
  const vSegs: VSeg[] = [];
  const hSegs: HSeg[] = [];
  // A "metro line" is a *connected run* of same-object-type edges, not just
  // every edge of that type: two arcs of one type that share no station are
  // separate strands and must not be drawn on top of each other. Union-find
  // over same-type forward edges joined by a shared endpoint gives exactly
  // that. Turn-back edges are separate excursions and keep a per-edge key.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
    let c = x;
    while (c !== r) { const nx = parent.get(c) ?? r; parent.set(c, r); c = nx; }
    return r;
  };
  const union = (a: string, b: string) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const e of edgesIn) if (!turnBack.has(e.id)) parent.set(e.id, e.id);
  const atNode = new Map<string, string[]>();
  for (const e of edgesIn) {
    if (turnBack.has(e.id)) continue;
    for (const nodeId of [e.source, e.target]) {
      const k = `${e.objectType}\u0000${nodeId}`;
      const seen = atNode.get(k);
      if (seen) { union(e.id, seen[0]); seen.push(e.id); } else atNode.set(k, [e.id]);
    }
  }
  const typeOf = new Map(edgesIn.map((e) => [e.id, e.objectType]));
  const edgeById = new Map(edgesIn.map(e => [e.id, e]));
  // In a junction column, tied branch spans follow their actual approach
  // order, not activity-name order. Reversing these slots creates a false
  // same-colour crossing just before the marker.
  const junctionOrder = new Map([...edgesIn].sort((a, b) => {
    const lane = (e: REdge) => nodes.get(nodes.get(e.source)?.gateway ? e.target : e.source)?.lane ?? 0;
    return lane(a) - lane(b) || a.id.localeCompare(b.id);
  }).map((e, i) => [e.id, String(i).padStart(8, '0')]));
  for (const [edgeId, chain] of stopsOf) {
    const objectType = typeOf.get(edgeId)!;
    const edge = edgeById.get(edgeId)!;
    const junctionBranch = nodes.get(edge.source)?.gateway || nodes.get(edge.target)?.gateway;
    const mergeKey = junctionBranch
      ? `${objectType}\u0000junction\u0000${junctionOrder.get(edgeId)}\u0000${edgeId}`
      : turnBack.has(edgeId)
      ? `${objectType}\u0000loop\u0000${edgeId}`
      : `${objectType}\u0000${find(edgeId)}`;
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      if (Math.abs(a.nominalX - b.nominalX) < 0.5 && a.at !== b.at) {
        vSegs.push({ kind: 'v', edgeId, mergeKey, nominalX: a.nominalX, from: a.at, to: b.at, x: a.nominalX });
      } else if (a.at === b.at) {
        hSegs.push({ kind: 'h', edgeId, mergeKey, at: a.at, x0: a.nominalX, x1: b.nominalX, y: 0 });
      }
    }
  }

  // -------------------------------------------------- columns (x, from rows)
  // Conflicts are decided on *row* spans, so this needs no pixel y at all —
  // which is what keeps the whole pipeline acyclic.
  const byColumn = new Map<number, VSeg[]>();
  for (const v of vSegs) {
    const key = Math.round(v.nominalX);
    (byColumn.get(key) ?? byColumn.set(key, []).get(key)!).push(v);
  }
  const sortedKeys = [...byColumn.keys()].sort((a, b) => a - b);

  // A node is drawn at its own nominal `laneX(lane)` unconditionally (see
  // `plugin.tsx`'s `nodeFor` call) — never at whatever a track-allocation
  // pass decides an edge's column should resolve to. Any column pass 2
  // below is allowed to *move* must therefore never contain a real node:
  // moving it would draw the node in one place and the edges leaving or
  // arriving at it in another, visibly detaching the line from its own
  // station. This is computed once, up front, over every rounded lane
  // position any node actually occupies.
  const nodeColumnKeys = new Set<number>();
  // Which *ranks* actually have a real node at this rounded column — pass 1
  // below uses this to tell "a segment that genuinely terminates at this
  // node" apart from "a segment that merely shares this column's rounded
  // pixel position for some unrelated reason" (a coincidence of X, not a
  // real connection to the node living here).
  const nodeRanksAtColumn = new Map<number, Set<number>>();
  for (const nd of nodesIn) {
    const key = Math.round(laneX(nd.lane));
    nodeColumnKeys.add(key);
    (nodeRanksAtColumn.get(key) ?? nodeRanksAtColumn.set(key, new Set()).get(key)!).add(nd.rank);
  }

  // Pass 1: each column's own track count and spread, computed exactly as
  // it always was — entirely independent of every other column. A lone
  // segment (`n === 1`) needs no internal separation and gets `halfSpread:
  // 0`, but it still has to take part in pass 2 below: a *different*
  // column's spread reaching into a lone column's exact position is just
  // as much a collision as two busy columns overlapping. Each column's own
  // row span (`yLo`/`yHi`, the union of every one of its segments' `from`/
  // `to`) is recorded too — pass 2 only ever needs to separate two columns
  // whose row spans actually overlap: a station at rank 1 and one at rank 4
  // never share a channel, so however close their nominal columns are,
  // nothing about them can visually conflict, and demanding separation
  // anyway is exactly what could turn "no valid position" into a false
  // alarm for a dummy that happens to sit near both in X.
  interface ColumnPlan {
    key: number;
    n: number;
    gap: number;
    halfSpread: number;
    slots: Map<string, number>;
    pinned: boolean;
    yLo: number;
    yHi: number;
    /** Set only when exactly one merge-key's segment genuinely terminates
     * at the real node pinning this column (a boundary marker's sole edge,
     * a station's own straight through-line, and so on): that group's own
     * slot index, so it can be anchored at offset 0 (the node's own centre)
     * instead of taking its turn in a spread that assumes every slot is
     * equally free to move. `undefined` for an ordinary busy interchange
     * where two or more distinct types genuinely converge on the same
     * node — there, no single slot is more entitled to the centre than any
     * other, and the existing symmetric spread is the right compromise. */
    anchorSlot?: number;
  }
  const yExtentOf = (segs: VSeg[]): { yLo: number; yHi: number } => {
    let yLo = Infinity;
    let yHi = -Infinity;
    for (const v of segs) {
      yLo = Math.min(yLo, v.from, v.to);
      yHi = Math.max(yHi, v.from, v.to);
    }
    return { yLo, yHi };
  };
  let maxTracks = 0;
  const plans: ColumnPlan[] = [];
  for (const key of sortedKeys) {
    const segs = byColumn.get(key)!;
    const slots = allocateSlots(segs.map((v) => ({ group: v.mergeKey, from: v.from, to: v.to })), 0.25, true);
    // `slots.size` is the number of *groups* fed in, not the number of
    // distinct tracks actually used — allocateSlots legitimately reuses one
    // track for two groups whose spans don't overlap (that's the point of
    // interval partitioning), so a column can hold, say, three groups on
    // just two real tracks. Every downstream use of `n` (the spread's own
    // width, and now the anchored reach) means "how many tracks", so it
    // has to come from the actual slot values assigned, not from how many
    // groups happened to ask for one. Slot indices are always the
    // contiguous range `0..trueTrackCount-1` (allocateSlots only ever
    // grows the index by one when reuse fails), so the max index plus one
    // is exactly that count.
    const n = slots.size ? Math.max(...slots.values()) + 1 : 0;
    maxTracks = Math.max(maxTracks, n);
    const pinned = nodeColumnKeys.has(key);
    const { yLo, yHi } = yExtentOf(segs);
    if (n <= 1) {
      plans.push({ key, n, gap: 0, halfSpread: 0, slots, pinned, yLo, yHi });
      continue;
    }
    // A pinned column's own node never moves (see `nodeColumnKeys` above) —
    // but a plain symmetric spread implicitly assumes every one of its n
    // slots is equally free to drift from centre, which isn't true the
    // moment one of those slots is the segment that actually terminates at
    // the node itself: that slot has nowhere else to be, so shoving it
    // aside just to keep the spread even visibly detaches the line from
    // its own station. This has to be decided *before* the gap/spread
    // bounds below, not after: forcing any slot other than the exact
    // middle to sit at offset 0 necessarily makes one side of the spread
    // reach further than a symmetric split would have (found out the hard
    // way — computing `gap` from the symmetric assumption first and only
    // widening the reported `halfSpread` afterward let an anchored
    // column's real, wider reach bleed straight past a neighbour pass 2
    // had only been told to expect the shorter, symmetric one).
    let anchorSlot: number | undefined;
    if (pinned) {
      const ranksHere = nodeRanksAtColumn.get(key);
      if (ranksHere) {
        // A turn-back edge's own excursion is already a deliberate detour —
        // it earns its separate track precisely *because* it isn't the
        // ongoing line (see the mergeKey comment above). That makes it the
        // group that should yield here too: only look for a single
        // *forward* group touching this node. A genuine multi-type
        // interchange (several distinct forward groups actually converging)
        // still finds more than one and correctly keeps the symmetric
        // spread below — but a plain through-line sharing this column with
        // nothing but its own rework loop (the common case: one object
        // type's straight flow, plus its own occasional redo) now anchors
        // on the line that's actually going somewhere, not split evenly
        // with a loop that already reads as a detour by its own shape.
        const touchingForward = new Set<string>();
        for (const v of segs) {
          if (!turnBack.has(v.edgeId) && (ranksHere.has(v.from) || ranksHere.has(v.to))) touchingForward.add(v.mergeKey);
        }
        if (touchingForward.size === 1) {
          anchorSlot = slots.get([...touchingForward][0]);
        } else if (n % 2 === 0) {
          // A genuine multi-type interchange with an *even* split has no
          // slot at offset 0 at all — the two middle slots straddle the
          // node at +-gap/2, so nothing ever lands exactly on it even
          // though the spread is, in aggregate, perfectly symmetric around
          // it. That reads as the station floating between its lines
          // rather than anchoring any of them. Neither middle slot has a
          // more legitimate claim to the centre than the other (this is
          // the genuine-interchange case, not the single-line one above),
          // so the tie is broken by merge-key alone — arbitrary, but
          // deterministic: the same graph always resolves the same way,
          // which matters far more here than *which* side wins.
          const bySlot = new Map<number, string>();
          for (const [mk, slot] of slots) bySlot.set(slot, mk);
          const left = bySlot.get(n / 2 - 1);
          const right = bySlot.get(n / 2);
          if (left != null && right != null) {
            // A turn-back edge's own excursion is a detour, same as above
            // — a real through-line has a stronger claim to the centre
            // than a rework loop does, even when the loop happens to win
            // the alphabetical tie-break. Only fall back to merge-key when
            // both tied slots are the same kind (both forward, or — rare —
            // both loops), where neither has a principled edge over the
            // other.
            const leftIsLoop = left.includes('\u0000loop\u0000');
            const rightIsLoop = right.includes('\u0000loop\u0000');
            anchorSlot = leftIsLoop !== rightIsLoop
              ? (leftIsLoop ? n / 2 : n / 2 - 1)
              : (left.localeCompare(right) <= 0 ? n / 2 - 1 : n / 2);
          }
        }
      }
    }
    // The true one-sided reach from centre, in gap units: half of `n - 1`
    // when nothing is anchored (the ordinary, symmetric case — a plain
    // relabelling of what this already was), or whichever side of a forced
    // anchor is longer otherwise.
    const maxGapUnits = anchorSlot != null ? Math.max(anchorSlot, n - 1 - anchorSlot) : (n - 1) / 2;
    // Two independent bounds on how far this column may reach from its own
    // centre in *either* direction:
    //   - a column running through node boxes should stay inside the
    //     narrowest of them, so every arrowhead lands on its node — but only
    //     when that still leaves room for a legible gap between tracks. A
    //     small "dot" station (as little as 26px across, see
    //     `StationNode.tsx`'s `stationDiameter`) with several different
    //     turn-back edges converging on it is a common, not a pathological,
    //     shape: `narrowest - 10` divided across even 4-5 tracks lands
    //     *below* this router's own `STROKE_W` — two different-type lines
    //     drawn that close together overlap visually regardless of what
    //     `findOverlaps`'s zero-width centreline check reports. Letting the
    //     spread exceed the node's own width in that case (arrowheads land
    //     just outside its edge, not exactly on it) is the smaller cost;
    //   - no column may ever reach as far as *half* the lane pitch in
    //     either direction (so two columns a full pitch apart can never
    //     together bleed into each other) — which is precisely how a
    //     turn-back corridor ended up sharing an x with a lane column. This
    //     bound is never relaxed: it is what keeps two different lanes'
    //     columns from bleeding into each other, not merely a legibility
    //     preference. It bounds the actual one-sided reach (`halfSpread`)
    //     directly, whether that reach ends up symmetric or anchored.
    let narrowest = Infinity;
    for (const nd of nodesIn) {
      if (Math.round(laneX(nd.lane)) === key) narrowest = Math.min(narrowest, nd.halfW * 2);
    }
    const nodeHalfWidthReach = isFinite(narrowest) ? (narrowest - 10) / 2 : Infinity;
    const neededForLegibleReach = maxGapUnits * spacing;
    const maxReach = Math.min(Math.max(nodeHalfWidthReach, neededForLegibleReach), (pitch - 8) / 2);
    // No lower floor on the gap: a floor (this used to read `Math.max(4,
    // …)`, on the reasoning that tracks packed closer than 4px read as one
    // line) can make the real reach exceed `maxReach` once a column is busy
    // enough that `maxReach / maxGapUnits` drops below the floor — at that
    // point the column's own drawn spread silently bleeds past the bound it
    // was computed to respect, into the very next lane's own column. The
    // bound above is what actually has to hold unconditionally for every
    // object type's line to stay in its own lane's band; a floor traded
    // that guarantee for a readability nicety that a caller should instead
    // get by giving a busy diagram a wider `pitch` in the first place (see
    // `peakTrackDemand`). The `1e-6` here is a purely numerical guard
    // against a zero-width `maxReach` collapsing every track onto the same
    // offset, not a visual-quality choice.
    const gap = Math.min(spacing, Math.max(1e-6, maxReach / maxGapUnits));
    const halfSpread = maxGapUnits * gap;
    plans.push({ key, n, gap, halfSpread, slots, pinned, yLo, yHi, anchorSlot });
  }

  // Pass 2: every column with a real node in it (`pinned`) is fixed at its
  // own nominal centre, always — the node itself is drawn at its own
  // `laneX(lane)` regardless of what this pass decides (see `nodeColumnKeys`
  // above), so moving *the edges'* column there would draw the line
  // detached from its own station instead of fixing anything. Each column's
  // own spread (pass 1) is already bounded against its *own* nominal centre,
  // but two *different* columns close enough together can still have those
  // independent spreads reach each other — this is exactly what let a
  // dummy-waypoint column and an unrelated column, sitting only a few px
  // apart, draw on top of one another, even though neither one's own
  // allocation was at fault.
  //
  // Three earlier versions of this fix each patched one gap and missed
  // another. First, merging every column within reach of another into one
  // shared allocation centred on their mean position — *correct* (no
  // overlap) but transitively merges a whole chain of otherwise
  // well-separated, unrelated columns the moment any two neighbours in the
  // chain are close, dragging real stations' own lines far from their true
  // position for no reason (the sweeping detours-around-the-whole-diagram
  // bug). Then, a purely left-to-right sweep pushing a dummy only as far
  // right as needed to clear whatever already settled to its *left* — fixed
  // that, but missed a pinned column sitting to a dummy's *right* (a fixed
  // position a backward-only sweep never sees coming). Then, a *symmetric*
  // two-directional sweep (left-to-right and right-to-left, combined) — but
  // still treating "nominally close in X" as the only thing that matters,
  // when what actually matters is "nominally close in X *and* occupying an
  // overlapping row span". Two stations several ranks apart never share a
  // channel, however close their columns happen to land in X, and demanding
  // separation between them anyway can trap a dummy between two obstacles
  // that were never really in conflict with *each other* — an unsolvable,
  // over-constrained position for a problem that a correctly-scoped version
  // wouldn't have posed in the first place.
  //
  // The fix is the same principle pass 1's own `allocateSlots` already
  // applies *within* one column — two segments only conflict when their row
  // spans actually overlap — extended across columns: a column only has to
  // clear another column that occupies an overlapping row span (`yOverlap`
  // below), not merely one that happens to be nominally nearby. For each
  // column this computes:
  //   - `minPossible`: the smallest centre it could have, given only the
  //     row-span-overlapping columns to its *left* (each contributing its
  //     own `minPossible`, so this is well-defined column by column in one
  //     left-to-right sweep);
  //   - `maxPossible`: the mirror, from row-span-overlapping columns to its
  //     *right*;
  //   - final centre: the column's own nominal key, clamped into
  //     `[minPossible, maxPossible]`. A pinned column's own key trivially
  //     satisfies both, since neither computation is ever allowed to move
  //     a pinned column.
  // If the two bounds still cross, the column is squeezed tighter than a
  // legible gap by obstacles that genuinely do share its row span on both
  // sides — a rarer, truly over-constrained case no repositioning here can
  // fully resolve. `maxPossible` is used in that case: clearing the
  // right-hand obstacle takes priority, since a dummy is otherwise free to
  // drift, while what precedes it has already committed to a position
  // everything since has been built on.
  //
  // The margin used throughout is `spacing`, not merely enough to clear
  // `findOverlaps`'s own numerical tolerance: every line is drawn
  // `STROKE_W` px wide, so two centrelines closer together than that
  // physically overlap on screen regardless of what a zero-width
  // centreline check reports. `spacing` is the same distance this router
  // already requires between two tracks sharing *one* column (pass 1, and
  // `LINE_SPACING` at the call site) — reusing it is what actually keeps
  // two different-type lines visibly apart, not just formally non-collinear.
  //
  // O(columns²): every plan is checked against every earlier (or later)
  // plan for row-span overlap. Column counts are node/edge-scaled, not
  // pixel-scaled, so this stays small for any diagram this view can
  // usefully display.
  const yOverlap = (a: ColumnPlan, b: ColumnPlan): boolean => a.yLo <= b.yHi && b.yLo <= a.yHi;
  const minPossible = new Map<number, number>();
  for (const plan of plans) {
    if (plan.pinned) {
      minPossible.set(plan.key, plan.key);
      continue;
    }
    let bound = -Infinity;
    for (const other of plans) {
      if (other.key >= plan.key || !yOverlap(plan, other)) continue;
      bound = Math.max(bound, minPossible.get(other.key)! + other.halfSpread + plan.halfSpread + spacing);
    }
    minPossible.set(plan.key, Math.max(plan.key, bound));
  }
  const maxPossible = new Map<number, number>();
  for (let idx = plans.length - 1; idx >= 0; idx--) {
    const plan = plans[idx];
    if (plan.pinned) {
      maxPossible.set(plan.key, plan.key);
      continue;
    }
    let bound = Infinity;
    for (const other of plans) {
      if (other.key <= plan.key || !yOverlap(plan, other)) continue;
      bound = Math.min(bound, maxPossible.get(other.key)! - other.halfSpread - plan.halfSpread - spacing);
    }
    maxPossible.set(plan.key, Math.min(plan.key, bound));
  }

  const centerOf = new Map<number, number>();
  // The smallest gap actually used between two adjacent tracks anywhere —
  // within one column (which can shrink below `spacing`, see pass 1 above)
  // or between two neighbouring columns after this pass (which can also
  // end up closer than `spacing`, if their own true nominal positions
  // already were, or in the genuinely over-constrained case above). This is
  // what bounds how far a render-time corner chamfer may reach without
  // risking a collinear overlap with whatever track — same column or the
  // next one over — sits closest to it: see `safeChamferCut` at the end of
  // this function.
  let minTrackGap = spacing;
  let prevCenter = -Infinity;
  let prevHalf = 0;
  for (const plan of plans) {
    const lo = minPossible.get(plan.key)!;
    const hi = maxPossible.get(plan.key)!;
    // `lo > hi` means two obstacles this column must clear — one on each
    // side — together demand more room than actually exists between them:
    // a genuine three-body conflict (typically two independently busy
    // pinned nodes, not necessarily at adjacent ranks, bridged by one long
    // unbent waypoint run that happens to occupy both their row spans at
    // once). No position for this column satisfies both sides at once, so
    // there is no "correct" answer — only a smaller or larger shortfall.
    // The midpoint of `[hi, lo]` is what minimises the *worse* of the two
    // shortfalls (clamping to either bound alone zeroes one side's
    // shortfall at the cost of maximising the other's); it is a rare,
    // last-resort case pass 1's own node-width relaxation and the sweep
    // above cannot fully absorb, since neither pinned obstacle may move.
    const center = plan.pinned ? plan.key : lo <= hi ? Math.min(Math.max(plan.key, lo), hi) : (lo + hi) / 2;
    if (prevCenter !== -Infinity) {
      minTrackGap = Math.min(minTrackGap, center - plan.halfSpread - (prevCenter + prevHalf));
    }
    centerOf.set(plan.key, center);
    prevCenter = center;
    prevHalf = plan.halfSpread;
  }
  if (plans.some((p) => p.n > 1)) {
    minTrackGap = Math.min(minTrackGap, ...plans.filter((p) => p.n > 1).map((p) => p.gap));
  }
  for (const plan of plans) {
    const center = centerOf.get(plan.key)!;
    for (const v of byColumn.get(plan.key)!) {
      const slot = plan.slots.get(v.mergeKey)!;
      // A constant shift of `slotOffset`'s own symmetric result — see the
      // `anchorSlot` comment in pass 1 — so the anchor group lands at
      // exactly the node's own centre and every other slot keeps the same
      // `gap`-spaced distance from it (and each other) it always had.
      const offset = plan.anchorSlot != null
        ? (slot - plan.anchorSlot) * plan.gap
        : slotOffset(slot, plan.n, plan.gap);
      v.x = center + offset;
    }
  }

  // Horizontal spans are only real once the columns are fixed.
  const vAt = new Map<string, VSeg[]>();
  for (const v of vSegs) (vAt.get(v.edgeId) ?? vAt.set(v.edgeId, []).get(v.edgeId)!).push(v);
  const resolvedX = (edgeId: string, at: number, nominalX: number): number => {
    for (const v of vAt.get(edgeId) ?? []) {
      if (Math.abs(v.nominalX - nominalX) < 0.5 && at >= lo(v.from, v.to) - 1e-6 && at <= hi(v.from, v.to) + 1e-6) {
        return v.x;
      }
    }
    return nominalX;
  };
  for (const h of hSegs) {
    h.x0 = resolvedX(h.edgeId, h.at, h.x0);
    h.x1 = resolvedX(h.edgeId, h.at, h.x1);
  }

  // ------------------------------------------------- channels (y, from x)
  const byChannel = new Map<number, HSeg[]>();
  for (const h of hSegs) (byChannel.get(h.at) ?? byChannel.set(h.at, []).get(h.at)!).push(h);
  const channelSlots = new Map<number, { slots: Map<string, number>; n: number }>();
  for (const [at, segs] of byChannel) {
    // Pad by a stroke's width so two horizontals that merely share an
    // endpoint are still given separate tracks rather than reading as one.
    const slots = allocateSlots(segs.map((h) => ({ group: h.mergeKey, from: h.x0, to: h.x1 })), 3);
    channelSlots.set(at, { slots, n: slots.size });
    maxTracks = Math.max(maxTracks, slots.size);
  }

  // Each channel is exactly as tall as its own track count needs.
  const channelHeight = (r: number): number => {
    const info = channelSlots.get(r + 0.5);
    const tracks = info ? info.n : 0;
    return Math.max(minChannel, tracks * spacing + spacing * 2);
  };

  const rowY = new Map<number, number>();
  let cursor = 0;
  for (let i = 0; i < ranks.length; i++) {
    const r = ranks[i];
    const half = rowHalfH.get(r) ?? 0;
    cursor += half;
    rowY.set(r, cursor);
    cursor += half;
    if (i < ranks.length - 1) cursor += channelHeight(r);
  }
  // Turn-back edges bend in the channels just outside the diagram too.
  const firstRank = ranks.length ? ranks[0] : 0;
  const topPad = channelHeight(firstRank - 1);
  const bottomPad = channelHeight(maxRank);

  const channelY = (at: number): number => {
    const r = Math.floor(at);
    const info = channelSlots.get(at);
    const n = info ? info.n : 1;
    const above = rowY.has(r) ? rowY.get(r)! + (rowHalfH.get(r) ?? 0) : (rowY.get(firstRank) ?? 0) - (rowHalfH.get(firstRank) ?? 0) - topPad;
    const below = rowY.has(r + 1) ? rowY.get(r + 1)! - (rowHalfH.get(r + 1) ?? 0) : above + bottomPad;
    const band = below - above;
    const mid = above + band / 2;
    return mid;
  };
  for (const [at, segs] of byChannel) {
    const info = channelSlots.get(at)!;
    const mid = channelY(at);
    for (const h of segs) h.y = mid + slotOffset(info.slots.get(h.mergeKey)!, info.n, spacing);
  }

  // ---------------------------------------------------------------- emit
  const hAt = new Map<string, HSeg[]>();
  for (const h of hSegs) (hAt.get(h.edgeId) ?? hAt.set(h.edgeId, []).get(h.edgeId)!).push(h);

  // A gateway with several incoming tracks belongs at the centre of their
  // visible span, not arbitrarily on whichever track slot happened to be
  // anchored to the nominal lane centre. Keep this as a node position (and
  // use it for departure geometry below); the arrival tracks themselves
  // remain untouched and therefore retain their clean vertical arrowheads.
  const nodeX = new Map(nodesIn.map((n) => [n.id, laneX(n.lane)]));
  const centredJoins = new Set<string>();
  const outgoingCount = new Map<string, number>();
  for (const edge of edgesIn) outgoingCount.set(edge.source, (outgoingCount.get(edge.source) ?? 0) + 1);
  for (const gateway of nodesIn.filter((n) => n.gateway)) {
    const arrivals: number[] = [];
    for (const edge of edgesIn) {
      if (edge.target !== gateway.id) continue;
      const chain = stopsOf.get(edge.id);
      if (!chain?.length) continue;
      const stop = chain[chain.length - 1];
      arrivals.push(resolvedX(edge.id, stop.at, stop.nominalX));
    }
    if (arrivals.length >= 2) {
      nodeX.set(gateway.id, (Math.min(...arrivals) + Math.max(...arrivals)) / 2);
      centredJoins.add(gateway.id);
    }
  }

  const points = new Map<string, Point[]>();
  for (const e of edgesIn) {
    const chain = stopsOf.get(e.id);
    if (!chain) continue;
    const s = nodes.get(e.source)!;
    const t = nodes.get(e.target)!;

    const yOf = (at: number, index: number): number => {
      if (index === 0) return rowY.get(s.rank)! + s.halfH; // leave the bottom border
      if (index === chain.length - 1) return rowY.get(t.rank)! - t.halfH; // arrive at the top border
      if (Number.isInteger(at)) return rowY.get(at) ?? 0;
      const own = (hAt.get(e.id) ?? []).find((h) => h.at === at);
      return own ? own.y : channelY(at);
    };

    const pts: Point[] = [];
    chain.forEach((stop, i) => {
      const x = resolvedX(e.id, stop.at, stop.nominalX);
      const y = yOf(stop.at, i);
      const prev = pts[pts.length - 1];
      if (!prev || Math.abs(prev.x - x) > 0.01 || Math.abs(prev.y - y) > 0.01) pts.push({ x, y });
    });
    // A split leaves from the marker itself, then fans out inside the
    // endpoint channel. On a join, however, keep every allocated incoming
    // track vertical all the way to the gateway's top bounding edge. The
    // renderer trims the arrow tip a few pixels back from that edge, so the
    // parallel arrowheads stop cleanly above the diamond instead of being
    // funnelled together into a slanted cluster at its top point.
    if (pts.length >= 2 && s.gateway) {
      const p = pts[0];
      const x = nodeX.get(s.id)!, dx = p.x - x;
      if (centredJoins.has(s.id) && outgoingCount.get(s.id) === 1) {
        // This is the continuation of a join, not one branch of a split.
        // Move its whole initial vertical run to the join's final centre.
        // Reusing the old allocated x after only a tiny endpoint fan makes
        // the line first bend back toward an incoming track and then reverse
        // toward its target — the conspicuous S-shaped hook seen below a
        // centred diamond.
        const oldX = p.x;
        for (const point of pts) {
          if (Math.abs(point.x - oldX) > 0.01) break;
          point.x = x;
        }
      } else {
        const reach = Math.min(Math.abs(dx), Math.abs(pts[1].y - p.y) / 3);
        pts[0] = { x, y: p.y };
        if (Math.abs(dx) > 0.01) {
          const fan = [{ x: x + Math.sign(dx) * reach, y: p.y + reach }];
          if (Math.abs(dx) > reach + 0.01) fan.push({ x: p.x, y: p.y + reach });
          pts.splice(1, 0, ...fan);
        }
      }
    }
    if (pts.length >= 2) points.set(e.id, pts);
  }

  let extLo = nodeLo;
  let extHi = nodeHi;
  for (const pts of points.values()) {
    for (const p of pts) {
      extLo = Math.min(extLo, p.x);
      extHi = Math.max(extHi, p.x);
    }
  }
  // The largest corner chamfer that is provably safe against `minTrackGap`:
  // a render-time chamfer cuts back along both of a corner's arms by up to
  // this much and replaces the corner with a diagonal — a *fixed* cut
  // (this router's original `CHAMFER_CUT = 28`) that ignores how close the
  // neighbouring track actually is will, for two adjacent tracks whose
  // corners happen to sit at roughly 45° to each other (routine once column
  // and channel gaps are similar sizes, which they usually are), reach far
  // enough to become collinear with the neighbour's own chamfer — the exact
  // failure `router.check.ts`'s chamfered-geometry check exists to catch.
  // Halving the smallest gap seen anywhere keeps each side's cut inside its
  // own track's half of that gap; `CHAMFER_SAFETY_MARGIN` is headroom past
  // `findOverlaps`'s own tolerance, not a cosmetic choice. The caller still
  // clamps this against the aesthetic default (`Math.min(CHAMFER_CUT,
  // safeChamferCut)`), so a sparse diagram with room to spare keeps the
  // full, more visually generous bend.
  const CHAMFER_SAFETY_MARGIN = 2;
  const safeChamferCut = Math.max(0, minTrackGap / 2 - CHAMFER_SAFETY_MARGIN);
  return { points, nodeX, rowY, extent: { lo: extLo, hi: extHi }, maxTracks, safeChamferCut };
}

/**
 * How many tracks would the busiest lane column or row channel need for
 * this graph, before anything is actually drawn? Runs the exact same
 * routing pipeline `routeAll` does — same stop/segment construction, same
 * `allocateSlots` grouping — at a placeholder lane pitch, so the result
 * reflects the real topology (which segments share a rank span or an x
 * span) rather than an approximation of it. The placeholder only has to be
 * large enough that `Math.round(nominalX)` never conflates two distinct
 * lanes; its absolute scale otherwise plays no further role; a track
 * *count* is a property of which segments share a group and a span, not of
 * how many pixels apart their nominal lane centres happen to be.
 *
 * Call this before choosing a real `pitch` for `routeAll`, so a diagram
 * whose busiest column needs many tracks gets a `pitch` sized for that,
 * instead of a fixed value that forces those tracks to pack tighter and
 * tighter — which is exactly what let a column's drawn spread exceed its
 * own bound before this function existed (see `routeAll`'s column-spread
 * comment).
 */
export function peakTrackDemand(nodesIn: RNode[], edgesIn: REdge[]): number {
  // Large enough that no two distinct lane indices in any real diagram
  // round to the same integer key, tiny enough that ordinary floating-point
  // arithmetic on it stays exact — several orders of magnitude past either
  // concern for the lane counts this router ever sees.
  const PLACEHOLDER_PITCH = 1_000_000;
  const { maxTracks } = routeAll(nodesIn, edgesIn, {
    laneX: (lane) => lane * PLACEHOLDER_PITCH,
    spacing: 1,
    minChannel: 1,
    pitch: PLACEHOLDER_PITCH,
  });
  return maxTracks;
}

// ---------------------------------------------------------------- verifier

export interface Overlap {
  a: string;
  b: string;
  /** 'h' / 'v' for a horizontal/vertical collinear pair, 'd' for any other
   * shared slope — a chamfered 45° corner segment, most commonly. */
  axis: 'h' | 'v' | 'd';
  at: number;
  span: [number, number];
}

/**
 * A segment's infinite line in normal form `nx*x + ny*y = c`, `(nx, ny)` a
 * unit vector, canonicalized (`nx > 0`, or `nx === 0 && ny > 0`) so walking
 * the same physical line in either direction yields the identical triple.
 * `null` for a zero-length segment (nothing to compare).
 */
function segLine(p: Point, q: Point): { nx: number; ny: number; c: number } | null {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  let nx = -dy / len;
  let ny = dx / len;
  if (nx < -1e-9 || (Math.abs(nx) <= 1e-9 && ny < 0)) {
    nx = -nx;
    ny = -ny;
  }
  return { nx, ny, c: nx * p.x + ny * p.y };
}

/**
 * The check I should have been running from the start instead of reading
 * screenshots: do any two segments belonging to different edges lie on the
 * same line and overlap? Not restricted to axis-aligned segments — a
 * chamfered corner (see `route.ts`'s `chamferCorners`, applied at render
 * time to what this router hands back) turns a right-angle bend into two
 * 45° segments, and those need the identical guarantee: a caller that only
 * ever checked horizontal/vertical segments would silently miss an overlap
 * that only exists in the *drawn*, chamfered geometry. Every segment's
 * infinite line is reduced to a canonical `(nx, ny, c)` normal form
 * (`segLine`) so "same line" and "1D interval overlap along it" are decided
 * identically regardless of slope, subsuming the old axis-only version
 * exactly for a purely horizontal or vertical segment.
 *
 * Same-object-type overlap is allowed *only* when the two edges actually
 * share a station — that is the intended "one metro line runs through this
 * stop" merge. Two arcs of one object type that touch nothing in common
 * (two separate rework loops, say) must not be drawn on top of each other;
 * letting them was a real bug, and this exclusion is what catches it.
 */
/**
 * Per-polyline segment decomposition, keyed on the points array itself —
 * see `findOverlaps`. Weak so a superseded drawing's polylines are not held
 * alive by the cache.
 */
const SEG_CACHE = new WeakMap<Point[], Array<{ axis: 'h' | 'v' | 'd'; nx: number; ny: number; c: number; a: number; b: number }>>();

export function findOverlaps(
  points: Map<string, Point[]>,
  /** True when these two edges are genuinely the same metro line and are
   * *meant* to draw on top of each other. Supplied by the caller and derived
   * from the input graph, not from the router's own bookkeeping, so the
   * check stays an independent assertion rather than a mirror of the code. */
  mayMerge: (a: string, b: string) => boolean,
  tolerance = 1.5,
  /** When given, only pairs with at least one edge in this set are reported.
   * A caller that already discards every overlap not touching the handful of
   * edges it just moved (see `geometry.ts`'s `valid`) gets the identical
   * answer without paying for the pairs it would throw away. */
  restrictTo?: ReadonlySet<string>,
): Overlap[] {
  interface Seg { id: string; axis: 'h' | 'v' | 'd'; nx: number; ny: number; c: number; a: number; b: number; k: number }
  const segs: Seg[] = [];
  for (const [id, pts] of points) {
    // A polyline's decomposition depends on nothing but the polyline. The
    // refinement calls this thousands of times while changing a handful of
    // edges per call, so an unchanged polyline — the same array object,
    // which is what the scratch drawing in `geometry.ts` hands back — is
    // decomposed once and reused. `k` is per-call (it is a position in this
    // call's enumeration order), so only that is filled in here.
    let cached = SEG_CACHE.get(pts);
    if (!cached) {
      cached = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i];
        const q = pts[i + 1];
        const line = segLine(p, q);
        if (!line) continue;
        const { nx, ny, c } = line;
        // Tangent derived from the *canonicalized* normal (rotate it -90°),
        // not from this segment's own possibly-flipped travel direction — two
        // segments on the same line must project onto one shared coordinate
        // frame, or a segment walked "backwards" relative to another one on
        // the same line would compute a mirrored interval and a real overlap
        // could read as none.
        const tx = ny;
        const ty = -nx;
        const ta = p.x * tx + p.y * ty;
        const tb = q.x * tx + q.y * ty;
        const axis: Seg['axis'] = Math.abs(ny) < 1e-6 ? 'v' : Math.abs(nx) < 1e-6 ? 'h' : 'd';
        cached.push({ axis, nx, ny, c, a: Math.min(ta, tb), b: Math.max(ta, tb) });
      }
      SEG_CACHE.set(pts, cached);
    }
    for (const g of cached) segs.push({ id, axis: g.axis, nx: g.nx, ny: g.ny, c: g.c, a: g.a, b: g.b, k: segs.length });
  }
  // Two segments can only share a line when their offsets `c` are within
  // `tolerance` of each other, whatever their normals — so bucket by offset
  // and let each segment look at its own bucket and the two beside it,
  // rather than ordering the whole drawing to walk a window through it. The
  // bucketing is a superset filter, exactly as the window was: `pair` makes
  // the real decision, and it now states the offset test itself instead of
  // inheriting it from the enumeration order. Sorting every segment of
  // every polyline on every call was two thirds of this function's cost on
  // a dense map, for an ordering only ever read one window at a time.
  //
  // `mayMerge` is asked last: it is the one predicate that can cost a map
  // lookup per call, and every cheap geometric test above it rejects the
  // overwhelming majority of candidates. It is a pure predicate, so
  // deferring it cannot change the outcome.
  const buckets = new Map<number, Seg[]>();
  for (const s of segs) {
    const b = Math.floor(s.c / tolerance);
    const list = buckets.get(b);
    if (list) list.push(s); else buckets.set(b, [s]);
  }
  // `k` order is the order a plain nested loop would have produced, so the
  // hits are restored to it at the end and the returned list is unchanged.
  const found: Array<{ i: number; j: number; hit: Overlap }> = [];
  const seen = restrictTo ? new Set<number>() : null;
  const pair = (s: Seg, o: Seg) => {
    if (s.id === o.id) return;
    if (Math.abs(s.c - o.c) > tolerance) return;
    // Same infinite line: canonicalized normals agree, and so do the
    // lines' offsets from the origin.
    if (Math.abs(s.nx - o.nx) > 1e-3 || Math.abs(s.ny - o.ny) > 1e-3) return;
    if (mayMerge(s.id, o.id)) return;
    const sl = s.k < o.k ? s : o;
    const oh = s.k < o.k ? o : s;
    if (seen) { const key = sl.k * segs.length + oh.k; if (seen.has(key)) return; seen.add(key); }
    const from = Math.max(sl.a, oh.a);
    const to = Math.min(sl.b, oh.b);
    if (to - from > tolerance) found.push({ i: sl.k, j: oh.k, hit: { a: sl.id, b: oh.id, axis: sl.axis, at: sl.c, span: [from, to] } });
  };
  for (const s of segs) {
    // Every reportable pair has a restricted segment on at least one side,
    // so start only from those — and then take the whole neighbourhood,
    // since a partner may sit on either side in offset order. Without a
    // restriction each unordered pair is visited from its lower `k` only.
    if (restrictTo && !restrictTo.has(s.id)) continue;
    const b = Math.floor(s.c / tolerance);
    for (let d = -1; d <= 1; d++) {
      const list = buckets.get(b + d);
      if (!list) continue;
      for (const o of list) {
        if (restrictTo ? o.k === s.k : o.k <= s.k) continue;
        pair(s, o);
      }
    }
  }
  found.sort((x, y) => x.i - y.i || x.j - y.j);
  return found.map(f => f.hit);
}

/**
 * Edge crossings in the drawing — the standard quality measure for a layered
 * layout, and the objective the ordering pass in `relayout.ts` is trying to
 * minimise. Counted here so improvements to that pass are *measured* rather
 * than eyeballed.
 */
export function countCrossings(points: Map<string, Point[]>): number {
  interface S { id: string; x1: number; y1: number; x2: number; y2: number }
  const segs: S[] = [];
  for (const [id, pts] of points) {
    for (let i = 0; i < pts.length - 1; i++) {
      segs.push({ id, x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y });
    }
  }
  const ccw = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
    (cy - ay) * (bx - ax) - (by - ay) * (cx - ax);
  let n = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i];
      const o = segs[j];
      if (s.id === o.id) continue;
      const d1 = ccw(s.x1, s.y1, s.x2, s.y2, o.x1, o.y1);
      const d2 = ccw(s.x1, s.y1, s.x2, s.y2, o.x2, o.y2);
      const d3 = ccw(o.x1, o.y1, o.x2, o.y2, s.x1, s.y1);
      const d4 = ccw(o.x1, o.y1, o.x2, o.y2, s.x2, s.y2);
      if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) n++;
    }
  }
  return n;
}
