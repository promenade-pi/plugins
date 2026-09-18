/**
 * The `OCStationMap` payload, as the Rust kernel writes it, and the view's own
 * parameters.
 *
 * The one structural thing worth knowing: every coordinate here is a *plan*
 * coordinate (`x`, `z`) and every depth is a *duration* (`t`, in seconds).
 * Nothing in the payload knows how many world units a second is worth, because
 * that is a view-time choice — linear or logarithmic, times a relief slider.
 * `depth.ts` is the only place that decides.
 */

export interface Pt {
  x: number;
  z: number;
}

export interface Platform {
  id: string;
  activity: string;
  x: number;
  z: number;
  /** Accumulated elapsed time from the start of the process, in seconds. */
  t: number;
  radius: number;
  rank: number;
  lane: number;
  objectTypes: string[];
  counts: number[];
  count: number;
  isStart: boolean;
  isEnd: boolean;
}

export interface Line {
  id: string;
  link: string;
  objectType: string;
  source: string;
  target: string;
  freq: number;
  waitSecs: number | null;
  backward: boolean;
  selfLoop: boolean;
  /** This hand-off is the one that sets the target's depth. */
  critical: boolean;
  points: Pt[];
  /** Index into `points` of the vertex the vertical move happens at. */
  dropAt: number;
}

export interface Shaft {
  id: string;
  link: string;
  x: number;
  z: number;
  radius: number;
  source: string;
  target: string;
  tTop: number;
  tBottom: number;
  waitSecs: number | null;
  critical: boolean;
  backward: boolean;
  objectTypes: string[];
  freq: number;
}

export interface ObjectTypeInfo {
  name: string;
  count: number;
  route: string[];
}

export interface Stats {
  activities: number;
  lines: number;
  shafts: number;
  objectTypes: number;
  maxTimeSecs: number;
  hasTiming: boolean;
  droppedActivities: number;
  droppedEdges: number;
  coverage: number;
  basis: string;
}

export interface StationMap {
  objectTypes: ObjectTypeInfo[];
  platforms: Platform[];
  lines: Line[];
  shafts: Shaft[];
  /** Platform ids in an order every forward hand-off respects. */
  order: string[];
  extent: Pt;
  stats: Stats;
}

export interface ViewParams {
  timeScale: 'logarithmic' | 'linear';
  depthScale: number;
  viewMode: 'time-depth' | 'flat';
  lineWidth: 'frequency' | 'uniform';
  shafts: 'elevators' | 'ramps';
  palette: 'daylight' | 'night';
  showGrid: boolean;
  showLabels: boolean;
  animateFlow: boolean;
  renderer: 'auto' | 'webgl2';
}

export const defaultViewParams: ViewParams = {
  timeScale: 'logarithmic',
  depthScale: 1,
  viewMode: 'time-depth',
  lineWidth: 'frequency',
  shafts: 'elevators',
  palette: 'daylight',
  showGrid: true,
  showLabels: true,
  animateFlow: true,
  renderer: 'auto',
};

/** A duration, in the units a station atlas would print beside a shaft. */
export function formatDuration(secs: number | null | undefined): string {
  if (secs == null || !Number.isFinite(secs)) return '—';
  if (secs < 1) return '<1 s';
  if (secs < 90) return `${Math.round(secs)} s`;
  const minutes = secs / 60;
  if (minutes < 90) return `${round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 36) return `${round(hours)} h`;
  const days = hours / 24;
  if (days < 21) return `${round(days)} d`;
  const weeks = days / 7;
  if (weeks < 12) return `${round(weeks)} wk`;
  return `${round(days / 30.44)} mo`;
}

function round(value: number): string {
  if (value >= 10) return String(Math.round(value));
  const one = Math.round(value * 10) / 10;
  return String(one);
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}
