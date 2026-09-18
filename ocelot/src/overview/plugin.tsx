import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { injectCss } from '../lib/styleInject';
// @ts-ignore -- esbuild's .css -> text loader, see build.js
import baseCss from '../lib/base.css';
import { useHostTheme } from '../lib/theme';
import { queryTables, queryOne, count, resolveTables, usToIso } from '../lib/sql';
import type { DeclaredType } from '../promenade';

injectCss(baseCss);

function fmtCount(n: number): string { return n.toLocaleString(); }

function fmtDuration(ms: number): string {
  const days = ms / 86400000;
  if (days < 1) return '<1 day';
  if (days < 30) return `${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`;
  if (days < 365) return `~${Math.round(days / 30)} month${Math.round(days / 30) === 1 ? '' : 's'}`;
  return `~${(days / 365).toFixed(1)} years`;
}

function fmtGap(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} d`;
}

/** Union-find over the O2O edge list — DuckDB has no native graph-connectivity
 * primitive, so (as Ocelot itself does) this pulls the raw edge list and
 * computes connected components client-side. */
function connectedComponents(edges: Array<{ a: string; b: string }>): { count: number; largestPct: number; totalNodes: number } {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) { const next = parent.get(cur)!; parent.set(cur, root); cur = next; }
    return root;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const e of edges) union(e.a, e.b);
  if (parent.size === 0) return { count: 0, largestPct: 0, totalNodes: 0 };
  const sizes = new Map<string, number>();
  for (const node of parent.keys()) { const r = find(node); sizes.set(r, (sizes.get(r) ?? 0) + 1); }
  const largest = Math.max(...sizes.values());
  return { count: sizes.size, largestPct: Math.round((largest / parent.size) * 100), totalNodes: parent.size };
}

function normalizedEntropy(counts: number[]): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (counts.length <= 1 || total === 0) return null;
  const entropy = -counts.reduce((sum, n) => { const p = n / total; return sum + (p > 0 ? p * Math.log2(p) : 0); }, 0);
  return entropy / Math.log2(counts.length);
}

interface TimingStats {
  medianActive: number; busiest: number; activeDays: number; idleDays: number;
  medianGapSeconds: number; precisionLabel: string; precisionShare: number;
  sharedTimestampShare: number; hourHistogram: number[];
}
interface StructureStats {
  e2oCount: number; objectsPerEvent: { median: number; max: number };
  eventsPerObject: { median: number; max: number }; eventsWithNoObjects: number; objectsWithNoEvents: number;
  o2oCount: number; distinctQualifiersE2O: number; distinctQualifiersO2O: number;
  components: { count: number; largestPct: number };
}
interface MatrixRow { activity: string; objectType: string; events: number; eventShare: number; relations: number; objectsPerEvent: number; maxObjectsPerEvent: number }
interface BehaviorRow { objectType: string; objects: number; variants: number; spread: number | null; medianLen: number; maxLen: number; mostCommonPath: string; mostCommonShare: number; mostCommonFull: string }

async function loadOverview(objectTypes: DeclaredType[], eventTypes: DeclaredType[]) {
  const [objectsCount, eventsCount, timeRange] = await Promise.all([
    count(resolveTables(`SELECT COUNT(*) AS n FROM {object}`)),
    count(resolveTables(`SELECT COUNT(*) AS n FROM {event}`)),
    queryOne<{ first: number; last: number }>(resolveTables(`SELECT MIN(ts) AS first, MAX(ts) AS last FROM {event}`))
      .then((r) => ({ first: usToIso(r?.first), last: usToIso(r?.last) })),
  ]);

  const [dailyStats, gapStats, precisionRow, tsShareRow, hourRows] = await Promise.all([
    queryOne<{ median_active: number; busiest: number; active_days: number }>(resolveTables(`
      WITH daily AS (SELECT date_trunc('day', ts) AS d, COUNT(*) AS n FROM {event} GROUP BY 1)
      SELECT median(n) AS median_active, max(n) AS busiest, count(*) AS active_days FROM daily
    `)),
    queryOne<{ median_gap: number }>(resolveTables(`
      WITH ordered AS (SELECT ts, LAG(ts) OVER (ORDER BY ts) AS prev FROM {event})
      SELECT median(epoch(ts) - epoch(prev)) AS median_gap FROM ordered WHERE prev IS NOT NULL
    `)),
    queryOne<{ day_f: number; hour_f: number; minute_f: number; second_f: number }>(resolveTables(`
      SELECT
        AVG(CASE WHEN epoch_ms(ts) % 86400000 = 0 THEN 1.0 ELSE 0 END) AS day_f,
        AVG(CASE WHEN epoch_ms(ts) % 3600000 = 0 THEN 1.0 ELSE 0 END) AS hour_f,
        AVG(CASE WHEN epoch_ms(ts) % 60000 = 0 THEN 1.0 ELSE 0 END) AS minute_f,
        AVG(CASE WHEN epoch_ms(ts) % 1000 = 0 THEN 1.0 ELSE 0 END) AS second_f
      FROM {event}
    `)),
    queryOne<{ total: number; distinct_ts: number }>(resolveTables(`SELECT COUNT(*) AS total, COUNT(DISTINCT ts) AS distinct_ts FROM {event}`)),
    queryTables<{ h: number; n: number }>(resolveTables(`SELECT EXTRACT(HOUR FROM ts) AS h, COUNT(*) AS n FROM {event} GROUP BY 1 ORDER BY 1`)),
  ]);

  const totalDaySpan = timeRange?.first && timeRange?.last
    ? Math.floor((Date.parse(timeRange.last) - Date.parse(timeRange.first)) / 86400000) + 1 : 0;
  const activeDays = dailyStats ? Number(dailyStats.active_days) : 0;
  const [precisionLabel, precisionShare] = (() => {
    const p = precisionRow;
    if (!p) return ['—', 0] as const;
    if (p.day_f >= 0.5) return ['whole days', p.day_f] as const;
    if (p.hour_f >= 0.5) return ['whole hours', p.hour_f] as const;
    if (p.minute_f >= 0.5) return ['whole minutes', p.minute_f] as const;
    if (p.second_f >= 0.5) return ['whole seconds', p.second_f] as const;
    return ['sub-second', 1 - p.second_f] as const;
  })();

  const hourHistogram = new Array(24).fill(0);
  for (const r of hourRows) hourHistogram[Number(r.h)] = Number(r.n);

  const timing: TimingStats = {
    medianActive: dailyStats ? Number(dailyStats.median_active) : 0,
    busiest: dailyStats ? Number(dailyStats.busiest) : 0,
    activeDays, idleDays: Math.max(0, totalDaySpan - activeDays),
    medianGapSeconds: gapStats ? Number(gapStats.median_gap) : 0,
    precisionLabel, precisionShare,
    sharedTimestampShare: tsShareRow ? 1 - Number(tsShareRow.distinct_ts) / Math.max(1, Number(tsShareRow.total)) : 0,
    hourHistogram,
  };

  const [e2oCount, o2oCount, objPerEvent, evPerObj, noObjEvents, noEvObjects, qualE2O, qualO2O, o2oEdges] = await Promise.all([
    count(resolveTables(`SELECT COUNT(*) AS n FROM {e2o}`)),
    count(resolveTables(`SELECT COUNT(*) AS n FROM {o2o}`)),
    queryOne<{ med: number; mx: number }>(resolveTables(`WITH t AS (SELECT event_id, COUNT(DISTINCT object_id) AS n FROM {e2o} GROUP BY 1) SELECT median(n) AS med, max(n) AS mx FROM t`)),
    queryOne<{ med: number; mx: number }>(resolveTables(`WITH t AS (SELECT object_id, COUNT(DISTINCT event_id) AS n FROM {e2o} GROUP BY 1) SELECT median(n) AS med, max(n) AS mx FROM t`)),
    count(resolveTables(`SELECT COUNT(*) AS n FROM {event} e WHERE NOT EXISTS (SELECT 1 FROM {e2o} r WHERE r.event_id = e.event_id)`)),
    count(resolveTables(`SELECT COUNT(*) AS n FROM {object} o WHERE NOT EXISTS (SELECT 1 FROM {e2o} r WHERE r.object_id = o.object_id)`)),
    count(resolveTables(`SELECT COUNT(DISTINCT COALESCE(NULLIF(qualifier, ''), '(none)')) AS n FROM {e2o}`)),
    count(resolveTables(`SELECT COUNT(DISTINCT COALESCE(NULLIF(qualifier, ''), '(none)')) AS n FROM {o2o}`)),
    queryTables<{ source_id: string; target_id: string }>(resolveTables(`SELECT source_id, target_id FROM {o2o}`)),
  ]);
  const components = connectedComponents(o2oEdges.map((e) => ({ a: e.source_id, b: e.target_id })));

  const structure: StructureStats = {
    e2oCount, objectsPerEvent: { median: objPerEvent ? Number(objPerEvent.med) : 0, max: objPerEvent ? Number(objPerEvent.mx) : 0 },
    eventsPerObject: { median: evPerObj ? Number(evPerObj.med) : 0, max: evPerObj ? Number(evPerObj.mx) : 0 },
    eventsWithNoObjects: noObjEvents, objectsWithNoEvents: noEvObjects, o2oCount,
    distinctQualifiersE2O: qualE2O, distinctQualifiersO2O: qualO2O,
    components: { count: components.count, largestPct: components.largestPct },
  };

  const matrixRows = await queryTables<{ activity: string; object_type: string; events: number; relations: number; max_per_event: number }>(resolveTables(`
    WITH links AS (
      SELECT e.event_id, e.activity, o.object_type
      FROM {e2o} r JOIN {event} e ON e.event_id = r.event_id JOIN {object} o ON o.object_id = r.object_id
    ), per_event_type AS (
      SELECT event_id, activity, object_type, COUNT(*) AS n FROM links GROUP BY 1, 2, 3
    )
    SELECT activity, object_type, COUNT(*) AS events, SUM(n) AS relations, MAX(n) AS max_per_event
    FROM per_event_type GROUP BY 1, 2
  `));
  const eventTotals = await queryTables<{ activity: string; n: number }>(resolveTables(`SELECT activity, COUNT(*) AS n FROM {event} GROUP BY 1`));
  const totalByType = new Map(eventTotals.map((r) => [r.activity, Number(r.n)]));
  const matrix: MatrixRow[] = matrixRows.map((r) => ({
    activity: r.activity, objectType: r.object_type, events: Number(r.events), relations: Number(r.relations),
    eventShare: Number(r.events) / Math.max(1, totalByType.get(r.activity) ?? 1),
    objectsPerEvent: Number(r.relations) / Math.max(1, Number(r.events)), maxObjectsPerEvent: Number(r.max_per_event),
  }));

  const variantRows = await queryTables<{ object_type: string; trace: string; n: number; trace_len: number }>(resolveTables(`
    WITH obj_trace AS (
      SELECT o.object_id, o.object_type, STRING_AGG(e.activity, ' → ' ORDER BY e.ts) AS trace, COUNT(*) AS trace_len
      FROM {object} o JOIN {e2o} r ON r.object_id = o.object_id JOIN {event} e ON e.event_id = r.event_id
      GROUP BY 1, 2
    )
    SELECT object_type, trace, COUNT(*) AS n, ANY_VALUE(trace_len) AS trace_len FROM obj_trace GROUP BY 1, 2
  `));
  const lenStats = await queryTables<{ object_type: string; med: number; mx: number; objects: number }>(resolveTables(`
    WITH obj_trace AS (
      SELECT o.object_id, o.object_type, COUNT(*) AS trace_len
      FROM {object} o JOIN {e2o} r ON r.object_id = o.object_id
      GROUP BY 1, 2
    )
    SELECT object_type, median(trace_len) AS med, max(trace_len) AS mx, count(*) AS objects FROM obj_trace GROUP BY 1
  `));
  const behavior: BehaviorRow[] = objectTypes.map((t) => {
    const variants = variantRows.filter((v) => v.object_type === t.name);
    const len = lenStats.find((l) => l.object_type === t.name);
    const totalObjects = variants.reduce((a, v) => a + Number(v.n), 0);
    const top = [...variants].sort((a, b) => Number(b.n) - Number(a.n))[0];
    const parts = top ? top.trace.split(' → ') : [];
    const truncated = parts.length > 4 ? `${parts.slice(0, 4).join(' → ')} → … (${parts.length})` : (top?.trace ?? '—');
    return {
      objectType: t.name, objects: len ? Number(len.objects) : 0, variants: variants.length,
      spread: normalizedEntropy(variants.map((v) => Number(v.n))),
      medianLen: len ? Number(len.med) : 0, maxLen: len ? Number(len.mx) : 0,
      mostCommonPath: truncated, mostCommonFull: top?.trace ?? '', mostCommonShare: top && totalObjects ? Math.round((Number(top.n) / totalObjects) * 100) : 0,
    };
  });

  // Declared types with zero instances still get a row (seeded from the
  // declared list, not just `GROUP BY`'d out of the data), matching Ocelot's
  // own breakdown convention — a type nobody has used yet is exactly the
  // kind of thing an overview should surface, not hide.
  const [objectTypeRows, eventTypeRows2] = await Promise.all([
    queryTables<{ object_type: string; n: number }>(resolveTables(`SELECT object_type, COUNT(*) AS n FROM {object} GROUP BY 1`)),
    queryTables<{ activity: string; n: number }>(resolveTables(`SELECT activity, COUNT(*) AS n FROM {event} GROUP BY 1`)),
  ]);
  const objectTypeCountOf = new Map(objectTypeRows.map((r) => [r.object_type, Number(r.n)]));
  const eventTypeCountOf = new Map(eventTypeRows2.map((r) => [r.activity, Number(r.n)]));
  const objectTypeBreakdown = objectTypes.map((t) => ({ name: t.name, count: objectTypeCountOf.get(t.name) ?? 0 }));
  const eventTypeBreakdown = eventTypes.map((t) => ({ name: t.name, count: eventTypeCountOf.get(t.name) ?? 0 }));

  return {
    counts: { objectTypes: objectTypes.length, objects: objectsCount, eventTypes: eventTypes.length, events: eventsCount },
    timeRange: { first: timeRange?.first ?? null, last: timeRange?.last ?? null },
    timing, structure, matrix, behavior, objectTypeBreakdown, eventTypeBreakdown,
  };
}

type OverviewData = Awaited<ReturnType<typeof loadOverview>>;

/** A stat tile that doubles as a shortcut into another one of this plugin's
 * views on the very same artifact — clicking "Objects" is the same move as
 * picking "Objects" from the Views list, just one click instead of two, and
 * `promenade.openView()` already focuses that view's panel instead of
 * opening a second one if it's sitting open in another tab. */
function LinkedStatCard({ value, label, artifactId, viewId }: { value: string; label: string; artifactId: string; viewId: string }) {
  return (
    <button
      type="button"
      className="oc-stat oc-stat--link"
      onClick={() => { void promenade.openView(artifactId, viewId); }}
      title={`Open ${label}`}
    >
      <div className="oc-stat-value">{value}</div>
      <div className="oc-stat-label oc-stat-label--link">{label}<span className="oc-stat-arrow">→</span></div>
    </button>
  );
}

function App({ objectTypes, eventTypes, name, artifactId }: { objectTypes: DeclaredType[]; eventTypes: DeclaredType[]; name: string; artifactId: string }) {
  useHostTheme();
  const [data, setData] = useState<OverviewData | null>(null);

  useEffect(() => {
    promenade.ready();
    loadOverview(objectTypes, eventTypes).then(setData);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!data) return <div className="oc-loading">Computing overview…</div>;

  const objectTypeColumns = [...new Set(data.matrix.map((m) => m.objectType))].sort();
  const eventTypeRows = [...new Set(data.matrix.map((m) => m.activity))].sort();
  const cell = (activity: string, objectType: string) => data.matrix.find((m) => m.activity === activity && m.objectType === objectType);

  const maxHour = Math.max(1, ...data.timing.hourHistogram);
  const peakHour = data.timing.hourHistogram.indexOf(maxHour);

  return (
    <div className="oc-body">
      <div className="oc-card-title" style={{ fontSize: 15 }}>{name}</div>

      <div className="oc-stat-grid" style={{ marginBottom: 12 }}>
        <LinkedStatCard value={fmtCount(data.counts.objectTypes)} label="Object Types" artifactId={artifactId} viewId="run.promenade.ocelot.object-types" />
        <LinkedStatCard value={fmtCount(data.counts.objects)} label="Objects" artifactId={artifactId} viewId="run.promenade.ocelot.objects" />
        <LinkedStatCard value={fmtCount(data.counts.eventTypes)} label="Event Types" artifactId={artifactId} viewId="run.promenade.ocelot.event-types" />
        <LinkedStatCard value={fmtCount(data.counts.events)} label="Events" artifactId={artifactId} viewId="run.promenade.ocelot.events" />
      </div>

      <div className="oc-card">
        <div className="oc-card-title">Time Range</div>
        <div className="oc-kv-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div><div className="oc-kv-label">Earliest event</div><div className="oc-kv-value">{data.timeRange.first ? new Date(data.timeRange.first).toLocaleString() : '—'}</div></div>
          <div><div className="oc-kv-label">Latest event</div><div className="oc-kv-value">{data.timeRange.last ? new Date(data.timeRange.last).toLocaleString() : '—'}</div></div>
          <div><div className="oc-kv-label">Duration</div><div className="oc-kv-value">
            {data.timeRange.first && data.timeRange.last ? fmtDuration(Date.parse(data.timeRange.last) - Date.parse(data.timeRange.first)) : '—'}
          </div></div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="oc-card">
          <div className="oc-card-title">Timing Profile</div>
          <StatRow label="Events per active day (median)" value={fmtCount(data.timing.medianActive)} />
          <StatRow label="Busiest day" value={fmtCount(data.timing.busiest)} />
          <StatRow label="Active / idle days" value={`${data.timing.activeDays} / ${data.timing.idleDays}`} />
          <StatRow label="Median gap between events" value={fmtGap(data.timing.medianGapSeconds)} />
          <StatRow label="Timestamp precision" value={`${data.timing.precisionLabel} (${Math.round(data.timing.precisionShare * 100)}%)`} />
          <StatRow label="Events sharing a timestamp" value={`${Math.round(data.timing.sharedTimestampShare * 100)}%`} />
          <div style={{ marginTop: 10 }}>
            <div className="oc-kv-label" style={{ marginBottom: 4 }}>Events by hour of day (UTC) — peak {fmtCount(maxHour)} at {String(peakHour).padStart(2, '0')}:00</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 44 }}>
              {data.timing.hourHistogram.map((n, h) => (
                <div key={h} title={`${h}:00 — ${n}`} style={{ flex: 1, height: `${Math.max(3, (n / maxHour) * 100)}%`, background: 'var(--accent, #2563eb)', opacity: .75, borderRadius: 1 }} />
              ))}
            </div>
          </div>
        </div>

        <div className="oc-card">
          <div className="oc-card-title">Structure</div>
          <StatRow label="Event-to-object relations" value={fmtCount(data.structure.e2oCount)} />
          <StatRow label="Objects per event (median / max)" value={`${data.structure.objectsPerEvent.median} / ${data.structure.objectsPerEvent.max}`} />
          <StatRow label="Events per object (median / max)" value={`${data.structure.eventsPerObject.median} / ${data.structure.eventsPerObject.max}`} />
          <StatRow label="Events with no objects" value={fmtCount(data.structure.eventsWithNoObjects)} />
          <StatRow label="Objects with no events" value={fmtCount(data.structure.objectsWithNoEvents)} />
          <StatRow label="Object-to-object relations" value={fmtCount(data.structure.o2oCount)} />
          <StatRow label="Distinct qualifiers (E2O / O2O)" value={`${data.structure.distinctQualifiersE2O} / ${data.structure.distinctQualifiersO2O}`} />
          <StatRow label="Object graph components" value={data.structure.components.count === 0 ? 'no O2O relations' : `${data.structure.components.count} (largest ${data.structure.components.largestPct}%)`} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <TypeBreakdownCard title="Object Types" items={data.objectTypeBreakdown} />
        <TypeBreakdownCard title="Event Types" items={data.eventTypeBreakdown} />
      </div>

      <div className="oc-card">
        <div className="oc-card-title">Event Type × Object Type</div>
        <div className="oc-card-sub">Average number of objects of each type per event, counted over the events of that type that touch it at all.</div>
        <div className="oc-table-wrap">
          <table className="oc-table">
            <thead><tr><th></th>{objectTypeColumns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {eventTypeRows.map((r) => (
                <tr key={r}>
                  <td style={{ fontWeight: 600 }}>{r}</td>
                  {objectTypeColumns.map((c) => {
                    const m = cell(r, c);
                    return (
                      <td key={c} title={m ? `${m.events} of the "${r}" events link to a ${c} (${Math.round(m.eventShare * 100)}% of them), ${m.relations} relations in total, up to ${m.maxObjectsPerEvent} per event` : undefined}>
                        {m ? (Number.isInteger(m.objectsPerEvent) ? m.objectsPerEvent : m.objectsPerEvent.toFixed(2)) : '·'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="oc-card">
        <div className="oc-card-title">Process Behavior</div>
        <div className="oc-card-sub">One profile per object type — an object-centric log has no single case notion, so each object type is its own.</div>
        <div className="oc-table-wrap">
          <table className="oc-table">
            <thead><tr><th>Object type</th><th>Objects</th><th>Variants</th><th>Spread</th><th>Trace length</th><th>Most common path</th></tr></thead>
            <tbody>
              {data.behavior.map((b) => (
                <tr key={b.objectType}>
                  <td style={{ fontWeight: 600 }}>{b.objectType}</td>
                  <td>{fmtCount(b.objects)}</td>
                  <td>{fmtCount(b.variants)}</td>
                  <td>{b.spread == null ? '—' : b.spread.toFixed(2)}</td>
                  <td>{b.medianLen} / {b.maxLen}</td>
                  <td title={b.mostCommonFull}>{b.mostCommonPath} {b.mostCommonShare ? <span style={{ color: 'var(--text-dim)' }}>({b.mostCommonShare}%)</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--text-dim)' }}>{label}</span><strong>{value}</strong>
    </div>
  );
}

const BREAKDOWN_LIMIT = 6;

/** A sorted top-N bar list with a collapsible "N more" toggle — ported from
 * Ocelot's `TypeBreakdownCard`, plus a share-of-total percentage next to
 * each count that Ocelot's own version didn't show. Declared types with
 * zero instances still get a row (seeded upstream in `loadOverview`), so an
 * unused type is visible, not silently absent. Bar width is relative to the
 * largest count in the list (a reading of "which types dominate"); the
 * bracketed percentage is relative to the whole (a reading of "how much of
 * the log this type accounts for") — deliberately two different scales. */
function TypeBreakdownCard({ title, items }: { title: string; items: Array<{ name: string; count: number }> }) {
  const [expanded, setExpanded] = useState(false);
  const sorted = [...items].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const total = sorted.reduce((sum, it) => sum + it.count, 0);
  const maxCount = Math.max(1, ...sorted.map((it) => it.count));
  const shown = expanded ? sorted : sorted.slice(0, BREAKDOWN_LIMIT);
  const remaining = sorted.length - BREAKDOWN_LIMIT;

  return (
    <div className="oc-card">
      <div className="oc-card-title">{title}</div>
      {sorted.length === 0 && <span style={{ color: 'var(--text-dim)' }}>None declared.</span>}
      {shown.map((it) => (
        <div key={it.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12 }}>
          <span style={{ flex: '0 0 120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</span>
          <div style={{ flex: 1, background: 'var(--bg-sunken)', borderRadius: 3, height: 8, overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(4, (it.count / maxCount) * 100)}%`, height: '100%', background: 'var(--accent, #2563eb)' }} />
          </div>
          <span style={{ flex: '0 0 auto', minWidth: 92, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
            {it.count.toLocaleString()}
            {total > 0 && <span style={{ color: 'var(--text-dim)' }}> ({Math.round((it.count / total) * 100)}%)</span>}
          </span>
        </div>
      ))}
      {remaining > 0 && (
        <button className="oc-btn" style={{ marginTop: 8 }} onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show less' : `${remaining} more`}
        </button>
      )}
    </div>
  );
}

const artifact = promenade.artifact();
createRoot(document.getElementById('root')!).render(
  <App objectTypes={artifact.semantics?.objectTypes ?? []} eventTypes={artifact.semantics?.eventTypes ?? []} name={artifact.name} artifactId={artifact.id} />
);
