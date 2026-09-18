/**
 * Layouts for a social network.
 *
 * Written here rather than taken from a layout engine because the graphs are
 * small — tens of people, not thousands of activities — and because the two
 * that matter both need the *weights*, which a generic engine either ignores
 * or takes as a hint. A handover network laid out without them puts the pair
 * who transfer once as far apart as the pair who transfer a thousand times,
 * which is the one thing the picture exists to show.
 *
 * Every layout here is deterministic: same input, same coordinates. A graph
 * that reshuffles itself whenever a slider moves is unreadable, and a
 * non-deterministic layout cannot be checked by an invariant.
 */

export interface LayoutNode { x: number; y: number }
export interface LayoutInput {
  count: number;
  /** Undirected for layout purposes: who is near whom has no direction. */
  edges: Array<{ from: number; to: number; weight: number }>;
  /** Per-node relative size in [0,1]; keeps big nodes from overlapping. */
  size: number[];
  width: number;
  height: number;
}

export type LayoutKind = 'stress' | 'force' | 'circle';

/** xorshift64*, so a layout is reproducible without a seeded-RNG dependency. */
function rng(seed: number) {
  let s = BigInt(seed || 1);
  const MASK = (1n << 64n) - 1n;
  return () => {
    s = (s ^ (s << 13n)) & MASK;
    s = s ^ (s >> 7n);
    s = (s ^ (s << 17n)) & MASK;
    return Number(s & 0xffffffn) / 0xffffff;
  };
}

/** Nodes evenly around a circle, in the order given. */
export function circleLayout(input: LayoutInput): LayoutNode[] {
  const { count, width, height } = input;
  const r = Math.max(40, Math.min(width, height) / 2 - 60);
  const cx = width / 2, cy = height / 2;
  if (count === 1) return [{ x: cx, y: cy }];
  return Array.from({ length: count }, (_, i) => {
    const a = (2 * Math.PI * i) / count - Math.PI / 2;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}

/**
 * Graph-theoretic distance between every pair, over the *inverse* of weight:
 * a strong relation is a short edge. Unreachable pairs get a distance one
 * step beyond the graph's diameter rather than infinity, which is what keeps
 * a disconnected network on one canvas instead of flinging components apart.
 */
function allPairsDistances(count: number, edges: LayoutInput['edges']): number[][] {
  const maxWeight = Math.max(1e-9, ...edges.map((e) => e.weight));
  const adj: Array<Array<[number, number]>> = Array.from({ length: count }, () => []);
  for (const e of edges) {
    if (e.from === e.to) continue;
    // Normalised so the strongest edge is length 1 and a weak one is longer.
    const len = maxWeight / Math.max(e.weight, maxWeight / 12);
    adj[e.from].push([e.to, len]);
    adj[e.to].push([e.from, len]);
  }

  const dist: number[][] = [];
  let finiteMax = 1;
  for (let s = 0; s < count; s++) {
    // Dijkstra with a linear scan: count is in the tens, so a heap would cost
    // more in code than it saves in time.
    const d = new Array(count).fill(Infinity);
    const done = new Array(count).fill(false);
    d[s] = 0;
    for (;;) {
      let u = -1, best = Infinity;
      for (let i = 0; i < count; i++) if (!done[i] && d[i] < best) { best = d[i]; u = i; }
      if (u < 0) break;
      done[u] = true;
      for (const [v, len] of adj[u]) if (d[u] + len < d[v]) d[v] = d[u] + len;
    }
    for (const x of d) if (Number.isFinite(x)) finiteMax = Math.max(finiteMax, x);
    dist.push(d);
  }
  const disconnected = finiteMax * 1.5;
  for (const row of dist) {
    for (let i = 0; i < row.length; i++) if (!Number.isFinite(row[i])) row[i] = disconnected;
  }
  return dist;
}

/**
 * Stress majorization (Gansner, Koren & North 2004): move every node towards
 * the position that best satisfies its ideal distance to every other node,
 * weighted by 1/d². Slower than a force simulation per iteration but it
 * converges monotonically and does not need a cooling schedule to stop
 * jittering, which is what makes the result stable enough to compare two
 * networks side by side.
 */
export function stressLayout(input: LayoutInput, iterations = 200): LayoutNode[] {
  const { count, width, height } = input;
  if (count <= 2) return circleLayout(input);

  const dist = allPairsDistances(count, input.edges);
  const span = Math.min(width, height) - 120;
  let maxDist = 1;
  for (const row of dist) for (const d of row) maxDist = Math.max(maxDist, d);
  const scale = span / (2 * maxDist);

  // Seeded from a circle rather than at random: stress majorization finds a
  // local optimum, and starting from a shape that already has every node
  // separated avoids the folded-over results a random start can settle into.
  const pos = circleLayout(input).map((p) => ({ x: p.x, y: p.y }));

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < count; i++) {
      let nx = 0, ny = 0, wsum = 0;
      for (let j = 0; j < count; j++) {
        if (i === j) continue;
        const target = dist[i][j] * scale;
        const dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
        const actual = Math.hypot(dx, dy) || 1e-6;
        const w = 1 / (target * target || 1e-6);
        nx += w * (pos[j].x + (target * dx) / actual);
        ny += w * (pos[j].y + (target * dy) / actual);
        wsum += w;
      }
      if (wsum > 0) { pos[i].x = nx / wsum; pos[i].y = ny / wsum; }
    }
  }
  return place(pos, input);
}

