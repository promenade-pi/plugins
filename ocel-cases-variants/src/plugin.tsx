import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { injectCss } from './lib/styleInject';
// @ts-ignore -- esbuild's .css -> text loader, see build.js
import baseCss from './lib/base.css';
import { useHostTheme } from './lib/theme';
import { queryTables } from './lib/sql';
import {
  computeVariants, layerColumns, topoActivitySeq,
  type ExecEvent, type ExecutionGraph,
} from './lib/isomorphism';
import {
  buildExecution, toSummary, typeCountsOf,
  type ExecutionDetail, type RawData, type VariantSummary,
} from './lib/executions';
import { runPipeline, type PipelineProgress } from './lib/pipeline';
import { CanceledNotice, LoadingChevrons } from './lib/LoadingState';
import type { SelectionItem } from './promenade';

injectCss(baseCss);

// ---------------------------------------------------------------------------
// Formatting (no shared module with the host inside a sandboxed bundle).
// ---------------------------------------------------------------------------
function fmtCount(n: number): string { return n.toLocaleString(); }
function fmtDate(ms: number): string { return ms ? new Date(ms).toLocaleString() : '—'; }
function fmtMs(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

// ---------------------------------------------------------------------------
// Raw data + process-execution construction (paper Def. 3/4/6/7).
// ---------------------------------------------------------------------------
async function loadRawData(): Promise<RawData> {
  const [objects, e2o, events, edgeRows] = await Promise.all([
    queryTables<{ object_id: string; object_type: string }>(`SELECT object_id, object_type FROM {object}`),
    queryTables<{ event_id: string; object_id: string }>(`SELECT event_id, object_id FROM {e2o}`),
    queryTables<{ event_id: string; activity: string; ts_ms: number | null }>(`SELECT event_id, activity, epoch_ms(ts) AS ts_ms FROM {event}`),
    queryTables<{ a: string; b: string }>(`
      SELECT DISTINCT r1.object_id AS a, r2.object_id AS b
      FROM {e2o} r1 JOIN {e2o} r2 ON r1.event_id = r2.event_id AND r1.object_id < r2.object_id
    `),
  ]);

  const typeOf = new Map(objects.map((o) => [o.object_id, o.object_type]));
  const eventById = new Map(events.map((e) => [e.event_id, { activity: e.activity, ts: e.ts_ms == null ? 0 : Number(e.ts_ms) }]));
  const eventsByObject = new Map<string, Array<{ event_id: string; ts: number }>>();
  const objectsByEvent = new Map<string, string[]>();
  for (const r of e2o) {
    const ev = eventById.get(r.event_id);
    if (!ev) continue;
    if (!eventsByObject.has(r.object_id)) eventsByObject.set(r.object_id, []);
    eventsByObject.get(r.object_id)!.push({ event_id: r.event_id, ts: ev.ts });
    if (!objectsByEvent.has(r.event_id)) objectsByEvent.set(r.event_id, []);
    objectsByEvent.get(r.event_id)!.push(r.object_id);
  }
  for (const list of eventsByObject.values()) list.sort((a, b) => a.ts - b.ts || a.event_id.localeCompare(b.event_id));

  return { typeOf, eventById, eventsByObject, objectsByEvent, edges: edgeRows.map((e) => ({ a: e.a, b: e.b })) };
}

interface CachedState {
  raw: RawData;
  legend: Array<{ activity: string; event_count: number }>;
  executions?: ExecutionDetail[];
  variantSummaries?: VariantSummary[];
  execSig?: string;
}

/**
 * The reusable artifact deliberately stores identifiers and extraction
 * semantics, not duplicate event/object records. Consumers resolve those ids
 * against `sourceArtifactId`, which keeps the OCEL itself canonical.
 */
function toExecutionPartition(
  sourceArtifactId: string, executions: ExecutionDetail[], variants: VariantSummary[], params: ViewParams, leadingType: string,
) {
  const variantOfExecution = new Map<string, string>();
  for (const variant of variants) for (const execution of variant.executions) variantOfExecution.set(execution.caseId, variant.variantId);
  return {
    schemaVersion: 1 as const,
    sourceArtifactId,
    extraction: {
      method: params.extraction,
      ...(params.extraction === 'leadingType' ? { leadingType } : {}),
      scopeSharedObjects: params.scopeSharedObjects,
      maxEvents: params.maxEvents,
    },
    executions: executions.map((execution) => ({
      id: execution.caseId,
      objectIds: [...execution.objectIds],
      eventIds: execution.graph.events.map((event) => event.id),
      variantId: variantOfExecution.get(execution.caseId) ?? 'unclassified',
      truncated: execution.truncated,
      startMs: execution.startMs,
      endMs: execution.endMs,
    })),
    variants: variants.map((variant) => ({
      id: variant.variantId,
      executionIds: variant.executions.map((execution) => execution.caseId),
    })),
  };
}

// ---------------------------------------------------------------------------
// Params (host pushes updates via promenade.on('params', ...); a plugin view
// never sets them itself — the generic Inspector renders controls from the
// manifest's params schema).
// ---------------------------------------------------------------------------
/** Raw values of the `chevronColor` enum param — used verbatim as `<select>`
 * option text by the host's generic params UI (it has no per-option label
 * mechanism, see `ParamControls.tsx`), so they're written as the human-facing
 * label directly rather than a machine code. */
type ChevronColorParam = 'by involved object types' | 'by activity' | 'by swimlane';
const CHEVRON_COLOR_MODE: Record<ChevronColorParam, ChevronColorMode> = {
  'by involved object types': 'objectTypes',
  'by activity': 'activity',
  'by swimlane': 'swimlane',
};

interface ViewParams {
  extraction: 'leadingType' | 'connectedComponents'; leadingType: string; coverage: number;
  maxEvents: number; scopeSharedObjects: boolean; chevronColor: ChevronColorParam;
}
const DEFAULT_PARAMS: ViewParams = {
  extraction: 'leadingType', leadingType: '', coverage: 95, maxEvents: 300,
  scopeSharedObjects: true, chevronColor: 'by involved object types',
};

function useViewParams(): ViewParams {
  const [params, setParams] = useState<ViewParams>(DEFAULT_PARAMS);
  useEffect(() => {
    promenade.on('params', (p) => {
      setParams((prev) => ({
        extraction: (p.extraction as ViewParams['extraction']) ?? prev.extraction,
        leadingType: p.leadingType !== undefined ? (p.leadingType as string) : prev.leadingType,
        coverage: (p.coverage as number) ?? prev.coverage,
        maxEvents: (p.maxEvents as number) ?? prev.maxEvents,
        scopeSharedObjects: (p.scopeSharedObjects as boolean) ?? prev.scopeSharedObjects,
        chevronColor: (p.chevronColor as ChevronColorParam) ?? prev.chevronColor,
      }));
    });
  }, []);
  return params;
}

// ---------------------------------------------------------------------------
// Shared bits ported from TraceExplorer.tsx (compact activity-chip path,
// sortable header, pagination).
// ---------------------------------------------------------------------------
/** TraceExplorer caps this at 6, tuned for its host panel's narrower width —
 * not a deliberate choice for this view. Raised generously here: a normal
 * (non-truncated) execution is typically well under this after event
 * scoping, so most rows now show their whole path with room to spare, and
 * the row simply wraps to a second line (already handled — see
 * `.trace-path-row`'s doc comment) rather than needing a cap for layout's
 * sake. It stays bounded, not removed: a *truncated* execution's path can
 * have up to `maxEvents` (default 300) entries, and rendering hundreds of
 * chips in one row would be a real cost, not just a display choice. */
const SEQUENCE_VISIBLE = 24;
const PAGE_SIZES = [25, 50, 100];
/** Caps how many variant rows ever get rendered/topo-sorted, independent of
 * the coverage %. A log with little repetition (e.g. a fine-grained leading
 * type where almost every execution is its own variant) can otherwise need
 * *thousands* of rows to reach 95% coverage — same cap TraceExplorer's own
 * `VARIANT_LIMIT` uses, so a diverse log degrades to "coverage limit not
 * reached" instead of freezing the render. */
const VARIANT_LIMIT = 1000;

function ActivityPath({ seq, selected, onToggle }: { seq: string[]; selected: (a: string) => boolean; onToggle: (a: string) => void }) {
  const shown = seq.slice(0, SEQUENCE_VISIBLE);
  const more = seq.length - shown.length;
  return <div className="trace-path" title={seq.join(' → ')}>
    {shown.map((activity, index) => <button
      className={`trace-step${selected(activity) ? ' selected' : ''}`}
      key={`${activity}-${index}`} title={activity}
      style={{ '--activity-color': promenade.color('activity', activity) } as CSSProperties}
      onClick={(event) => { event.stopPropagation(); onToggle(activity); }}
    >{activity}</button>)}
    {more > 0 && <span className="trace-more" title={`${more} more activities`}>+{more}</span>}
  </div>;
}

function SortHeader({ children, active, descending, onClick }: { children: React.ReactNode; active: boolean; descending: boolean; onClick: () => void }) {
  return <th className="num"><button className={`trace-sort${active ? ' active' : ''}`} onClick={onClick}>
    {children}<span aria-hidden="true">{active ? (descending ? '↓' : '↑') : '↕'}</span>
  </button></th>;
}

function Pagination({ page, pageSize, total, onPage, onPageSize }: { page: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize: (s: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const last = pages - 1;
  const visible = [...new Set([0, page - 1, page, page + 1, last].filter((p) => p >= 0 && p <= last))].sort((a, b) => a - b);
  return <div className="trace-pagination">
    <label>Rows per page <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
      {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
    </select></label>
    <span>{total ? `${fmtCount(page * pageSize + 1)}–${fmtCount(Math.min((page + 1) * pageSize, total))} of ${fmtCount(total)}` : 'No cases'}</span>
    <div className="trace-page-buttons">
      <button title="First page" disabled={page === 0} onClick={() => onPage(0)}>‹‹</button>
      <button title="Previous page" disabled={page === 0} onClick={() => onPage(page - 1)}>‹</button>
      {visible.map((p, index) => <Fragment key={p}>
        {index > 0 && visible[index - 1] !== p - 1 && <span>…</span>}
        <button className={p === page ? 'active' : ''} onClick={() => onPage(p)}>{p + 1}</button>
      </Fragment>)}
      <button title="Next page" disabled={page >= last} onClick={() => onPage(page + 1)}>›</button>
      <button title="Last page" disabled={page >= last} onClick={() => onPage(last)}>››</button>
    </div>
  </div>;
}

// ---------------------------------------------------------------------------
// Swimlane visualization (paper §V-B / Table I & III) — one lane per object,
// events placed in a shared DAG column so partial order and shared/concurrent
// events line up across lanes.
// ---------------------------------------------------------------------------
type ChevronColorMode = 'objectTypes' | 'activity' | 'swimlane';

/** Table I's own convention for a shared event: "colored with the
 * corresponding colors" (plural) of every object type touching it, not just
 * the lane's. Diagonal hard-stop bands read as a compact multi-color
 * chevron even at the ~90px cell width the grid uses. */
function stripeBackground(colors: string[]): string {
  if (colors.length <= 1) return colors[0] ?? 'var(--accent)';
  const seg = 100 / colors.length;
  const stops = colors.flatMap((c, i) => [`${c} ${(i * seg).toFixed(2)}%`, `${c} ${((i + 1) * seg).toFixed(2)}%`]);
  return `linear-gradient(135deg, ${stops.join(', ')})`;
}

function Swimlane({ exec, typeOf, selected, onToggle, colorMode }: {
  exec: ExecutionDetail; typeOf: Map<string, string>; selected: (a: string) => boolean; onToggle: (a: string) => void;
  colorMode: ChevronColorMode;
}) {
  const cols = useMemo(() => layerColumns(exec.graph), [exec]);
  const maxCol = Math.max(0, ...exec.graph.events.map((e) => cols.get(e.id) ?? 0));

  const cellsByObject = useMemo(() => {
    const map = new Map<string, Map<number, ExecEvent>>();
    for (const ev of exec.graph.events) {
      const c = cols.get(ev.id) ?? 0;
      for (const oid of exec.touchingByEvent.get(ev.id) ?? []) {
        if (!map.has(oid)) map.set(oid, new Map());
        map.get(oid)!.set(c, ev);
      }
    }
    return map;
  }, [exec, cols]);

  /** With `scopeSharedObjects` on, O' can still list far more objects than
   * ever get an owned event (Def. 6 keeps every object tied at the minimum
   * per-type distance — on a log with many identical-distance ties, that can
   * be hundreds). A lane with zero cells shows nothing and, at real scale,
   * turns rendering the grid into the actual bottleneck — so it's dropped
   * from display, not just left empty. */
  const hiddenEmptyLanes = exec.objectIds.length - cellsByObject.size;
  const lanes = useMemo(() => {
    const byType = new Map<string, string[]>();
    for (const oid of exec.objectIds) {
      if (!cellsByObject.has(oid)) continue;
      const t = typeOf.get(oid) ?? '?';
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t)!.push(oid);
    }
    for (const list of byType.values()) list.sort();
    return [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [exec, typeOf, cellsByObject]);

  const [scrolled, setScrolled] = useState(false);

  /** One entry per lane row, in display order — computed once and shared by
   * both panes below instead of walking `lanes` twice. */
  const rows = useMemo(() => lanes.flatMap(([type, ids]) => ids.map((oid) => {
    const typeColor = promenade.color('objectType', type);
    // "By involved object types" carries the per-lane pale wash too — the
    // chevrons already show every touching type, but the lane band is what
    // makes a lane's *own* type readable at a glance without having to
    // decode which stripe belongs to it.
    const washed = colorMode === 'swimlane' || colorMode === 'objectTypes';
    const band = washed ? `color-mix(in srgb, ${typeColor} 20%, var(--bg))` : undefined;
    return { type, oid, typeColor, washed, band };
  })), [lanes, colorMode]);

  return <div className="swim-wrap">
    {exec.truncated && <div className="trace-detail-label" style={{ marginBottom: 6 }}>
      Showing the first {fmtCount(exec.eventCount)} events (chronologically) — this execution's real object graph
      is larger, most likely because a shared hub object (an employee, a warehouse, a busy customer) links a big
      part of the log together. Raise "Max events per execution" in the view's params to see more, at the cost of
      a slower extraction.
    </div>}
    {hiddenEmptyLanes > 0 && <div className="trace-detail-label" style={{ marginBottom: 6 }}>
      {fmtCount(hiddenEmptyLanes)} object{hiddenEmptyLanes === 1 ? '' : 's'} in this execution have no events of
      their own here (tied at the same closest distance per Def. 6, but their events belong to other executions
      under "Scope shared objects to their closest case") and are hidden from the lanes below.
    </div>}
    {/* Two independent panes, not one grid with a sticky first column: a grid
     * item's containing block for `position: sticky` purposes is its own
     * grid area (here, 120px), not the whole grid — so a sticky label column
     * built that way stops sticking as soon as the scroll passes its own
     * column's width, which is exactly the "sticks briefly, then drifts"
     * bug this replaced. A plain non-scrolling label pane next to an
     * independently `overflow-x: auto` cell pane has no such ceiling — the
     * label simply never scrolls, so it never needs to catch up to a
     * containing block at all. No scroll-sync is needed between the two:
     * `.swim-wrap` never scrolls vertically (unbounded height, no
     * max-height), so only the horizontal axis, owned solely by the cell
     * pane, is ever in play. */}
    <div className={`swim-body${scrolled ? ' scrolled' : ''}`}>
      <div className="swim-labels">
        {rows.map(({ type, oid, typeColor, washed, band }) => (
          <div
            className="swim-lane-label"
            key={oid}
            style={washed ? { background: band } : { borderLeft: `3px solid ${typeColor}` }}
            title={oid}
          >
            <span className="swim-lane-type">{type}</span><span className="swim-lane-id">{oid}</span>
          </div>
        ))}
      </div>
      <div className="swim-cells" onScroll={(e) => setScrolled(e.currentTarget.scrollLeft > 0)}>
        <div className="swim-grid" style={{ gridTemplateColumns: `repeat(${maxCol + 1}, minmax(90px, auto))` }}>
          {rows.map(({ oid, typeColor, band }) => {
            const cells = cellsByObject.get(oid);
            return <Fragment key={oid}>
              {Array.from({ length: maxCol + 1 }).map((_, c) => {
                const ev = cells?.get(c);
                let chevronBg = typeColor;
                let multiColor = false;
                if (ev) {
                  if (colorMode === 'activity') {
                    chevronBg = promenade.color('activity', ev.activity);
                  } else if (colorMode === 'objectTypes') {
                    const touchingTypes = [...new Set([...(exec.touchingByEvent.get(ev.id) ?? [])].map((o) => typeOf.get(o) ?? '?'))]
                      .sort((a, b) => a.localeCompare(b));
                    const colors = touchingTypes.map((t) => promenade.color('objectType', t));
                    chevronBg = stripeBackground(colors);
                    multiColor = colors.length > 1;
                  } else {
                    chevronBg = typeColor;
                  }
                }
                return <div className="swim-cell" style={{ background: band }} key={c}>
                  {ev && <button className={`trace-step${selected(ev.activity) ? ' selected' : ''}${multiColor ? ' trace-step-multi' : ''}`}
                    style={{ '--activity-color': chevronBg } as CSSProperties}
                    title={`${ev.activity}\n${ev.id}`}
                    onClick={() => onToggle(ev.activity)}
                  >{ev.activity}</button>}
                </div>;
              })}
            </Fragment>;
          })}
        </div>
      </div>
    </div>
  </div>;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
type VariantSortKey = 'execCount' | 'share' | 'avgEvents' | 'avgObjects' | 'avgDurationMs';
type CaseSort = 'start_asc' | 'start_desc' | 'duration_desc' | 'length_desc';

function App({ name }: { name: string }) {
  useHostTheme();
  const params = useViewParams();
  const [raw, setRaw] = useState<RawData | null>(null);
  const [legend, setLegend] = useState<Array<{ activity: string; event_count: number }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<{ items: SelectionItem[] }>({ items: [] });
  const [tab, setTab] = useState<'variants' | 'cases'>('variants');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [variantSort, setVariantSort] = useState<{ key: VariantSortKey; desc: boolean }>({ key: 'execCount', desc: true });
  const [caseSort, setCaseSort] = useState<CaseSort>('start_asc');
  const [casePage, setCasePage] = useState(0);
  const [casePageSize, setCasePageSize] = useState(50);
  const [variantPage, setVariantPage] = useState(0);
  const [variantPageSize, setVariantPageSize] = useState(50);
  const [legendFilter, setLegendFilter] = useState('');
  const [publishState, setPublishState] = useState<'idle' | 'publishing' | 'published' | 'error'>('idle');
  const [publishMessage, setPublishMessage] = useState('');

  const [executions, setExecutions] = useState<ExecutionDetail[] | null>(null);
  /** Captured once, at mount — see the extraction effect below for why. */
  const initialCacheRef = useRef<CachedState | null>(null);

  useEffect(() => {
    promenade.ready();
    // Closing this panel's tab and reopening it still gets a brand-new
    // iframe (there is no way around that), but the host remembers whatever
    // was last handed to `setCachedState` for this exact panel — so a
    // reopen can skip straight back to a populated view instead of redoing
    // the SQL fetch and the extraction that follows it.
    //
    // `cachedState()` is an RPC (awaited here), not a value read
    // synchronously off this effect — a large cached value costs real,
    // sometimes multi-second, structured-clone time to cross back into a
    // fresh iframe, and by the time this component's first effect runs,
    // React has already committed and painted its first render (this
    // `useEffect` runs strictly after that paint). `executions` starts
    // `null`, so that first paint is already the loading chevrons — the
    // clone cost, whichever way this resolves, now lands *after* something
    // is already on screen, not before anything could be.
    promenade.cachedState().then((cachedValue) => {
      const cached = cachedValue as CachedState | null;
      initialCacheRef.current = cached;
      if (cached?.raw) {
        setRaw(cached.raw);
        setLegend(cached.legend ?? null);
      } else {
        loadRawData().then(setRaw).catch((e) => setError(String(e?.message ?? e)));
        queryTables<{ activity: string; event_count: number }>(`SELECT activity, COUNT(*) AS event_count FROM {event} GROUP BY activity ORDER BY event_count DESC, activity`)
          .then((rows) => setLegend(rows.map((r) => ({ activity: r.activity, event_count: Number(r.event_count) }))));
      }
    });
    promenade.on('selection', (s) => setSel({ items: s.items }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const objectTypesByFrequency = useMemo(() => {
    if (!raw) return [] as string[];
    const counts = new Map<string, number>();
    for (const t of raw.typeOf.values()) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [raw]);
  const leadingType = params.leadingType || objectTypesByFrequency[0] || '';

  /**
   * Everything expensive, in one sliced, cancellable run.
   *
   * Both halves of this (extraction, then variant grouping) used to be a
   * `setTimeout(…, 0)` around a single synchronous call. That got the
   * loading state painted first, which was the bug being fixed at the time,
   * but the call itself still held the main thread from start to finish: on
   * the Logistics log that was long enough for the browser to offer to kill
   * the page. There is no Worker to move it to — the sandboxed frame's CSP
   * is `default-src 'none'` with no `worker-src` — so the stages are
   * generators and `runPipeline` drives them in ~12ms slices instead. The
   * tab keeps painting, the progress below is real (it counts executions,
   * it does not animate on a timer), and Cancel is noticed within a slice.
   *
   * `initialCacheRef` — captured once, at mount, before any params change
   * can happen — still lets a reopen with the *same* extraction settings
   * skip the whole thing: if the cached `execSig` matches what this exact
   * combination of params would produce, the cached results are reused
   * outright. A later params change no longer matches that fixed signature
   * and simply stops taking this branch.
   */
  const [variantSummaries, setVariantSummaries] = useState<VariantSummary[] | null>(null);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [canceled, setCanceled] = useState(false);
  /** Bumped by Retry to re-run an attempt the user previously canceled. */
  const [runAttempt, setRunAttempt] = useState(0);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!raw) { setExecutions(null); setVariantSummaries(null); return; }
    const sig = JSON.stringify([params.extraction, leadingType, params.maxEvents, params.scopeSharedObjects]);
    const cached = initialCacheRef.current;
    if (cached?.executions && cached.variantSummaries && cached.execSig === sig) {
      setExecutions(cached.executions);
      setVariantSummaries(cached.variantSummaries);
      return;
    }

    let disposed = false;
    cancelRef.current = false;
    setCanceled(false);
    setExecutions(null);
    setVariantSummaries(null);
    setProgress(null);

    runPipeline(
      {
        extraction: params.extraction,
        leadingType,
        raw,
        maxEvents: params.maxEvents,
        scopeSharedObjects: params.scopeSharedObjects,
      },
      {
        isCanceled: () => disposed || cancelRef.current,
        onProgress: (p) => { if (!disposed) setProgress({ ...p }); },
      },
    ).then((result) => {
      if (disposed) return;
      setProgress(null);
      // `null` means canceled — leave the results empty and say so, rather
      // than silently showing a view built from nothing.
      if (!result) { setCanceled(cancelRef.current); return; }
      setExecutions(result.executions);
      setVariantSummaries(result.variantSummaries);
    }).catch((e) => {
      if (disposed) return;
      setProgress(null);
      setError(String((e as Error)?.message ?? e));
      setExecutions([]);
      setVariantSummaries([]);
    });

    // A params change (or unmount) abandons the run in flight: the driver
    // stops at its next slice rather than finishing work nobody wants.
    return () => { disposed = true; };
  }, [raw, params.extraction, leadingType, params.maxEvents, params.scopeSharedObjects, runAttempt]);

  // Saved once every piece is in — not saved incrementally, so a reopen
  // never restores a `raw` without its `legend`, or an `executions`/
  // `variantSummaries` that does not actually match the params `execSig`
  // claims it does.
  useEffect(() => {
    if (!raw || !legend || !executions || !variantSummaries) return;
    const execSig = JSON.stringify([params.extraction, leadingType, params.maxEvents, params.scopeSharedObjects]);
    promenade.setCachedState({ raw, legend, executions, variantSummaries, execSig });
  }, [raw, legend, executions, variantSummaries, params.extraction, leadingType, params.maxEvents, params.scopeSharedObjects]);

  useEffect(() => { setExpanded(new Set()); setCasePage(0); setVariantPage(0); }, [executions]);

  const isSelected = (activity: string) => sel.items.some((item) => item.kind === 'activity' && item.id === activity);
  const toggleSelect = (activity: string) => promenade.select(isSelected(activity) ? [] : [{ kind: 'activity', id: activity }]);
  const toggleExpanded = (key: string) => setExpanded((prev) => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next; });

  const totalExecutions = executions?.length ?? 0;
  const totalVariants = variantSummaries?.length ?? 0;

  const shownVariants = useMemo(() => {
    if (!variantSummaries?.length) return { rows: [] as VariantSummary[], reachedCoverage: true };
    // variantSummaries is already sorted by execCount desc (summarizeVariants).
    const pool = variantSummaries.slice(0, VARIANT_LIMIT);
    const target = (params.coverage / 100) * totalExecutions;
    let total = 0;
    const cutoff = pool.findIndex((v) => (total += v.execCount) >= target);
    return { rows: pool.slice(0, cutoff < 0 ? pool.length : cutoff + 1), reachedCoverage: cutoff >= 0 };
  }, [variantSummaries, params.coverage, totalExecutions]);

  const sortedVariants = useMemo(() => [...shownVariants.rows].sort((a, b) => {
    const av = variantSort.key === 'share' ? a.execCount / (totalExecutions || 1) : a[variantSort.key];
    const bv = variantSort.key === 'share' ? b.execCount / (totalExecutions || 1) : b[variantSort.key];
    return (av - bv) * (variantSort.desc ? -1 : 1);
  }), [shownVariants.rows, variantSort, totalExecutions]);
  const changeVariantSort = (key: VariantSortKey) => setVariantSort((cur) => cur.key === key ? { key, desc: !cur.desc } : { key, desc: true });
  useEffect(() => { setVariantPage(0); }, [sortedVariants]);
  const pagedVariants = sortedVariants.slice(variantPage * variantPageSize, (variantPage + 1) * variantPageSize);

  const caseOrder: Record<CaseSort, (a: ExecutionDetail, b: ExecutionDetail) => number> = {
    start_asc: (a, b) => a.startMs - b.startMs || a.caseId.localeCompare(b.caseId),
    start_desc: (a, b) => b.startMs - a.startMs || a.caseId.localeCompare(b.caseId),
    duration_desc: (a, b) => (b.endMs - b.startMs) - (a.endMs - a.startMs) || a.caseId.localeCompare(b.caseId),
    length_desc: (a, b) => b.eventCount - a.eventCount || a.caseId.localeCompare(b.caseId),
  };
  const sortedCases = useMemo(() => executions ? [...executions].sort(caseOrder[caseSort]) : [], [executions, caseSort]);
  const pagedCases = sortedCases.slice(casePage * casePageSize, (casePage + 1) * casePageSize);

  const filteredLegend = useMemo(() => legend?.filter((e) => e.activity.toLowerCase().includes(legendFilter.toLowerCase())), [legend, legendFilter]);
  const publishPartition = async () => {
    if (!executions || !variantSummaries || publishState === 'publishing') return;
    setPublishState('publishing'); setPublishMessage('Publishing execution partition…');
    try {
      const partition = toExecutionPartition(promenade.artifact().id, executions, variantSummaries, params, leadingType);
      const result = await promenade.publishExecutionPartition(partition, `Execution partition · ${name}`);
      setPublishState('published'); setPublishMessage(`Published “${result.name}”.`);
    } catch (e) {
      setPublishState('error'); setPublishMessage(String((e as Error)?.message ?? e));
    }
  };

  return <div className="oc-body trace-explorer">
    <div className="trace-header">
      <div><h2>Cases &amp; variants</h2><p>Object-centric process executions and their variants — {name}.</p></div>
      {executions && <div className="trace-kpis"><span><b>{fmtCount(totalExecutions)}</b> executions</span><span><b>{fmtCount(totalVariants)}</b> variants</span>
        <button type="button" onClick={publishPartition} disabled={!variantSummaries || publishState === 'publishing'} title="Create a reusable, source-bound execution partition for downstream views">
          {publishState === 'publishing' ? 'Publishing…' : 'Create execution partition'}
        </button>
      </div>}
    </div>
    {publishMessage && <div className={publishState === 'error' ? 'err' : 'trace-detail-label'} style={{ margin: '0 0 8px' }}>{publishMessage}</div>}
    <div className="pd-tabs trace-tabs">
      <button className={tab === 'variants' ? 'active' : ''} onClick={() => setTab('variants')}>Variants</button>
      <button className={tab === 'cases' ? 'active' : ''} onClick={() => setTab('cases')}>Cases</button>
    </div>

    {error && <div className="err">{error}</div>}
    {/* Waits on `variantSummaries` too, not just `executions` — both tabs
     * share this one loading state (simpler than the Cases tab, which
     * doesn't actually need `variantSummaries`, becoming interactive
     * slightly earlier than the Variants tab would be ready), rather than
     * letting the Variants tab render with an empty, still-summarizing
     * table for however long that second deferred computation takes. */}
    {!error && canceled && <CanceledNotice onRetry={() => { setCanceled(false); setRunAttempt((n) => n + 1); }} />}
    {!error && !canceled && (!executions || !variantSummaries) && (
      <LoadingChevrons
        label="Extracting process executions"
        progress={progress}
        onCancel={() => { cancelRef.current = true; }}
      />
    )}

    {!error && executions && variantSummaries && tab === 'variants' && (() => {
      if (!executions.length) return <div className="trace-empty">No process executions yet — check the extraction method and leading object type.</div>;
      return <div className="trace-layout"><main className="trace-main">
        <div className="trace-toolbar">
          <span>Extraction: {params.extraction === 'leadingType' ? `leading type "${leadingType}"` : 'connected components'}</span>
          <span>{fmtCount(sortedVariants.length)} of {fmtCount(totalVariants)} variants · {shownVariants.reachedCoverage ? `${params.coverage}% of executions` : 'coverage limit not reached'}</span>
        </div>
        <div className="trace-table-wrap"><table className="grid trace-table trace-variants-table"><thead><tr><th className="trace-chevron-col" /><th>#</th><th>Variant path</th>
          <SortHeader active={variantSort.key === 'execCount'} descending={variantSort.desc} onClick={() => changeVariantSort('execCount')}>Executions</SortHeader>
          <SortHeader active={variantSort.key === 'share'} descending={variantSort.desc} onClick={() => changeVariantSort('share')}>Share</SortHeader>
          <SortHeader active={variantSort.key === 'avgEvents'} descending={variantSort.desc} onClick={() => changeVariantSort('avgEvents')}>Avg. events</SortHeader>
          <SortHeader active={variantSort.key === 'avgObjects'} descending={variantSort.desc} onClick={() => changeVariantSort('avgObjects')}>Avg. objects</SortHeader>
          <SortHeader active={variantSort.key === 'avgDurationMs'} descending={variantSort.desc} onClick={() => changeVariantSort('avgDurationMs')}>Avg. duration</SortHeader>
        </tr></thead><tbody>{pagedVariants.map((variant, i) => {
          const index = variantPage * variantPageSize + i;
          const open = expanded.has(variant.variantId);
          const truncated = variant.representative.truncated;
          const seq = topoActivitySeq(variant.representative.graph);
          return <Fragment key={variant.variantId}>
            <tr className="clickable" onClick={() => toggleExpanded(variant.variantId)}>
              <td className="trace-chevron-col"><span className={`trace-chevron${open ? ' open' : ''}`}>›</span></td>
              <td className="trace-rank">{index + 1}</td>
              <td>
                <div className="trace-path-row">
                  <ActivityPath seq={seq} selected={isSelected} onToggle={toggleSelect} />
                  {truncated && <span className="chip" title="This execution's real object graph is larger than the max-events cap — showing the first events only">truncated</span>}
                </div>
              </td>
              <td className="num">{fmtCount(variant.execCount)}</td>
              <td className="num">{((variant.execCount / (totalExecutions || 1)) * 100).toFixed(1)}%</td>
              <td className="num">{variant.avgEvents.toFixed(1)}</td>
              <td className="num">{variant.avgObjects.toFixed(1)}</td>
              <td className="num">{fmtMs(variant.avgDurationMs)}</td>
            </tr>
            {open && <tr className="trace-detail-row"><td /><td /><td colSpan={6}>
              <div className="trace-detail-label">Representative execution — {variant.representative.caseId}</div>
              <Swimlane exec={variant.representative} typeOf={raw!.typeOf} selected={isSelected} onToggle={toggleSelect} colorMode={CHEVRON_COLOR_MODE[params.chevronColor]} />
              <div className="trace-detail-label">Example executions</div>
              <div className="trace-case-chips">{variant.executions.slice(0, 20).map((e) => <span className="chip" key={e.caseId}>{e.caseId}</span>)}
                {variant.execCount > 20 && <span className="chip">+{fmtCount(variant.execCount - 20)} more</span>}</div>
            </td></tr>}
          </Fragment>;
        })}</tbody></table></div>
        <Pagination page={variantPage} pageSize={variantPageSize} total={sortedVariants.length} onPage={setVariantPage} onPageSize={(size) => { setVariantPageSize(size); setVariantPage(0); }} />
      </main><aside className="trace-legend"><div className="trace-legend-head"><h3>Legend</h3><span>{legend ? `${fmtCount(legend.length)} activities` : '…'}</span></div>
        <input aria-label="Search activities" value={legendFilter} onChange={(e) => setLegendFilter(e.target.value)} placeholder="Search activities…" />
        <div className="trace-legend-list">{filteredLegend?.map((entry) => <button
          className={`trace-legend-row${isSelected(entry.activity) ? ' selected' : ''}`} key={entry.activity} title={entry.activity}
          onClick={() => toggleSelect(entry.activity)}
        ><i style={{ background: promenade.color('activity', entry.activity) }} /><span>{entry.activity}</span><b>{fmtCount(entry.event_count)}</b></button>)}</div>
      </aside></div>;
    })()}

    {!error && executions && tab === 'cases' && (() => {
      if (!executions.length) return <div className="trace-empty">No cases yet.</div>;
      return <div className="trace-main trace-cases">
        <div className="trace-toolbar"><span>{fmtCount(executions.length)} cases</span>
          <label>Sort <select value={caseSort} onChange={(e) => { setCaseSort(e.target.value as CaseSort); setCasePage(0); }}>
            <option value="start_asc">Start time · oldest first</option>
            <option value="start_desc">Start time · newest first</option>
            <option value="duration_desc">Duration · longest first</option>
            <option value="length_desc">Events · most first</option>
          </select></label>
        </div>
        <div className="trace-table-wrap"><table className="grid trace-table trace-cases-table"><thead><tr><th className="trace-chevron-col" /><th>Case</th><th>Objects</th><th>Path</th><th className="num">Events</th><th>Start</th><th>End</th><th className="num">Duration</th></tr></thead>
          <tbody>{pagedCases.map((c) => {
            const key = c.caseId;
            const open = expanded.has(key);
            const objSummary = typeCountsOf(c.objectIds, raw!.typeOf).map(([t, n]) => `${n} ${t}`).join(', ');
            return <Fragment key={key}>
              <tr className="clickable" onClick={() => toggleExpanded(key)}>
                <td className="trace-chevron-col"><span className={`trace-chevron${open ? ' open' : ''}`}>›</span></td>
                <td className="trace-case-id" title={c.caseId}>{c.caseId}</td>
                <td title={objSummary}>{objSummary}</td>
                <td>
                  <div className="trace-path-row">
                    <ActivityPath seq={topoActivitySeq(c.graph)} selected={isSelected} onToggle={toggleSelect} />
                    {c.truncated && <span className="chip" title="This execution's real object graph is larger than the max-events cap — showing the first events only">truncated</span>}
                  </div>
                </td>
                <td className="num">{c.truncated ? `${fmtCount(c.eventCount)}+` : fmtCount(c.eventCount)}</td>
                <td>{fmtDate(c.startMs)}</td>
                <td>{fmtDate(c.endMs)}</td>
                <td className="num">{fmtMs(c.endMs - c.startMs)}</td>
              </tr>
              {open && <tr className="trace-detail-row"><td colSpan={8}><Swimlane exec={c} typeOf={raw!.typeOf} selected={isSelected} onToggle={toggleSelect} colorMode={CHEVRON_COLOR_MODE[params.chevronColor]} /></td></tr>}
            </Fragment>;
          })}</tbody></table></div>
        <Pagination page={casePage} pageSize={casePageSize} total={executions.length} onPage={setCasePage} onPageSize={(size) => { setCasePageSize(size); setCasePage(0); }} />
      </div>;
    })()}
  </div>;
}

const artifact = promenade.artifact();
createRoot(document.getElementById('root')!).render(<App name={artifact.name} />);
