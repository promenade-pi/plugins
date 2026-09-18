import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Grid } from './grid';
import { RowForm } from './form';
import { TypesPanel } from './types';
import { RelationDialog } from './relations';
import { loadLogDoc } from './load';
import {
  PAGE_SIZE, cell, cellErrorAt, allowedAt, applyProjection, columnsOf, completionsAt, declarationsOf,
  emptyDoc, exampleDoc, filledRows, isBlankRow, projectRows, publishRequest, sheetSpec, sheetTabs,
  suggestionsOf, tabDefaults, tabKey, validate, withRows, withTypes,
  type ColumnSpec, type Doc, type Row, type SheetKey, type SheetTab,
} from './model';
import css from './styles.css';

/**
 * OCEL Builder — declare a log's event and object types, fill in their
 * instances, publish the result as an OCEL 2.0 artifact.
 *
 * Two views, one editor. As a standalone view (manifest `standalone: true`) it
 * writes a log from scratch: the artifact it makes does not exist until the
 * user presses Create. Bound to an existing log it is "Edit log": the same
 * document, loaded out of DuckDB, published as a *new* artifact that records
 * the one it came from. Editing in place is deliberately not offered —
 * artifacts in this app are immutable, and an edit that silently rewrote one
 * would invalidate everything already derived from it.
 *
 * `promenade.publishLog()` is the door both go through; the host validates and
 * materializes, so what lands in the workspace is a normal OCEL log with real
 * Parquet behind it.
 */

/** The top-level tab strip — one entry per sheet, plus Types. */
type Section = 'types' | SheetKey;

type Mode = 'new' | 'loading' | 'edit' | 'tooBig';

const HISTORY_LIMIT = 50;

const isLog = (a: any) => a?.type === 'ObjectCentricEventLog' && !!a?.tables?.event;

