/** The `ResourceProfiles` payload, as `src/lib.rs` serialises it. */

export interface Profile {
  resource: number;
  events: number;
  activities: number;
  cases: number;
  collaborators: number;
  firstMs: number;
  lastMs: number;
  activeDays: number;
  eventsPerActiveDay: number;
  topActivity: number | null;
  topActivityShare: number;
  /** Normalised entropy of the activity mix: 0 a specialist, 1 a generalist. */
  spread: number;
  batchedShare: number;
  meanBatchSize: number;
  /** Work items started and finished by this person. 0 without a lifecycle. */
  items: number;
  /** All `null` together on a log with no lifecycle — never partially present. */
  meanServiceSecs: number | null;
  medianServiceSecs: number | null;
  meanWaitSecs: number | null;
  busySecs: number | null;
  workSecs: number | null;
  utilisation: number | null;
  multitaskingShare: number | null;
  workloadSpeedR: number | null;
}

export interface TimelineRow { resource: number; counts: number[] }

export interface ResourceProfilesPayload {
  resources: string[];
  activities: string[];
  profiles: Profile[];
  bucket: string;
  bucketMs: number;
  bucketStartMs: number;
  bucketCount: number;
  timeline: TimelineRow[];
  /** `[items in progress at start, duration in seconds, resource]`. */
  scatter: Array<[number, number, number]>;
  stats: {
    events: number;
    cases: number;
    resources: number;
    resourcesOmitted: number;
    eventsWithoutResource: number;
    eventsWithoutTimestamp: number;
    hasLifecycle: boolean;
    itemsPaired: number;
    transferredItems: number;
    unfinishedItems: number;
    workloadSpeedR: number | null;
  };
}

/** A duration, at whatever unit stops it being unreadable. */
export function fmtSecs(secs: number | null): string {
  if (secs == null) return '—';
  if (secs < 90) return `${secs.toFixed(0)}s`;
  if (secs < 5400) return `${(secs / 60).toFixed(1)}m`;
  if (secs < 172800) return `${(secs / 3600).toFixed(1)}h`;
  return `${(secs / 86400).toFixed(1)}d`;
}

export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function fmtPercent(x: number | null): string {
  return x == null ? '—' : `${(x * 100).toFixed(0)}%`;
}
