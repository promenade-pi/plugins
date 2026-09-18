import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { injectCss } from '../lib/styleInject';
// @ts-ignore
import baseCss from '../lib/base.css';
import { useHostTheme } from '../lib/theme';
import { queryTables, escapeLiteral, makeLatestOnly } from '../lib/sql';
import { ActivityMultiSelect, ObjectTypeSelector, AttributeSelector } from '../lib/selectors';
import { getEventAttributeNames, getObjectAttributeNames } from '../lib/objectState';
import { detectAttributeKind } from '../lib/attributeKind';
import { ViewSummaryMetrics } from '../lib/SummaryMetrics';
import { EmptyState } from '../lib/EmptyState';
import { SemanticHelp } from '../lib/SemanticHelp';
import { ExportMenu } from '../lib/ExportMenu';
import { Histogram } from '../lib/charts/Histogram';
import { BarList } from '../lib/charts/BarList';
import { useViewParams } from '../lib/useViewParams';

injectCss(baseCss);

/**
 * Object Dynamics · Attribute Distribution (spec §13).
 *
 * Event mode aggregates `event_attributes` for the selected activity/ies;
 * object mode resolves a *dynamic* object attribute's value as of each
 * qualifying event's own timestamp, for participating objects of the
 * selected type — "prefer unique event-object pairs as the aggregation
 * unit" (spec's own wording). Both paths group in SQL (`GROUP BY value`),
 * never fetch one row per event: the shipped result set is proportional to
 * the attribute's *cardinality*, not the log's size.
 */

interface GroupedRow { value: string | null; n: number }
interface Loaded { rows: GroupedRow[]; totalQualifying: number }

async function loadEventAttribute(activities: string[], attribute: string): Promise<Loaded> {
  const activityFilter = activities.length > 0 ? `WHERE activity IN (${activities.map(escapeLiteral).join(',')})` : '';
  const [rows, totalRow] = await Promise.all([
    queryTables<{ value: string | null; n: number | bigint }>(`
      WITH qualifying AS (SELECT event_id FROM {event} ${activityFilter})
      SELECT a.value, COUNT(*) AS n FROM {event_attr} a JOIN qualifying q ON q.event_id = a.event_id
      WHERE a.name = ${escapeLiteral(attribute)} GROUP BY 1
    `),
    queryTables<{ n: number | bigint }>(`SELECT COUNT(*) AS n FROM {event} ${activityFilter}`),
  ]);
  return { rows: rows.map((r) => ({ value: r.value, n: Number(r.n) })), totalQualifying: Number(totalRow[0]?.n ?? 0) };
}

async function loadObjectAttribute(activities: string[], objectType: string, attribute: string): Promise<Loaded> {
  const activityFilter = activities.length > 0 ? `AND e.activity IN (${activities.map(escapeLiteral).join(',')})` : '';
  const [rows, totalRow] = await Promise.all([
    queryTables<{ value: string | null; n: number | bigint }>(`
      WITH pairs AS (
        SELECT e.event_id, e.ts AS event_ts, r.object_id
        FROM {event} e JOIN {e2o} r ON r.event_id = e.event_id
          JOIN {object} o ON o.object_id = r.object_id AND o.object_type = ${escapeLiteral(objectType)}
        WHERE 1=1 ${activityFilter}
      ),
      attrs AS (SELECT object_id, value, ts FROM {object_attr} WHERE name = ${escapeLiteral(attribute)}),
      joined AS (
        SELECT p.event_id, p.object_id, a.value,
          ROW_NUMBER() OVER (PARTITION BY p.event_id, p.object_id ORDER BY (a.ts IS NULL) ASC, a.ts DESC) AS rn
        FROM pairs p LEFT JOIN attrs a ON a.object_id = p.object_id AND (a.ts IS NULL OR a.ts <= p.event_ts)
      )
      SELECT value, COUNT(*) AS n FROM joined WHERE rn = 1 GROUP BY 1
    `),
    queryTables<{ n: number | bigint }>(`
      SELECT COUNT(*) AS n FROM {event} e JOIN {e2o} r ON r.event_id = e.event_id
        JOIN {object} o ON o.object_id = r.object_id AND o.object_type = ${escapeLiteral(objectType)}
      WHERE 1=1 ${activityFilter}
    `),
  ]);
  return { rows: rows.map((r) => ({ value: r.value, n: Number(r.n) })), totalQualifying: Number(totalRow[0]?.n ?? 0) };
}

