import { useEffect, useMemo, useState } from 'react';
import { queryTables, escapeLiteral, usToIso } from '../lib/sql';
import { RelationshipChips } from '../lib/RelationshipChips';
import { TimelineTab } from './Timeline';
import { RelationsExplorer } from './RelationsExplorer';
import type { DeclaredType } from '../promenade';
import type { RelationRef } from './types';

interface DetailData {
  relatedEvents: Array<{ eventId: string; activity: string; ts: string; attrs: Array<{ name: string; value: string }> }>;
  attributeHistory: Map<string, Array<{ value: string; ts: string }>>;
  relationshipsOut: RelationRef[];
  relationshipsIn: RelationRef[];
}

async function loadDetail(objectId: string): Promise<DetailData> {
  const idLit = escapeLiteral(objectId);
  const [eventRows, historyRows, outRows, inRows] = await Promise.all([
    queryTables<{ event_id: string; activity: string; ts: number }>(`
      SELECT e.event_id, e.activity, e.ts FROM {e2o} r JOIN {event} e ON e.event_id = r.event_id
      WHERE r.object_id = ${idLit} ORDER BY e.ts
    `),
    queryTables<{ name: string; value: string; ts: number }>(`SELECT name, value, ts FROM {object_attr} WHERE object_id = ${idLit} ORDER BY ts`),
    queryTables<{ object_id: string; qualifier: string | null; object_type: string }>(`
      SELECT r.target_id AS object_id, r.qualifier, ot.object_type
      FROM {o2o} r JOIN {object} ot ON ot.object_id = r.target_id WHERE r.source_id = ${idLit}
    `),
    queryTables<{ object_id: string; qualifier: string | null; object_type: string }>(`
      SELECT r.source_id AS object_id, r.qualifier, os.object_type
      FROM {o2o} r JOIN {object} os ON os.object_id = r.source_id WHERE r.target_id = ${idLit}
    `),
  ]);

  const eventIds = eventRows.map((e) => e.event_id);
  const attrRows = eventIds.length
    ? await queryTables<{ event_id: string; name: string; value: string }>(
        `SELECT event_id, name, value FROM {event_attr} WHERE event_id IN (${eventIds.map(escapeLiteral).join(',')})`
      )
    : [];
  const attrsByEvent = new Map<string, Array<{ name: string; value: string }>>();
  for (const a of attrRows) {
    if (!attrsByEvent.has(a.event_id)) attrsByEvent.set(a.event_id, []);
    attrsByEvent.get(a.event_id)!.push({ name: a.name, value: a.value });
  }

  const attributeHistory = new Map<string, Array<{ value: string; ts: string }>>();
  for (const r of historyRows) {
    if (!attributeHistory.has(r.name)) attributeHistory.set(r.name, []);
    attributeHistory.get(r.name)!.push({ value: r.value, ts: usToIso(r.ts)! });
  }

  return {
    relatedEvents: eventRows.map((e) => ({ eventId: e.event_id, activity: e.activity, ts: usToIso(e.ts)!, attrs: attrsByEvent.get(e.event_id) ?? [] })),
    attributeHistory,
    relationshipsOut: outRows.map((r) => ({ objectId: r.object_id, objectType: r.object_type, qualifier: r.qualifier })),
    relationshipsIn: inRows.map((r) => ({ objectId: r.object_id, objectType: r.object_type, qualifier: r.qualifier })),
  };
}

function groupByType(items: RelationRef[]): Map<string, RelationRef[]> {
  const m = new Map<string, RelationRef[]>();
  for (const r of items) {
    const key = r.objectType || 'Unknown';
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(r);
  }
  return m;
}

