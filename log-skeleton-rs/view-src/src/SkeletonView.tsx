import { useMemo, useState } from 'react';
import { useParams, useTheme } from './bootstrap';
import {
  relationColour, RELATION_LABEL, RELATION_SYMBOL,
  type Constraint, type LogSkeleton,
} from './types';

/**
 * A skeleton is a list of facts plus a table of counts, so the view is both.
 *
 * The counts come first, deliberately. They are the part a reader can check
 * against their own knowledge of the process in one glance — "an order is
 * confirmed exactly once, and rejected zero or one times" — and the part with
 * the most classifying power when the skeleton is later used to judge a trace.
 */

const RELATIONS = ['equivalence', 'alwaysBefore', 'alwaysAfter', 'neverTogether', 'directlyFollows'];

function percent(value: number): string {
  if (value >= 0.9995) return '100%';
  return `${(value * 100).toFixed(1)}%`;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function SkeletonView({ payload }: { payload: LogSkeleton }) {
  const theme = useTheme();
  const { sort } = useParams({ sort: 'relation' });
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState<string[]>([]);

  const text = theme.text ?? '#1c2027';
  const dim = theme['text-dim'] ?? '#6b7280';
  const border = theme.border ?? '#dfe3ea';
  const stats = payload.stats;

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (c: Constraint) =>
      !needle
      || c.sentence.toLowerCase().includes(needle)
      || c.activities.some((a) => a.toLowerCase().includes(needle));
    const list = payload.constraints.filter((c) => matches(c) && !hidden.includes(c.relation));
    if (sort === 'activity') {
      return [...list].sort(
        (l, r) => l.activities[0].localeCompare(r.activities[0])
          || l.activities[1].localeCompare(r.activities[1]),
      );
    }
    if (sort === 'support') return [...list].sort((l, r) => r.support - l.support);
    return [...list].sort(
      (l, r) => RELATIONS.indexOf(l.relation) - RELATIONS.indexOf(r.relation)
        || l.activities[0].localeCompare(r.activities[0])
        || l.activities[1].localeCompare(r.activities[1]),
    );
  }, [payload, query, hidden, sort]);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of payload.constraints) out[c.relation] = (out[c.relation] ?? 0) + 1;
    return out;
  }, [payload]);

  const countRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return payload.counts.filter((c) => !needle || c.activity.toLowerCase().includes(needle));
  }, [payload, query]);

  return (
    <div style={{
      width: '100%', height: '100%', overflow: 'auto', background: theme.bg ?? '#fff', color: text,
      font: '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 1, background: theme.bg ?? '#fff',
        borderBottom: `1px solid ${border}`, padding: '12px 16px 10px',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 15 }}>{stats.constraints} facts</strong>
          <span style={{ color: dim }}>
            over {stats.activities} activities · from {compact(stats.traces)} cases
            {stats.noise > 0 && ` · up to ${percent(stats.noise)} of cases may break a fact`}
          </span>
        </div>
        <div style={{ color: dim, fontSize: 11, marginTop: 3 }}>
          {compact(stats.candidates)} candidates considered
          {stats.dropped > 0 && ` · ${stats.dropped} left out by the size limit`}
          {payload.counts.length > 0 && ` · ${payload.counts.length} activities with a recorded number of occurrences`}
        </div>

        <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by activity…"
            style={{
              flex: '1 1 200px', minWidth: 160, padding: '4px 8px', fontSize: 12,
              border: `1px solid ${border}`, borderRadius: 5,
              background: theme['bg-soft'] ?? '#f7f8fa', color: text,
            }}
          />
          {RELATIONS.map((relation) => {
            const off = hidden.includes(relation);
            const colour = relationColour(relation, theme);
            return (
              <button
                key={relation}
                onClick={() => setHidden((h) => (off ? h.filter((r) => r !== relation) : [...h, relation]))}
                style={{
                  padding: '3px 8px', fontSize: 11, borderRadius: 999, cursor: 'pointer',
                  border: `1px solid ${off ? border : colour}`,
                  background: off ? 'transparent' : `${colour}1a`,
                  color: off ? dim : text,
                }}
              >
                <span style={{
                  display: 'inline-block', width: 7, height: 7, borderRadius: 4, marginRight: 5,
                  background: off ? border : colour,
                }} />
                {RELATION_LABEL[relation]} {counts[relation] ?? 0}
              </button>
            );
          })}
        </div>
      </div>

      {countRows.length > 0 && (
        <div style={{ padding: '14px 16px 4px' }}>
          <div style={{ color: dim, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
            How often each activity happens
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {countRows.map((c) => (
              <span
                key={c.activity}
                title={c.dropped > 0 ? `${c.dropped} case(s) had a count dropped as noise` : undefined}
                style={{
                  padding: '3px 9px', borderRadius: 999, fontSize: 11.5,
                  border: `1px solid ${border}`, background: theme['bg-soft'] ?? '#f7f8fa',
                }}
              >
                {c.activity}{' '}
                <span style={{ color: relationColour('count', theme), fontVariantNumeric: 'tabular-nums' }}>
                  {c.counts.join(' / ')}×
                </span>
                {c.dropped > 0 && <span style={{ color: dim }}> · {c.dropped} dropped</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {shown.length === 0 ? (
        <div style={{ padding: 24, color: dim }}>
          {payload.constraints.length === 0
            ? 'No fact held in every case. Allow some noise in the Inspector — a log with no fact at all is itself a finding about how free this process is.'
            : 'Nothing matches this filter.'}
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, marginTop: 10 }}>
          <thead>
            <tr style={{ color: dim, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em' }}>
              <th style={{ textAlign: 'left', padding: '8px 6px 6px 16px', fontWeight: 600 }}>Fact</th>
              <th style={{ textAlign: 'right', padding: '8px 16px 6px 6px', fontWeight: 600, width: 120 }}>Held in</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c, i) => {
              const colour = relationColour(c.relation, theme);
              return (
                <tr
                  key={`${c.relation}:${c.activities.join('>')}`}
                  onClick={() => {
                    try {
                      promenade.select(c.activities.map((a) => ({ kind: 'activity' as const, id: a })));
                    } catch { /* the host may not be listening */ }
                  }}
                  style={{
                    borderTop: `1px solid ${border}`,
                    background: i % 2 ? (theme['bg-soft'] ?? '#f7f8fa') : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <td style={{ padding: '7px 6px 7px 16px' }}>
                    <span
                      title={RELATION_LABEL[c.relation]}
                      style={{
                        display: 'inline-block', minWidth: 34, marginRight: 8, color: colour,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11,
                      }}
                    >
                      {RELATION_SYMBOL[c.relation] ?? c.relation}
                    </span>
                    {c.sentence}
                  </td>
                  <td style={{
                    padding: '7px 16px 7px 6px', textAlign: 'right', color: c.violations > 0 ? dim : text,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                    title={c.violations > 0 ? `${c.violations} case(s) broke it` : 'every case'}
                  >
                    {percent(c.support)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