const TOP_N = 11;

function CategoricalView({ rows, total }: { rows: GroupedRow[]; total: number }) {
  const present = rows.filter((r) => r.value != null && r.value !== '');
  const missing = total - present.reduce((s, r) => s + r.n, 0);
  const sorted = [...present].sort((a, b) => b.n - a.n);
  const top = sorted.slice(0, TOP_N);
  const rest = sorted.slice(TOP_N).reduce((s, r) => s + r.n, 0);
  const items = [
    ...top.map((r) => ({ label: r.value!, value: r.n })),
    ...(rest > 0 ? [{ label: `Other (${sorted.length - TOP_N})`, value: rest }] : []),
    ...(missing > 0 ? [{ label: '(missing)', value: missing }] : []),
  ];
  return (
    <div className="od-card">
      <div className="od-card-title">Value distribution</div>
      <BarList items={items} />
    </div>
  );
}

function NumericView({ rows, total }: { rows: GroupedRow[]; total: number }) {
  const present = rows.filter((r) => r.value != null && r.value !== '').map((r) => ({ v: Number(r.value), n: r.n }));
  const missing = total - present.reduce((s, r) => s + r.n, 0);
  const sorted = [...present].sort((a, b) => a.v - b.v);
  const totalPresent = sorted.reduce((s, r) => s + r.n, 0);
  const min = sorted[0]?.v ?? 0, max = sorted[sorted.length - 1]?.v ?? 0;
  const mean = totalPresent ? sorted.reduce((s, r) => s + r.v * r.n, 0) / totalPresent : 0;
  let cum = 0, median = 0;
  const target = (totalPresent - 1) / 2;
  for (const r of sorted) { const next = cum + r.n; if (target < next) { median = r.v; break; } cum = next; }
  const distinct = sorted.length;

  const BIN_COUNT = 20;
  const width = Math.max(1e-9, (max - min) / BIN_COUNT);
  const counts = new Array(BIN_COUNT).fill(0);
  for (const r of sorted) counts[Math.min(BIN_COUNT - 1, Math.floor((r.v - min) / width))] += r.n;
  const bins = counts.map((c, i) => ({ label: (min + i * width).toFixed(1), count: c }));

  return (
    <>
      <ViewSummaryMetrics metrics={[
        { label: 'Count', value: totalPresent.toLocaleString() },
        { label: 'Missing', value: missing.toLocaleString() },
        { label: 'Distinct', value: distinct.toLocaleString() },
        { label: 'Min', value: min.toFixed(2) },
        { label: 'Median', value: median.toFixed(2) },
        { label: 'Mean', value: mean.toFixed(2) },
        { label: 'Max', value: max.toFixed(2) },
      ]} />
      <div className="od-card">
        <div className="od-card-title">Value distribution</div>
        <Histogram bins={bins} height={200} />
      </div>
    </>
  );
}

const HELP = (
  <>
    <strong>Event attribute</strong> mode aggregates a chosen event attribute across the selected activity/ies.
    <strong> Object attribute</strong> mode resolves a dynamic object attribute's value <em>as of each qualifying
    event's own timestamp</em> for participating objects of the selected type — one row per (event, object) pair, the
    same "latest value at or before" semantics as Attribute History. Missing values are always shown explicitly, never
    silently dropped.
  </>
);

interface Params {
  attributeMode: 'event' | 'object';
  activities: string[]; eventAttribute: string;
  objectType: string; objectAttribute: string;
}
const DEFAULTS: Params = { attributeMode: 'event', activities: [], eventAttribute: '', objectType: '', objectAttribute: '' };

