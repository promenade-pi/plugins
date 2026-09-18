/**
 * Which metric the heatmap draws, and how activities are ordered — kept free
 * of rendering and of `promenade` so it can be tested without a DOM or a
 * mocked host (`matrixMetrics.check.ts`).
 *
 * ProM's own Fuzzy Miner metrics screen is two panels: a multi-curve chart of
 * the *unary* metrics (one value per activity) and a coloured matrix of the
 * *binary* ones (one value per ordered pair). This module is the data half of
 * both, refactored into two families rather than kept as ProM's fixed pair of
 * panels — this plugin's kernel produces the same weighted totals ProM shows
 * plus the seven individual metrics behind them (`FuzzyMetricDetail`), and any
 * of those nine can go in either slot.
 */
import type { FuzzyMetricDetail, FuzzyModelPayload } from './types';

export type MatrixMetricKey =
  | 'weightedSignificance' | 'weightedCorrelation'
  | 'frequencyBinary' | 'distanceBinary'
  | 'proximity' | 'endpoint' | 'originator';

export type RowMetricKey = 'nodeSignificance' | 'frequencyUnary' | 'routingUnary';

export type MetricFamily = 'significance' | 'correlation';

export interface MatrixMetricOption {
  key: MatrixMetricKey;
  label: string;
  /** Which of the two colour ramps this metric draws with — see `palette.ts`. */
  family: MetricFamily;
  /** True for one of the seven raw metrics, only present with `includeMetricDetail`. */
  needsDetail: boolean;
}

/** In display order — the two always-present weighted totals first, then the
 * raw metrics grouped by family. */
export const MATRIX_METRICS: MatrixMetricOption[] = [
  { key: 'weightedSignificance', label: 'Binary significance (weighted)', family: 'significance', needsDetail: false },
  { key: 'weightedCorrelation', label: 'Binary correlation (weighted)', family: 'correlation', needsDetail: false },
  { key: 'frequencyBinary', label: 'Frequency significance', family: 'significance', needsDetail: true },
  { key: 'distanceBinary', label: 'Distance significance', family: 'significance', needsDetail: true },
  { key: 'proximity', label: 'Proximity correlation', family: 'correlation', needsDetail: true },
  { key: 'endpoint', label: 'Endpoint correlation', family: 'correlation', needsDetail: true },
  { key: 'originator', label: 'Originator correlation', family: 'correlation', needsDetail: true },
];

export interface RowMetricOption {
  key: RowMetricKey;
  label: string;
  needsDetail: boolean;
}

export const ROW_METRICS: RowMetricOption[] = [
  { key: 'nodeSignificance', label: 'Overall significance', needsDetail: false },
  { key: 'frequencyUnary', label: 'Frequency significance', needsDetail: true },
  { key: 'routingUnary', label: 'Routing significance', needsDetail: true },
];

export function matrixMetricOf(key: MatrixMetricKey): MatrixMetricOption {
  const m = MATRIX_METRICS.find((x) => x.key === key);
  if (!m) throw new Error(`unknown matrix metric "${key}"`);
  return m;
}

function binaryArray(payload: FuzzyModelPayload, key: MatrixMetricKey): number[] | null {
  if (key === 'weightedSignificance') return payload.edgeSignificance ?? null;
  if (key === 'weightedCorrelation') return payload.edgeCorrelation ?? null;
  const field = key as keyof FuzzyMetricDetail;
  return payload.metrics?.[field] ?? null;
}

function unaryArray(payload: FuzzyModelPayload, key: RowMetricKey): number[] | null {
  if (key === 'nodeSignificance') return payload.nodeSignificance ?? null;
  const field = key as keyof FuzzyMetricDetail;
  return payload.metrics?.[field] ?? null;
}

export function metricAvailable(payload: FuzzyModelPayload, key: MatrixMetricKey): boolean {
  return binaryArray(payload, key) != null;
}

export function rowMetricAvailable(payload: FuzzyModelPayload, key: RowMetricKey): boolean {
  return unaryArray(payload, key) != null;
}

/**
 * Display order for activities — a permutation of `[0..n)`, applied to both
 * axes so the matrix stays square in the same order it is labelled.
 *
 * `alphabetical` breaks ties on index so the order is deterministic even
 * when two activities share an exact name; `significance` breaks ties the
 * same way, so re-sorting on an unrelated re-render never visibly reshuffles
 * equal-weight rows.
 */
export function sortOrder(payload: FuzzyModelPayload, sort: 'significance' | 'alphabetical'): number[] {
  const n = payload.activities.length;
  const order = Array.from({ length: n }, (_, i) => i);
  if (sort === 'alphabetical') {
    order.sort((a, b) => payload.activities[a].localeCompare(payload.activities[b]) || a - b);
  } else {
    order.sort((a, b) => (payload.nodeSignificance[b] ?? 0) - (payload.nodeSignificance[a] ?? 0) || a - b);
  }
  return order;
}

export interface MatrixData {
  n: number;
  order: number[];
  /** The largest cell value, for scaling colour — never 0, so a division by
   * it is always safe even on an all-zero (e.g. all-self-loop) matrix. */
  max: number;
  /** Cell value at *display* position `(r, c)`, already permuted by `order`. */
  value(r: number, c: number): number;
}

/** `null` when the metric needs per-metric detail the model wasn't mined with. */
export function buildMatrix(payload: FuzzyModelPayload, key: MatrixMetricKey, order: number[]): MatrixData | null {
  const data = binaryArray(payload, key);
  if (!data) return null;
  const n = payload.activities.length;
  let max = 0;
  for (const v of data) if (v > max) max = v;
  if (max <= 0) max = 1;
  return { n, order, max, value: (r, c) => data[order[r] * n + order[c]] };
}

export interface RowSeries {
  order: number[];
  max: number;
  value(r: number): number;
}

export function buildRowSeries(payload: FuzzyModelPayload, key: RowMetricKey, order: number[]): RowSeries | null {
  const data = unaryArray(payload, key);
  if (!data) return null;
  let max = 0;
  for (const v of data) if (v > max) max = v;
  if (max <= 0) max = 1;
  return { order, max, value: (r) => data[order[r]] };
}
