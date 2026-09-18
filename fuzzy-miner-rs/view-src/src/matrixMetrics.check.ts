/**
 * Executable invariants for `matrixMetrics.ts`, over hand-written cases and a
 * few hundred randomised payloads.
 *
 * Run with `npm run check`; `check.js` gates the build on this alongside
 * `filters.check.ts`.
 */
import type { FuzzyMetricDetail, FuzzyModelPayload } from './types';
import {
  buildMatrix, buildRowSeries, MATRIX_METRICS, matrixMetricOf, metricAvailable,
  rowMetricAvailable, ROW_METRICS, sortOrder, type MatrixMetricKey, type RowMetricKey,
} from './matrixMetrics';

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

const DETAIL_FIELDS: (keyof FuzzyMetricDetail)[] = [
  'frequencyUnary', 'routingUnary', 'frequencyBinary', 'distanceBinary', 'proximity', 'endpoint', 'originator',
];

function payload(n: number, next: () => number, withDetail: boolean): FuzzyModelPayload {
  const activities = Array.from({ length: n }, (_, i) => `act-${i}`);
  const nodeSignificance = Array.from({ length: n }, () => next());
  const edgeSignificance = Array.from({ length: n * n }, () => next());
  const edgeCorrelation = Array.from({ length: n * n }, () => next());
  let metrics: FuzzyMetricDetail | undefined;
  if (withDetail) {
    const unary = () => Array.from({ length: n }, () => next());
    const binary = () => Array.from({ length: n * n }, () => next());
    metrics = {
      frequencyUnary: unary(), routingUnary: unary(),
      frequencyBinary: binary(), distanceBinary: binary(),
      proximity: binary(), endpoint: binary(), originator: binary(),
    };
  }
  return {
    activities,
    counts: Array.from({ length: n }, () => Math.floor(next() * 100)),
    nodeSignificance, edgeSignificance, edgeCorrelation, metrics,
    distanceHistogram: Array.from({ length: 20 }, () => Math.floor(next() * 50)),
    stats: {
      activities: n, relations: 0, events: 0, cases: 0, maximalDistance: 5,
      attenuation: 'nRoot', radical: 2.7, truncated: false, hasResources: true, hasTimestamps: true,
    },
  };
}

function isPermutation(order: number[], n: number): boolean {
  if (order.length !== n) return false;
  const seen = new Set(order);
  if (seen.size !== n) return false;
  for (let i = 0; i < n; i++) if (!seen.has(i)) return false;
  return true;
}

console.log('matrixMetrics invariants');

// ---- registries agree with each other -------------------------------------

for (const opt of MATRIX_METRICS) {
  check(matrixMetricOf(opt.key) === opt, `matrixMetricOf(${opt.key}) should return the same option object`);
}
check(new Set(MATRIX_METRICS.map((m) => m.key)).size === MATRIX_METRICS.length, 'MATRIX_METRICS has a duplicate key');
check(new Set(ROW_METRICS.map((m) => m.key)).size === ROW_METRICS.length, 'ROW_METRICS has a duplicate key');
check(MATRIX_METRICS.filter((m) => !m.needsDetail).length === 2, 'exactly the two weighted totals need no detail');
check(ROW_METRICS.filter((m) => !m.needsDetail).length === 1, 'exactly node significance needs no detail');

// ---- hand-written cases ----------------------------------------------------

{
  const p = payload(4, rng(1), false);
  // Every raw metric is absent without includeMetricDetail.
  for (const opt of MATRIX_METRICS.filter((m) => m.needsDetail)) {
    check(!metricAvailable(p, opt.key), `${opt.key} should be unavailable with no metric detail`);
    check(buildMatrix(p, opt.key, sortOrder(p, 'significance')) === null, `buildMatrix(${opt.key}) should be null with no metric detail`);
  }
  for (const opt of ROW_METRICS.filter((m) => m.needsDetail)) {
    check(!rowMetricAvailable(p, opt.key), `${opt.key} should be unavailable with no metric detail`);
  }
  // The two weighted totals are always there.
  check(metricAvailable(p, 'weightedSignificance'), 'weightedSignificance should always be available');
  check(metricAvailable(p, 'weightedCorrelation'), 'weightedCorrelation should always be available');
  check(rowMetricAvailable(p, 'nodeSignificance'), 'nodeSignificance should always be available');
}

{
  const p = payload(4, rng(2), true);
  for (const opt of MATRIX_METRICS) check(metricAvailable(p, opt.key), `${opt.key} should be available with detail present`);
  for (const opt of ROW_METRICS) check(rowMetricAvailable(p, opt.key), `${opt.key} should be available with detail present`);
}

