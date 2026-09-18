import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { injectCss } from '../lib/styleInject';
// @ts-ignore
import baseCss from '../lib/base.css';
import { useHostTheme } from '../lib/theme';
import { queryTables, escapeLiteral, makeLatestOnly } from '../lib/sql';
import { ActivitySelector, ObjectTypeSelector, EnumSelect, DurationUnitSelector, type DurationUnit } from '../lib/selectors';
import { ViewSummaryMetrics } from '../lib/SummaryMetrics';
import { EmptyState } from '../lib/EmptyState';
import { SemanticHelp } from '../lib/SemanticHelp';
import { ExportMenu } from '../lib/ExportMenu';
import { Histogram } from '../lib/charts/Histogram';
import { useViewParams } from '../lib/useViewParams';

injectCss(baseCss);

/**
 * Object Dynamics · Activity Timing (spec §11).
 *
 * Elapsed time from activity A to a matching activity B on the *same*
 * object of the selected type. Pairing is genuinely ambiguous in the
 * abstract ("next"/"first"/"closest" B after A collapse to the same thing
 * on a single object's own timeline) — this view resolves it to three
 * pairing strategies with distinct, testable semantics:
 *
 * - `nextAfter` (default): a 1:1 greedy chronological match — walking each
 *   object's own A/B timeline in order, every A is queued and every B
 *   consumes the *earliest still-unconsumed* queued A (FIFO). Each event is
 *   used in at most one pair. This is the "directly-follows-style" reading:
 *   an A that already got its B doesn't get a second one from a later B.
 * - `firstAfter`: every A independently pairs with the nearest B after it,
 *   with reuse allowed — the same B can be "the next B" for several A's.
 *   Answers "how long until the next B", without consumption bookkeeping.
 * - `allPairs`: every (A, B) pair on the same object with B after A — the
 *   full cross product, for exploring the whole relationship rather than
 *   one canonical pairing.
 *
 * Query shape: this only ever fetches the A/B-activity events of objects of
 * the *selected type* (never the whole log), then matches them per object in
 * JS — a bounded, already-filtered slice, the same discipline `ocelot`'s own
 * client-side union-find over O2O edges uses.
 */

interface TimedEvent { objectId: string; eventId: string; activity: 'A' | 'B'; ts: number }

/** Activities actually observed on objects of this type — scopes A's
 * options so picking an activity that never touches this type isn't even
 * offered. */
async function loadActivitiesForType(objectType: string): Promise<string[]> {
  const rows = await queryTables<{ activity: string }>(`
    SELECT DISTINCT e.activity
    FROM {e2o} r JOIN {event} e ON e.event_id = r.event_id JOIN {object} o ON o.object_id = r.object_id
    WHERE o.object_type = ${escapeLiteral(objectType)}
    ORDER BY 1
  `);
  return rows.map((r) => r.activity);
}

/** Activities that occur strictly after at least one occurrence of
 * `activityA` on the same object of this type — scopes B's options to what
 * can actually produce a pair, independent of pairing strategy (strategy
 * only decides *how* qualifying A/B occurrences are matched, not whether a
 * B ever follows this A at all). */
async function loadFollowingActivities(objectType: string, activityA: string): Promise<string[]> {
  const rows = await queryTables<{ activity: string }>(`
    SELECT DISTINCT e2.activity
    FROM {object} o
      JOIN {e2o} r1 ON r1.object_id = o.object_id
      JOIN {event} e1 ON e1.event_id = r1.event_id AND e1.activity = ${escapeLiteral(activityA)}
      JOIN {e2o} r2 ON r2.object_id = o.object_id
      JOIN {event} e2 ON e2.event_id = r2.event_id
    WHERE o.object_type = ${escapeLiteral(objectType)} AND e2.ts > e1.ts
    ORDER BY 1
  `);
  return rows.map((r) => r.activity);
}

async function loadEvents(activityA: string, activityB: string, objectType: string): Promise<TimedEvent[]> {
  const rows = await queryTables<{ object_id: string; event_id: string; activity: string; ts: number }>(`
    SELECT o.object_id, e.event_id, e.activity, e.ts
    FROM {object} o JOIN {e2o} r ON r.object_id = o.object_id JOIN {event} e ON e.event_id = r.event_id
    WHERE o.object_type = ${escapeLiteral(objectType)} AND e.activity IN (${escapeLiteral(activityA)}, ${escapeLiteral(activityB)})
    ORDER BY o.object_id, e.ts
  `);
  return rows.map((r) => ({ objectId: r.object_id, eventId: r.event_id, activity: r.activity === activityA ? 'A' : 'B', ts: Number(r.ts) }));
}

interface Pair { objectId: string; aEventId: string; bEventId: string; elapsedUs: number }

