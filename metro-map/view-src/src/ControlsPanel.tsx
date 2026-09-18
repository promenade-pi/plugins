import { useEffect, useRef, useState } from 'react';
import type { Coverage } from './complexity';
import type { ViewParams } from './types';

export function ControlsPanel({
  basis, theme, params, onParamsChange, complexity, sliderMax, onComplexityChange, coverage,
}: {
  basis: 'petriNet' | 'directlyFollows';
  theme: Record<string, string>;
  params: ViewParams;
  onParamsChange: (next: Partial<ViewParams>) => void;
  complexity: number;
  sliderMax: number;
  onComplexityChange: (v: number) => void;
  coverage: Coverage;
}) {
  // Local echo of the slider so dragging feels instant; the real filter
  // recompute is debounced so a drag doesn't relayout on every pixel.
  const [local, setLocal] = useState(complexity);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => setLocal(complexity), [complexity]);

  const commit = (v: number) => {
    setLocal(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onComplexityChange(v), 110);
  };
  const step = (d: number) => commit(Math.min(sliderMax, Math.max(0, local + d)));
  // Only the OC-DFG basis carries per-arc numbers to print.
  const labelsAvailable = basis === 'directlyFollows';

  const box: React.CSSProperties = {
    background: theme['bg-soft'], border: `1px solid ${theme.border}`, borderRadius: 8,
    padding: 10, minWidth: 190, fontSize: 11, color: theme.text, boxShadow: '0 2px 8px rgba(0,0,0,.08)',
    display: 'flex', flexDirection: 'column', gap: 9,
  };
  const label: React.CSSProperties = { fontWeight: 600, color: theme['text-dim'], fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 };

  return (
    <div style={box}>
      <div>
        <div style={label}>{basis === 'directlyFollows' ? 'Detail' : 'Complexity'}</div>
        {/* Vertical: more detail upward, less downward — the same direction
            as the reading of the map itself, and it keeps the panel narrow. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
            <button type="button" onClick={() => step(1)} title="More detail" style={btn(theme)}>+</button>
            <input
              type="range" min={0} max={Math.max(1, sliderMax)} step={1} value={local}
              onChange={(e) => commit(Number(e.target.value))}
              aria-label="Detail"
              style={{
                // `vertical-lr` + `rtl` is the standard way to stand a range
                // input up with its maximum at the top.
                writingMode: 'vertical-lr', direction: 'rtl',
                width: 16, height: 104, padding: 0,
                accentColor: theme.accent, cursor: 'pointer',
              }}
            />
            <button type="button" onClick={() => step(-1)} title="Less detail" style={btn(theme)}>−</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 1.35 }}>
            <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {coverage.primaryShown} / {coverage.primaryTotal}
            </span>
            <span style={{ color: theme['text-dim'] }}>{coverage.primaryLabel}</span>
            <span style={{ color: theme['text-dim'], marginTop: 4 }}>{coverage.pct}% shown</span>
            <span style={{ color: theme['text-dim'], fontVariantNumeric: 'tabular-nums' }}>
              {coverage.secondaryShown} / {coverage.secondaryTotal} {coverage.secondaryLabel}
            </span>
          </div>
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

      {/* Only the OC-DFG basis has anything to print on an arc. A Petri net
          is a structural model — its arcs carry no counts and no timestamps —
          so the whole section is hidden rather than shown disabled next to an
          explanation nobody can act on from here. */}
      {labelsAvailable && (
        <div>
          <div style={label}>Edge labels</div>
          <select
            value={params.edgeLabel}
            onChange={(e) => onParamsChange({ edgeLabel: e.target.value as ViewParams['edgeLabel'] })}
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
      )}

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
        title="On: moving the slider only ever reveals more detail, never reshuffles what's already shown. Off: every slider position is laid out fresh from only what's currently visible."
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
