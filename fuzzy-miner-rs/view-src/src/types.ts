/**
 * The seven raw per-metric arrays the kernel folds into `edgeSignificance` /
 * `edgeCorrelation` / `nodeSignificance`, present only when the model was
 * mined with `includeMetricDetail: true`. The two `*Unary` arrays are
 * per-activity (length n); the rest are row-major n×n, the same shape and
 * indexing as `edgeSignificance`. Field names match the Rust `MetricDetail`
 * struct's `#[serde(rename_all = "camelCase")]` output exactly.
 */
export interface FuzzyMetricDetail {
  frequencyUnary: number[];
  routingUnary: number[];
  frequencyBinary: number[];
  distanceBinary: number[];
  proximity: number[];
  endpoint: number[];
  originator: number[];
}

/** The `FuzzyModel` artifact payload, as the Rust kernel serialises it. */
export interface FuzzyModelPayload {
  activities: string[];
  counts: number[];
  /** Unary significance per activity, scaled so the maximum is 1. */
  nodeSignificance: number[];
  /** Row-major n×n binary significance. */
  edgeSignificance: number[];
  /** Row-major n×n binary correlation. */
  edgeCorrelation: number[];
  metrics?: FuzzyMetricDetail;
  /** Raw relation-observation count per look-back distance — index 0 is
   * distance 1 — unattenuated and independent of `maximalDistance`. */
  distanceHistogram: number[];
  stats: {
    activities: number;
    relations: number;
    events: number;
    cases: number;
    maximalDistance: number;
    attenuation: string;
    radical: number;
    truncated: boolean;
    hasResources: boolean;
    hasTimestamps: boolean;
  };
}

/** The filter chain's settings — every one of them a slider on the rail. */
export interface ViewParams {
  nodeCutoff: number;
  edgeTransform: 'fuzzy' | 'best';
  edgeCutoff: number;
  utilityRatio: number;
  interpretAbsolute: boolean;
  ignoreSelfLoops: boolean;
  filterConcurrency: boolean;
  concurrencyPreserve: number;
  concurrencyRatio: number;
  edgeLabel: 'none' | 'significance' | 'both';
  dropDisconnected: boolean;
}

/**
 * The reference implementation's defaults, unchanged — ProM's Fuzzy Miner
 * opens on exactly these numbers.
 */
export const defaultViewParams: ViewParams = {
  nodeCutoff: 0,
  edgeTransform: 'fuzzy',
  edgeCutoff: 0.2,
  utilityRatio: 0.75,
  interpretAbsolute: false,
  ignoreSelfLoops: true,
  filterConcurrency: true,
  concurrencyPreserve: 0.6,
  concurrencyRatio: 0.7,
  edgeLabel: 'significance',
  dropDisconnected: true,
};

export function format3(v: number): string {
  return v.toFixed(3);
}

/**
 * `create_attenuation_factor` from ProM/`src/lib.rs`, mirrored so the
 * distance histogram can overlay the curve the *current* mining params
 * actually apply, without round-tripping through wasm for a formula this
 * simple.
 */
export function attenuationFactor(kind: string, radical: number, distance: number): number {
  if (distance <= 1) return 1;
  if (kind === 'linear') return Math.max(0, (radical - distance + 1) / radical);
  return 1 / Math.pow(radical, distance - 1);
}

/** The Fuzzy metrics view's own controls — see `matrixMetrics.ts`. */
export interface MatrixViewParams {
  /** 'matrix' is ProM's binary-metric panel; 'curves' is ProM's other panel,
   * the multi-curve unary-metric chart; 'histogram' is a diagnostic this
   * plugin adds that ProM never had: how many relation observations the scan
   * actually found at each look-back distance, so raising `maximalDistance`
   * (an Inspector-only, mining-time param — not editable from this view) is
   * an informed choice rather than a guess. */
  mode: 'matrix' | 'curves' | 'histogram';
  metric: import('./matrixMetrics').MatrixMetricKey;
  rowMetric: import('./matrixMetrics').RowMetricKey;
  sort: 'significance' | 'alphabetical';
  cellSize: number;
}

export const defaultMatrixParams: MatrixViewParams = {
  mode: 'matrix',
  metric: 'weightedSignificance',
  rowMetric: 'nodeSignificance',
  sort: 'significance',
  cellSize: 18,
};