function matchPairs(events: TimedEvent[], strategy: 'nextAfter' | 'firstAfter' | 'allPairs'): { pairs: Pair[]; unmatchedA: number } {
  const byObject = new Map<string, TimedEvent[]>();
  for (const e of events) {
    if (!byObject.has(e.objectId)) byObject.set(e.objectId, []);
    byObject.get(e.objectId)!.push(e);
  }
  const pairs: Pair[] = [];
  let unmatchedA = 0;

  for (const timeline of byObject.values()) {
    if (strategy === 'allPairs') {
      const as = timeline.filter((e) => e.activity === 'A');
      const bs = timeline.filter((e) => e.activity === 'B');
      let anyB = false;
      for (const a of as) {
        for (const b of bs) {
          if (b.ts > a.ts) { pairs.push({ objectId: a.objectId, aEventId: a.eventId, bEventId: b.eventId, elapsedUs: b.ts - a.ts }); anyB = true; }
        }
        if (!bs.some((b) => b.ts > a.ts)) unmatchedA++;
      }
      continue;
    }
    if (strategy === 'firstAfter') {
      const bs = timeline.filter((e) => e.activity === 'B');
      for (const a of timeline) {
        if (a.activity !== 'A') continue;
        const next = bs.find((b) => b.ts > a.ts);
        if (next) pairs.push({ objectId: a.objectId, aEventId: a.eventId, bEventId: next.eventId, elapsedUs: next.ts - a.ts });
        else unmatchedA++;
      }
      continue;
    }
    // nextAfter: FIFO queue of pending A's, each B consumes the earliest one.
    const pending: TimedEvent[] = [];
    for (const e of timeline) {
      if (e.activity === 'A') pending.push(e);
      else if (pending.length > 0) {
        const a = pending.shift()!;
        pairs.push({ objectId: e.objectId, aEventId: a.eventId, bEventId: e.eventId, elapsedUs: e.ts - a.ts });
      }
    }
    unmatchedA += pending.length;
  }
  return { pairs, unmatchedA };
}

function pickAutoUnit(medianUs: number): Exclude<DurationUnit, 'auto'> {
  const s = medianUs / 1e6;
  if (s < 120) return 'seconds';
  if (s < 7200) return 'minutes';
  if (s < 172800) return 'hours';
  return 'days';
}
const UNIT_DIVISOR: Record<Exclude<DurationUnit, 'auto'>, number> = { seconds: 1e6, minutes: 6e7, hours: 3.6e9, days: 8.64e10 };
const UNIT_LABEL: Record<Exclude<DurationUnit, 'auto'>, string> = { seconds: 's', minutes: 'min', hours: 'h', days: 'd' };

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const HELP = (
  <>
    Elapsed time from activity <strong>A</strong> to a matching activity <strong>B</strong> on the same object of the
    selected type. Pick the object type first — A then only lists activities actually observed on that type, and B
    only lists activities that actually occur after some chosen A on it, so a combination that can never produce a
    pair isn't offered in the first place. Pairing strategy decides what "matching" means once both are valid:
    <em> Next after</em> (default) is a 1:1 chronological match, one B per A; <em>First after</em> lets one B satisfy
    several A's; <em>All pairs</em> is the full A→B cross product per object.
  </>
);

interface Params { activityA: string; activityB: string; objectType: string; pairing: 'nextAfter' | 'firstAfter' | 'allPairs'; durationUnit: DurationUnit }
const DEFAULTS: Params = { activityA: '', activityB: '', objectType: '', pairing: 'nextAfter', durationUnit: 'auto' };

