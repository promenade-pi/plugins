/**
 * The panel furniture: the title bar, the legend, the camera buttons and the
 * platform inspector.
 *
 * All of it carries `data-ms-chrome`, which is how `Labels.tsx` finds these
 * boxes at run time and refuses to place a platform name underneath one. That
 * is a measurement rather than a declaration on purpose — every one of these
 * panels changes size with its content.
 */
import type { Depth } from './depth';
import type { Platform, StationMap, ViewParams } from './types';
import { formatCount, formatDuration } from './types';

export function Toolbar({
  name,
  map,
  params,
  onChange,
  backend,
}: {
  name: string;
  map: StationMap;
  params: ViewParams;
  onChange: (patch: Partial<ViewParams>) => void;
  backend: string;
}) {
  return (
    <div className="ms-toolbar" data-ms-chrome>
      <h1 className="ms-title">{name}</h1>
      <span className="ms-chip is-static" title={`Mined from ${map.stats.basis} inside this action`}>
        {map.stats.basis}
      </span>
      <label className="ms-chip is-select" title="Whether depth is proportional to elapsed time or to its logarithm">
        <span className="ms-chip-glyph" aria-hidden="true">◷</span>
        <select
          value={params.timeScale}
          onChange={(event) => onChange({ timeScale: event.target.value as ViewParams['timeScale'] })}
        >
          <option value="logarithmic">Logarithmic depth</option>
          <option value="linear">Linear depth</option>
        </select>
      </label>
      <button
        type="button"
        className={`ms-chip is-toggle ${params.viewMode === 'flat' ? 'is-on' : ''}`}
        onClick={() =>
          onChange({ viewMode: params.viewMode === 'flat' ? 'time-depth' : 'flat' })
        }
        title="Collapse the depth axis and look straight down — the same routes as an ordinary 2D metro map"
      >
        {params.viewMode === 'flat' ? 'Flat' : '3D'}
      </button>
      {backend && backend !== 'WebGPU' && backend !== 'WebGL 2' && (
        <span className="ms-chip is-warn">{backend}</span>
      )}
    </div>
  );
}

export function Legend({
  map,
  depth,
  colors,
  highlight,
  onHighlight,
  params,
}: {
  map: StationMap;
  depth: Depth;
  colors: Map<string, string>;
  highlight: string | null;
  onHighlight: (name: string | null) => void;
  params: ViewParams;
}) {
  return (
    <div className="ms-legend" data-ms-chrome>
      <h2>Object types</h2>
      <ul>
        {map.objectTypes.map((type) => (
          <li key={type.name}>
            <button
              type="button"
              className={highlight && highlight !== type.name ? 'is-dim' : ''}
              onClick={() => onHighlight(highlight === type.name ? null : type.name)}
              title={`${formatCount(type.count)} events over ${type.route.length} platforms — click to follow this lifecycle alone`}
            >
              <span className="ms-swatch" style={{ background: colors.get(type.name) }} />
              <span className="ms-legend-name">{type.name}</span>
            </button>
          </li>
        ))}
      </ul>
      {params.viewMode !== 'flat' && depth.unit === 'time' && (
        <>
          <h2>Time depth</h2>
          <ul className="ms-legend-depth">
            <li>
              <span className="ms-swatch is-glass" />
              <span className="ms-legend-name">Waiting — a lift shaft</span>
            </li>
            <li>
              <span className="ms-swatch is-car" />
              <span className="ms-legend-name">Cars only go down</span>
            </li>
            <li>
              <span className="ms-swatch is-stairs" />
              <span className="ms-legend-name">A shorter wait — stairs</span>
            </li>
          </ul>
        </>
      )}
      {depth.unit === 'steps' && (
        <p className="ms-note">
          This OC-DFG carries no timing, so depth counts hand-offs rather than seconds.
        </p>
      )}
    </div>
  );
}

