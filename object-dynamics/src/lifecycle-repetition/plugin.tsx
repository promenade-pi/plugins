import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { injectCss } from '../lib/styleInject';
// @ts-ignore
import baseCss from '../lib/base.css';
import { useHostTheme } from '../lib/theme';
import { queryTables, escapeLiteral, makeLatestOnly } from '../lib/sql';
import { ObjectTypeSelector } from '../lib/selectors';
import { ViewSummaryMetrics } from '../lib/SummaryMetrics';
import { EmptyState } from '../lib/EmptyState';
import { SemanticHelp } from '../lib/SemanticHelp';
import { ExportMenu } from '../lib/ExportMenu';
import { StackedBars, StackedBarsLegend, type StackedBarItem } from '../lib/charts/StackedBars';
import { useViewParams } from '../lib/useViewParams';

injectCss(baseCss);

/**
 * Object Dynamics · Lifecycle Repetition (spec §10).
 *
 * For every object of the selected type and every activity it ever
 * participates in, the number of times it participates in that activity
 * across its whole lifecycle — `COUNT(*)` grouped by `(object_id,
 * activity)`, then that count's own distribution grouped by `activity`.
 * Subsumes "activity execution count per object" and "object activity
 * execution frequency distribution" as the two axes of one chart, per the
 * spec's explicit instruction not to split this into redundant views.
 */

interface Row { activity: string; n: number; objects: number }

async function loadRepetition(objectType: string): Promise<Row[]> {
  const rows = await queryTables<{ activity: string; n: number; objects: number | bigint }>(`
    WITH per_object_activity AS (
      SELECT o.object_id, e.activity, COUNT(*) AS n
      FROM {object} o JOIN {e2o} r ON r.object_id = o.object_id JOIN {event} e ON e.event_id = r.event_id
      WHERE o.object_type = ${escapeLiteral(objectType)}
      GROUP BY 1, 2
    )
    SELECT activity, n, COUNT(*) AS objects FROM per_object_activity GROUP BY 1, 2 ORDER BY 1, 2
  `);
  return rows.map((r) => ({ activity: r.activity, n: Number(r.n), objects: Number(r.objects) }));
}

const BUCKETS = ['1x', '2x', '3x', '4x', '5+'];
function bucketOf(n: number): string { return n >= 5 ? '5+' : `${n}x`; }

const HELP = (
  <>
    For each object of the selected type, how many times it participates in each activity across its own lifecycle —
    grouped by <code>(object_id, activity)</code>, then bucketed by repetition count. This is a per-object rework/looping
    signal, distinct from Multiplicity (which counts objects per event, not events per object).
  </>
);

interface Params { objectType: string; displayMode: 'absolute' | 'percentage'; onlyRepeated: boolean }
const DEFAULTS: Params = { objectType: '', displayMode: 'percentage', onlyRepeated: false };

