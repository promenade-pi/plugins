import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { injectCss } from '../lib/styleInject';
// @ts-ignore
import baseCss from '../lib/base.css';
import { useHostTheme } from '../lib/theme';
import { queryTables, makeLatestOnly } from '../lib/sql';
import { ActivityMultiSelect } from '../lib/selectors';
import { ViewSummaryMetrics } from '../lib/SummaryMetrics';
import { EmptyState } from '../lib/EmptyState';
import { SemanticHelp } from '../lib/SemanticHelp';
import { ExportMenu } from '../lib/ExportMenu';
import { StackedBars, type StackedBarItem } from '../lib/charts/StackedBars';
import { useViewParams } from '../lib/useViewParams';

injectCss(baseCss);

/**
 * Object Dynamics · Type Signatures (spec §9).
 *
 * For every event, its exact object-type signature: the set of distinct
 * object types it relates to, with multiplicity ignored — an event touching
 * three OrderItems and one Customer has the same signature as one touching
 * one OrderItem and one Customer. Events with no `event_object` rows at all
 * get the explicit signature "(no objects)" rather than being silently
 * dropped, so they show up rather than making the total look short by however
 * many there are.
 */

interface Row { signature: string; activity: string; n: number }

async function loadSignatures(): Promise<Row[]> {
  const rows = await queryTables<{ activity: string; signature: string; n: number | bigint }>(`
    WITH per_event_types AS (
      SELECT DISTINCT e.event_id, o.object_type
      FROM {e2o} r JOIN {event} e ON e.event_id = r.event_id JOIN {object} o ON o.object_id = r.object_id
    ),
    sig_per_event AS (
      SELECT event_id, STRING_AGG(object_type, '|' ORDER BY object_type) AS signature
      FROM per_event_types GROUP BY event_id
    )
    SELECT e.activity, COALESCE(s.signature, '(no objects)') AS signature, COUNT(*) AS n
    FROM {event} e LEFT JOIN sig_per_event s ON s.event_id = e.event_id
    GROUP BY 1, 2
  `);
  return rows.map((r) => ({ signature: r.signature, activity: r.activity, n: Number(r.n) }));
}

function label(sig: string): string {
  return sig === '(no objects)' ? sig : sig.split('|').join(' + ');
}

const HELP = (
  <>
    A <strong>type signature</strong> is the exact set of object types an event relates to — presence/absence only,
    multiplicity is ignored. An event touching three OrderItems and one Customer has the same signature as one touching
    a single OrderItem and a single Customer. Bars are stacked by activity and sorted by total event count.
  </>
);

interface Params { minFrequency: number; showAll: boolean; activityFilter: string[] }
const DEFAULTS: Params = { minFrequency: 0, showAll: false, activityFilter: [] };
const TOP_N = 15;

function App() {
  useHostTheme();
  const [params, setParams] = useViewParams<Params>(DEFAULTS);
  const [rows, setRows] = useState<Row[] | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const guard = useRef(makeLatestOnly()).current;

  useEffect(() => { promenade.ready(); guard(loadSignatures(), setRows); }, []);

  const filtered = useMemo(() => {
    if (!rows) return null;
    return params.activityFilter.length > 0 ? rows.filter((r) => params.activityFilter.includes(r.activity)) : rows;
  }, [rows, params.activityFilter]);

  const grouped = useMemo(() => {
    if (!filtered) return null;
    const bySig = new Map<string, Map<string, number>>();
    for (const r of filtered) {
      if (!bySig.has(r.signature)) bySig.set(r.signature, new Map());
      const m = bySig.get(r.signature)!;
      m.set(r.activity, (m.get(r.activity) ?? 0) + r.n);
    }
    const items = [...bySig.entries()].map(([signature, byActivity]) => ({
      signature, total: [...byActivity.values()].reduce((a, b) => a + b, 0), byActivity,
    })).filter((it) => it.total >= params.minFrequency)
      .sort((a, b) => b.total - a.total);
    return items;
  }, [filtered, params.minFrequency]);

  const totalEvents = useMemo(() => (filtered ?? []).reduce((s, r) => s + r.n, 0), [filtered]);
  const shown = grouped ? (params.showAll ? grouped : grouped.slice(0, TOP_N)) : null;

  const chartItems: StackedBarItem[] = (shown ?? []).map((it) => ({
    label: label(it.signature),
    segments: [...it.byActivity.entries()].sort((a, b) => b[1] - a[1]).map(([key, value]) => ({ key, value })),
  }));

  return (
    <>
      <div className="od-toolbar">
        <span className="od-field">Activity <ActivityMultiSelect value={params.activityFilter} onChange={(v) => setParams({ activityFilter: v })} /></span>
        <span className="od-field">Min. frequency
          <input type="number" className="od-input" style={{ width: 64 }} min={0} value={params.minFrequency}
                 onChange={(e) => setParams({ minFrequency: Math.max(0, Number(e.target.value) || 0) })} />
        </span>
        <label><input type="checkbox" checked={params.showAll} onChange={(e) => setParams({ showAll: e.target.checked })} /> Show all ({grouped?.length ?? 0} signatures)</label>
        <div className="od-toolbar-spacer" />
        <ExportMenu
          filename="type-signatures"
          getElement={() => bodyRef.current}
          csvRows={(grouped ?? []).map((it) => ({ signature: label(it.signature), events: it.total, ...Object.fromEntries(it.byActivity) }))}
        />
        <SemanticHelp>{HELP}</SemanticHelp>
      </div>
      <div className="od-body" ref={bodyRef}>
        {!rows ? <div className="od-loading">Computing type signatures…</div>
          : grouped!.length === 0 ? <EmptyState title="No signatures match these filters" detail="Try lowering the minimum frequency or widening the activity filter." />
          : (
            <>
              <ViewSummaryMetrics metrics={[
                { label: 'Signatures', value: grouped!.length.toLocaleString() },
                { label: 'Events', value: totalEvents.toLocaleString() },
                { label: 'Most common', value: `${Math.round((grouped![0].total / Math.max(1, totalEvents)) * 100)}%`, title: label(grouped![0].signature) },
              ]} />
              <div className="od-card">
                <div className="od-card-title">Event count by type signature{params.showAll ? '' : ` — top ${TOP_N}`}</div>
                <StackedBars items={chartItems} orientation="horizontal" segmentColorDomain="activity" height={Math.max(180, chartItems.length * 26)} />
              </div>
            </>
          )}
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