export function CameraButtons({
  params,
  onChange,
  onZoom,
  onReset,
}: {
  params: ViewParams;
  onChange: (patch: Partial<ViewParams>) => void;
  onZoom: (by: number) => void;
  onReset: () => void;
}) {
  return (
    <div className="ms-camera" data-ms-chrome>
      <div className="ms-buttons">
        <button type="button" onClick={() => onZoom(0.78)} title="Zoom in">＋</button>
        <button type="button" onClick={() => onZoom(1.28)} title="Zoom out">－</button>
      </div>
      <button type="button" className="ms-round" onClick={onReset} title="Back to the opening view">
        ◎
      </button>
      {params.viewMode !== 'flat' && (
        <label className="ms-slider" title="Vertical exaggeration">
          <span>Depth</span>
          <input
            type="range"
            min={0.25}
            max={2.5}
            step={0.05}
            value={params.depthScale}
            onChange={(event) => onChange({ depthScale: Number(event.target.value) })}
          />
        </label>
      )}
    </div>
  );
}

export function Inspector({
  platform,
  map,
  depth,
  colors,
  onClose,
  onFocus,
  onHighlight,
}: {
  platform: Platform;
  map: StationMap;
  depth: Depth;
  colors: Map<string, string>;
  onClose: () => void;
  onFocus: () => void;
  onHighlight: (name: string) => void;
}) {
  const arriving = map.lines.filter((line) => line.target === platform.id && !line.selfLoop);
  const leaving = map.lines.filter((line) => line.source === platform.id && !line.selfLoop);
  const byId = new Map(map.platforms.map((p) => [p.id, p]));
  const shaft = map.shafts
    .filter((s) => s.target === platform.id)
    .sort((a, b) => Math.abs(b.tBottom - b.tTop) - Math.abs(a.tBottom - a.tTop))[0];

  return (
    <div className="ms-inspector" data-ms-chrome>
      <header>
        <h2>{platform.activity}</h2>
        <div className="ms-inspector-actions">
          <button type="button" onClick={onFocus} title="Fly to this platform">⌖</button>
          <button type="button" onClick={onClose} title="Close">✕</button>
        </div>
      </header>

      <dl className="ms-facts">
        <div>
          <dt>Depth</dt>
          <dd>
            {depth.unit === 'time'
              ? formatDuration(platform.t)
              : `${Math.round(platform.t)} steps`}
            <small>into the process</small>
          </dd>
        </div>
        <div>
          <dt>Occurrences</dt>
          <dd>{formatCount(platform.count)}</dd>
        </div>
      </dl>

      {shaft && depth.unit === 'time' && (
        <p className="ms-shaft-note">
          The deepest arrival here drops <strong>{formatDuration(Math.abs(shaft.tBottom - shaft.tTop))}</strong>{' '}
          from {shaft.source}
          {shaft.critical ? (
            ', which is the wait that sets this platform’s depth.'
          ) : (
            <>
              , though that hand-off’s own measured wait is{' '}
              {formatDuration(shaft.waitSecs)} — a platform has one depth, and it is
              the deepest of the paths that reach it.
            </>
          )}
        </p>
      )}

      <h3>Routes through</h3>
      <ul className="ms-types">
        {platform.objectTypes.map((type, index) => (
          <li key={type}>
            <button type="button" onClick={() => onHighlight(type)}>
              <span className="ms-swatch" style={{ background: colors.get(type) }} />
              <span className="ms-legend-name">{type}</span>
              <span className="ms-count">{formatCount(platform.counts[index] ?? 0)}</span>
            </button>
          </li>
        ))}
      </ul>

      <h3>Hand-offs</h3>
      <ul className="ms-handoffs">
        {arriving.map((line) => (
          <li key={`in:${line.id}`}>
            <span className="ms-swatch" style={{ background: colors.get(line.objectType) }} />
            <span className="ms-arrow">←</span>
            <span className="ms-legend-name">{line.source}</span>
            <span className="ms-count">
              {depth.unit === 'time' ? formatDuration(line.waitSecs) : formatCount(line.freq)}
            </span>
          </li>
        ))}
        {leaving.map((line) => (
          <li key={`out:${line.id}`}>
            <span className="ms-swatch" style={{ background: colors.get(line.objectType) }} />
            <span className="ms-arrow">→</span>
            <span className="ms-legend-name">{line.target}</span>
            <span className="ms-count">
              {depth.unit === 'time'
                ? formatDuration(
                    byId.has(line.target)
                      ? Math.abs((byId.get(line.target)!.t ?? 0) - platform.t)
                      : line.waitSecs
                  )
                : formatCount(line.freq)}
            </span>
          </li>
        ))}
        {arriving.length === 0 && leaving.length === 0 && <li className="ms-empty">None drawn.</li>}
      </ul>
    </div>
  );
}