function App() {
  useHostTheme();
  const [params, setParams] = useViewParams<Params>(DEFAULTS);
  const [rows, setRows] = useState<Row[] | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const guard = useRef(makeLatestOnly()).current;

  useEffect(() => { promenade.ready(); }, []);
  useEffect(() => {
    if (!params.objectType) { setRows(null); return; }
    setRows(null);
    guard(loadRepetition(params.objectType), setRows);
  }, [params.objectType]);

  const perActivity = useMemo(() => {
    if (!rows) return null;
    const byActivity = new Map<string, { buckets: Map<string, number>; total: number; max: number; sumN: number; sumObjects: number; repeatedObjects: number }>();
    for (const r of rows) {
      if (!byActivity.has(r.activity)) byActivity.set(r.activity, { buckets: new Map(), total: 0, max: 0, sumN: 0, sumObjects: 0, repeatedObjects: 0 });
      const a = byActivity.get(r.activity)!;
      const b = bucketOf(r.n);
      a.buckets.set(b, (a.buckets.get(b) ?? 0) + r.objects);
      a.total += r.objects;
      a.max = Math.max(a.max, r.n);
      a.sumN += r.n * r.objects;
      a.sumObjects += r.objects;
      if (r.n > 1) a.repeatedObjects += r.objects;
    }
    return byActivity;
  }, [rows]);

  const activities = perActivity ? [...perActivity.keys()].sort() : [];
  const withRepetition = activities.filter((a) => perActivity!.get(a)!.max > 1);
  const shownActivities = params.onlyRepeated ? withRepetition : activities;

  const overall = useMemo(() => {
    if (!rows) return null;
    const totalObjects = rows.reduce((s, r) => s + r.objects, 0);
    const totalOccurrences = rows.reduce((s, r) => s + r.n * r.objects, 0);
    const maxRep = Math.max(0, ...rows.map((r) => r.n));
    const repeated = rows.filter((r) => r.n > 1).reduce((s, r) => s + r.objects, 0);
    return {
      avgReps: totalObjects ? totalOccurrences / totalObjects : 0,
      maxReps: maxRep,
      pctRepeated: totalObjects ? Math.round((repeated / totalObjects) * 100) : 0,
    };
  }, [rows]);

  const chartItems: StackedBarItem[] = shownActivities.map((a) => {
    const info = perActivity!.get(a)!;
    return {
      label: a, total: info.total,
      segments: BUCKETS.filter((b) => info.buckets.has(b)).map((b) => ({ key: b, value: info.buckets.get(b)! })),
    };
  });

  return (
    <>
      <div className="od-toolbar">
        <span className="od-field">Object type <ObjectTypeSelector value={params.objectType} onChange={(v) => setParams({ objectType: v })} /></span>
        <div className="od-btn-group">
          <button type="button" className={`od-btn${params.displayMode === 'absolute' ? ' active' : ''}`} onClick={() => setParams({ displayMode: 'absolute' })}>Absolute</button>
          <button type="button" className={`od-btn${params.displayMode === 'percentage' ? ' active' : ''}`} onClick={() => setParams({ displayMode: 'percentage' })}>Percentage</button>
        </div>
        <label><input type="checkbox" checked={params.onlyRepeated} onChange={(e) => setParams({ onlyRepeated: e.target.checked })} /> Only repeated activities</label>
        <div className="od-toolbar-spacer" />
        <ExportMenu
          filename={`lifecycle-repetition-${params.objectType || 'none'}`}
          getElement={() => bodyRef.current}
          csvRows={rows ?? []}
        />
        <SemanticHelp>{HELP}</SemanticHelp>
      </div>
      <div className="od-body" ref={bodyRef}>
        {!params.objectType ? <EmptyState title="Select an object type" detail="Pick an object type to see how often its objects repeat each activity." />
          : !rows ? <div className="od-loading">Computing lifecycle repetition…</div>
          : rows.length === 0 ? <EmptyState title="No data" detail={`No "${params.objectType}" object participates in any event.`} />
          : (
            <>
              <ViewSummaryMetrics metrics={[
                { label: 'Average repetitions', value: overall!.avgReps.toFixed(2) },
                { label: 'Maximum repetitions', value: String(overall!.maxReps) },
                { label: 'Objects with repetition > 1', value: `${overall!.pctRepeated}%` },
              ]} />
              {shownActivities.length === 0 ? (
                <EmptyState title="No repeated activities" detail="Every activity happens at most once per object for this type." />
              ) : (
                <div className="od-card">
                  <div className="od-card-title">Repetitions by activity</div>
                  <StackedBars items={chartItems} orientation="vertical" percentage={params.displayMode === 'percentage'} height={240}
                               segmentColor={(k) => ['#2563eb', '#0ea5a3', '#b45309', '#7c3aed', '#dc2626'][BUCKETS.indexOf(k)]} />
                  <StackedBarsLegend keys={BUCKETS} segmentColor={(k) => ['#2563eb', '#0ea5a3', '#b45309', '#7c3aed', '#dc2626'][BUCKETS.indexOf(k)]} />
                </div>
              )}
            </>
          )}
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