export function ObjectDetail({ objectType, objectId, tab, objectTypes, onChangeTab, onBack, onNavigate }: {
  objectType: string;
  objectId: string;
  tab: 'overview' | 'timeline' | 'relations';
  objectTypes: DeclaredType[];
  onChangeTab: (tab: 'overview' | 'timeline' | 'relations') => void;
  onBack: () => void;
  onNavigate: (objectType: string, objectId: string, tab: 'overview' | 'relations') => void;
}) {
  const [data, setData] = useState<DetailData | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    loadDetail(objectId).then((d) => { if (!cancelled) setData(d); });
    return () => { cancelled = true; };
  }, [objectId]);

  const currentAttributes = useMemo(() => {
    if (!data) return [];
    return [...data.attributeHistory.entries()].map(([name, hist]) => ({ name, value: hist[hist.length - 1].value }));
  }, [data]);

  const firstLastSeen = useMemo(() => {
    if (!data) return { first: null as string | null, last: null as string | null };
    const times = [
      ...data.relatedEvents.map((e) => e.ts),
      ...[...data.attributeHistory.values()].flat().map((h) => h.ts),
    ];
    if (times.length === 0) return { first: null, last: null };
    const ms = times.map((t) => Date.parse(t));
    return { first: new Date(Math.min(...ms)).toISOString(), last: new Date(Math.max(...ms)).toISOString() };
  }, [data]);

  return (
    <>
      <div className="oc-toolbar" style={{ borderBottom: 0 }}>
        <button className="oc-btn" onClick={onBack}>← Objects</button>
        <span style={{ color: 'var(--text-dim)' }}>{objectType} ›</span>
        <strong>{objectId}</strong>
      </div>
      <div style={{ padding: '0 12px 10px', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <span className="oc-chip">Object Type: {objectType}</span>
        <span className="oc-chip">Events: {data?.relatedEvents.length ?? '…'}</span>
        <span className="oc-chip">Relationships: {data?.relationshipsOut.length ?? '…'}</span>
        <span className="oc-chip">First seen: {firstLastSeen.first ? new Date(firstLastSeen.first).toLocaleString() : '…'}</span>
        <span className="oc-chip">Last seen: {firstLastSeen.last ? new Date(firstLastSeen.last).toLocaleString() : '…'}</span>
      </div>
      <div className="oc-tabs">
        <button className={`oc-tab${tab === 'overview' ? ' active' : ''}`} onClick={() => onChangeTab('overview')}>Overview</button>
        <button className={`oc-tab${tab === 'timeline' ? ' active' : ''}`} onClick={() => onChangeTab('timeline')}>Timeline</button>
        <button className={`oc-tab${tab === 'relations' ? ' active' : ''}`} onClick={() => onChangeTab('relations')}>Relations</button>
      </div>
      <div className="oc-body">
        {!data ? <div className="oc-loading">Loading…</div> : tab === 'overview' ? (
          <>
            <div className="oc-card">
              <div className="oc-card-title">Current attributes</div>
              <div className="oc-kv-grid">
                {currentAttributes.map((a) => (
                  <div key={a.name}><div className="oc-kv-label">{a.name}</div><div className="oc-kv-value">{a.value}</div></div>
                ))}
                {currentAttributes.length === 0 && <span style={{ color: 'var(--text-dim)' }}>No attributes recorded.</span>}
              </div>
            </div>
            <div className="oc-card">
              <div className="oc-card-title">
                Recent events
                {data.relatedEvents.length > 5 && (
                  <button className="oc-btn" style={{ marginLeft: 'auto' }} onClick={() => onChangeTab('timeline')}>View all {data.relatedEvents.length}</button>
                )}
              </div>
              {[...data.relatedEvents].slice(-5).reverse().map((e) => (
                <div key={e.eventId} style={{ display: 'flex', gap: 8, padding: '4px 0', fontSize: 12 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent, #2563eb)', marginTop: 5, flex: '0 0 auto' }} />
                  <span style={{ flex: 1 }}>{e.activity}</span>
                  <span style={{ color: 'var(--text-dim)' }}>{new Date(e.ts).toLocaleString()}</span>
                </div>
              ))}
              {data.relatedEvents.length === 0 && <span style={{ color: 'var(--text-dim)' }}>No related events.</span>}
            </div>
            <div className="oc-card">
              <div className="oc-card-title">Directly related objects</div>
              <RelationshipChips items={data.relationshipsOut} onOpen={(id, t) => onNavigate(t, id, 'overview')} />
            </div>
          </>
        ) : tab === 'timeline' ? (
          <TimelineTab attributeHistory={data.attributeHistory} relatedEvents={data.relatedEvents} />
        ) : (
          <>
            <RelationsExplorer rootObjectType={objectType} rootObjectId={objectId} objectTypes={objectTypes} onNavigate={onNavigate} />
            <div className="oc-card" style={{ marginTop: 14 }}>
              <div className="oc-card-title">Relationships from this object</div>
              {[...groupByType(data.relationshipsOut)].map(([type, items]) => (
                <div key={type} style={{ marginBottom: 8 }}>
                  <div className="oc-kv-label" style={{ marginBottom: 4 }}>{type}</div>
                  <RelationshipChips items={items} onOpen={(id, t) => onNavigate(t, id, 'overview')} />
                </div>
              ))}
              {data.relationshipsOut.length === 0 && <span style={{ color: 'var(--text-dim)' }}>None.</span>}
            </div>
            <div className="oc-card">
              <div className="oc-card-title">Relationships to this object</div>
              {[...groupByType(data.relationshipsIn)].map(([type, items]) => (
                <div key={type} style={{ marginBottom: 8 }}>
                  <div className="oc-kv-label" style={{ marginBottom: 4 }}>{type}</div>
                  <RelationshipChips items={items} onOpen={(id, t) => onNavigate(t, id, 'overview')} />
                </div>
              ))}
              {data.relationshipsIn.length === 0 && <span style={{ color: 'var(--text-dim)' }}>None.</span>}
            </div>
          </>
        )}
      </div>
    </>
  );
}