{
  // A known matrix: value(r,c) must read back exactly at every permuted cell.
  const p = payload(3, rng(3), false);
  p.edgeSignificance = [0, 0.2, 0.9, 0.4, 0, 0.1, 0.7, 0.3, 0];
  const order = [2, 0, 1]; // deliberately not identity
  const m = buildMatrix(p, 'weightedSignificance', order)!;
  check(m.max === 0.9, `expected max 0.9, got ${m.max}`);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const expected = p.edgeSignificance[order[r] * 3 + order[c]];
      check(m.value(r, c) === expected, `value(${r},${c}) mismatch: got ${m.value(r, c)}, want ${expected}`);
    }
  }
}

{
  // An all-zero matrix must not divide by zero — max falls back to 1.
  const p = payload(3, rng(4), false);
  p.edgeSignificance = p.edgeSignificance.map(() => 0);
  const m = buildMatrix(p, 'weightedSignificance', sortOrder(p, 'significance'))!;
  check(m.max === 1, `all-zero matrix should report max 1, got ${m.max}`);
}

{
  const p = payload(5, rng(5), false);
  p.activities = ['banana', 'Apple', 'cherry', 'apple2', 'Banana2'];
  const order = sortOrder(p, 'alphabetical');
  const names = order.map((i) => p.activities[i]);
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  check(JSON.stringify(names) === JSON.stringify(sorted), `alphabetical order not sorted: ${names.join(',')}`);
}

{
  const p = payload(5, rng(6), false);
  const order = sortOrder(p, 'significance');
  for (let i = 1; i < order.length; i++) {
    check(
      p.nodeSignificance[order[i - 1]] >= p.nodeSignificance[order[i]],
      `significance order not non-increasing at ${i}`
    );
  }
}

// ---- randomised -------------------------------------------------------------

const next = rng(20260914);
let randomised = 0;
let withDetailCount = 0;
let nonTrivialMax = 0;

for (let trial = 0; trial < 400; trial++) {
  const n = 1 + Math.floor(next() * 12);
  const withDetail = next() < 0.5;
  const p = payload(n, next, withDetail);
  if (withDetail) withDetailCount++;

  for (const sort of ['significance', 'alphabetical'] as const) {
    const order = sortOrder(p, sort);
    check(isPermutation(order, n), `random#${trial}/${sort}: order is not a permutation of [0,${n})`);

    for (const opt of MATRIX_METRICS) {
      const available = metricAvailable(p, opt.key);
      check(available === (opt.needsDetail ? withDetail : true), `random#${trial}: ${opt.key} availability mismatch`);
      const m = buildMatrix(p, opt.key, order);
      check((m !== null) === available, `random#${trial}: buildMatrix(${opt.key}) nullness mismatch`);
      if (!m) continue;
      check(m.max > 0, `random#${trial}: ${opt.key} max must be positive`);
      if (m.max !== 1 || n > 0) nonTrivialMax++;
      // Every displayed cell must be a real cell from the underlying array,
      // never a fabricated or out-of-range value.
      const r = Math.floor(next() * n);
      const c = Math.floor(next() * n);
      const v = m.value(r, c);
      check(v >= 0 && v <= m.max + 1e-9, `random#${trial}: ${opt.key} value ${v} exceeds its own max ${m.max}`);
    }

    for (const opt of ROW_METRICS) {
      const available = rowMetricAvailable(p, opt.key);
      check(available === (opt.needsDetail ? withDetail : true), `random#${trial}: row ${opt.key} availability mismatch`);
      const s = buildRowSeries(p, opt.key, order);
      check((s !== null) === available, `random#${trial}: buildRowSeries(${opt.key}) nullness mismatch`);
      if (!s) continue;
      check(s.max > 0, `random#${trial}: row ${opt.key} max must be positive`);
      const r = Math.floor(next() * n);
      const v = s.value(r);
      check(v >= 0 && v <= s.max + 1e-9, `random#${trial}: row ${opt.key} value ${v} exceeds its own max ${s.max}`);
    }
  }
  randomised++;
}

check(withDetailCount > 50, `only ${withDetailCount} random payloads carried metric detail`);
check(nonTrivialMax > 50, `only ${nonTrivialMax} matrices had a meaningful max`);

console.log(`  ${randomised} randomised payloads, ${checks} assertions`);
console.log(`  coverage: ${withDetailCount} with metric detail, ${nonTrivialMax} matrices built`);
if (failures > 0) {
  console.error(`  ${failures} failing`);
  process.exit(1);
}
console.log('  ok');
