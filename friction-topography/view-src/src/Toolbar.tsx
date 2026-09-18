/**
 * The chrome: a compact toolbar and the map legend.
 *
 * Both are glued to the terrain rather than living in the host Inspector,
 * because both are about *reading the picture* - which way is up, what the
 * colours mean, how much the relief is exaggerated. The Inspector still owns
 * the same parameters (this panel writes them back through
 * `promenade.setParams`, so a slider position is saved with the view); what
 * would be wrong is making someone look away from the map to change how the
 * map is drawn.
 */
import { useState } from 'react';

import type { FrictionMetric } from './types';
import { FRICTION_LABEL, type ViewParams } from './types';

export interface ToolbarProps {
  params: ViewParams;
  onChange: (patch: Partial<ViewParams>) => void;
  onReset: () => void;
  onTop: () => void;
  onFlyToSummit: () => void;
  summit: string | null;
  /** Which backend the renderer actually got, WebGPU or WebGL 2. */
  backend: string;
}

const METRICS: FrictionMetric[] = ['medianWait', 'p90Wait', 'meanWait', 'totalWait', 'reworkRate'];

export function Toolbar(props: ToolbarProps) {
  const { params, onChange } = props;
  // Local, not a view param: whether the controls are tucked away is a
  // per-session convenience for reclaiming screen space, not something worth
  // persisting with the saved view the way the controls' own values are.
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="ft-toolbar">
      <div className="ft-toolbar-head">
        <span className="ft-toolbar-title">Elevation</span>
        <button
          type="button"
          className="ft-icon-button"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand controls' : 'Collapse controls'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="ft-toolbar-row">
            <label className="ft-select">
              <select
                value={params.frictionMetric}
                onChange={(event) => onChange({ frictionMetric: event.target.value as FrictionMetric })}
                title="Which statistic the terrain height represents"
              >
                {METRICS.map((metric) => (
                  <option key={metric} value={metric}>{FRICTION_LABEL[metric]}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="ft-toolbar-row">
            <button type="button" className="ft-button" onClick={props.onReset} title="Back to the opening view">
              Reset view
            </button>
            <button
              type="button"
              className={`ft-button ${params.viewMode === 'top' ? 'is-active' : ''}`}
              onClick={props.onTop}
              title="Look straight down: the terrain becomes a plan-view heat map"
            >
              {params.viewMode === 'top' ? 'Oblique' : 'Top-down'}
            </button>
            {props.summit && (
              <button type="button" className="ft-button ft-button-accent" onClick={props.onFlyToSummit} title={props.summit}>
                Fly to bottleneck
              </button>
            )}
          </div>

          <div className="ft-toolbar-row">
            <label className="ft-slider" title="Exaggerate the relief without changing what it means">
              <span>Relief</span>
              <input
                type="range"
                min={0.2}
                max={2.6}
                step={0.05}
                value={params.verticalScale}
                onChange={(event) => onChange({ verticalScale: Number(event.target.value) })}
              />
              <span className="ft-slider-value">{params.verticalScale.toFixed(2)}&times;</span>
            </label>
          </div>

          <div className="ft-toolbar-row ft-toolbar-toggles">
            {([
              ['showContours', 'Contours'],
              ['showStreams', 'Flows'],
              ['showLabels', 'Labels'],
              ['animateFlow', 'Motion'],
            ] as Array<[keyof ViewParams, string]>).map(([field, label]) => (
              <label key={field} className="ft-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(params[field])}
                  onChange={(event) => onChange({ [field]: event.target.checked } as Partial<ViewParams>)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>

          <div className="ft-backend">
            {props.backend && <span title="three.js WebGPURenderer picks WebGPU where available and falls back to WebGL 2">{props.backend}</span>}
            <button
              type="button"
              className="ft-backend-toggle"
              onClick={() => onChange({ renderer: params.renderer === 'webgl2' ? 'auto' : 'webgl2' })}
              title={params.renderer === 'webgl2'
                ? 'Let the renderer choose WebGPU where it is available'
                : 'Pin the WebGL 2 backend, for a machine where WebGPU misbehaves'}
            >
              {params.renderer === 'webgl2' ? 'auto' : 'force WebGL 2'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The map key.
 *
 * A three-dimensional encoding is only as good as its legend: elevation,
 * carved depth and colour all mean something specific here, and none of them
 * is guessable. The glyphs are drawn rather than described so the shape a
 * reader is looking for is the shape they see in the key.
 */
export function Legend({
  metric, objectCentric, hasRoute,
}: {
  metric: FrictionMetric;
  objectCentric: boolean;
  hasRoute: boolean;
}) {
  const entityWord = objectCentric ? 'object' : 'case';
  return (
    <div className="ft-legend">
      <span className="ft-legend-item">
        <svg viewBox="0 0 44 14" className="ft-glyph" aria-hidden>
          <path d="M1 4 C 10 4, 12 11, 22 11 C 32 11, 34 4, 43 4" className="ft-glyph-valley" />
        </svg>
        valley = routine flow
      </span>
      <span className="ft-legend-item">
        <svg viewBox="0 0 44 14" className="ft-glyph" aria-hidden>
          <path d="M1 12 C 12 12, 14 2, 22 2 C 30 2, 32 12, 43 12" className="ft-glyph-ridge" />
        </svg>
        ridge = {FRICTION_LABEL[metric].toLowerCase()}
      </span>
      <span className={`ft-legend-item ${hasRoute ? '' : 'is-dim'}`}>
        <svg viewBox="0 0 44 14" className="ft-glyph" aria-hidden>
          <path d="M1 7 H 43" className="ft-glyph-route" />
        </svg>
        route = selected {entityWord}
      </span>
    </div>
  );
}
