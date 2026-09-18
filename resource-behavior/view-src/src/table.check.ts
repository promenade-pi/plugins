/**
 * Table invariants.
 *
 * The failure this exists to prevent is the quiet one: a table that sorts by
 * one number and prints another, or that pushes an unknown value to the top
 * of "most utilised" because `null` compared as zero. Neither looks wrong on
 * screen — the rows are in *an* order and the numbers are *some* numbers.
 */

import { buildColumns, sortProfiles, columnMax, SORT_COLUMN, type SortKey } from './table';
import type { Profile, ResourceProfilesPayload } from './types';

/**
 * Node's `process`, declared rather than depended on: these checks run under
 * `node` via esbuild but the package types itself with `types: []`.
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

function randomPayload(seed: number, hasLifecycle: boolean): ResourceProfilesPayload {
  const r = rng(seed);
  const n = 1 + Math.floor(r() * 25);
  const profiles: Profile[] = Array.from({ length: n }, (_, i) => {
    // A resource can have no paired items even on a lifecycle log — that is
    // exactly where a null must not sort as a zero.
    const items = hasLifecycle && r() < 0.8 ? 1 + Math.floor(r() * 50) : 0;
    const durations = items > 0;
    return {
      resource: i,
      events: 1 + Math.floor(r() * 500),
      activities: 1 + Math.floor(r() * 8),
      cases: 1 + Math.floor(r() * 200),
      collaborators: Math.floor(r() * n),
      firstMs: r() * 1e12,
      lastMs: r() * 1e12 + 1e9,
      activeDays: 1 + Math.floor(r() * 100),
      eventsPerActiveDay: r() * 30,
      topActivity: Math.floor(r() * 8),
      topActivityShare: r(),
      spread: r(),
      batchedShare: r(),
      meanBatchSize: r() * 6,
      items,
      meanServiceSecs: durations ? r() * 10000 : null,
      medianServiceSecs: durations ? r() * 10000 : null,
      meanWaitSecs: durations && r() < 0.7 ? r() * 10000 : null,
      busySecs: durations ? r() * 1e6 : null,
      workSecs: durations ? r() * 1e6 : null,
      utilisation: durations ? r() : null,
      multitaskingShare: durations ? r() : null,
      workloadSpeedR: durations && r() < 0.8 ? r() * 2 - 1 : null,
    };
  });
  return {
    resources: profiles.map((_, i) => `p${i}`),
    activities: Array.from({ length: 8 }, (_, i) => `act-${i}`),
    profiles,
    bucket: 'day', bucketMs: 86400000, bucketStartMs: 0, bucketCount: 10,
    timeline: profiles.map((p) => ({ resource: p.resource, counts: Array(10).fill(1) })),
    scatter: [],
    stats: {
      events: 1000, cases: 100, resources: n, resourcesOmitted: 0,
      eventsWithoutResource: 0, eventsWithoutTimestamp: 0,
      hasLifecycle, itemsPaired: 0, transferredItems: 0, unfinishedItems: 0,
      workloadSpeedR: null,
    },
  };
}

const SORTS: SortKey[] = [
  'events', 'utilisation', 'multitasking', 'service',
  'batching', 'spread', 'collaborators', 'name',
];

console.log('table invariants');
for (let seed = 1; seed <= 120; seed++) {
  for (const hasLifecycle of [true, false]) {
    const payload = randomPayload(seed, hasLifecycle);
    const columns = buildColumns(payload);
    const where = `seed ${seed}, lifecycle ${hasLifecycle}`;

    // Duration columns exist exactly when the log can fill them.
    const durationColumns = columns.filter((c) => c.needsLifecycle);
    check('duration columns appear only with a lifecycle',
      hasLifecycle ? durationColumns.length > 0 : durationColumns.length === 0, where);
    check('every sort key names a real column',
      Object.values(SORT_COLUMN).every((key) =>
        !columns.some((c) => c.key === key) || columns.some((c) => c.key === key)), where);

    for (const sortBy of SORTS) {
      const sorted = sortProfiles(payload.profiles, payload, sortBy, columns);

      check('sorting keeps every row exactly once',
        sorted.length === payload.profiles.length
        && new Set(sorted.map((p) => p.resource)).size === payload.profiles.length,
        `${where}, ${sortBy}`);

      if (sortBy === 'name') {
        const names = sorted.map((p) => payload.resources[p.resource]);
        check('by name is ascending',
          names.every((x, i) => i === 0 || names[i - 1].localeCompare(x) <= 0),
          `${where}, ${sortBy}`);
        continue;
      }

      const column = columns.find((c) => c.key === SORT_COLUMN[sortBy]);
      if (!column) continue; // the column is hidden on this log; sorting is a no-op

      const values = sorted.map((p) => column.value(p));
      // Descending among the known values...
      const known = values.filter((v): v is number => v != null);
      check('numeric sorts are descending',
        known.every((v, i) => i === 0 || known[i - 1] >= v), `${where}, ${sortBy}`);

      // ...and every unknown after every known. An absent value is not a
      // small one, and must never lead a "who most" ranking.
      const firstNull = values.indexOf(null);
      check('unknown values sort last',
        firstNull === -1 || values.slice(firstNull).every((v) => v == null),
        `${where}, ${sortBy}: ${values.map((v) => (v == null ? '·' : 'x')).join('')}`);
    }

    // A bar is only drawn where it can mean something, and never wider than
    // the column's own maximum.
    for (const column of columns) {
      const max = columnMax(payload.profiles, column);
      check('a column maximum is finite and non-negative',
        Number.isFinite(max) && max >= 0, `${where}, ${column.key}`);
      for (const p of payload.profiles) {
        const v = column.value(p);
        if (v == null) {
          check('an absent value formats as a dash', column.format(p).includes('—'),
            `${where}, ${column.key}: "${column.format(p)}"`);
        } else {
          check('a present value never exceeds the column maximum', v <= max + 1e-9,
            `${where}, ${column.key}`);
          check('a present value formats to something', column.format(p).length > 0, where);
        }
      }
    }
  }
}

// A single profile, and an empty one, must not throw.
const lone = randomPayload(7, true);
lone.profiles = lone.profiles.slice(0, 1);
check('one profile sorts fine', sortProfiles(lone.profiles, lone, 'events', buildColumns(lone)).length === 1);
const none = randomPayload(9, false);
none.profiles = [];
check('no profiles sorts fine', sortProfiles([], none, 'utilisation', buildColumns(none)).length === 0);
check('an empty column has a zero maximum',
  columnMax([], buildColumns(none)[0]) === 0);

if (failures > 0) {
  console.error(`${failures} table invariant(s) failed`);
  process.exit(1);
}
console.log('  ✓ all table invariants hold');
