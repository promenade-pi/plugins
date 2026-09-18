import { useEffect, useMemo, useState } from 'react';
import { count, queryTables, resolveTables, escapeLiteral, debounce, usToIso } from '../lib/sql';
import { PaginatedTable, type Column } from '../lib/Table';
import { RelationshipChips } from '../lib/RelationshipChips';
import { SidePanel } from '../lib/SidePanel';
import { ObjectPreview } from './ObjectPreview';
import type { DeclaredType } from '../promenade';
import type { RelationRef } from './types';

const PAGE_SIZE = 25;

interface ObjectRow {
  object_id: string;
  attrs: Record<string, { value: string; historyCount: number }>;
  relations: RelationRef[];
}

interface HistoryEntry { value: string; ts: string }

function AttrCell({ objectId, name, cell }: { objectId: string; name: string; cell: { value: string; historyCount: number } }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);

  const openDialog = () => {
    setOpen(true);
    if (!history) {
      queryTables<{ value: string; ts: number }>(`SELECT value, ts FROM {object_attr} WHERE object_id = ${escapeLiteral(objectId)} AND name = ${escapeLiteral(name)} ORDER BY ts`)
        .then((rows) => setHistory(rows.map((r) => ({ value: r.value, ts: usToIso(r.ts)! }))));
    }
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {cell.value}
      {cell.historyCount > 1 && (
        <>
          <button className="oc-close-btn" style={{ fontSize: 11, padding: '0 2px' }} title={`${cell.historyCount} recorded values`} onClick={openDialog}>↻</button>
          {open && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20 }} onClick={() => setOpen(false)}>
              <div className="oc-card" style={{ background: 'var(--bg)', maxHeight: '70vh', overflow: 'auto', minWidth: 280 }} onClick={(e) => e.stopPropagation()}>
                <div className="oc-card-title">{name} — history</div>
                <table className="oc-table">
                  <thead><tr><th>Time</th><th>Value</th></tr></thead>
                  <tbody>
                    {(history ?? []).map((h, i) => <tr key={i}><td>{new Date(h.ts).toLocaleString()}</td><td>{h.value}</td></tr>)}
                    {!history && <tr><td colSpan={2}>Loading…</td></tr>}
                  </tbody>
                </table>
                <button className="oc-btn" style={{ marginTop: 8 }} onClick={() => setOpen(false)}>Close</button>
              </div>
            </div>
          )}
        </>
      )}
    </span>
  );
}

