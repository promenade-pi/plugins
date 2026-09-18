import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { injectCss } from '../lib/styleInject';
// @ts-ignore -- esbuild's .css -> text loader, see build.js
import baseCss from '../lib/base.css';
import { useHostTheme } from '../lib/theme';
import { count, queryTables, resolveTables, escapeLiteral, debounce, usToIso } from '../lib/sql';
import { PaginatedTable, type Column } from '../lib/Table';
import { RelationshipChips } from '../lib/RelationshipChips';
import type { DeclaredType } from '../promenade';

injectCss(baseCss);

const PAGE_SIZE = 25;

interface EventRow {
  event_id: string;
  ts: string;
  attrs: Record<string, string>;
  relations: Array<{ objectId: string; objectType: string; qualifier: string | null }>;
}

function App({ eventTypes }: { eventTypes: DeclaredType[] }) {
  useHostTheme();
  const [activeType, setActiveType] = useState(eventTypes[0]?.name ?? '');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => { promenade.ready(); }, []);
  useEffect(() => { setPage(0); }, [activeType, search]);

  const setSearchDebounced = useMemo(() => debounce((v: string) => setSearch(v), 250), []);

  useEffect(() => {
    if (!activeType) return;
    let cancelled = false;
    setLoading(true);
    const typeLit = escapeLiteral(activeType);
    const searchFilter = search ? ` AND e.event_id ILIKE ${escapeLiteral(`%${search}%`)}` : '';

    (async () => {
      const [n, idRows] = await Promise.all([
        count(resolveTables(`SELECT COUNT(*) AS n FROM {event} e WHERE e.activity = ${typeLit}${searchFilter}`)),
        queryTables<{ event_id: string; ts: number }>(`
          SELECT e.event_id, e.ts FROM {event} e
          WHERE e.activity = ${typeLit}${searchFilter}
          ORDER BY e.ts LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}
        `),
      ]);
      if (cancelled) return;
      setTotal(n);
      if (idRows.length === 0) { setRows([]); setLoading(false); return; }
      const ids = idRows.map((r) => escapeLiteral(r.event_id)).join(',');
      const [attrRows, relRows] = await Promise.all([
        queryTables<{ event_id: string; name: string; value: string }>(`SELECT event_id, name, value FROM {event_attr} WHERE event_id IN (${ids})`),
        queryTables<{ event_id: string; object_id: string; qualifier: string | null; object_type: string }>(`
          SELECT r.event_id, r.object_id, r.qualifier, o.object_type
          FROM {e2o} r JOIN {object} o ON o.object_id = r.object_id
          WHERE r.event_id IN (${ids})
        `),
      ]);
      if (cancelled) return;
      const attrsByEvent = new Map<string, Record<string, string>>();
      for (const a of attrRows) {
        if (!attrsByEvent.has(a.event_id)) attrsByEvent.set(a.event_id, {});
        attrsByEvent.get(a.event_id)![a.name] = a.value;
      }
      const relsByEvent = new Map<string, EventRow['relations']>();
      for (const r of relRows) {
        if (!relsByEvent.has(r.event_id)) relsByEvent.set(r.event_id, []);
        relsByEvent.get(r.event_id)!.push({ objectId: r.object_id, objectType: r.object_type, qualifier: r.qualifier });
      }
      setRows(idRows.map((r) => ({ event_id: r.event_id, ts: usToIso(r.ts)!, attrs: attrsByEvent.get(r.event_id) ?? {}, relations: relsByEvent.get(r.event_id) ?? [] })));
      setLoading(false);
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeType, search, page]);

  const declared = eventTypes.find((t) => t.name === activeType);
  const columns: Column<EventRow>[] = useMemo(() => {
    const cols: Column<EventRow>[] = [
      { key: 'id', label: 'ID', render: (r) => r.event_id },
      { key: 'time', label: 'Time', render: (r) => new Date(r.ts).toISOString() },
    ];
    for (const a of declared?.attributes ?? []) {
      cols.push({ key: a.name, label: a.name, render: (r) => r.attrs[a.name] ?? '' });
    }
    cols.push({
      key: 'relations', label: 'Object Relationships',
      render: (r) => (
        <RelationshipChips
          items={r.relations.map((x) => ({ objectId: x.objectId, objectType: x.objectType, qualifier: x.qualifier }))}
          onOpen={(id, objectType) => {
            void promenade.openView(artifact.id, 'run.promenade.ocelot.objects', { focusObjectId: id, focusObjectType: objectType });
          }}
        />
      ),
    });
    return cols;
  }, [declared]);

  return (
    <>
      <div className="oc-tabs">
        {eventTypes.map((t) => (
          <button key={t.name} className={`oc-tab${t.name === activeType ? ' active' : ''}`} onClick={() => setActiveType(t.name)}>{t.name}</button>
        ))}
      </div>
      <div className="oc-toolbar">
        <input
          className="oc-input" placeholder="Search by ID…" style={{ minWidth: 220 }}
          value={searchInput}
          onChange={(e) => { setSearchInput(e.target.value); setSearchDebounced(e.target.value); }}
        />
      </div>
      <div className="oc-body">
        <PaginatedTable
          columns={columns} rows={rows} rowKey={(r) => r.event_id} total={total}
          page={page} pageSize={PAGE_SIZE} onPageChange={setPage} loading={loading}
          emptyMessage="No events."
        />
      </div>
    </>
  );
}

const artifact = promenade.artifact();
const eventTypes = artifact.semantics?.eventTypes ?? [];
createRoot(document.getElementById('root')!).render(<App eventTypes={eventTypes} />);
