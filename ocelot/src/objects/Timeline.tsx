import { useMemo, useState } from 'react';

interface AttrHistoryEntry { value: string; ts: string }
interface EventForTimeline { eventId: string; activity: string; ts: string; attrs: Array<{ name: string; value: string }> }

type TimelineEntry =
  | { kind: 'event'; time: string; eventId: string; activity: string; eventAttrs: Array<{ name: string; value: string }>; initialAttributes: Array<{ name: string; value: string }> }
  | { kind: 'attribute-change'; time: string; name: string; previousValue: string | null; newValue: string; isInitial: boolean };

/**
 * Chronological merge of related events and attribute-history rows, exactly
 * as Ocelot's `useObjectDetail` builds `timelineEntries`: an attribute's
 * very first recorded value folds into whichever event shares its exact
 * (millisecond) timestamp as that event's "created with" list, rather than
 * appearing as its own "change" row — a creation-time value isn't a change.
 * Every other history row becomes its own entry with `previous -> new`.
 */
function buildTimeline(
  attributeHistory: Map<string, AttrHistoryEntry[]>,
  relatedEvents: EventForTimeline[]
): TimelineEntry[] {
  const eventEntries: Extract<TimelineEntry, { kind: 'event' }>[] = relatedEvents.map((e) => ({
    kind: 'event', time: e.ts, eventId: e.eventId, activity: e.activity, eventAttrs: e.attrs, initialAttributes: [],
  }));
  const byExactTime = new Map<number, Extract<TimelineEntry, { kind: 'event' }>[]>();
  for (const e of eventEntries) {
    const ms = Date.parse(e.time);
    if (!byExactTime.has(ms)) byExactTime.set(ms, []);
    byExactTime.get(ms)!.push(e);
  }

  const attrEntries: Extract<TimelineEntry, { kind: 'attribute-change' }>[] = [];
  for (const [name, history] of attributeHistory) {
    history.forEach((entry, i) => {
      if (i === 0) {
        const ms = Date.parse(entry.ts);
        const matches = byExactTime.get(ms);
        if (matches && matches.length > 0) {
          matches[0].initialAttributes.push({ name, value: entry.value });
          return;
        }
        attrEntries.push({ kind: 'attribute-change', time: entry.ts, name, previousValue: null, newValue: entry.value, isInitial: true });
      } else {
        attrEntries.push({ kind: 'attribute-change', time: entry.ts, name, previousValue: history[i - 1].value, newValue: entry.value, isInitial: false });
      }
    });
  }

  return [...eventEntries, ...attrEntries].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

export function TimelineTab({ attributeHistory, relatedEvents }: {
  attributeHistory: Map<string, AttrHistoryEntry[]>;
  relatedEvents: EventForTimeline[];
}) {
  const [showEvents, setShowEvents] = useState(true);
  const [showChanges, setShowChanges] = useState(true);
  const [eventTypeFilter, setEventTypeFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const entries = useMemo(() => buildTimeline(attributeHistory, relatedEvents), [attributeHistory, relatedEvents]);
  const eventTypeOptions = useMemo(
    () => [...new Set(relatedEvents.map((e) => e.activity))].sort(),
    [relatedEvents]
  );

  const filtered = useMemo(() => {
    const fromMs = dateFrom ? Date.parse(dateFrom) : -Infinity;
    const toMs = dateTo ? Date.parse(dateTo + 'T23:59:59') : Infinity;
    return entries.filter((e) => {
      if (e.kind === 'event' && !showEvents) return false;
      if (e.kind === 'attribute-change' && !showChanges) return false;
      if (e.kind === 'event' && eventTypeFilter !== 'all' && e.activity !== eventTypeFilter) return false;
      const t = Date.parse(e.time);
      return t >= fromMs && t <= toMs;
    });
  }, [entries, showEvents, showChanges, eventTypeFilter, dateFrom, dateTo]);

  return (
    <div>
      <div className="oc-toolbar" style={{ borderBottom: 0, padding: '0 0 12px' }}>
        <label><input type="checkbox" checked={showEvents} onChange={(e) => setShowEvents(e.target.checked)} /> Events</label>
        <label><input type="checkbox" checked={showChanges} onChange={(e) => setShowChanges(e.target.checked)} /> Attribute changes</label>
        <select className="oc-input" value={eventTypeFilter} onChange={(e) => setEventTypeFilter(e.target.value)}>
          <option value="all">All event types</option>
          {eventTypeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input type="date" className="oc-input" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        <span style={{ color: 'var(--text-dim)' }}>–</span>
        <input type="date" className="oc-input" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
      </div>

      {filtered.length === 0 && <div className="oc-empty">No timeline entries match these filters.</div>}

      <div className="oc-timeline">
        {filtered.map((e, i) => (
          <div key={i} className={`oc-timeline-entry${e.kind === 'attribute-change' ? ' is-attr' : ''}`}>
            <span className="oc-timeline-dot" />
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <div>
                {e.kind === 'event' ? (
                  <>
                    <strong>{e.activity}</strong> <span className="oc-chip">Event</span>
                    {e.eventAttrs.length > 0 && (
                      <div style={{ fontSize: 12, marginTop: 3 }}>
                        {e.eventAttrs.map((a) => <div key={a.name}>{a.name}: {a.value}</div>)}
                      </div>
                    )}
                    {e.initialAttributes.length > 0 && (
                      <div style={{ fontSize: 12, marginTop: 3, color: 'var(--text-dim)' }}>
                        Object created with: {e.initialAttributes.map((a) => `${a.name}=${a.value}`).join(', ')}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <strong>{e.name}</strong> <span className="oc-chip">Attribute change</span>
                    <div style={{ fontSize: 12, marginTop: 3 }}>
                      {e.isInitial ? <>{e.newValue} <span style={{ color: 'var(--text-dim)' }}>(initial value)</span></> : <>{e.previousValue} → {e.newValue}</>}
                    </div>
                  </>
                )}
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{new Date(e.time).toLocaleString()}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