export function ObjectsList({ objectTypes, onOpenDetail }: {
  objectTypes: DeclaredType[];
  onOpenDetail: (objectType: string, objectId: string, tab: 'overview' | 'relations') => void;
}) {
  const [activeType, setActiveType] = useState(objectTypes[0]?.name ?? '');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<ObjectRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);

  useEffect(() => { setPage(0); setPreviewId(null); }, [activeType, search]);

  const setSearchDebounced = useMemo(() => debounce((v: string) => setSearch(v), 250), []);

  useEffect(() => {
    if (!activeType) return;
    let cancelled = false;
    setLoading(true);
    const typeLit = escapeLiteral(activeType);
    const searchFilter = search ? ` AND o.object_id ILIKE ${escapeLiteral(`%${search}%`)}` : '';

    (async () => {
      const [n, idRows] = await Promise.all([
        count(resolveTables(`SELECT COUNT(*) AS n FROM {object} o WHERE o.object_type = ${typeLit}${searchFilter}`)),
        queryTables<{ object_id: string }>(`
          SELECT o.object_id FROM {object} o WHERE o.object_type = ${typeLit}${searchFilter}
          ORDER BY o.object_id LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}
        `),
      ]);
      if (cancelled) return;
      setTotal(n);
      if (idRows.length === 0) { setRows([]); setLoading(false); return; }
      const ids = idRows.map((r) => escapeLiteral(r.object_id)).join(',');
      const [attrRows, relRows] = await Promise.all([
        queryTables<{ object_id: string; name: string; value: string; history_count: number }>(`
          SELECT object_id, name, value, COUNT(*) OVER (PARTITION BY object_id, name) AS history_count
          FROM {object_attr} WHERE object_id IN (${ids})
          QUALIFY ROW_NUMBER() OVER (PARTITION BY object_id, name ORDER BY ts DESC) = 1
        `),
        queryTables<{ object_id: string; target_id: string; qualifier: string | null; target_type: string }>(`
          SELECT r.source_id AS object_id, r.target_id, r.qualifier, ot.object_type AS target_type
          FROM {o2o} r JOIN {object} ot ON ot.object_id = r.target_id
          WHERE r.source_id IN (${ids})
        `),
      ]);
      if (cancelled) return;
      const attrsByObject = new Map<string, ObjectRow['attrs']>();
      for (const a of attrRows) {
        if (!attrsByObject.has(a.object_id)) attrsByObject.set(a.object_id, {});
        attrsByObject.get(a.object_id)![a.name] = { value: a.value, historyCount: Number(a.history_count) };
      }
      const relsByObject = new Map<string, RelationRef[]>();
      for (const r of relRows) {
        if (!relsByObject.has(r.object_id)) relsByObject.set(r.object_id, []);
        relsByObject.get(r.object_id)!.push({ objectId: r.target_id, objectType: r.target_type, qualifier: r.qualifier });
      }
      setRows(idRows.map((r) => ({ object_id: r.object_id, attrs: attrsByObject.get(r.object_id) ?? {}, relations: relsByObject.get(r.object_id) ?? [] })));
      setLoading(false);
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeType, search, page]);

  const declared = objectTypes.find((t) => t.name === activeType);
  const previewRow = rows.find((r) => r.object_id === previewId) ?? null;

  const columns: Column<ObjectRow>[] = useMemo(() => {
    const cols: Column<ObjectRow>[] = [
      { key: 'id', label: 'ID', render: (r) => <button className="oc-id-link" onClick={() => onOpenDetail(activeType, r.object_id, 'overview')}>{r.object_id}</button> },
    ];
    for (const a of declared?.attributes ?? []) {
      cols.push({
        key: a.name, label: a.name,
        render: (r) => r.attrs[a.name] ? <AttrCell objectId={r.object_id} name={a.name} cell={r.attrs[a.name]} /> : '',
      });
    }
    cols.push({
      key: 'relationships', label: 'Relationships',
      render: (r) => <RelationshipChips items={r.relations} onOpen={(id, t) => onOpenDetail(t, id, 'overview')} />,
    });
    cols.push({
      key: 'actions', label: 'Actions',
      render: (r) => (
        <button className="oc-btn" title="Preview" onClick={() => setPreviewId((cur) => cur === r.object_id ? null : r.object_id)}>
          👁
        </button>
      ),
    });
    return cols;
  }, [declared, activeType, onOpenDetail]);

  return (
    <>
      <div className="oc-tabs">
        {objectTypes.map((t) => (
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
      <div className="oc-relative">
        <div className="oc-body">
          <PaginatedTable
            columns={columns} rows={rows} rowKey={(r) => r.object_id} total={total}
            page={page} pageSize={PAGE_SIZE} onPageChange={setPage} loading={loading}
            emptyMessage="No objects."
          />
        </div>
        <SidePanel open={!!previewRow} title={previewRow ? `${activeType} ${previewRow.object_id}` : ''} onClose={() => setPreviewId(null)}>
          {previewRow && (
            <ObjectPreview
              objectType={activeType}
              objectId={previewRow.object_id}
              currentAttributes={Object.entries(previewRow.attrs).map(([name, v]) => ({ name, value: v.value }))}
              relationCount={previewRow.relations.length}
              onOpenLifecycle={() => onOpenDetail(activeType, previewRow.object_id, 'overview')}
              onExploreRelations={() => onOpenDetail(activeType, previewRow.object_id, 'relations')}
            />
          )}
        </SidePanel>
      </div>
    </>
  );
}