/**
 * Fruchterman-Reingold: every node repels every other, every edge pulls its
 * two ends together in proportion to its weight. Cruder than stress
 * majorization and it needs the cooling schedule to settle, but it clusters
 * more aggressively, which reads better on a network whose weights span
 * orders of magnitude.
 */
export function forceLayout(input: LayoutInput, iterations = 400): LayoutNode[] {
  const { count, width, height } = input;
  if (count <= 2) return circleLayout(input);

  const area = (width - 100) * (height - 100);
  const k = Math.sqrt(area / count);
  const random = rng(count * 7919 + input.edges.length);
  const pos = circleLayout(input).map((p) => ({
    // A circle start plus a small deterministic jitter: two nodes at exactly
    // the same point have no direction to repel in.
    x: p.x + (random() - 0.5) * 4,
    y: p.y + (random() - 0.5) * 4,
  }));

  const maxWeight = Math.max(1e-9, ...input.edges.map((e) => e.weight));
  let temperature = Math.min(width, height) / 8;
  const cooling = temperature / (iterations + 1);

  for (let iter = 0; iter < iterations; iter++) {
    const dx = new Array(count).fill(0);
    const dy = new Array(count).fill(0);

    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let ux = pos[i].x - pos[j].x, uy = pos[i].y - pos[j].y;
        let d = Math.hypot(ux, uy);
        if (d < 1e-6) { ux = 1e-3; uy = 0; d = 1e-3; }
        const rep = (k * k) / d;
        dx[i] += (ux / d) * rep; dy[i] += (uy / d) * rep;
        dx[j] -= (ux / d) * rep; dy[j] -= (uy / d) * rep;
      }
    }
    for (const e of input.edges) {
      if (e.from === e.to) continue;
      let ux = pos[e.from].x - pos[e.to].x, uy = pos[e.from].y - pos[e.to].y;
      let d = Math.hypot(ux, uy);
      if (d < 1e-6) { ux = 1e-3; uy = 0; d = 1e-3; }
      // A strong relation pulls harder — the whole reason not to use a
      // weight-blind layout.
      const att = ((d * d) / k) * (0.25 + (0.75 * e.weight) / maxWeight);
      dx[e.from] -= (ux / d) * att; dy[e.from] -= (uy / d) * att;
      dx[e.to] += (ux / d) * att; dy[e.to] += (uy / d) * att;
    }

    for (let i = 0; i < count; i++) {
      const d = Math.hypot(dx[i], dy[i]) || 1e-6;
      const step = Math.min(d, temperature);
      pos[i].x += (dx[i] / d) * step;
      pos[i].y += (dy[i] / d) * step;
    }
    temperature -= cooling;
  }
  return place(pos, input);
}

