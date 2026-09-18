/**
 * The plugin's own vocabulary: what a "friction topography" is made of.
 *
 * Deliberately separated from both the SQL that fills it (`query.ts`) and the
 * geometry that draws it (`field.ts`, `scene/`). The elevation of the terrain
 * is one named statistic per activity, chosen by the user — nothing
 * downstream needs to know which one, only that it is comparable across
 * activities and that bigger means more friction.
 */

/** Which statistic becomes terrain height. */
export type FrictionMetric = 'medianWait' | 'p90Wait' | 'meanWait' | 'totalWait' | 'reworkRate';

export const FRICTION_LABEL: Record<FrictionMetric, string> = {
  medianWait: 'Median waiting time',
  p90Wait: '90th-percentile wait',
  meanWait: 'Mean waiting time',
  totalWait: 'Total waiting time',
  reworkRate: 'Rework probability',
};

/** Short axis caption for the elevation scale. */
export const FRICTION_AXIS: Record<FrictionMetric, string> = {
  medianWait: 'Friction /\nmedian wait',
  p90Wait: 'Friction /\np90 wait',
  meanWait: 'Friction /\nmean wait',
  totalWait: 'Friction /\ntotal wait',
  reworkRate: 'Friction /\nrework rate',
};

/** `true` when the metric is a duration in milliseconds, not a ratio. */
export function isDuration(metric: FrictionMetric): boolean {
  return metric !== 'reworkRate';
}

export interface ActivityStat {
  activity: string;
  /** Event occurrences of this activity in the filtered window. */
  occurrences: number;
  /** Distinct cases (classic) or objects (OCEL) touching it. */
  entities: number;
  /** How often it is the first step of an entity's life. */
  starts: number;
  /** How often it is the last step. */
  ends: number;
  /** Waiting time before this activity, i.e. since the entity's previous event. */
  medianWait: number;
  p90Wait: number;
  meanWait: number;
  minWait: number;
  maxWait: number;
  totalWait: number;
  /** Share of entities in which the activity occurs more than once. */
  reworkRate: number;
  /** Directly-follows self-repetitions (A -> A). */
  selfLoops: number;
  /**
   * Median position of this activity within an entity's life, 1-based.
   *
   * The log's own answer to "how far into the process is this step", and the
   * basis for calling a flow rework rather than reading that off a layout
   * engine's arbitrary choice of which arc to cut to break a cycle.
   */
  medianPos: number;
}

export interface EdgeStat {
  source: string;
  target: string;
  /** Observed directly-follows occurrences. */
  count: number;
  entities: number;
  medianMs: number;
  p90Ms: number;
  totalMs: number;
}

export interface Overview {
  entities: number;
  events: number;
  activities: number;
  medianCycleMs: number;
  p90CycleMs: number;
  firstMs: number;
  lastMs: number;
  /** Sum of all inter-event waits — the denominator for "share of waiting". */
  totalWaitMs: number;
}

export interface TopographyData {
  overview: Overview;
  activities: ActivityStat[];
  edges: EdgeStat[];
  /** `true` for an OCEL: entities are objects, and "case" is the wrong word. */
  objectCentric: boolean;
}

/** What `frictionMetric` reads off one activity. */
export function frictionOf(a: ActivityStat, metric: FrictionMetric): number {
  const value = a[metric];
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * How a friction value maps to altitude.
 *
 * `linear` is the literal reading: twice the wait, twice the height. It is
 * also, on a real log, frequently unusable - one rare exception path with a
 * three-day wait sets the scale and presses the entire routine process into a
 * flat black plain, which is the opposite of what the map is for.
 *
 * `compressed` raises altitude to a fractional power, the vertical
 * exaggeration every relief map of a real landscape applies. Ordering is
 * untouched (the transform is strictly increasing), so no peak overtakes
 * another; what changes is that the lowlands become readable. The elevation
 * axis is graduated through the same transform, so the numbers beside the
 * pole stay correct - the gaps between them simply are not even, exactly as on
 * a log-scaled axis.
 */
export type ElevationCurve = 'compressed' | 'linear';

/**
 * Which graphics backend to ask for.
 *
 * `auto` lets three's `WebGPURenderer` choose - WebGPU where the browser
 * offers it, its own WebGL 2 backend otherwise. `webgl2` pins the fallback,
 * which exists because a driver that reports WebGPU support and then renders
 * incorrectly is a real category of machine, and "the 3D view is broken here"
 * should have an answer that is not "wait for a new browser".
 */
export type RendererChoice = 'auto' | 'webgl2';

export type ViewMode = '3d' | 'top';
export type Palette = 'auto' | 'topographic' | 'relief';
export type Detail = 'low' | 'medium' | 'high';

export interface ViewParams {
  frictionMetric: FrictionMetric;
  activities: string[];
  objectTypes: string[];
  timeStart: string;
  timeEnd: string;
  edgeCoverage: number;
  maxActivities: number;
  verticalScale: number;
  elevationCurve: ElevationCurve;
  renderer: RendererChoice;
  terrainDetail: Detail;
  palette: Palette;
  viewMode: ViewMode;
  showContours: boolean;
  showStreams: boolean;
  showLabels: boolean;
  animateFlow: boolean;
}

export const defaultViewParams: ViewParams = {
  frictionMetric: 'medianWait',
  activities: [],
  objectTypes: [],
  timeStart: '',
  timeEnd: '',
  edgeCoverage: 92,
  maxActivities: 16,
  verticalScale: 1,
  elevationCurve: 'compressed',
  renderer: 'auto',
  terrainDetail: 'medium',
  palette: 'auto',
  viewMode: '3d',
  showContours: true,
  showStreams: true,
  showLabels: true,
  animateFlow: true,
};

/** Grid resolution per detail level. Square; the terrain plane is square. */
export const GRID_OF: Record<Detail, number> = { low: 96, medium: 160, high: 240 };

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(ms)}ms`;
  if (abs < 60_000) return `${(ms / 1000).toFixed(abs < 10_000 ? 1 : 0)}s`;
  if (abs < 3_600_000) return `${(ms / 60_000).toFixed(abs < 600_000 ? 1 : 0)}min`;
  if (abs < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (abs < 86_400_000 * 60) return `${(ms / 86_400_000).toFixed(1)}d`;
  return `${(ms / (86_400_000 * 30.44)).toFixed(1)}mo`;
}

/** Compact integer, e.g. 12.4k. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatPercent(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Formats a friction value in the unit its metric actually has. */
export function formatFriction(value: number, metric: FrictionMetric): string {
  return isDuration(metric) ? formatDuration(value) : formatPercent(value, 0);
}

/** Exponent of the `compressed` elevation curve. */
const COMPRESSION = 0.65;

/**
 * Maps a 0..1 friction ratio to a 0..1 altitude ratio.
 *
 * Strictly increasing for both curves, which is what lets the terrain's
 * ordering invariants (`field.check.ts`) hold regardless of which is chosen.
 */
export function elevationOf(ratio: number, curve: ElevationCurve): number {
  const t = Math.min(1, Math.max(0, ratio));
  return curve === 'linear' ? t : Math.pow(t, COMPRESSION);
}

/** Inverse of `elevationOf`, for reading a value off an altitude. */
export function frictionAt(altitude: number, curve: ElevationCurve): number {
  const t = Math.min(1, Math.max(0, altitude));
  return curve === 'linear' ? t : Math.pow(t, 1 / COMPRESSION);
}
