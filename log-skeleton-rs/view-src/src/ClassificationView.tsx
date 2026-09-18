import { useMemo } from 'react';
import { useParams, useTheme } from './bootstrap';
import { relationColour, RELATION_LABEL, RELATION_SYMBOL, type SkeletonDiagnostics } from './types';

/**
 * What the skeleton decided about each case, and which fact each rejection
 * turned on.
 *
 * "Fitting" is the paper's own word and the paper's own claim: a log skeleton
 * classifies traces, so the headline is the share of cases it accepts, not a
 * distance. Facts are ordered by how often they were broken, because a fact
 * broken by half the cases is a finding about the *fact* — usually that the
 * skeleton came from a different population than the log being judged.
 */

function percent(value: number): string {
  if (value >= 0.9995) return '100%';
  if (value > 0 && value < 0.001) return '<0.1%';
  return `${(value * 100).toFixed(1)}%`;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function ClassificationView({ payload }: { payload: SkeletonDiagnostics }) {
  const theme = useTheme();
  const { show } = useParams({ show: 'broken' });

  const text = theme.text ?? '#1c2027';
  const dim = theme['text-dim'] ?? '#6b7280';
  const border = theme.border ?? '#dfe3ea';
  const danger = theme.danger ?? '#d64550';
  const ok = theme.ok ?? '#15803d';
  const stats = payload.stats;

  const rules = useMemo(() => {
    const list = payload.constraints.filter((c) => show === 'all' || c.violations > 0);
    return [...list].sort((l, r) => r.violations - l.violations);
  }, [payload, show]);

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
          <strong style={{ fontSize: 15, color: stats.nonFitting === 0 ? ok : text }}>
            {percent(stats.fitness)} of cases fit the skeleton
          </strong>
          <span style={{ color: dim }}>
            {compact(stats.fitting)} of {compact(stats.traces)} cases ·
            {' '}{compact(stats.violations)} broken facts across {stats.constraints} rules
            {stats.countRules > 0 && ` (${stats.countRules} about how often an activity happens)`}
          </span>
        </div>
        <div style={{ color: dim, fontSize: 11, marginTop: 3 }}>
          {payload.unknownActivities.length > 0
            && `Activities this log does not record: ${payload.unknownActivities.join(', ')}. `}
          {payload.unknownRelations.length > 0
            && `Relation types this build does not know, left unchecked: ${payload.unknownRelations.join(', ')}. `}
          {payload.unconstrainedActivities.length > 0
            && `No fact mentions: ${payload.unconstrainedActivities.slice(0, 8).join(', ')}${payload.unconstrainedActivities.length > 8 ? '…' : ''}.`}
        </div>
      </div>

      {rules.length === 0 ? (
        <div style={{ padding: 24, color: dim }}>
          {stats.constraints === 0
            ? 'This skeleton has no facts to check.'
            : 'Every fact held in every case. Switch “Show” to “Every fact” in the Inspector to see them all.'}
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: dim, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em' }}>
              <th style={{ textAlign: 'left', padding: '8px 6px 6px 16px', fontWeight: 600 }}>Fact</th>
              <th style={{ textAlign: 'right', padding: '8px 6px 6px', fontWeight: 600, width: 90 }}>Broken by</th>
              <th style={{ textAlign: 'left', padding: '8px 16px 6px 6px', fontWeight: 600, width: 120 }}>Share of cases</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((c, i) => {
              const colour = c.violations > 0 ? danger : relationColour(c.relation, theme);
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
                      title={RELATION_LABEL[c.relation] ?? c.relation}
                      style={{
                        display: 'inline-block', minWidth: 34, marginRight: 8, color: colour,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11,
                      }}
                    >
                      {RELATION_SYMBOL[c.relation] ?? c.relation}
                    </span>
                    {c.sentence}
                    {c.unknownActivity && (
                      <span style={{ color: dim, fontStyle: 'italic' }}> — names an activity this log never records</span>
                    )}
                  </td>
                  <td style={{ padding: '7px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {c.violations === 0 ? <span style={{ color: ok }}>—</span> : compact(c.violations)}
                  </td>
                  <td style={{ padding: '7px 16px 7px 6px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{
                        width: 52, height: 5, borderRadius: 3, flex: '0 0 auto',
                        background: theme['bg-sunken'] ?? '#eef0f4', overflow: 'hidden',
                      }}>
                        <div style={{ width: `${Math.min(1, c.violationRate) * 100}%`, height: '100%', background: danger }} />
                      </div>
                      <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 11, color: dim }}>
                        {percent(c.violationRate)}
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {payload.cases.length > 0 && (
        <div style={{ padding: '16px 16px 24px' }}>
          <div style={{ color: dim, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
            Cases that broke the most facts
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {payload.cases.slice(0, 60).map((c) => (
              <span
                key={c.case}
                title={c.violated.map((i) => payload.constraints[i]?.sentence ?? '').join('\n')}
                style={{
                  padding: '3px 8px', borderRadius: 999, fontSize: 11,
                  border: `1px solid ${border}`, background: theme['bg-soft'] ?? '#f7f8fa',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                case {c.case} · {c.violated.length} {c.violated.length === 1 ? 'fact' : 'facts'}
              </span>
            ))}
          </div>
          <div style={{ color: dim, fontSize: 11, marginTop: 8 }}>
            Case numbers are the log's own case index. Hover one to read the facts it broke.
          </div>
        </div>
      )}
    </div>
  );
}