function Editor() {
  const [doc, setDoc] = useState<Doc>(emptyDoc);
  const [mode, setMode] = useState<Mode>(() => (isLog(promenade.artifact()) ? 'loading' : 'new'));
  const [tooBig, setTooBig] = useState<{ events: number; objects: number; cap: number } | null>(null);
  const [section, setSection] = useState<Section>('types');
  // Per-type tabs under Events/Objects. There is no "All" tab — see
  // `sheetTabs`'s own doc comment for why — so the only choices worth
  // remembering per section are which declared type, or "Other".
  const [sub, setSub] = useState<Record<'events' | 'objects', SheetTab>>({
    events: { kind: 'other' }, objects: { kind: 'other' },
  });
  const [query, setQuery] = useState<Partial<Record<SheetKey, string>>>({});
  const [page, setPage] = useState<Partial<Record<SheetKey, number>>>({});
  const [activeRow, setActiveRow] = useState(0);
  const [showForm, setShowForm] = useState(true);
  const [relationDialog, setRelationDialog] = useState<{ kind: 'event' | 'object'; ownerId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [published, setPublished] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const history = useRef<Doc[]>([]);

  const source = isLog(promenade.artifact()) ? promenade.artifact() : null;

  /**
   * Whatever was being typed when this panel was last closed wins over
   * reloading from the log: an interrupted edit is more valuable than a fresh
   * copy of what the user was in the middle of changing.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let saved: unknown = null;
      try { saved = await promenade.cachedState(); } catch { /* no cache is normal */ }
      if (cancelled) return;
      const candidate = saved as Doc | null;
      if (candidate?.sheets?.events && Array.isArray(candidate.eventTypes)) {
        setDoc(candidate);
        setMode(source ? 'edit' : 'new');
        setSection('events');
      } else if (source) {
        try {
          const outcome = await loadLogDoc(
            { name: `${source.name} (edited)`, tables: source.tables, semantics: source.semantics },
            (sql: string) => promenade.sql(sql) as any,
          );
          if (cancelled) return;
          if (outcome.ok) {
            setDoc(outcome.doc);
            setMode('edit');
            setSection('events');
          } else {
            setTooBig(outcome.tooBig);
            setMode('tooBig');
          }
        } catch (e: any) {
          if (!cancelled) { setError(String(e?.message ?? e)); setMode('new'); }
        }
      }
      if (!cancelled) setRestored(true);
    })();
    promenade.on('resize', ({ w }) => setNarrow(w < 780));
    promenade.ready();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (restored) promenade.setCachedState(doc);
  }, [doc, restored]);

  /** Every change goes through here, so undo is a stack of whole documents. */
  const edit = useCallback((next: Doc) => {
    setDoc((current) => {
      history.current = [...history.current.slice(-HISTORY_LIMIT), current];
      return next;
    });
    setPublished(null);
    setError(null);
  }, []);

  const undo = useCallback(() => {
    const previous = history.current.pop();
    if (previous) setDoc(previous);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { undo(); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo]);

  const suggestions = useMemo(() => suggestionsOf(doc), [doc]);
  const issues = useMemo(() => validate(doc), [doc]);
  const errors = issues.filter((i) => i.level === 'error');

  const counts: Record<Section, number> = {
    types: doc.eventTypes.length + doc.objectTypes.length,
    events: filledRows(doc, 'events').length,
    objects: filledRows(doc, 'objects').length,
    changes: filledRows(doc, 'changes').length,
    e2o: filledRows(doc, 'e2o').length,
    o2o: filledRows(doc, 'o2o').length,
  };

  const spec = section === 'types' ? null : sheetSpec(section);
  const isTypedSection = section === 'events' || section === 'objects';
  const typedSection = isTypedSection ? (section as 'events' | 'objects') : null;

  // Which per-type tab is actually showing: the stored preference if it still
  // exists among this section's tabs, else the first one — a declared type's
  // own tab is the default, "Other" only when nothing has been declared yet.
  const availableTabs = typedSection && spec ? sheetTabs(doc, spec) : [];
  const storedTab = typedSection ? sub[typedSection] : null;
  const effectiveTab: SheetTab | null = typedSection
    ? (availableTabs.find((t) => tabKey(t) === tabKey(storedTab ?? { kind: 'other' })) ?? availableTabs[0] ?? { kind: 'other' })
    : null;
  const hasDeclaredTypes = typedSection
    ? declarationsOf(doc, typedSection === 'events' ? 'event' : 'object').some((d) => d.name.trim())
    : false;

  const columns = useMemo(
    () => (spec ? columnsOf(doc, spec, effectiveTab) : ([] as ColumnSpec[])),
    [doc, spec?.key, effectiveTab && tabKey(effectiveTab)],
  );

  const sheetQuery = spec ? query[spec.key] ?? '' : '';
  const projection = useMemo(
    () => (spec ? projectRows(doc, spec, {
      tab: effectiveTab, query: sheetQuery, page: page[spec.key] ?? 0,
    }) : null),
    [doc, spec?.key, effectiveTab && tabKey(effectiveTab), sheetQuery, spec ? page[spec.key] : 0],
  );

  /** New rows on a per-type tab already know their type — that is the point. */
  const defaults: Row = useMemo(
    () => (spec ? tabDefaults(spec, effectiveTab) : {}),
    [spec?.key, effectiveTab && tabKey(effectiveTab)],
  );

  const projected = useMemo(
    () => (spec && projection ? projection.indices.map((i) => doc.sheets[spec.key].rows[i]) : []),
    [doc, spec?.key, projection],
  );

  /** The row a per-cell callback is about — a spare row is a would-be new row. */
  const rowAt = useCallback(
    (r: number) => projected[r] ?? defaults,
    [projected, defaults],
  );

  const onRows = useCallback((rows: Row[]) => {
    if (!spec || !projection) return;
    edit(withRows(doc, spec.key, applyProjection(
      doc.sheets[spec.key].rows, projection.indices, rows, defaults,
    )));
  }, [doc, spec?.key, projection, defaults, edit]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await promenade.publishLog(publishRequest(doc, source?.id));
      setPublished(result.name);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const formVisible = !!spec?.typedBy && showForm && !narrow;
  const underlyingRow = projection && activeRow < projection.indices.length
    ? projection.indices[activeRow]
    : (spec ? doc.sheets[spec.key].rows.length : 0);

  /** Whether any row this tab shows is the subject of a current error. */
  const tabHasError = (tab: SheetTab) => spec && issues.some((issue) =>
    issue.level === 'error' && issue.sheet === spec.key
    && issue.rows?.some((idx) => {
      const row = doc.sheets[spec.key].rows[idx];
      return row && (tab.kind === 'type'
        ? cell(row, spec.typedBy!.column).trim() === tab.name
        : !declarationsOf(doc, spec.typedBy!.kind).some((d) => d.name.trim() === cell(row, spec.typedBy!.column).trim()));
    }));

  /** Where "Go" on an events/objects issue should land: the row's own tab. */
  const bestTabFor = (key: 'events' | 'objects', rowIdx: number | undefined): SheetTab => {
    if (rowIdx == null) return { kind: 'other' };
    const s = sheetSpec(key);
    const row = doc.sheets[key].rows[rowIdx];
    if (!row || !s.typedBy) return { kind: 'other' };
    const typeName = cell(row, s.typedBy.column).trim();
    const declared = typeName && declarationsOf(doc, s.typedBy.kind).some((d) => d.name.trim() === typeName);
    return declared ? { kind: 'type', name: typeName } : { kind: 'other' };
  };

  if (mode === 'loading') {
    return <div className="app"><div className="notice">Loading the log…</div></div>;
  }

  if (mode === 'tooBig' && tooBig) {
    return (
      <div className="app">
        <div className="notice">
          <h3>Too large to hand-edit</h3>
          <p>
            This log has {tooBig.events.toLocaleString()} events and{' '}
            {tooBig.objects.toLocaleString()} objects. Editing loads the whole log into the
            panel and re-checks it on every keystroke, which stops being usable past about{' '}
            {tooBig.cap.toLocaleString()} rows.
          </p>
          <p className="hint">
            For a log this size, a transformation that describes the change — a filter, a
            projection, a rename — is both faster and reproducible, which hand-editing is not.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <input
          className="name"
          placeholder="Log name"
          value={doc.name}
          onChange={(e) => edit({ ...doc, name: e.target.value })}
        />
        {mode === 'edit'
          ? <span className="from" title={`Edited from ${source?.name}`}>from “{source?.name}”</span>
          : <button className="ghost" onClick={() => edit(exampleDoc())}>Example</button>}
        <button
          className="ghost"
          disabled={counts.types + counts.events + counts.objects + counts.e2o + counts.o2o === 0}
          onClick={() => edit({ ...emptyDoc(), name: doc.name })}
        >
          Clear
        </button>
        <span className="spacer" />
        {published && <span className="ok">Created “{published}”</span>}
        <button
          className="primary"
          disabled={busy || errors.length > 0}
          title={errors.length ? errors[0].message : 'Publish as a new OCEL 2.0 artifact'}
          onClick={create}
        >
          {busy ? 'Creating…' : mode === 'edit' ? 'Create edited log' : 'Create OCEL log'}
        </button>
      </header>

      <nav>
        <button className={section === 'types' ? 'on' : ''} onClick={() => setSection('types')}>
          Types<em>{counts.types}</em>
          {issues.some((i) => i.sheet === 'types' && i.level === 'error') && <i className="dot" />}
        </button>
        <span className="navsep" />
        {(['events', 'objects', 'changes', 'e2o', 'o2o'] as const).map((key) => (
          <button key={key} className={section === key ? 'on' : ''} onClick={() => setSection(key)}>
            {sheetSpec(key).label}<em>{counts[key]}</em>
            {issues.some((i) => i.sheet === key && i.level === 'error') && <i className="dot" />}
          </button>
        ))}
        <span className="spacer" />
        {spec?.typedBy && !narrow && (
          <button className={showForm ? 'on' : ''} onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Hide form' : 'Form'}
          </button>
        )}
      </nav>

      {typedSection && hasDeclaredTypes && (
        <div className="subnav">
          {availableTabs.map((tab) => (
            <button
              key={tabKey(tab)}
              className={tabKey(tab) === tabKey(effectiveTab!) ? 'on' : ''}
              onClick={() => setSub({ ...sub, [typedSection]: tab })}
              title={tab.kind === 'type'
                ? `Only ${tab.name} rows, with only its own attribute columns`
                : 'Rows with no type, or a type not declared yet'}
            >
              {tab.kind === 'type' ? tab.name : 'Other'}
              <em>{filledRows(doc, typedSection).filter((r) => (tab.kind === 'type'
                ? cell(r, spec!.typedBy!.column).trim() === tab.name
                : !declarationsOf(doc, spec!.typedBy!.kind).some((d) => d.name.trim() === cell(r, spec!.typedBy!.column).trim()))).length}</em>
              {tabHasError(tab) && <i className="dot" />}
            </button>
          ))}
          <button
            className="ghost addtype"
            title="Declare another type"
            onClick={() => {
              const kind = typedSection === 'events' ? 'event' : 'object';
              edit(withTypes(doc, kind, [...declarationsOf(doc, kind), { name: '', attributes: [] }]));
              setSection('types');
            }}
          >
            + type
          </button>
        </div>
      )}

      {spec && projection && (projection.total > PAGE_SIZE || sheetQuery) && (
        <div className="sheetbar">
          <input
            className="search"
            placeholder={`Search ${spec.label.toLowerCase()}…`}
            value={sheetQuery}
            onChange={(e) => {
              setQuery({ ...query, [spec.key]: e.target.value });
              setPage({ ...page, [spec.key]: 0 });
            }}
          />
          <span className="hint">
            {projection.matched === projection.total
              ? `${projection.total.toLocaleString()} rows`
              : `${projection.matched.toLocaleString()} of ${projection.total.toLocaleString()} rows`}
          </span>
          {projection.pages > 1 && (
            <>
              <span className="spacer" />
              <button
                disabled={projection.page === 0}
                onClick={() => setPage({ ...page, [spec.key]: projection.page - 1 })}
              >
                ‹
              </button>
              <span className="hint">Page {projection.page + 1} / {projection.pages}</span>
              <button
                disabled={projection.page + 1 >= projection.pages}
                onClick={() => setPage({ ...page, [spec.key]: projection.page + 1 })}
              >
                ›
              </button>
            </>
          )}
        </div>
      )}

      <div className="work">
        {spec && projection
          ? (
            <>
              <Grid
                key={`${section}:${effectiveTab ? tabKey(effectiveTab) : ''}`}
                columns={columns}
                rows={projected}
                spare={projection.spare}
                completionsAt={(r, column) => completionsAt(doc, spec, rowAt(r), column, suggestions)}
                allowedAt={(r, column) => allowedAt(doc, spec, rowAt(r), column)}
                errorAt={(r, column) => cellErrorAt(doc, spec, rowAt(r), column)}
                onActiveRow={setActiveRow}
                onChange={onRows}
                rowAction={typedSection ? (r) => {
                  const row = projected[r];
                  const idKey = typedSection === 'events' ? 'event_id' : 'object_id';
                  const id = row ? cell(row, idKey).trim() : '';
                  if (!id || isBlankRow(row)) return null;
                  return (
                    <button
                      className="rowlink"
                      title="Relations…"
                      onClick={() => setRelationDialog({ kind: typedSection === 'events' ? 'event' : 'object', ownerId: id })}
                    >
                      ⛓
                    </button>
                  );
                } : undefined}
              />
              {formVisible && (
                <RowForm
                  doc={doc}
                  spec={spec}
                  rowIndex={underlyingRow}
                  defaults={defaults}
                  onRows={(rows) => edit(withRows(doc, spec.key, rows))}
                  onGoToTypes={() => setSection('types')}
                />
              )}
            </>
          )
          : <TypesPanel doc={doc} onChange={edit} />}
      </div>

      <footer>
        {error && <div className="issue error"><span>{error}</span></div>}
        {issues.length === 0 && !error && (
          <div className="issue fine">
            <span>
              {counts.events} events · {counts.objects} objects · {counts.e2o} E2O · {counts.o2o} O2O ·
              {' '}{counts.changes} timed values ·
              {' '}{doc.eventTypes.length} event types · {doc.objectTypes.length} object types
            </span>
          </div>
        )}
        {issues.map((issue, i) => (
          <div key={i} className={`issue ${issue.level}`}>
            <span>{issue.message}</span>
            {issue.fix && <button onClick={() => edit(issue.fix!.apply(doc))}>{issue.fix.label}</button>}
            {issue.sheet && issue.sheet !== section && (
              <button
                className="ghost"
                onClick={() => {
                  if (issue.sheet === 'types') { setSection('types'); return; }
                  setSection(issue.sheet as Section);
                  if (issue.sheet === 'events' || issue.sheet === 'objects') {
                    setSub({ ...sub, [issue.sheet]: bestTabFor(issue.sheet, issue.rows?.[0]) });
                  }
                }}
              >
                Go
              </button>
            )}
          </div>
        ))}
      </footer>

      {relationDialog && (
        <RelationDialog
          doc={doc}
          kind={relationDialog.kind}
          ownerId={relationDialog.ownerId}
          onChange={edit}
          onClose={() => setRelationDialog(null)}
          onGoToTypes={() => setSection('types')}
        />
      )}
    </div>
  );
}

const style = document.createElement('style');
style.textContent = css as unknown as string;
document.head.appendChild(style);
createRoot(document.getElementById('root')!).render(<Editor />);
