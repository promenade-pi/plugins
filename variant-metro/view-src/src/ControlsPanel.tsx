import { useEffect, useRef, useState } from 'react';
import type { Coverage } from './variants';
import type { ViewParams, VariantSummary } from './types';

export function ControlsPanel({
  theme, params, onParamsChange, position, sliderMax, onPositionChange, coverage, at,
}: {
  theme: Record<string, string>;
  params: ViewParams;
  onParamsChange: (next: Partial<ViewParams>) => void;
  position: number;
  sliderMax: number;
  onPositionChange: (v: number) => void;
  coverage: Coverage;
  /** The variant this slider position adds, for the "this notch" readout. */
  at: VariantSummary | undefined;
}) {
  // Local echo of the slider so dragging feels instant; the real filter
  // recompute is debounced so a drag doesn't relayout on every pixel.
  const [local, setLocal] = useState(position);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => setLocal(position), [position]);

  const commit = (v: number) => {
    setLocal(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onPositionChange(v), 110);
  };
  const step = (d: number) => commit(Math.min(sliderMax, Math.max(1, local + d)));

  const box: React.CSSProperties = {
    background: theme['bg-soft'], border: `1px solid ${theme.border}`, borderRadius: 8,
    padding: 10, minWidth: 196, fontSize: 11, color: theme.text, boxShadow: '0 2px 8px rgba(0,0,0,.08)',
    display: 'flex', flexDirection: 'column', gap: 9,
  };
  const label: React.CSSProperties = { fontWeight: 600, color: theme['text-dim'], fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 };

  return (
    <div style={box}>
      <div>
        <div style={label}>Variants</div>
        {/* Vertical, maximum at the top: the whole log at the top of the
            slider, the single most frequent variant at the bottom. Same
            direction as the reading of the map itself, and it keeps the
            panel narrow. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
            <button type="button" onClick={() => step(1)} title="One more variant" style={btn(theme)}>+</button>
            <input
              type="range" min={1} max={Math.max(1, sliderMax)} step={1} value={local}
              onChange={(e) => commit(Number(e.target.value))}
              aria-label="Variants shown"
              style={{
                // `vertical-lr` + `rtl` is the standard way to stand a range
                // input up with its maximum at the top.
                writingMode: 'vertical-lr', direction: 'rtl',
                width: 16, height: 104, padding: 0,
                accentColor: theme.accent, cursor: 'pointer',
              }}
            />
            <button type="button" onClick={() => step(-1)} title="One fewer variant" style={btn(theme)}>−</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 1.35 }}>
            <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {coverage.primaryShown} / {coverage.primaryTotal}
            </span>
            <span style={{ color: theme['text-dim'] }}>
              {coverage.primaryLabel}{coverage.tail ? ' (all)' : ''}
            </span>
            <span style={{ color: theme['text-dim'], marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
              {coverage.pct}% {coverage.pctLabel}
            </span>
            <span style={{ color: theme['text-dim'], fontVariantNumeric: 'tabular-nums' }}>
              {coverage.secondaryShown} / {coverage.secondaryTotal} {coverage.secondaryLabel}
            </span>
            <span style={{ color: theme['text-dim'], fontVariantNumeric: 'tabular-nums' }}>
              {coverage.tertiaryShown} / {coverage.tertiaryTotal} {coverage.tertiaryLabel}
            </span>
          </div>
        </div>
        {/* What *this* notch is, as opposed to how much is on screen: at the
            bottom the single most frequent variant, at the top the whole log
            — the two readings the plugin is for. */}
        <div style={{ marginTop: 6, color: theme['text-dim'], lineHeight: 1.4 }}>
          {local <= 1
            ? <>Most frequent variant only{at?.executions != null ? <> — {at.executions.toLocaleString('en')} case{at.executions === 1 ? '' : 's'}</> : null}.</>
            : local >= sliderMax
              ? <>Every variant — the whole log.</>
              : <>The {local.toLocaleString('en')} most frequent variants{coverage.tail ? ', and every remaining one' : ''}.</>}
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 8 }}>
        <div style={label}>Stations</div>
        <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
          {(['dots', 'labels'] as const).map((s) => (
            <button
              key={s} type="button" onClick={() => onParamsChange({ stationStyle: s })}
              style={{
                ...btn(theme), flex: 1, fontWeight: params.stationStyle === s ? 700 : 400,
                background: params.stationStyle === s ? theme.accent : 'transparent',
                color: params.stationStyle === s ? theme.bg : theme.text,
              }}
            >
              {s === 'dots' ? '● dots' : '▭ labels'}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div style={label}>Edge labels</div>
        <select
          value={params.edgeLabel}
          onChange={(e) => onParamsChange({ edgeLabel: e.target.value as ViewParams['edgeLabel'] })}
          title="Counted over the variants currently shown, not over the whole log."
          style={{
            marginTop: 4, width: '100%', fontSize: 11, padding: '3px 4px',
            border: `1px solid ${theme.border}`, borderRadius: 5,
            background: 'transparent', color: theme.text, cursor: 'pointer',
          }}
        >
          <option value="none">None</option>
          <option value="frequency">Frequency</option>
          <option value="performance">Performance</option>
        </select>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
        <input
          type="checkbox" checked={params.animateFlow}
          onChange={(e) => onParamsChange({ animateFlow: e.target.checked })}
          style={{ margin: 0, cursor: 'pointer' }}
        />
        <span>Animate flow</span>
      </label>

      <label
        style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
        title="On: adding a variant only ever reveals more detail, never reshuffles what's already shown. Off: every slider position is laid out fresh from only what's currently visible."
      >
        <input
          type="checkbox" checked={params.preserveStability}
          onChange={(e) => onParamsChange({ preserveStability: e.target.checked })}
          style={{ margin: 0, cursor: 'pointer' }}
        />
        <span>Preserve layout stability</span>
      </label>
    </div>
  );
}

function btn(theme: Record<string, string>): React.CSSProperties {
  return {
    border: `1px solid ${theme.border}`, borderRadius: 5, background: 'transparent', color: theme.text,
    cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: '3px 7px', minWidth: 22,
  };
}
