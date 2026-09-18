import { useEffect, useMemo, useState } from 'react';
import { buildColumns, columnMax, sortProfiles, type SortKey } from './table';
import { fmtCount, fmtSecs, type ResourceProfilesPayload } from './types';
import { resourceColor } from './palette';
import { useParams, useSize, useTheme } from './bootstrap';

interface Params { sortBy: SortKey; showScatter: boolean }

/**
 * The profile table.
 *
 * A table rather than a chart because these are a dozen unlike quantities per
 * person — a rate, two shares, two durations and a correlation — and the only
 * honest way to show unlike quantities together is side by side with their
 * units. The bars behind the cells are there to make one column scannable, not
 * to invite comparison across columns.
 *
 * The workload-versus-speed scatter is the one genuinely two-dimensional thing
 * here, and it earns a chart: the claim "people slow down when busy" is a
 * shape, and a correlation coefficient alone hides whether that shape is a
 * trend or two clusters.
 */
export function ProfilesView({ payload }: { payload: ResourceProfilesPayload }) {
  const theme = useTheme();
  const size = useSize();
  const p = useParams<Params>({ sortBy: 'events', showScatter: true });
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => { try { promenade.ready(); } catch { /* host not listening */ } }, []);

  const fg = theme.text ?? '#1c2027';
  const dim = theme['text-dim'] ?? '#697386';
  const bg = theme.bg ?? '#fff';
  const border = theme.border ?? '#e3e6ea';
  const accent = theme.accent ?? '#0072B2';
  const warn = theme.warn ?? '#c80';
  const font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  const columns = useMemo(() => buildColumns(payload), [payload]);
  const rows = useMemo(
    () => sortProfiles(payload.profiles, payload, p.sortBy, columns),
    [payload, p.sortBy, columns],
  );
  const maxima = useMemo(
    () => new Map(columns.map((c) => [c.key, columnMax(payload.profiles, c)])),
    [columns, payload.profiles],
  );

  const s = payload.stats;
  const showScatter = p.showScatter && s.hasLifecycle && payload.scatter.length > 0;

  return (
    <div style={{ width: '100%', height: '100%', background: bg, color: fg, font,
                  display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px 8px', borderBottom: `1px solid ${border}`,
                    display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13 }}>{payload.profiles.length} people</b>
        <span style={{ color: dim, fontSize: 11.5 }}>
          {fmtCount(s.events)} events · {fmtCount(s.cases)} cases
          {s.hasLifecycle
            ? ` · ${fmtCount(s.itemsPaired)} work items timed`
            : ' · no lifecycle in this log, so nothing can be timed'}
          {s.resourcesOmitted > 0 && ` · ${s.resourcesOmitted} people omitted`}
        </span>
        {s.hasLifecycle && s.workloadSpeedR != null && (
          <span style={{ marginLeft: 'auto', fontSize: 11.5,
                         color: s.workloadSpeedR > 0.2 ? warn : dim }}>
            workload ⇢ duration r = {s.workloadSpeedR.toFixed(3)}
            {s.workloadSpeedR > 0.2 ? ' — work takes longer when people are busier' : ''}
          </span>
        )}
      </div>

      {(s.transferredItems > 0 || s.unfinishedItems > 0 || s.eventsWithoutTimestamp > 0) && (
        <div style={{ padding: '6px 14px', fontSize: 11, color: dim,
                      borderBottom: `1px solid ${border}` }}>
          {s.transferredItems > 0 && (
            <>{fmtCount(s.transferredItems)} items changed hands between start and
              complete and are attributed to nobody. </>
          )}
          {s.unfinishedItems > 0 && <>{fmtCount(s.unfinishedItems)} items were started and never finished. </>}
          {s.eventsWithoutTimestamp > 0 && <>{fmtCount(s.eventsWithoutTimestamp)} events had no timestamp.</>}
        </div>
      )}

      <div style={{ flex: '1 1 auto', overflow: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11.5 }}>
          <thead>
            <tr style={{ position: 'sticky', top: 0, background: bg, zIndex: 1 }}>
              <th style={{ ...th(border, dim), textAlign: 'left', minWidth: 110 }}>Resource</th>
              {columns.map((c) => (
                <th key={c.key} title={c.title} style={{ ...th(border, dim), textAlign: 'right' }}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((profile) => {
              const name = payload.resources[profile.resource];
              const lit = hover == null || hover === profile.resource;
              return (
                <tr key={profile.resource}
                    onMouseEnter={() => setHover(profile.resource)}
                    onMouseLeave={() => setHover(null)}
                    style={{ opacity: lit ? 1 : 0.45, background: hover === profile.resource
                      ? `color-mix(in srgb, ${accent} 6%, transparent)` : undefined }}>
                  <td style={{ ...td(border), textAlign: 'left', whiteSpace: 'nowrap' }}>
                    <span style={{
                      display: 'inline-block', width: 8, height: 8, borderRadius: 4,
                      background: resourceColor(name), marginRight: 6,
                    }} />
                    {name}
                  </td>
                  {columns.map((c) => {
                    const value = c.value(profile);
                    const max = maxima.get(c.key) ?? 0;
                    const fill = c.bar && value != null && max > 0 ? (value / max) * 100 : 0;
                    return (
                      <td key={c.key} style={{ ...td(border), textAlign: 'right', position: 'relative' }}>
                        {c.bar && fill > 0 && (
                          <div style={{
                            position: 'absolute', right: 0, top: 2, bottom: 2, width: `${fill}%`,
                            background: `color-mix(in srgb, ${accent} 14%, transparent)`,
                            borderRadius: 2, pointerEvents: 'none',
                          }} />
                        )}
                        <span style={{ position: 'relative',
                                       color: value == null ? dim : undefined }}>
                          {c.format(profile)}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>

        {showScatter && (
          <Scatter payload={payload} hover={hover} width={Math.max(320, size.w - 28)}
                   theme={{ fg, dim, border, accent }} />
        )}
      </div>
    </div>
  );
}

function th(border: string, dim: string): React.CSSProperties {
  return {
    borderBottom: `1px solid ${border}`, padding: '6px 8px',
    fontWeight: 600, color: dim, whiteSpace: 'nowrap', cursor: 'help',
  };
}
function td(border: string): React.CSSProperties {
  return { borderBottom: `1px solid ${border}`, padding: '4px 8px', whiteSpace: 'nowrap' };
}

/**
 * Workload against duration, one point per timed work item.
 *
 * Both axes are drawn from the data rather than from a fixed range, and the
 * duration axis is logarithmic: service times on a real log span four orders
 * of magnitude, and on a linear axis every point but the slowest handful sits
 * on the floor.
 */
function Scatter({ payload, hover, width, theme }: {
  payload: ResourceProfilesPayload; hover: number | null; width: number;
  theme: { fg: string; dim: string; border: string; accent: string };
}) {
  const height = 220;
  const pad = { left: 52, right: 14, top: 14, bottom: 34 };
  const plotW = Math.max(40, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;

  const points = payload.scatter;
  const maxLoad = Math.max(1, ...points.map(([load]) => load));
  // Durations of zero are real (an item opened and closed in the same instant)
  // and have no logarithm, so the axis starts one second below the smallest
  // positive value rather than at zero.
  const positive = points.map(([, secs]) => secs).filter((s) => s > 0);
  const minSecs = positive.length ? Math.min(...positive) : 1;
  const maxSecs = Math.max(minSecs * 10, ...points.map(([, secs]) => secs));
  const logMin = Math.log10(Math.max(minSecs, 0.5));
  const logMax = Math.log10(maxSecs);

  // Workload is a count, so every point in a column shares an x and the cloud
  // draws as a row of vertical bars — which hides exactly the density the
  // chart is for. A deterministic spread within each column, derived from the
  // point's own index, restores it without moving a point between columns:
  // the jitter is bounded to just under half a column's width.
  const columnW = plotW / Math.max(maxLoad, 1);
  const jitter = (i: number) => {
    // A cheap integer hash, so the same data always scatters the same way.
    const h = Math.imul(i + 1, 0x9e3779b1) >>> 0;
    return ((h % 1000) / 1000 - 0.5) * Math.min(columnW * 0.8, 26);
  };
  const x = (load: number, i: number) =>
    pad.left + (load / maxLoad) * plotW + (maxLoad > 0 ? jitter(i) : 0);
  const y = (secs: number) => {
    const l = Math.log10(Math.max(secs, Math.pow(10, logMin)));
    return pad.top + plotH - ((l - logMin) / Math.max(logMax - logMin, 1e-9)) * plotH;
  };

  const ticks: number[] = [];
  for (let e = Math.floor(logMin); e <= Math.ceil(logMax); e++) ticks.push(Math.pow(10, e));

  return (
    <div style={{ padding: '10px 14px 18px', borderTop: `1px solid ${theme.border}` }}>
      <div style={{ fontSize: 11.5, color: theme.dim, marginBottom: 4 }}>
        Workload against duration — each point is one work item, placed by how many
        others that person had open when it started.
        {payload.scatter.length < payload.stats.itemsPaired
          && ` Showing ${payload.scatter.length.toLocaleString()} of `
             + `${payload.stats.itemsPaired.toLocaleString()} items.`}
      </div>
      <svg width={width} height={height} style={{ display: 'block' }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} y1={y(t)} x2={pad.left + plotW} y2={y(t)}
                  stroke={theme.border} strokeWidth={1} />
            <text x={pad.left - 6} y={y(t) + 3} textAnchor="end" fontSize={9} fill={theme.dim}>
              {fmtSecs(t)}
            </text>
          </g>
        ))}
        {Array.from({ length: Math.min(maxLoad + 1, 12) }, (_, i) => {
          const load = Math.round((i / Math.min(maxLoad, 11)) * maxLoad);
          return (
            <text key={i} x={pad.left + (load / maxLoad) * plotW} y={pad.top + plotH + 14}
                  textAnchor="middle" fontSize={9} fill={theme.dim}>{load}</text>
          );
        })}
        <text x={pad.left + plotW / 2} y={height - 4} textAnchor="middle"
              fontSize={10} fill={theme.dim}>items already in progress</text>

        {points.map(([load, secs, resource], i) => (
          <circle key={i} cx={x(load, i)} cy={y(secs)} r={2.2}
                  fill={resourceColor(payload.resources[resource] ?? '')}
                  opacity={hover == null ? 0.42 : (hover === resource ? 0.9 : 0.07)} />
        ))}
      </svg>
    </div>
  );
}