/**
 * Pushes apart any two nodes whose drawn circles would overlap.
 *
 * A layout optimises positions, not discs: two nodes at an ideal distance of
 * four pixels are correct by the objective and unreadable on screen. This is
 * a post-pass rather than a term in the objective so that it cannot trade
 * away the structure the layout just found — it only ever moves nodes the
 * minimum needed to stop them touching.
 */
function separate(pos: LayoutNode[], input: LayoutInput, rounds = 60): LayoutNode[] {
  const radius = input.size.map((s) => nodeRadius(s) + 3);
  for (let round = 0; round < rounds; round++) {
    let moved = false;
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const need = radius[i] + radius[j];
        let ux = pos[i].x - pos[j].x, uy = pos[i].y - pos[j].y;
        let d = Math.hypot(ux, uy);
        if (d >= need) continue;
        if (d < 1e-6) { ux = (i % 2 ? 1 : -1) * 1e-3; uy = 1e-3; d = Math.hypot(ux, uy); }
        const push = (need - d) / 2;
        pos[i].x += (ux / d) * push; pos[i].y += (uy / d) * push;
        pos[j].x -= (ux / d) * push; pos[j].y -= (uy / d) * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return pos;
}

/**
 * Scale into the viewport, then stop the circles touching, then keep them on
 * screen — in that order, and repeatedly.
 *
 * The order is the whole point and was wrong first time round: separating
 * before fitting means the fit's own rescale shrinks the gaps it was given,
 * so a layout that spread out more than the canvas came back with nodes
 * overlapping by up to thirty pixels. The invariant caught it on the force
 * layout, which spreads most; stress happened to pass, which is exactly the
 * kind of luck a randomised check exists to remove.
 *
 * Clamping can itself push two nodes back together at a wall, so the two
 * passes alternate until they agree. They converge for any input with room
 * for its own circles; an input without that room has no correct answer, and
 * this leaves it as separated as it can get rather than looping.
 */
function place(pos: LayoutNode[], input: LayoutInput): LayoutNode[] {
  let out = fit(pos, input);
  for (let round = 0; round < 8; round++) {
    out = separate(out, input, 40);
    out = clamp(out, input);
  }
  return out;
}

/** Keeps every node's drawn circle inside the canvas. */
function clamp(pos: LayoutNode[], input: LayoutInput): LayoutNode[] {
  return pos.map((p, i) => {
    const r = nodeRadius(input.size[i]) + 2;
    return {
      x: Math.min(Math.max(p.x, r), Math.max(r, input.width - r)),
      y: Math.min(Math.max(p.y, r), Math.max(r, input.height - r)),
    };
  });
}

/** Scales and centres the result into the viewport, leaving room for labels. */
function fit(pos: LayoutNode[], input: LayoutInput): LayoutNode[] {
  const pad = 46;
  const xs = pos.map((p) => p.x), ys = pos.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = Math.max(maxX - minX, 1e-6), h = Math.max(maxY - minY, 1e-6);
  const s = Math.min((input.width - 2 * pad) / w, (input.height - 2 * pad) / h, 3);
  const ox = (input.width - w * s) / 2 - minX * s;
  const oy = (input.height - h * s) / 2 - minY * s;
  return pos.map((p) => ({ x: p.x * s + ox, y: p.y * s + oy }));
}

/** One node's drawn radius from its relative size. Shared with the renderer. */
export function nodeRadius(size: number): number {
  return 5 + 13 * Math.sqrt(Math.max(0, Math.min(1, size)));
}

export function layoutGraph(kind: LayoutKind, input: LayoutInput): LayoutNode[] {
  if (input.count === 0) return [];
  switch (kind) {
    case 'circle': return circleLayout(input);
    case 'force': return forceLayout(input);
    default: return stressLayout(input);
  }
}