function App() {
  useHostTheme();
  const [params, setParams] = useViewParams<Params>(DEFAULTS);
  const [events, setEvents] = useState<TimedEvent[] | null>(null);
  const [activitiesForType, setActivitiesForType] = useState<string[] | null>(null);
  const [followingActivities, setFollowingActivities] = useState<string[] | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const guard = useRef(makeLatestOnly()).current;
  const optionsGuard = useRef(makeLatestOnly()).current;
  const ready = params.activityA && params.activityB && params.objectType;

  useEffect(() => { promenade.ready(); }, []);

  // Object type is the first choice: it scopes A's options to activities
  // actually observed on that type. Changing it invalidates any A/B chosen
  // for a different type, so both are cleared rather than left stale.
  useEffect(() => {
    if (!params.objectType) { setActivitiesForType(null); return; }
    setActivitiesForType(null);
    optionsGuard(loadActivitiesForType(params.objectType), setActivitiesForType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.objectType]);

  // B's options are scoped to what actually follows the chosen A on this
  // object type — independent of pairing strategy, which only decides how
  // qualifying occurrences are matched once both are valid.
  useEffect(() => {
    if (!params.objectType || !params.activityA) { setFollowingActivities(null); return; }
    setFollowingActivities(null);
    optionsGuard(loadFollowingActivities(params.objectType, params.activityA), setFollowingActivities);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.objectType, params.activityA]);

  useEffect(() => {
    if (!ready) { setEvents(null); return; }
    setEvents(null);
    guard(loadEvents(params.activityA, params.activityB, params.objectType), setEvents);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.activityA, params.activityB, params.objectType]);

  const onChangeObjectType = (v: string) => setParams({ objectType: v, activityA: '', activityB: '' });
  const onChangeActivityA = (v: string) => setParams({ activityA: v, activityB: '' });

  const result = useMemo(() => {
    if (!events) return null;
    return matchPairs(events, params.pairing);
  }, [events, params.pairing]);

  const stats = useMemo(() => {
    if (!result || result.pairs.length === 0) return null;
    const sorted = [...result.pairs.map((p) => p.elapsedUs)].sort((a, b) => a - b);
    return {
      matched: sorted.length, unmatchedA: result.unmatchedA,
      min: sorted[0], max: sorted[sorted.length - 1],
      median: quantile(sorted, 0.5), mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
      p10: quantile(sorted, 0.1), p90: quantile(sorted, 0.9),
      sorted,
    };
  }, [result]);

  const unit = params.durationUnit === 'auto' ? (stats ? pickAutoUnit(stats.median) : 'seconds') : params.durationUnit;
  const div = UNIT_DIVISOR[unit];
  const fmt = (us: number) => `${(us / div).toFixed(us / div < 10 ? 2 : 0)} ${UNIT_LABEL[unit]}`;

  const bins = useMemo(() => {
    if (!stats) return [];
    const BIN_COUNT = 20;
    const min = stats.sorted[0], max = stats.sorted[stats.sorted.length - 1];
    const width = Math.max(1e-9, (max - min) / BIN_COUNT);
    const counts = new Array(BIN_COUNT).fill(0);
    for (const v of stats.sorted) counts[Math.min(BIN_COUNT - 1, Math.floor((v - min) / width))]++;
    return counts.map((c, i) => ({ label: fmt(min + i * width), count: c }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats, unit]);

  return (
    <>
      <div className="od-toolbar">
        <span className="od-field">Object type <ObjectTypeSelector value={params.objectType} onChange={onChangeObjectType} /></span>
        <span className="od-field">A
          <ActivitySelector
            value={params.activityA} onChange={onChangeActivityA}
            names={activitiesForType ?? []}
            disabled={!params.objectType || activitiesForType === null}
            placeholder={!params.objectType ? 'Select object type first' : activitiesForType === null ? 'Loading…' : 'Select activity…'}
          />
        </span>
        <span className="od-field">B
          <ActivitySelector
            value={params.activityB} onChange={(v) => setParams({ activityB: v })}
            names={followingActivities ?? []}
            disabled={!params.activityA || followingActivities === null}
            placeholder={!params.activityA ? 'Select A first' : followingActivities === null ? 'Loading…' : 'Select activity…'}
          />
        </span>
        <span className="od-field">Pairing
          <EnumSelect value={params.pairing} onChange={(v) => setParams({ pairing: v as Params['pairing'] })} options={[
            { value: 'nextAfter', label: 'Next after (1:1)' },
            { value: 'firstAfter', label: 'First after (reuse allowed)' },
            { value: 'allPairs', label: 'All pairs' },
          ]} />
        </span>
        <span className="od-field">Unit <DurationUnitSelector value={params.durationUnit} onChange={(v) => setParams({ durationUnit: v })} /></span>
        <div className="od-toolbar-spacer" />
        <ExportMenu
          filename={`activity-timing-${params.activityA || 'A'}-${params.activityB || 'B'}`}
          getElement={() => bodyRef.current}
          csvRows={(result?.pairs ?? []).map((p) => ({ objectId: p.objectId, aEventId: p.aEventId, bEventId: p.bEventId, elapsedSeconds: p.elapsedUs / 1e6 }))}
        />
        <SemanticHelp>{HELP}</SemanticHelp>
      </div>
      <div className="od-body" ref={bodyRef}>
        {!ready ? <EmptyState title="Select an object type, then A and B" detail="Object type first — A and B then only offer activities that can actually produce a pair." />
          : !result ? <div className="od-loading">Matching A→B pairs…</div>
          : result.pairs.length === 0 ? <EmptyState title="No matching pairs" detail={`No "${params.objectType}" object has a "${params.activityB}" after a "${params.activityA}".`} />
          : (
            <>
              <ViewSummaryMetrics metrics={[
                { label: 'Matched pairs', value: stats!.matched.toLocaleString() },
                { label: 'Unmatched A', value: stats!.unmatchedA.toLocaleString() },
                { label: 'Min', value: fmt(stats!.min) },
                { label: 'p10', value: fmt(stats!.p10) },
                { label: 'Median', value: fmt(stats!.median) },
                { label: 'Mean', value: fmt(stats!.mean) },
                { label: 'p90', value: fmt(stats!.p90) },
                { label: 'Max', value: fmt(stats!.max) },
              ]} />
              <div className="od-card">
                <div className="od-card-title">Elapsed time from {params.activityA} to {params.activityB}</div>
                <Histogram bins={bins} height={220} showCumulative />
              </div>
            </>
          )}
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
