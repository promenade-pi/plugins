import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { injectCss } from '../lib/styleInject';
// @ts-ignore
import baseCss from '../lib/base.css';
import { useHostTheme } from '../lib/theme';
import { ObjectTypeSelector, ObjectSelector, AttributeSelector, EnumSelect } from '../lib/selectors';
import { getObjectAttributeHistory, getObjectAttributeNames, type HistoryEntry } from '../lib/objectState';
import { detectAttributeKind } from '../lib/attributeKind';
import { EmptyState } from '../lib/EmptyState';
import { SemanticHelp } from '../lib/SemanticHelp';
import { ExportMenu } from '../lib/ExportMenu';
import { useViewParams } from '../lib/useViewParams';
import { makeLatestOnly } from '../lib/sql';

injectCss(baseCss);

/**
 * Object Dynamics · Attribute History (spec §12), built entirely on the
 * shared dynamic-object-state service (`lib/objectState.ts`, spec §14) —
 * this view supplies no attribute-history logic of its own beyond drawing
 * what that service returns.
 */

type EntriesMode = 'changes' | 'object_events' | 'all_events';

interface Params { objectType: string; objectId: string; attributes: string[]; entries: EntriesMode }
const DEFAULTS: Params = { objectType: '', objectId: '', attributes: [], entries: 'object_events' };

const HELP = (
  <>
    One row per selected attribute, sharing a single time axis. A step segment is that attribute's value from the
    moment it took effect until its next recorded change — the same "latest value at or before" semantics used
    throughout Object Dynamics. Ticks on the event row mark this object's own events (and, in "+ related objects"
    mode, events of objects one hop away via a declared relation) — hover any segment or tick for its exact timestamp.
  </>
);

function App() {
  useHostTheme();
  const [params, setParams] = useViewParams<Params>(DEFAULTS);
  const [attrNames, setAttrNames] = useState<string[]>([]);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const guard = useRef(makeLatestOnly()).current;

  useEffect(() => { promenade.ready(); }, []);
  useEffect(() => {
    if (params.objectType) getObjectAttributeNames(params.objectType).then(setAttrNames);
    else setAttrNames([]);
  }, [params.objectType]);

  const ready = !!(params.objectId && params.attributes.length > 0);
  useEffect(() => {
    if (!ready) { setHistory(null); return; }
    setHistory(null);
    guard(getObjectAttributeHistory(params.objectId, params.attributes, params.entries), setHistory);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.objectId, params.attributes.join(','), params.entries]);

  const range = useMemo(() => {
    if (!history || history.length === 0) return null;
    const times = history.map((e) => Date.parse(e.timestamp));
    return { min: Math.min(...times), max: Math.max(...times) };
  }, [history]);

  return (
    <>
      <div className="od-toolbar">
        <span className="od-field">Object type <ObjectTypeSelector value={params.objectType} onChange={(v) => setParams({ objectType: v, objectId: '', attributes: [] })} /></span>
        <span className="od-field">Object <ObjectSelector objectType={params.objectType} value={params.objectId} onChange={(v) => setParams({ objectId: v })} /></span>
        <span className="od-field">Event context
          <EnumSelect value={params.entries} onChange={(v) => setParams({ entries: v as EntriesMode })} options={[
            { value: 'changes', label: 'None (changes only)' },
            { value: 'object_events', label: "This object's events" },
            { value: 'all_events', label: '+ related objects' },
          ]} />
        </span>
        <div className="od-toolbar-spacer" />
        <ExportMenu filename={`attribute-history-${params.objectId || 'none'}`} getElement={() => bodyRef.current} csvRows={(history ?? []).map((e) => ({ timestamp: e.timestamp, kind: e.kind, attribute: e.attribute ?? '', previousValue: e.previousValue ?? '', newValue: e.newValue ?? '', eventId: e.eventId ?? '', eventActivity: e.eventActivity ?? '' }))} />
        <SemanticHelp>{HELP}</SemanticHelp>
      </div>
      <div className="od-body" ref={bodyRef}>
        <div className="od-card" style={{ marginBottom: 12 }}>
          <div className="od-card-title">Attributes</div>
          <AttributeSelector names={attrNames} value={params.attributes} onChange={(v) => setParams({ attributes: v })} multiple />
        </div>
        {!params.objectType || !params.objectId ? <EmptyState title="Select an object" detail="Pick an object type, then search for a specific object." />
          : params.attributes.length === 0 ? <EmptyState title="Select at least one attribute" detail="Choose which recorded attributes to plot." />
          : !history ? <div className="od-loading">Loading history…</div>
          : history.length === 0 ? <EmptyState title="No history recorded" detail="This object has no recorded attribute changes or events." />
          : <TimelineChart history={history} attributes={params.attributes} range={range!} />}
      </div>
    </>
  );
}

function timeToPct(ts: string, range: { min: number; max: number }): number {
  const span = Math.max(1, range.max - range.min);
  return ((Date.parse(ts) - range.min) / span) * 100;
}

function AttributeTrack({ attribute, entries, range }: { attribute: string; entries: HistoryEntry[]; range: { min: number; max: number } }) {
  const own = entries.filter((e) => e.attribute === attribute).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  if (own.length === 0) return null;
  const kind = detectAttributeKind(own.map((e) => e.newValue ?? null));
  const isNumeric = kind === 'numeric';

  return (
    <div className="od-track">
      <div className="od-track-label">{attribute}</div>
      <div className="od-track-lane">
        {isNumeric ? (
          <svg className="od-track-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
            <polyline
              fill="none" stroke="var(--accent, #2563eb)" strokeWidth={1.5} vectorEffect="non-scaling-stroke"
              points={own.map((e) => `${timeToPct(e.timestamp, range)},${100 - Math.min(100, Math.max(0, normalize(Number(e.newValue), own)))}`).join(' ')}
            />
          </svg>
        ) : (
          own.map((e, i) => {
            const left = timeToPct(e.timestamp, range);
            const right = i + 1 < own.length ? timeToPct(own[i + 1].timestamp, range) : 100;
            return (
              <div
                key={i} className="od-track-seg"
                style={{ left: `${left}%`, width: `${Math.max(0.5, right - left)}%` }}
                title={`${attribute} = ${e.newValue} (from ${new Date(e.timestamp).toLocaleString()})`}
              >
                <span>{e.newValue}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function normalize(v: number, own: HistoryEntry[]): number {
  const values = own.map((e) => Number(e.newValue));
  const min = Math.min(...values), max = Math.max(...values);
  if (max === min) return 50;
  return ((v - min) / (max - min)) * 100;
}

function TimelineChart({ history, attributes, range }: { history: HistoryEntry[]; attributes: string[]; range: { min: number; max: number } }) {
  const events = history.filter((e) => e.kind === 'event');
  return (
    <div className="od-card">
      <div className="od-card-title">Timeline</div>
      <div className="od-card-sub">{new Date(range.min).toLocaleString()} — {new Date(range.max).toLocaleString()}</div>
      {attributes.map((a) => <AttributeTrack key={a} attribute={a} entries={history} range={range} />)}
      {events.length > 0 && (
        <div className="od-track">
          <div className="od-track-label">Events</div>
          <div className="od-track-lane od-track-lane--events">
            {events.map((e, i) => (
              <div key={i} className="od-track-tick" style={{ left: `${timeToPct(e.timestamp, range)}%` }}
                   title={`${e.eventActivity} · ${e.eventId} · ${new Date(e.timestamp).toLocaleString()}`} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
