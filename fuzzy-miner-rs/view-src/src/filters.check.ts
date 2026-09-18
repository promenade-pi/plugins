/**
 * Executable invariants for the filter chain, over hand-written cases and a
 * few hundred randomised models.
 *
 * The chain is easy to get subtly wrong in ways a screenshot will not show:
 * an edge pointing at a node that was clustered away, an activity that is
 * both drawn and inside a cluster, a cluster of one that should have been
 * dissolved. Every one of those is a statement about the *output*, so it can
 * be checked rather than eyeballed — and checked against inputs nobody chose
 * by hand, which is where the interesting failures live.
 *
 * Run with `npm run check`; `package.sh` gates the build on it.
 */
import { applyFilters, type FuzzyFilterModel, type FuzzyGraph } from './filters';
import { defaultViewParams, type ViewParams } from './types';

// This file runs under Node (bundled by `check.js`), not in the frame, and
// the package deliberately carries no @types/node.
declare const process: { exit(code: number): never };

let failures = 0;
let checks = 0;

function check(condition: boolean, message: string) {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL ${message}`);
  }
}

/** xorshift32 — a deterministic generator, so a failure is reproducible. */
function rng(seed: number) {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

function model(n: number, next: () => number, density = 0.4): FuzzyFilterModel {
  const nodeSignificance = Array.from({ length: n }, () => next());
  const edgeSignificance = new Array(n * n).fill(0);
  const edgeCorrelation = new Array(n * n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (next() < density) {
        edgeSignificance[i * n + j] = next();
        edgeCorrelation[i * n + j] = next();
      }
    }
  }
  return {
    n,
    activities: Array.from({ length: n }, (_, i) => `act ${i}`),
    counts: Array.from({ length: n }, () => Math.floor(next() * 500) + 1),
    nodeSignificance,
    edgeSignificance,
    edgeCorrelation,
  };
}

function invariants(g: FuzzyGraph, m: FuzzyFilterModel, p: ViewParams, label: string) {
  const nodeIds = new Set(g.nodes.map((x) => x.index));
  const clusterIds = new Set(g.clusters.map((c) => c.index));

  for (const e of g.edges) {
    check(
      nodeIds.has(e.source) || clusterIds.has(e.source),
      `${label}: edge from ${e.source}, which is not drawn`
    );
    check(
      nodeIds.has(e.target) || clusterIds.has(e.target),
      `${label}: edge to ${e.target}, which is not drawn`
    );
    check(e.significance > 0, `${label}: edge ${e.source}->${e.target} has no significance`);
  }

  // No activity is both a node in its own right and a cluster member.
  const clustered = new Set<number>();
  for (const c of g.clusters) {
    check(c.primitives.length >= 2, `${label}: cluster ${c.index} has ${c.primitives.length} member(s)`);
    check(
      c.index >= m.n,
      `${label}: cluster index ${c.index} collides with the activity index space`
    );
    for (const prim of c.primitives) {
      check(!clustered.has(prim), `${label}: activity ${prim} is in two clusters`);
      clustered.add(prim);
      check(!nodeIds.has(prim), `${label}: activity ${prim} is drawn and clustered`);
      check(
        m.nodeSignificance[prim] < p.nodeCutoff,
        `${label}: activity ${prim} was clustered despite clearing the cutoff`
      );
    }
    check(
      c.significance >= 0 && c.significance <= 1,
      `${label}: cluster ${c.index} mean significance ${c.significance} out of range`
    );
  }

  // Every drawn activity cleared the cutoff.
  for (const node of g.nodes) {
    check(
      m.nodeSignificance[node.index] >= p.nodeCutoff,
      `${label}: activity ${node.index} is drawn below the cutoff`
    );
  }

  // No duplicate edges — the chain merges them onto the strongest.
  const seen = new Set<string>();
  for (const e of g.edges) {
    const key = `${e.source}>${e.target}`;
    check(!seen.has(key), `${label}: duplicate edge ${key}`);
    seen.add(key);
  }

  // Self-loops only ever belong to a real activity.
  for (const e of g.edges) {
    if (e.source === e.target) {
      check(nodeIds.has(e.source), `${label}: cluster ${e.source} drew a self-loop`);
    }
  }

  if (p.dropDisconnected) {
    for (const node of g.nodes) {
      check(
        g.edges.some((e) => e.source === node.index || e.target === node.index),
        `${label}: activity ${node.index} is drawn with no relations`
      );
    }
  }
}

// ---- hand-written cases ---------------------------------------------------

function sequence(): FuzzyFilterModel {
  // a -> b -> c -> d, decreasing significance, b well below the rest.
  const n = 4;
  const edgeSignificance = new Array(n * n).fill(0);
  const edgeCorrelation = new Array(n * n).fill(0);
  for (const [i, j] of [[0, 1], [1, 2], [2, 3]]) {
    edgeSignificance[i * n + j] = 1;
    edgeCorrelation[i * n + j] = 0.8;
  }
  return {
    n,
    activities: ['a', 'b', 'c', 'd'],
    counts: [10, 10, 10, 10],
    nodeSignificance: [1, 0.05, 0.9, 1],
    edgeSignificance,
    edgeCorrelation,
  };
}

console.log('filter-chain invariants');

{
  const m = sequence();
  const p = { ...defaultViewParams, nodeCutoff: 0 };
  const g = applyFilters(m, p);
  check(g.nodes.length === 4, `no cutoff: expected 4 activities, got ${g.nodes.length}`);
  check(g.clusters.length === 0, `no cutoff: expected no clusters, got ${g.clusters.length}`);
  invariants(g, m, p, 'sequence/no cutoff');
}

{
  // b alone falls below the cutoff, so its cluster is singular and dissolves,
  // and a->c must be drawn in its place.
  const m = sequence();
  const p = { ...defaultViewParams, nodeCutoff: 0.5 };
  const g = applyFilters(m, p);
  check(g.clusters.length === 0, `singular: expected the cluster to dissolve, got ${g.clusters.length}`);
  check(!g.nodes.some((x) => x.index === 1), 'singular: b should be gone');
  check(
    g.edges.some((e) => e.source === 0 && e.target === 2),
    'singular: the transitive a->c relation was not drawn'
  );
  invariants(g, m, p, 'sequence/cutoff 0.5');
}

{
  // Two insignificant, mutually correlated activities form a real cluster.
  const n = 4;
  const edgeSignificance = new Array(n * n).fill(0);
  const edgeCorrelation = new Array(n * n).fill(0);
  for (const [i, j, s, c] of [[0, 1, 1, 0.3], [1, 2, 1, 0.95], [2, 1, 0.9, 0.95], [2, 3, 1, 0.3]] as number[][]) {
    edgeSignificance[i * n + j] = s;
    edgeCorrelation[i * n + j] = c;
  }
  const m: FuzzyFilterModel = {
    n,
    activities: ['a', 'b', 'c', 'd'],
    counts: [10, 3, 3, 10],
    nodeSignificance: [1, 0.05, 0.06, 1],
    edgeSignificance,
    edgeCorrelation,
  };
  const p = { ...defaultViewParams, nodeCutoff: 0.5, filterConcurrency: false };
  const g = applyFilters(m, p);
  check(g.clusters.length === 1, `cluster: expected 1 cluster, got ${g.clusters.length}`);
  check(
    g.clusters[0]?.primitives.length === 2,
    `cluster: expected 2 members, got ${g.clusters[0]?.primitives.length}`
  );
  invariants(g, m, p, 'cluster');
}

{
  // Concurrency resolution: a two-way relation that dominates both endpoints
  // survives; the same pair as a lopsided minority does not.
  const n = 2;
  const balanced: FuzzyFilterModel = {
    n,
    activities: ['a', 'b'],
    counts: [10, 10],
    nodeSignificance: [1, 1],
    edgeSignificance: [0, 1, 1, 0],
    edgeCorrelation: [0, 0.5, 0.5, 0],
  };
  const p = { ...defaultViewParams, nodeCutoff: 0 };
  const g = applyFilters(balanced, p);
  check(g.edges.length === 2, `concurrency: expected both directions kept, got ${g.edges.length}`);
  invariants(g, balanced, p, 'concurrency/balanced');
}

{
  // An empty model must not throw and must draw nothing.
  const m: FuzzyFilterModel = {
    n: 0, activities: [], counts: [], nodeSignificance: [], edgeSignificance: [], edgeCorrelation: [],
  };
  const g = applyFilters(m, defaultViewParams);
  check(g.nodes.length === 0 && g.edges.length === 0 && g.clusters.length === 0, 'empty model drew something');
}

// ---- randomised -----------------------------------------------------------

const next = rng(20260902);
let randomised = 0;
// Coverage counters. An invariant suite that never sees a cluster, a merge or
// a dissolved singleton is only asserting that nothing happened.
let withClusters = 0;
let withEdges = 0;
let withRemovals = 0;
let bigClusters = 0;
for (let trial = 0; trial < 400; trial++) {
  const n = 2 + Math.floor(next() * 14);
  const m = model(n, next, 0.15 + next() * 0.6);
  const p: ViewParams = {
    nodeCutoff: next(),
    edgeTransform: next() < 0.25 ? 'best' : 'fuzzy',
    edgeCutoff: next(),
    utilityRatio: next(),
    interpretAbsolute: next() < 0.3,
    ignoreSelfLoops: next() < 0.8,
    filterConcurrency: next() < 0.8,
    concurrencyPreserve: next(),
    concurrencyRatio: next(),
    edgeLabel: 'significance',
    dropDisconnected: next() < 0.7,
  };
  const g = applyFilters(m, p);
  invariants(g, m, p, `random#${trial}(n=${n})`);
  if (g.clusters.length > 0) withClusters++;
  if (g.edges.length > 0) withEdges++;
  if (g.removed > 0) withRemovals++;
  if (g.clusters.some((c) => c.primitives.length > 2)) bigClusters++;
  randomised++;
}

check(withClusters > 20, `only ${withClusters} random models produced a cluster`);
check(withEdges > 300, `only ${withEdges} random models produced an edge`);
check(withRemovals > 20, `only ${withRemovals} random models removed an activity`);
check(bigClusters > 5, `only ${bigClusters} random models produced a cluster of 3+`);

console.log(`  ${randomised} randomised models, ${checks} assertions`);
console.log(`  coverage: ${withEdges} with edges, ${withClusters} with clusters ` +
  `(${bigClusters} of 3+), ${withRemovals} with removals`);
if (failures > 0) {
  console.error(`  ${failures} failing`);
  process.exit(1);
}
console.log('  ok');
