import { useEffect, useMemo, useRef, useState } from 'react';
import { CurveChart, type CurveChartHandle } from './CurveChart';
import { DistanceHistogram, type DistanceHistogramHandle } from './DistanceHistogram';
import { Heatmap, type HeatmapHandle } from './Heatmap';
import { ACTIVITY_COLORS, CLUSTER_COLORS } from './palette';
import {
  buildMatrix, buildRowSeries, MATRIX_METRICS, matrixMetricOf, metricAvailable,
  rowMetricAvailable, ROW_METRICS, sortOrder, type MatrixMetricKey, type RowMetricKey,
} from './matrixMetrics';
import { defaultMatrixParams, format3, type FuzzyModelPayload, type MatrixViewParams } from './types';

/**
 * ProM's Fuzzy Miner metrics screen was two panels: a coloured matrix of the
 * *binary* metrics (one value per ordered pair) and a separate multi-curve
 * chart of the *unary* ones (one value per activity). This view renders both,
 * as a mode toggle over one shared shell — same activity order, same metric
 * fallback banner, same "Export PNG" button routed to whichever chart is
 * active — rather than as two disconnected panels.
 */

interface ExportableHandle {
  exportPng(): void;
}

export function MatrixView({ payload }: { payload: FuzzyModelPayload }) {
  const [theme, setTheme] = useState<Record<string, string>>(promenade.theme());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Owns its params the same way `plugin.tsx`'s `App` owns `ViewParams`:
  // `views[].ownsControls` means the host hands them over through the
  // `params` event (a saved view's restore arrives after the first paint,
  // not baked into `artifact()`) rather than rendering its own controls.
  const [params, setParams] = useState<MatrixViewParams>(defaultMatrixParams);
  const chartRef = useRef<ExportableHandle>(null);

  useEffect(() => {
    promenade.on('theme', (p) => setTheme(p.theme));
    promenade.on('selection', (sel) => {
      setSelected(new Set(sel.items.filter((i) => i.kind === 'activity').map((i) => i.id)));
    });
    promenade.on('params', (next) => setParams((cur) => ({ ...cur, ...(next as Partial<MatrixViewParams>) })));
    promenade.ready();
  }, []);

  const onChange = (patch: Partial<MatrixViewParams>) => {
    setParams((cur) => ({ ...cur, ...patch }));
    promenade.setParams(patch as Record<string, unknown>);
  };

  const order = useMemo(() => sortOrder(payload, params.sort), [payload, params.sort]);

  // A saved view can persist a metric this run's model doesn't have (mined
  // without `includeMetricDetail`, say) — fall back to the weighted total /
  // overall significance rather than showing nothing, and say so.
  const metricFellBack = !metricAvailable(payload, params.metric);
  const effectiveMetric: MatrixMetricKey = metricFellBack ? 'weightedSignificance' : params.metric;
  const rowMetricFellBack = !rowMetricAvailable(payload, params.rowMetric);
  const effectiveRowMetric: RowMetricKey = rowMetricFellBack ? 'nodeSignificance' : params.rowMetric;

  const matrix = useMemo(() => buildMatrix(payload, effectiveMetric, order), [payload, effectiveMetric, order]);
  const rowSeries = useMemo(
    () => buildRowSeries(payload, effectiveRowMetric, order),
    [payload, effectiveRowMetric, order]
  );
  const family = matrixMetricOf(effectiveMetric).family;
  const palette = family === 'significance' ? ACTIVITY_COLORS : CLUSTER_COLORS;

  const exportPng = () => chartRef.current?.exportPng();

  const toolbarStyle: React.CSSProperties = {
    flex: '0 0 auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12,
    padding: '8px 12px', borderBottom: `1px solid ${theme.border}`, background: theme['bg-soft'],
    fontSize: 11, color: theme.text,
  };
  const fieldStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 };
  const labelStyle: React.CSSProperties = {
    fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: theme['text-dim'],
  };
  const selectStyle: React.CSSProperties = {
    fontSize: 11, padding: '3px 5px', borderRadius: 4, border: `1px solid ${theme.border}`,
    background: theme.bg, color: theme.text, cursor: 'pointer',
  };
  const modeButtonStyle = (active: boolean): React.CSSProperties => ({
    fontSize: 11, padding: '4px 9px', borderRadius: 4, border: `1px solid ${theme.border}`,
    background: active ? theme.accent : theme.bg, color: active ? '#fff' : theme.text,
    cursor: 'pointer', fontWeight: active ? 600 : 400,
  });

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: theme.bg }}>
      <div style={toolbarStyle}>
        <div style={fieldStyle}>
          <span style={labelStyle}>View</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button type="button" style={modeButtonStyle(params.mode === 'matrix')} onClick={() => onChange({ mode: 'matrix' })}>
              Matrix
            </button>
            <button type="button" style={modeButtonStyle(params.mode === 'curves')} onClick={() => onChange({ mode: 'curves' })}>
              Curves
            </button>
            <button
              type="button" style={modeButtonStyle(params.mode === 'histogram')}
              onClick={() => onChange({ mode: 'histogram' })}
              title="How many relation observations the scan found at each look-back distance, and the current attenuation curve over them"
            >
              Distances
            </button>
          </div>
        </div>

        {params.mode === 'matrix' && (
          <div style={fieldStyle}>
            <span style={labelStyle}>Matrix metric</span>
            <select
              style={selectStyle}
              value={params.metric}
              onChange={(e) => onChange({ metric: e.target.value as MatrixMetricKey })}
            >
              {MATRIX_METRICS.map((m) => (
                <option key={m.key} value={m.key} disabled={m.needsDetail && !metricAvailable(payload, m.key)}>
                  {m.label}{m.needsDetail && !metricAvailable(payload, m.key) ? ' (not kept)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        {params.mode === 'matrix' && (
          <div style={fieldStyle}>
            <span style={labelStyle}>Row metric</span>
            <select
              style={selectStyle}
              value={params.rowMetric}
              onChange={(e) => onChange({ rowMetric: e.target.value as RowMetricKey })}
            >
              {ROW_METRICS.map((m) => (
                <option key={m.key} value={m.key} disabled={m.needsDetail && !rowMetricAvailable(payload, m.key)}>
                  {m.label}{m.needsDetail && !rowMetricAvailable(payload, m.key) ? ' (not kept)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        {params.mode !== 'histogram' && (
          <div style={fieldStyle}>
            <span style={labelStyle}>Sort</span>
            <select
              style={selectStyle}
              value={params.sort}
              onChange={(e) => onChange({ sort: e.target.value as MatrixViewParams['sort'] })}
            >
              <option value="significance">By significance</option>
              <option value="alphabetical">Alphabetical</option>
            </select>
          </div>
        )}

        {params.mode !== 'histogram' && (
          <div style={fieldStyle}>
            <span style={labelStyle}>{params.mode === 'matrix' ? 'Cell size' : 'Point spacing'}</span>
            <input
              type="range" min={8} max={36} step={1} value={params.cellSize}
              onChange={(e) => onChange({ cellSize: Number(e.target.value) })}
              style={{ width: 90 }}
            />
          </div>
        )}

        {params.mode === 'histogram' && (
          <div style={{ ...fieldStyle, fontSize: 10.5, color: theme['text-dim'] }}>
            <span style={labelStyle}>Current mining params</span>
            <span>
              Max distance <b style={{ color: theme.text }}>{payload.stats.maximalDistance}</b>
              {' · '}
              {payload.stats.attenuation === 'linear' ? 'Linear' : 'Nth-root'} attenuation, radical{' '}
              <b style={{ color: theme.text }}>{payload.stats.radical}</b>
            </span>
          </div>
        )}

        {params.mode === 'matrix' && (
          <div style={{ ...fieldStyle, marginLeft: 'auto' }}>
            <span style={labelStyle}>Legend</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ color: theme['text-dim'] }}>0</span>
              <div style={{
                width: 70, height: 9, borderRadius: 3,
                background: `linear-gradient(to right, ${palette.join(', ')})`,
                border: `1px solid ${theme.border}`,
              }} />
              <span style={{ color: theme['text-dim'] }}>{matrix ? format3(matrix.max) : '1.000'}</span>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={exportPng}
          title="Export the current chart as a PNG"
          style={{
            fontSize: 11, padding: '4px 9px', borderRadius: 4, border: `1px solid ${theme.border}`,
            background: theme.bg, color: theme.text, cursor: 'pointer',
            marginLeft: params.mode !== 'matrix' ? 'auto' : undefined,
          }}
        >
          Export PNG
        </button>
      </div>

      {params.mode === 'matrix' && (metricFellBack || rowMetricFellBack) && (
        <div style={{
          flex: '0 0 auto', padding: '6px 12px', fontSize: 10.5, color: theme['text-dim'],
          borderBottom: `1px solid ${theme.border}`, background: theme['bg-soft'],
        }}>
          Per-metric detail wasn't kept for this run — re-run Fuzzy Miner with "Keep per-metric values"
          enabled to inspect the individual metrics separately. Showing the weighted total instead.
        </div>
      )}

      {params.mode === 'matrix' && (
        <Heatmap
          ref={chartRef as React.Ref<HeatmapHandle>}
          payload={payload} order={order} matrix={matrix} rowSeries={rowSeries} palette={palette}
          cellSize={params.cellSize} theme={theme} selected={selected}
          effectiveMetric={effectiveMetric} effectiveRowMetric={effectiveRowMetric}
        />
      )}
      {params.mode === 'curves' && (
        <CurveChart
          ref={chartRef as React.Ref<CurveChartHandle>}
          payload={payload} order={order} spacing={Math.max(24, params.cellSize * 1.6)}
          theme={theme} selected={selected}
        />
      )}
      {params.mode === 'histogram' && (
        <DistanceHistogram
          ref={chartRef as React.Ref<DistanceHistogramHandle>}
          payload={payload} theme={theme}
        />
      )}
    </div>
  );
}