function App() {
  useHostTheme();
  const [params, setParams] = useViewParams<Params>(DEFAULTS);
  const [eventAttrNames, setEventAttrNames] = useState<string[]>([]);
  const [objectAttrNames, setObjectAttrNames] = useState<string[]>([]);
  const [data, setData] = useState<Loaded | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const guard = useRef(makeLatestOnly()).current;

  useEffect(() => { promenade.ready(); }, []);
  useEffect(() => { getEventAttributeNames(params.activities.length ? params.activities : undefined).then(setEventAttrNames); }, [params.activities.join(',')]);
  useEffect(() => { if (params.objectType) getObjectAttributeNames(params.objectType).then(setObjectAttrNames); else setObjectAttrNames([]); }, [params.objectType]);

  const ready = params.attributeMode === 'event' ? !!params.eventAttribute : !!(params.objectType && params.objectAttribute);

  useEffect(() => {
    if (!ready) { setData(null); return; }
    setData(null);
    if (params.attributeMode === 'event') guard(loadEventAttribute(params.activities, params.eventAttribute), setData);
    else guard(loadObjectAttribute(params.activities, params.objectType, params.objectAttribute), setData);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.attributeMode, params.activities.join(','), params.eventAttribute, params.objectType, params.objectAttribute]);

  const kind = data ? detectAttributeKind(data.rows.map((r) => r.value)) : null;

  return (
    <>
      <div className="od-toolbar">
        <div className="od-btn-group">
          <button type="button" className={`od-btn${params.attributeMode === 'event' ? ' active' : ''}`} onClick={() => setParams({ attributeMode: 'event' })}>Event attributes</button>
          <button type="button" className={`od-btn${params.attributeMode === 'object' ? ' active' : ''}`} onClick={() => setParams({ attributeMode: 'object' })}>Object attributes</button>
        </div>
        <span className="od-field">Activity <ActivityMultiSelect value={params.activities} onChange={(v) => setParams({ activities: v })} /></span>
        {params.attributeMode === 'event' ? (
          <span className="od-field">Attribute <AttributeSelector names={eventAttrNames} value={params.eventAttribute} onChange={(v) => setParams({ eventAttribute: v })} /></span>
        ) : (
          <>
            <span className="od-field">Object type <ObjectTypeSelector value={params.objectType} onChange={(v) => setParams({ objectType: v, objectAttribute: '' })} /></span>
            <span className="od-field">Attribute <AttributeSelector names={objectAttrNames} value={params.objectAttribute} onChange={(v) => setParams({ objectAttribute: v })} /></span>
          </>
        )}
        <div className="od-toolbar-spacer" />
        <ExportMenu
          filename={`attribute-distribution-${params.attributeMode}`}
          getElement={() => bodyRef.current}
          csvRows={(data?.rows ?? []).map((r) => ({ value: r.value ?? '(null)', count: r.n }))}
        />
        <SemanticHelp>{HELP}</SemanticHelp>
      </div>
      <div className="od-body" ref={bodyRef}>
        {!ready ? <EmptyState title="Select an attribute" detail="Pick an event attribute, or an object type and attribute, to see its distribution." />
          : !data ? <div className="od-loading">Computing distribution…</div>
          : data.rows.length === 0 && data.totalQualifying === 0 ? <EmptyState title="No matching events" detail="No event matches the current activity filter." />
          : (
            <>
              {kind === 'mixed' && <div className="od-card" style={{ background: 'var(--accent-soft, #dbeafe)' }}>Mixed value types detected — shown as categories.</div>}
              {kind === 'numeric' ? <NumericView rows={data.rows} total={data.totalQualifying} /> : (
                <>
                  <ViewSummaryMetrics metrics={[
                    { label: 'Total', value: data.totalQualifying.toLocaleString() },
                    { label: 'Missing', value: (data.totalQualifying - data.rows.filter((r) => r.value != null && r.value !== '').reduce((s, r) => s + r.n, 0)).toLocaleString() },
                    { label: 'Distinct', value: data.rows.filter((r) => r.value != null && r.value !== '').length.toLocaleString() },
                  ]} />
                  <CategoricalView rows={data.rows} total={data.totalQualifying} />
                </>
              )}
            </>
          )}
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
