/**
 * Dendrogram invariants, over randomised merge sequences.
 *
 * A dendrogram that places a leaf twice, or lets one subtree's edges cross
 * another's, still *looks* like a dendrogram — which is exactly why it needs
 * asserted properties rather than a glance. The contiguity property below is
 * the one that makes the drawing readable, and it is invisible until someone
 * traces an edge by hand.
 */

import { layoutDendrogram, cutHeight, type Merge } from './dendrogram';

/**
 * Node's `process`, declared rather than depended on: these checks run under
 * `node` via esbuild but the package types itself with `types: []` so the
 * browser sources cannot reach for a Node global.
 */
declare const process: { exit(code: number): never };

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function rng(seed: number) {
  let s = seed || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}

/** A well-formed agglomeration: n-1 merges, non-decreasing, each id used once. */
function randomMerges(seed: number, n: number): Merge[] {
  const r = rng(seed);
  const live: number[] = Array.from({ length: n }, (_, i) => i);
  const merges: Merge[] = [];
  let next = n;
  let distance = 0;
  const size = new Map<number, number>(live.map((i) => [i, 1]));
  while (live.length > 1) {
    const i = Math.floor(r() * live.length);
    const a = live.splice(i, 1)[0];
    const j = Math.floor(r() * live.length);
    const b = live.splice(j, 1)[0];
    distance += r() * 0.2;
    const merged = (size.get(a) ?? 1) + (size.get(b) ?? 1);
    size.set(next, merged);
    merges.push({ a, b, distance, size: merged });
    live.push(next);
    next++;
  }
  return merges;
}

/** Every leaf under a cluster id, by walking the merge tree. */
function leavesUnder(id: number, leafCount: number, merges: Merge[]): number[] {
  if (id < leafCount) return [id];
  const m = merges[id - leafCount];
  return [...leavesUnder(m.a, leafCount, merges), ...leavesUnder(m.b, leafCount, merges)];
}

console.log('dendrogram invariants');
for (let seed = 1; seed <= 120; seed++) {
  const n = 2 + Math.floor(rng(seed)() * 20);
  const merges = randomMerges(seed, n);
  const d = layoutDendrogram(n, merges);
  const where = `seed ${seed}, n=${n}`;

  check('every leaf is placed exactly once',
    d.order.length === n && new Set(d.order).size === n, `${where}, got ${d.order.length}`);
  check('every leaf and every merge has a node',
    d.nodes.size === n + merges.length, `${where}, got ${d.nodes.size}`);
  check('a complete merge list has one root', d.root !== null, where);

  for (const node of d.nodes.values()) {
    check('every coordinate is finite',
      Number.isFinite(node.x) && Number.isFinite(node.y), `${where}, node ${node.id}`);
    check('leaves sit on the baseline',
      node.id >= n || node.y === 0, `${where}, leaf ${node.id} at y=${node.y}`);
  }

  // A parent sits at or above both children — otherwise an edge would be
  // drawn downwards and the height axis would be meaningless.
  for (const node of d.nodes.values()) {
    if (!node.children) continue;
    for (const child of node.children) {
      const c = d.nodes.get(child)!;
      check('a join is drawn at or above what it joins',
        node.y >= c.y - 1e-9, `${where}: ${node.id} at ${node.y} over ${child} at ${c.y}`);
      check('a join sits between its children horizontally',
        node.x >= Math.min(...node.children.map((k) => d.nodes.get(k)!.x)) - 1e-9
        && node.x <= Math.max(...node.children.map((k) => d.nodes.get(k)!.x)) + 1e-9, where);
    }
  }

  // No crossings: every subtree occupies one unbroken run of slots. This is
  // what the in-order walk buys, and the property that silently disappears if
  // the leaf order is ever taken from the input instead of from the tree.
  const slotOf = new Map<number, number>();
  d.order.forEach((leaf, slot) => slotOf.set(leaf, slot));
  for (let i = 0; i < merges.length; i++) {
    const slots = leavesUnder(n + i, n, merges).map((l) => slotOf.get(l)!).sort((x, y) => x - y);
    const contiguous = slots.every((s, k) => k === 0 || s === slots[k - 1] + 1);
    check('each subtree occupies one unbroken run of slots', contiguous,
      `${where}, merge ${i}: ${slots.join(',')}`);
  }
}

// The cut line has to land where the cut actually happened: strictly between
// the last merge the count allows and the first it does not.
for (let seed = 1; seed <= 60; seed++) {
  const n = 3 + Math.floor(rng(seed)() * 15);
  const merges = randomMerges(seed, n);
  for (let groups = 1; groups <= n; groups++) {
    const h = cutHeight(merges, 'count', groups, n);
    check('a count cut has a height', h !== null, `seed ${seed}, groups ${groups}`);
    const applied = n - groups;
    if (applied > 0 && applied < merges.length) {
      check('the cut falls between the merges it separates',
        h! > merges[applied - 1].distance - 1e-9 && h! < merges[applied].distance + 1e-9,
        `seed ${seed}, groups ${groups}: ${h} not between ${merges[applied - 1].distance} and ${merges[applied].distance}`);
    }
  }
  // A threshold cut is simply the threshold.
  check('a threshold cut is drawn at the threshold',
    cutHeight(merges, 'threshold', 0.37, n) === 0.37, `seed ${seed}`);
}

// Degenerate inputs must not throw and must not invent structure.
const empty = layoutDendrogram(0, []);
check('an empty model lays out to nothing', empty.order.length === 0 && empty.root === null);
const lone = layoutDendrogram(1, []);
check('one person is their own root', lone.order.length === 1 && lone.root === 0);
check('no merges means no cut line', cutHeight([], 'count', 3, 1) === null);

// Connected components emits no merges at all: the layout must degrade to a
// flat row rather than to an exception.
const flat = layoutDendrogram(5, []);
check('a model with no merges is five roots on the baseline',
  flat.order.length === 5 && flat.root === null
  && [...flat.nodes.values()].every((node) => node.y === 0));

if (failures > 0) {
  console.error(`${failures} dendrogram invariant(s) failed`);
  process.exit(1);
}
console.log('  ✓ all dendrogram invariants hold');
