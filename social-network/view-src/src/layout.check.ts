/**
 * Layout invariants, over randomised networks.
 *
 * A graph layout has no right answer to compare against, which is exactly why
 * it needs asserted properties rather than a look at a screenshot: every node
 * on the canvas, no two nodes overlapping, the same input giving the same
 * coordinates twice. Each of those has been silently violated by a layout
 * that looked fine on the one graph it was developed against.
 */

import { layoutGraph, nodeRadius, type LayoutInput, type LayoutKind } from './layout';

/**
 * Node's `process`, declared rather than depended on: these checks run under
 * `node` via esbuild but the package types itself with `types: []` so the
 * browser sources cannot accidentally reach for a Node global.
 */
declare const process: { exit(code: number): never };

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function rng(seed: number) {
  let s = seed || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/** A random network: some connected, some with isolated nodes, some dense. */
function randomInput(seed: number): LayoutInput {
  const r = rng(seed);
  const count = 1 + Math.floor(r() * 24);
  const density = r();
  const edges: LayoutInput['edges'] = [];
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      if (r() < density) edges.push({ from: i, to: j, weight: 0.001 + r() });
    }
  }
  return {
    count,
    edges,
    size: Array.from({ length: count }, () => r()),
    width: 400 + Math.floor(r() * 600),
    height: 300 + Math.floor(r() * 400),
  };
}

const KINDS: LayoutKind[] = ['stress', 'force', 'circle'];

console.log('layout invariants');
for (let seed = 1; seed <= 120; seed++) {
  const input = randomInput(seed);
  for (const kind of KINDS) {
    const where = `seed ${seed}, ${kind}, n=${input.count}`;
    const pos = layoutGraph(kind, input);

    check('one position per node', pos.length === input.count, where);
    check('every coordinate is finite',
      pos.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), where);

    // Inside the canvas, allowing the radius itself to sit on the padding.
    const inside = pos.every((p, i) => {
      const r = nodeRadius(input.size[i]);
      return p.x >= -r && p.x <= input.width + r && p.y >= -r && p.y <= input.height + r;
    });
    check('every node is on the canvas', inside, where);

    // Overlap: the separation pass exists precisely to make this true, and it
    // is the property that silently regresses whenever the layout changes.
    // Circle has no separation pass — it cannot, the positions are its
    // definition — so it is exempt and says so rather than being skipped
    // quietly.
    if (kind !== 'circle') {
      let worst = 0, worstPair = '';
      for (let i = 0; i < pos.length; i++) {
        for (let j = i + 1; j < pos.length; j++) {
          const need = nodeRadius(input.size[i]) + nodeRadius(input.size[j]);
          const have = Math.hypot(pos[i].x - pos[j].x, pos[i].y - pos[j].y);
          if (need - have > worst) { worst = need - have; worstPair = `${i}/${j}`; }
        }
      }
      check('no two nodes overlap', worst <= 0.5, `${where}, ${worstPair} overlaps by ${worst.toFixed(2)}px`);
    }

    // Determinism: a layout that moves when nothing changed makes every
    // comparison between two runs meaningless, and cannot be checked at all.
    const again = layoutGraph(kind, input);
    const same = pos.every((p, i) =>
      Math.abs(p.x - again[i].x) < 1e-9 && Math.abs(p.y - again[i].y) < 1e-9);
    check('the same input gives the same layout', same, where);
  }
}

// A strong relation must end up shorter than a weak one. This is the whole
// claim of using a weighted layout, so it is asserted rather than assumed —
// on a deliberately unambiguous graph: two tight pairs, one thin link.
for (const kind of ['stress', 'force'] as LayoutKind[]) {
  const input: LayoutInput = {
    count: 4,
    edges: [
      { from: 0, to: 1, weight: 1 },
      { from: 2, to: 3, weight: 1 },
      { from: 1, to: 2, weight: 0.02 },
    ],
    size: [0.5, 0.5, 0.5, 0.5],
    width: 800, height: 600,
  };
  const pos = layoutGraph(kind, input);
  const len = (a: number, b: number) => Math.hypot(pos[a].x - pos[b].x, pos[a].y - pos[b].y);
  check('a strong edge is drawn shorter than a weak one',
    Math.max(len(0, 1), len(2, 3)) < len(1, 2),
    `${kind}: pairs ${len(0, 1).toFixed(0)}/${len(2, 3).toFixed(0)} vs link ${len(1, 2).toFixed(0)}`);
}

// An empty network must not throw, and must produce nothing.
for (const kind of KINDS) {
  const pos = layoutGraph(kind, { count: 0, edges: [], size: [], width: 400, height: 300 });
  check('an empty network lays out to nothing', pos.length === 0, kind);
}

if (failures > 0) {
  console.error(`${failures} layout invariant(s) failed`);
  process.exit(1);
}
console.log('  ✓ all layout invariants hold');
