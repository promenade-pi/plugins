/**
 * Edge-cut invariants.
 *
 * The cut is the control a reader touches most, so its guarantees have to
 * hold on every network rather than on the one it was written against:
 * monotone (moving the slider up never removes an edge), never empty while
 * there is anything to show, and never reordered.
 */

import { prunedEdges, isolatedNodes } from './prune';
import type { SocialEdge } from './types';

/**
 * Node's `process`, declared rather than depended on: these checks run under
 * `node` via esbuild but the package types itself with `types: []` so the
 * browser sources cannot accidentally reach for a Node global.
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

/** `signed` produces similarity-shaped weights, which can be negative. */
function randomEdges(seed: number, signed: boolean): SocialEdge[] {
  const r = rng(seed);
  const n = Math.floor(r() * 40);
  const raw = Array.from({ length: n }, () => (signed ? r() * 2 - 1 : r()));
  const total = signed ? 1 : raw.reduce((a, b) => a + b, 0) || 1;
  return raw
    .map((w, i) => ({ from: i % 7, to: (i % 7) + 1, weight: w / total, raw: w }))
    .sort((a, b) => b.weight - a.weight);
}

console.log('edge-cut invariants');
const SHARES = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95, 1];

for (let seed = 1; seed <= 120; seed++) {
  for (const signed of [false, true]) {
    const edges = randomEdges(seed, signed);
    const where = `seed ${seed}${signed ? ', signed' : ''}, ${edges.length} edges`;

    let previous: SocialEdge[] = [];
    for (const share of SHARES) {
      const kept = prunedEdges(edges, share);

      check('never keeps an edge that is not there',
        kept.every((e) => edges.includes(e)), where);
      check('keeps something whenever there is something',
        edges.length === 0 || kept.length > 0, `${where}, share ${share}`);
      check('stays sorted strongest first',
        kept.every((e, i) => i === 0 || kept[i - 1].weight >= e.weight), `${where}, share ${share}`);

      // Monotone: raising the share may only add. A cut that drops an edge as
      // the slider goes up makes the control unusable — the picture would
      // flicker rather than fill in.
      const grew = previous.every((e) => kept.includes(e)) && kept.length >= previous.length;
      check('raising the share only ever adds edges', grew,
        `${where}, share ${share}: ${previous.length} → ${kept.length}`);
      previous = kept;
    }

    check('a full share keeps everything', prunedEdges(edges, 1).length === edges.length, where);
  }
}

// The cumulative rule must actually cover the share it claims.
for (let seed = 1; seed <= 60; seed++) {
  const edges = randomEdges(seed, false);
  if (edges.length === 0) continue;
  const total = edges.reduce((s, e) => s + e.weight, 0);
  for (const share of [0.25, 0.5, 0.9]) {
    const kept = prunedEdges(edges, share);
    const covered = kept.reduce((s, e) => s + e.weight, 0);
    check('the kept edges cover at least the share asked for',
      covered >= total * share - 1e-9,
      `seed ${seed}, share ${share}: covered ${covered.toFixed(4)} of ${total.toFixed(4)}`);
    // And not wastefully more: dropping the last one must fall short.
    if (kept.length > 1) {
      const without = covered - kept[kept.length - 1].weight;
      check('and no more edges than that needs', without < total * share + 1e-9,
        `seed ${seed}, share ${share}`);
    }
  }
}

// Isolated nodes are a consequence of the cut, and the view greys them out
// rather than dropping them — a person who disappears from the picture reads
// as a person who is not in the log.
const isolated = isolatedNodes(5, [{ from: 0, to: 1, weight: 1, raw: 1 }]);
check('nodes with no surviving edge are reported',
  isolated.size === 3 && isolated.has(2) && isolated.has(3) && isolated.has(4),
  [...isolated].join(','));
check('an empty network isolates nobody', isolatedNodes(0, []).size === 0);

if (failures > 0) {
  console.error(`${failures} edge-cut invariant(s) failed`);
  process.exit(1);
}
console.log('  ✓ all edge-cut invariants hold');
