import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { injectCss } from '../lib/styleInject';
// @ts-ignore -- esbuild's .css -> text loader, see build.js
import baseCss from '../lib/base.css';
import { useHostTheme } from '../lib/theme';
import { queryTables, escapeLiteral, makeLatestOnly } from '../lib/sql';
import { useObjectTypes, useActivities } from '../lib/selectors';
import { ViewSummaryMetrics } from '../lib/SummaryMetrics';
import { EmptyState } from '../lib/EmptyState';
import { SemanticHelp } from '../lib/SemanticHelp';
import { ExportMenu } from '../lib/ExportMenu';
import { Histogram } from '../lib/charts/Histogram';
import { useViewParams } from '../lib/useViewParams';

injectCss(baseCss);

/**
 * Object Dynamics · Multiplicity (spec §8).
 *
 * Core semantic unit: for every event and object type, the number of
 * *unique* participating objects of that type — `COUNT(DISTINCT object_id)`
 * over `event_object` joined to `object`, grouped by `(event_id,
 * object_type)`. This is deliberately not `COUNT(*)` over the join: a
 * duplicated relational row (the same object related twice, e.g. under two
 * qualifiers) must not inflate the multiplicity.
 */

interface MatrixCell {
  activity: string; objectType: string; events: number;
  min: number; max: number; median: number; mean: number; exactlyOne: number;
}

async function loadMatrix(): Promise<MatrixCell[]> {
  const rows = await queryTables<{
    activity: string; object_type: string; events: number | bigint;
    min_n: number; max_n: number; median_n: number; mean_n: number; exactly_one: number | bigint;
  }>(`
    WITH per_event AS (
      SELECT e.event_id, e.activity, o.object_type, COUNT(DISTINCT r.object_id) AS n
      FROM {e2o} r JOIN {event} e ON e.event_id = r.event_id JOIN {object} o ON o.object_id = r.object_id
      GROUP BY 1, 2, 3
    )
    SELECT activity, object_type, COUNT(*) AS events, MIN(n) AS min_n, MAX(n) AS max_n,
      MEDIAN(n) AS median_n, AVG(n) AS mean_n, SUM(CASE WHEN n = 1 THEN 1 ELSE 0 END) AS exactly_one
    FROM per_event GROUP BY 1, 2
  `);
  return rows.map((r) => ({
    activity: r.activity, objectType: r.object_type, events: Number(r.events),
    min: r.min_n, max: r.max_n, median: r.median_n, mean: r.mean_n, exactlyOne: Number(r.exactly_one),
  }));
}

interface DistributionBin { n: number; events: number }

async function loadDistribution(activity: string, objectType: string): Promise<DistributionBin[]> {
  return queryTables<DistributionBin>(`
    WITH per_event AS (
      SELECT e.event_id, COUNT(DISTINCT r.object_id) AS n
      FROM {e2o} r JOIN {event} e ON e.event_id = r.event_id JOIN {object} o ON o.object_id = r.object_id
      WHERE e.activity = ${escapeLiteral(activity)} AND o.object_type = ${escapeLiteral(objectType)}
      GROUP BY 1
    )
    SELECT n, COUNT(*) AS events FROM per_event GROUP BY 1 ORDER BY 1
  `).then((rows) => rows.map((r) => ({ n: Number(r.n), events: Number(r.events) })));
}

const HELP = (
  <>
    <strong>Multiplicity</strong> counts the number of <em>unique</em> objects of a given type participating in each event
    — <code>COUNT(DISTINCT object_id)</code>, not the raw number of event-to-object relations, so a duplicated relational
    row never inflates the count. The matrix shows the typical (median) and full (min–max) range per activity/object-type
    combination; click a cell to see the exact distribution.
  </>
);

interface Params { mode: 'matrix' | 'detail'; activity: string; objectType: string }
const DEFAULTS: Params = { mode: 'matrix', activity: '', objectType: '' };

