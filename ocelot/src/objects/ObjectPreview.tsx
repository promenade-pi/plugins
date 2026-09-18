import { useEffect, useState } from 'react';
import { queryTables, queryOne, count, escapeLiteral, resolveTables, usToIso } from '../lib/sql';
import type { RelatedEvent } from './types';

interface PreviewData {
  totalEvents: number;
  firstSeen: string | null;
  lastSeen: string | null;
  recentEvents: RelatedEvent[];
}

async function loadPreview(objectId: string): Promise<PreviewData> {
  const idLit = escapeLiteral(objectId);
  const [totalEvents, recent, span] = await Promise.all([
    count(resolveTables(`SELECT COUNT(*) AS n FROM {e2o} WHERE object_id = ${idLit}`)),
    queryTables<{ event_id: string; activity: string; ts: number }>(`
      SELECT e.event_id, e.activity, e.ts FROM {e2o} r JOIN {event} e ON e.event_id = r.event_id
      WHERE r.object_id = ${idLit} ORDER BY e.ts DESC LIMIT 5
    `),
    queryOne<{ first_seen: number | null; last_seen: number | null }>(resolveTables(`
      WITH times AS (
        SELECT e.ts AS ts FROM {e2o} r JOIN {event} e ON e.event_id = r.event_id WHERE r.object_id = ${idLit}
        UNION ALL
        SELECT ts FROM {object_attr} WHERE object_id = ${idLit}
      )
      SELECT MIN(ts) AS first_seen, MAX(ts) AS last_seen FROM times
    `)),
  ]);
  return {
    totalEvents,
    firstSeen: usToIso(span?.first_seen),
    lastSeen: usToIso(span?.last_seen),
    recentEvents: recent.map((r) => ({ eventId: r.event_id, activity: r.activity, ts: usToIso(r.ts)! })),
  };
}

/**
 * The eye-action preview — an in-plugin side panel, not a host panel (no
 * such API exists for a sandboxed view). Ported from Ocelot's
 * `ObjectSidebarPanel`, including its purely decorative "lifecycle preview"
 * sparkline: the wobble is a deterministic `sin(i*1.7)` curve with no data
 * meaning at all, kept only because the ask was parity with Ocelot, not a
 * better chart.
 */
export function ObjectPreview({
  objectType, objectId, currentAttributes, relationCount, onOpenLifecycle, onExploreRelations,
}: {
  objectType: string;
  objectId: string;
  currentAttributes: Array<{ name: string; value: string }>;
  relationCount: number;
  onOpenLifecycle: () => void;
  onExploreRelations: () => void;
}) {
  const [data, setData] = useState<PreviewData | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    loadPreview(objectId).then((d) => { if (!cancelled) setData(d); });
    return () => { cancelled = true; };
  }, [objectId]);

  if (!data) return <div className="oc-loading">Loading…</div>;

  const days = data.firstSeen && data.lastSeen
    ? Math.max(1, Math.round((Date.parse(data.lastSeen) - Date.parse(data.firstSeen)) / 86400000))
    : 0;

  return (
    <div>
      <div className="oc-kv-grid" style={{ marginBottom: 14 }}>
        {currentAttributes.slice(0, 4).map((a) => (
          <div key={a.name}>
            <div className="oc-kv-label">{a.name}</div>
            <div className="oc-kv-value">{a.value}</div>
          </div>
        ))}
        <div><div className="oc-kv-label">Total Events</div><div className="oc-kv-value">{data.totalEvents}</div></div>
        <div><div className="oc-kv-label">Relationships</div><div className="oc-kv-value">{relationCount}</div></div>
        <div><div className="oc-kv-label">First Seen</div><div className="oc-kv-value">{data.firstSeen ? new Date(data.firstSeen).toLocaleString() : '—'}</div></div>
        <div><div className="oc-kv-label">Last Seen</div><div className="oc-kv-value">{data.lastSeen ? new Date(data.lastSeen).toLocaleString() : '—'}</div></div>
      </div>

      {data.recentEvents.length >= 2 && (
        <div style={{ marginBottom: 14 }}>
          <div className="oc-kv-label" style={{ marginBottom: 4 }}>Lifecycle preview</div>
          <svg viewBox="0 0 260 40" width="100%" height="40">
            <polyline
              fill="none" stroke="var(--accent, #2563eb)" strokeWidth="1.5"
              points={data.recentEvents.map((_, i) => {
                const x = (i / Math.max(1, data.recentEvents.length - 1)) * 260;
                const y = 20 + Math.sin(i * 1.7) * 12;
                return `${x},${y}`;
              }).join(' ')}
            />
          </svg>
          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{data.totalEvents} events across {days} day{days === 1 ? '' : 's'}</div>
        </div>
      )}

      <div className="oc-card-title" style={{ fontSize: 12 }}>Recent events</div>
      {data.recentEvents.map((e) => (
        <div key={e.eventId} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', fontSize: 12 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent, #2563eb)', flex: '0 0 auto' }} />
          <span style={{ flex: 1 }}>{e.activity}</span>
          <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{new Date(e.ts).toLocaleString()}</span>
        </div>
      ))}
      {data.totalEvents > 5 && (
        <button className="oc-btn" style={{ marginTop: 6 }} onClick={onOpenLifecycle}>View all {data.totalEvents} events</button>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="oc-btn active" onClick={onOpenLifecycle}>Open lifecycle</button>
        <button className="oc-btn" onClick={onExploreRelations}>Explore relations</button>
      </div>
    </div>
  );
}
