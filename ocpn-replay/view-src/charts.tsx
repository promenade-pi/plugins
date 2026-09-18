import { useMemo } from 'react';
import type { ExpectedInteractionField, ReplayEventRow } from './evidence';

type Theme = Record<string, string>;

function fmtInt(n: number): string {
  return n.toLocaleString();
}

/** Support over the replay's timestamp-total order, bucketed to the panel width. */
export function SupportTimeline({ events, theme, cursorFrac }: {
  events: ReplayEventRow[];
  theme: Theme;
  cursorFrac: number | null;
}) {
  const W = 232;
  const H = 64;
  const buckets = useMemo(() => {
    const n = Math.min(W, Math.max(1, events.length));
    const acc = new Array(n).fill(0);
    const cnt = new Array(n).fill(0);
    events.forEach((e, i) => {
      const b = Math.min(n - 1, Math.floor((i / events.length) * n));
      acc[b] += e.support;
      cnt[b] += 1;
    });
    return acc.map((s, i) => (cnt[i] ? s / cnt[i] : 0));
  }, [events]);

  const path = buckets
    .map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i / (buckets.length - 1 || 1)) * W} ${H - v * H}`)
    .join(' ');
  const area = `${path} L ${W} ${H} L 0 ${H} Z`;

  return (
    <div>
      <ChartHead label="Event support" hint="mean replayed fraction, in timestamp order" theme={theme} />
      <svg width={W} height={H} style={{ display: 'block' }}>
        <path d={area} fill={`${theme.accent}22`} />
        <path d={path} fill="none" stroke={theme.accent} strokeWidth={1.5} />
        <line x1={0} y1={H - 0.5} x2={W} y2={H - 0.5} stroke={theme.border} />
        {cursorFrac != null && (
          <line x1={cursorFrac * W} y1={0} x2={cursorFrac * W} y2={H} stroke={theme.text} strokeWidth={1} strokeDasharray="2 2" />
        )}
      </svg>
    </div>
  );
}

/** Log moves vs silent model moves, as a stacked proportion bar. */
export function MoveBreakdown({ events, theme }: { events: ReplayEventRow[]; theme: Theme }) {
  const { support, logMoves, silentModel } = useMemo(() => {
    let s = 0; let lm = 0; let mm = 0;
    for (const e of events) { s += e.support; lm += e.logMoves; mm += e.modelMoves; }
    return { support: s, logMoves: lm, silentModel: mm };
  }, [events]);
  const meanSupport = events.length ? support / events.length : 0;
  const total = logMoves + silentModel || 1;

  return (
    <div>
      <ChartHead label="Moves" hint="over the whole replay" theme={theme} />
      <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', border: `1px solid ${theme.border}` }}>
        <span style={{ width: `${(logMoves / total) * 100}%`, background: theme.danger }} title={`${fmtInt(logMoves)} log moves`} />
        <span style={{ width: `${(silentModel / total) * 100}%`, background: theme['text-dim'] }} title={`${fmtInt(silentModel)} silent model moves`} />
      </div>
      <dl style={{ margin: '8px 0 0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px', fontSize: 11 }}>
        <Row k="Mean support" v={`${(meanSupport * 100).toFixed(1)}%`} theme={theme} />
        <Row k="Log moves" v={fmtInt(logMoves)} theme={theme} dot={theme.danger} />
        <Row k="Silent model moves" v={fmtInt(silentModel)} theme={theme} dot={theme['text-dim']} />
        <Row k="Events" v={fmtInt(events.length)} theme={theme} />
      </dl>
    </div>
  );
}

/** One expected-interaction field as a lifecycle-phase heatmap. */
export function InteractionHeatmap({ field, theme }: { field: ExpectedInteractionField; theme: Theme }) {
  const { binCount, mass } = field;
  const cell = Math.max(3, Math.floor(220 / binCount));
  const max = mass.reduce((m, v) => Math.max(m, v), 0) || 1;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: theme.text, marginBottom: 4 }}>
        {field.pair.a} × {field.pair.b}
      </div>
      <svg width={cell * binCount} height={cell * binCount} style={{ display: 'block', border: `1px solid ${theme.border}` }}>
        {mass.map((v, i) => {
          if (v <= 0) return null;
          const x = (i % binCount) * cell;
          const y = Math.floor(i / binCount) * cell;
          return <rect key={i} x={x} y={y} width={cell} height={cell} fill={theme.accent} opacity={0.15 + 0.85 * (v / max)} />;
        })}
      </svg>
      <div style={{ fontSize: 10, color: theme['text-dim'], marginTop: 2 }}>
        phase of {field.pair.a} → · phase of {field.pair.b} ↓
      </div>
    </div>
  );
}

function ChartHead({ label, hint, theme }: { label: string; hint: string; theme: Theme }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: theme.text }}>{label}</div>
      <div style={{ fontSize: 10, color: theme['text-dim'] }}>{hint}</div>
    </div>
  );
}

function Row({ k, v, theme, dot }: { k: string; v: string; theme: Theme; dot?: string }) {
  return (
    <>
      <dt style={{ color: theme['text-dim'], display: 'flex', alignItems: 'center', gap: 5 }}>
        {dot && <span style={{ width: 8, height: 8, borderRadius: 2, background: dot }} />}
        {k}
      </dt>
      <dd style={{ margin: 0, color: theme.text, fontVariantNumeric: 'tabular-nums' }}>{v}</dd>
    </>
  );
}