function App() {
  useHostTheme();
  const activities = useActivities();
  const objectTypes = useObjectTypes();
  const [params, setParams] = useViewParams<Params>(DEFAULTS);
  const [matrix, setMatrix] = useState<MatrixCell[] | null>(null);
  const [dist, setDist] = useState<DistributionBin[] | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const guard = useRef(makeLatestOnly()).current;

  useEffect(() => { promenade.ready(); guard(loadMatrix(), setMatrix); }, []);
  useEffect(() => {
    if (params.mode === 'detail' && params.activity && params.objectType) {
      setDist(null);
      guard(loadDistribution(params.activity, params.objectType), setDist);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.mode, params.activity, params.objectType]);

  const openDetail = (activity: string, objectType: string) => setParams({ mode: 'detail', activity, objectType });

  return (
    <>
      <div className="od-toolbar">
        {params.mode === 'detail' ? (
          <>
            <button type="button" className="od-back-link" onClick={() => setParams({ mode: 'matrix' })}>← Matrix</button>
            <span className="od-muted">{params.activity} ×</span>
            <strong>{params.objectType}</strong>
          </>
        ) : (
          <span className="od-muted">Matrix: activities × object types</span>
        )}
        <div className="od-toolbar-spacer" />
        <ExportMenu
          filename={params.mode === 'detail' ? `multiplicity-${params.activity}-${params.objectType}` : 'multiplicity-matrix'}
          getElement={() => bodyRef.current}
          csvRows={params.mode === 'detail' ? (dist ?? []).map((d) => ({ objects: d.n, events: d.events })) : (matrix ?? []).map((m) => ({ activity: m.activity, objectType: m.objectType, events: m.events, min: m.min, median: m.median, max: m.max, mean: m.mean }))}
        />
        <SemanticHelp>{HELP}</SemanticHelp>
      </div>
      <div className="od-body" ref={bodyRef}>
        {params.mode === 'matrix'
          ? <MatrixView matrix={matrix} activities={activities.map((a) => a.name)} objectTypes={objectTypes.map((t) => t.name)} onOpen={openDetail} />
          : <DetailView activity={params.activity} objectType={params.objectType} bins={dist} />}
      </div>
    </>
  );
}

function fmtCell(c: MatrixCell): { text: string; variable: boolean } {
  if (c.min === c.max) return { text: String(c.min), variable: false };
  const med = Number.isInteger(c.median) ? c.median : c.median.toFixed(1);
  return { text: `${c.min}–${c.max} (med ${med})`, variable: true };
}

function MatrixView({ matrix, activities, objectTypes, onOpen }: {
  matrix: MatrixCell[] | null; activities: string[]; objectTypes: string[];
  onOpen: (activity: string, objectType: string) => void;
}) {
  if (!matrix) return <div className="od-loading">Computing multiplicity matrix…</div>;
  if (matrix.length === 0) return <EmptyState title="No event-to-object relations" detail="This log has no e2o relations to count multiplicity over." />;

  const rows = activities.length > 0 ? activities : [...new Set(matrix.map((m) => m.activity))].sort();
  const cols = objectTypes.length > 0 ? objectTypes : [...new Set(matrix.map((m) => m.objectType))].sort();
  const cell = (a: string, t: string) => matrix.find((m) => m.activity === a && m.objectType === t);

  return (
    <div className="od-matrix-wrap">
      <table className="od-matrix">
        <thead><tr><th>Activity ↓ / Object type →</th>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a}>
              <td>{a}</td>
              {cols.map((t) => {
                const c = cell(a, t);
                if (!c) return <td key={t} className="od-matrix-empty-cell">·</td>;
                const { text, variable } = fmtCell(c);
                return (
                  <td
                    key={t}
                    className={`has-data${variable ? ' is-variable' : ''}`}
                    title={`${c.events.toLocaleString()} events · mean ${c.mean.toFixed(2)} · ${Math.round((c.exactlyOne / c.events) * 100)}% exactly one`}
                    onClick={() => onOpen(a, t)}
                  >
                    {text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailView({ activity, objectType, bins }: { activity: string; objectType: string; bins: DistributionBin[] | null }) {
  if (!activity || !objectType) return <EmptyState title="Pick an activity and object type" detail="Click a cell in the matrix, or select both from the toolbar." />;
  if (!bins) return <div className="od-loading">Computing distribution…</div>;
  if (bins.length === 0) return <EmptyState title="No matching events" detail={`No events of "${activity}" relate to any "${objectType}" object.`} />;

  const total = bins.reduce((s, b) => s + b.events, 0);
  const bucketed: DistributionBin[] = [];
  for (const b of bins) {
    if (b.n >= 5) {
      const existing = bucketed.find((x) => x.n === 5);
      if (existing) existing.events += b.events; else bucketed.push({ n: 5, events: b.events });
    } else bucketed.push(b);
  }
  const values = bins.flatMap((b) => Array(b.events).fill(b.n));
  const min = Math.min(...values), max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const exactlyOne = bins.find((b) => b.n === 1)?.events ?? 0;

  return (
    <>
      <ViewSummaryMetrics metrics={[
        { label: 'Events', value: total.toLocaleString() },
        { label: 'Min', value: String(min) },
        { label: 'Median', value: String(median) },
        { label: 'Mean', value: mean.toFixed(2) },
        { label: 'Max', value: String(max) },
        { label: 'Exactly one', value: `${Math.round((exactlyOne / total) * 100)}%` },
        { label: 'More than one', value: `${Math.round(((total - exactlyOne) / total) * 100)}%` },
      ]} />
      <div className="od-card">
        <div className="od-card-title">Objects per event</div>
        <Histogram bins={bucketed.map((b) => ({ label: b.n === 5 ? '5+' : String(b.n), count: b.events }))} height={220} />
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
