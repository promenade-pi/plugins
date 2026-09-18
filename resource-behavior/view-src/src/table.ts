import type { Profile, ResourceProfilesPayload } from './types';

/**
 * The columns of the profile table, and how each one is read.
 *
 * Declared as data rather than written out as JSX because three separate
 * things have to agree about every column — its header, its sort, and the bar
 * drawn behind its value — and keeping them in three places is how a table
 * ends up sorting by one number and showing another.
 *
 * `bar: true` means the cell is drawn with a proportional bar behind it, which
 * only makes sense for a value with a meaningful zero and a meaningful
 * maximum. A correlation has neither (it is signed and already bounded), so it
 * is printed plainly.
 */
export interface Column {
  key: string;
  label: string;
  title: string;
  /** `null` sorts last regardless of direction — an absent value is not a small one. */
  value: (p: Profile) => number | null;
  format: (p: Profile) => string;
  bar: boolean;
  /** Needs paired start/complete events. */
  needsLifecycle: boolean;
}

export type SortKey =
  | 'events' | 'utilisation' | 'multitasking' | 'service'
  | 'batching' | 'spread' | 'collaborators' | 'name';

/** Which column a sort key refers to. `name` sorts by the resource, not a column. */
export const SORT_COLUMN: Record<Exclude<SortKey, 'name'>, string> = {
  events: 'events',
  utilisation: 'utilisation',
  multitasking: 'multitasking',
  service: 'service',
  batching: 'batching',
  spread: 'spread',
  collaborators: 'collaborators',
};

/**
 * Sorts profiles for display.
 *
 * Descending on every numeric column, because the question a reader brings to
 * this table is always "who most" — and ascending by name when that is what
 * was asked for. A profile with no value for the chosen column sorts to the
 * bottom rather than to either extreme: a person whose utilisation is unknown
 * is not the least utilised person.
 */
export function sortProfiles(
  profiles: Profile[], payload: ResourceProfilesPayload, sortBy: SortKey, columns: Column[],
): Profile[] {
  const out = [...profiles];
  if (sortBy === 'name') {
    return out.sort((a, b) =>
      payload.resources[a.resource].localeCompare(payload.resources[b.resource]));
  }
  const column = columns.find((c) => c.key === SORT_COLUMN[sortBy]);
  if (!column) return out;
  return out.sort((a, b) => {
    const [x, y] = [column.value(a), column.value(b)];
    if (x == null && y == null) {
      return payload.resources[a.resource].localeCompare(payload.resources[b.resource]);
    }
    if (x == null) return 1;
    if (y == null) return -1;
    return y - x || payload.resources[a.resource].localeCompare(payload.resources[b.resource]);
  });
}

/** The largest value in a column, for scaling its bars. Nulls are ignored. */
export function columnMax(profiles: Profile[], column: Column): number {
  let max = 0;
  for (const p of profiles) {
    const v = column.value(p);
    if (v != null && v > max) max = v;
  }
  return max;
}

export function buildColumns(payload: ResourceProfilesPayload): Column[] {
  const activityName = (p: Profile) =>
    p.topActivity == null ? '—' : (payload.activities[p.topActivity] ?? `#${p.topActivity}`);

  const all: Column[] = [
    {
      key: 'events', label: 'Events', bar: true, needsLifecycle: false,
      title: 'Events this person performed.',
      value: (p) => p.events, format: (p) => fmt(p.events),
    },
    {
      key: 'cases', label: 'Cases', bar: true, needsLifecycle: false,
      title: 'Distinct cases they touched.',
      value: (p) => p.cases, format: (p) => fmt(p.cases),
    },
    {
      key: 'perDay', label: 'Per day', bar: true, needsLifecycle: false,
      title: 'Events per day on which they did anything at all — a rate that '
        + 'ignores the days they were not working.',
      value: (p) => p.eventsPerActiveDay, format: (p) => p.eventsPerActiveDay.toFixed(1),
    },
    {
      key: 'spread', label: 'Spread', bar: true, needsLifecycle: false,
      title: 'How evenly their work is spread across the activities they do: '
        + '0% is a specialist who only ever does one thing, 100% a generalist '
        + 'spread evenly over everything they touch.',
      value: (p) => p.spread, format: (p) => `${(p.spread * 100).toFixed(0)}%`,
    },
    {
      key: 'top', label: 'Mostly', bar: false, needsLifecycle: false,
      title: 'The activity they perform most, and its share of their work.',
      value: (p) => p.topActivityShare,
      format: (p) => `${activityName(p)} ${(p.topActivityShare * 100).toFixed(0)}%`,
    },
    {
      key: 'collaborators', label: 'With', bar: true, needsLifecycle: false,
      title: 'Distinct other people who worked on a case this person also worked on.',
      value: (p) => p.collaborators, format: (p) => fmt(p.collaborators),
    },
    {
      key: 'batching', label: 'Batched', bar: true, needsLifecycle: false,
      title: 'Share of their events sitting in a run of the same activity done '
        + 'back to back within the batch window.',
      value: (p) => p.batchedShare, format: (p) => `${(p.batchedShare * 100).toFixed(0)}%`,
    },
    {
      key: 'service', label: 'Service', bar: true, needsLifecycle: true,
      title: 'Mean time from starting a work item to finishing it.',
      value: (p) => p.meanServiceSecs, format: (p) => dur(p.meanServiceSecs),
    },
    {
      key: 'wait', label: 'Waited', bar: true, needsLifecycle: true,
      title: 'Mean time an item sat between being queued and being started.',
      value: (p) => p.meanWaitSecs, format: (p) => dur(p.meanWaitSecs),
    },
    {
      key: 'utilisation', label: 'Utilised', bar: true, needsLifecycle: true,
      title: 'Time spent working over the span between their first and last '
        + 'event — overlapping items counted once.',
      value: (p) => p.utilisation, format: (p) => pct(p.utilisation),
    },
    {
      key: 'multitasking', label: 'Juggling', bar: true, needsLifecycle: true,
      title: 'Share of their busy time with more than one item in progress.',
      value: (p) => p.multitaskingShare, format: (p) => pct(p.multitaskingShare),
    },
    {
      key: 'load', label: 'Load ⇢ time', bar: false, needsLifecycle: true,
      title: 'Correlation between how many items they had in progress when each '
        + 'one started and how long it then took. Positive means they slow down '
        + 'when busy.',
      value: (p) => p.workloadSpeedR,
      format: (p) => (p.workloadSpeedR == null ? '—' : p.workloadSpeedR.toFixed(2)),
    },
  ];

  // A log with no lifecycle has nothing to put in the duration columns, and a
  // column of dashes is worse than no column: it invites the reader to wonder
  // which rows are missing rather than telling them the log is.
  return payload.stats.hasLifecycle ? all : all.filter((c) => !c.needsLifecycle);
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
function dur(secs: number | null): string {
  if (secs == null) return '—';
  if (secs < 90) return `${secs.toFixed(0)}s`;
  if (secs < 5400) return `${(secs / 60).toFixed(1)}m`;
  if (secs < 172800) return `${(secs / 3600).toFixed(1)}h`;
  return `${(secs / 86400).toFixed(1)}d`;
}
function pct(x: number | null): string {
  return x == null ? '—' : `${(x * 100).toFixed(0)}%`;
}
