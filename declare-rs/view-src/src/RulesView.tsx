import { useMemo, useState } from 'react';
import { useParams, useTheme } from './bootstrap';
import { familyColour, FAMILY_OF, SYMBOL_OF, type Constraint, type DeclareModel } from './types';

/**
 * A DECLARE model is a list of sentences, so the view is a list of sentences.
 *
 * Deliberately not a node-link diagram. DECLARE's own notation draws
 * constraints as decorated edges between activities, which is unreadable past
 * about twenty of them — and a discovered model has hundreds. What a reader
 * actually does with a discovered model is scan it for rules they did not
 * expect, and that is reading, sorting and filtering. The symbol from the
 * notation is kept next to each rule for anyone who knows it.
 */

const FAMILIES = ['single activity', 'ordering', 'alternating', 'immediate', 'never'] as const;

function percent(value: number): string {
  if (value >= 0.9995) return '100%';
  return `${(value * 100).toFixed(1)}%`;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** A number from 0 to 1 as a bar, because a column of percentages does not sort itself in the eye. */
function Bar({ value, colour, theme }: { value: number; colour: string; theme: Record<string, string> }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{
        width: 46, height: 5, borderRadius: 3, flex: '0 0 auto',
        background: theme['bg-sunken'] ?? '#eef0f4', overflow: 'hidden',
      }}>
        <div style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, height: '100%', background: colour }} />
      </div>
      <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 11 }}>{percent(value)}</span>
    </div>
  );
}

export function RulesView({ payload }: { payload: DeclareModel }) {
  const theme = useTheme();
  const { sort } = useParams({ sort: 'confidence' });
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState<string[]>([]);

  const text = theme.text ?? '#1c2027';
  const dim = theme['text-dim'] ?? '#6b7280';
  const border = theme.border ?? '#dfe3ea';

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (c: Constraint) =>
      !needle
      || c.sentence.toLowerCase().includes(needle)
      || c.template.toLowerCase().includes(needle)
      || c.activities.some((a) => a.toLowerCase().includes(needle));

    const list = payload.constraints.filter(
      (c) => matches(c) && !hidden.includes(FAMILY_OF[c.template] ?? ''),
    );
    const by = (c: Constraint) => {
      switch (sort) {
        case 'support': return [-c.support, -c.confidence];
        case 'activations': return [-c.activations, -c.confidence];
        default: return [-c.confidence, -c.activations];
      }
    };
    if (sort === 'template') {
      return [...list].sort((l, r) => l.template.localeCompare(r.template) || r.confidence - l.confidence);
    }
    if (sort === 'activity') {
      return [...list].sort(
        (l, r) => l.activities[0].localeCompare(r.activities[0])
          || (l.activities[1] ?? '').localeCompare(r.activities[1] ?? ''),
      );
    }
    return [...list].sort((l, r) => {
      const [a1, a2] = by(l);
      const [b1, b2] = by(r);
      return a1 - b1 || a2 - b2;
    });
  }, [payload, query, hidden, sort]);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of payload.constraints) {
      const family = FAMILY_OF[c.template] ?? 'other';
      out[family] = (out[family] ?? 0) + 1;
    }
    return out;
  }, [payload]);

  const stats = payload.stats;

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
          <strong style={{ fontSize: 15 }}>{stats.constraints} rules</strong>
          <span style={{ color: dim }}>
            over {stats.activities} activities · from {compact(stats.traces)} cases ·
            {' '}support ≥ {percent(stats.minSupport)}, confidence ≥ {percent(stats.minConfidence)}
          </span>
        </div>
        <div style={{ color: dim, fontSize: 11, marginTop: 3 }}>
          {compact(stats.candidates)} candidates considered
          {stats.pruned > 0 && ` · ${stats.pruned} dropped as implied by a stronger rule`}
          {stats.dropped > 0 && ` · ${stats.dropped} left out by the size limit`}
        </div>

        <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by activity or rule…"
            style={{
              flex: '1 1 200px', minWidth: 160, padding: '4px 8px', fontSize: 12,
              border: `1px solid ${border}`, borderRadius: 5,
              background: theme['bg-soft'] ?? '#f7f8fa', color: text,
            }}
          />
          {FAMILIES.map((family) => {
            const off = hidden.includes(family);
            const colour = familyColour(
              Object.keys(FAMILY_OF).find((t) => FAMILY_OF[t] === family) ?? '', theme,
            );
            return (
              <button
                key={family}
                onClick={() => setHidden((h) => (off ? h.filter((f) => f !== family) : [...h, family]))}
                title={`${counts[family] ?? 0} rules`}
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
                {family} {counts[family] ?? 0}
              </button>
            );
          })}
        </div>
      </div>

      {shown.length === 0 ? (
        <div style={{ padding: 24, color: dim }}>
          {payload.constraints.length === 0
            ? 'No rule held often enough to be kept. Lower the support or confidence threshold in the Inspector — a log with no rule at all is itself a finding about how free this process is.'
            : 'Nothing matches this filter.'}
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: dim, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em' }}>
              <th style={{ textAlign: 'left', padding: '8px 6px 6px 16px', fontWeight: 600 }}>Rule</th>
              <th style={{ textAlign: 'left', padding: '8px 6px 6px', fontWeight: 600, width: 110 }}>Support</th>
              <th style={{ textAlign: 'left', padding: '8px 6px 6px', fontWeight: 600, width: 110 }}>Confidence</th>
              <th style={{ textAlign: 'right', padding: '8px 16px 6px 6px', fontWeight: 600, width: 90 }}>Applies to</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c, i) => {
              const colour = familyColour(c.template, theme);
              return (
                <tr
                  key={`${c.template}:${c.activities.join('>')}`}
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
                      title={`${c.template} · ${FAMILY_OF[c.template] ?? ''}`}
                      style={{
                        display: 'inline-block', minWidth: 42, marginRight: 8, color: colour,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11,
                      }}
                    >
                      {SYMBOL_OF[c.template] ?? c.template}
                    </span>
                    {c.sentence}
                  </td>
                  <td style={{ padding: '7px 6px' }}>
                    <Bar value={c.support} colour={colour} theme={theme} />
                  </td>
                  <td style={{ padding: '7px 6px' }}>
                    <Bar value={c.confidence} colour={colour} theme={theme} />
                  </td>
                  <td style={{
                    padding: '7px 16px 7px 6px', textAlign: 'right', color: dim,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                    title={`${c.activations} of ${stats.traces} cases could have broken this rule; ${c.violations} did`}
                  >
                    {compact(c.activations)} cases
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
