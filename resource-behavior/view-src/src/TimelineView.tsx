import { useEffect, useMemo, useState } from 'react';
import { fmtCount, type ResourceProfilesPayload } from './types';
import { resourceColor } from './palette';
import { useParams, useSize, useTheme } from './bootstrap';

interface Params { order: 'events' | 'first' | 'name'; scale: 'sqrt' | 'linear' }

const DAY_MS = 86_400_000;

/**
 * Who was busy when.
 *
 * One row per person, one column per bucket, shaded by how much they did.
 * This is the view that answers the questions the table cannot: when somebody
 * joined and when they stopped, whether a team's load moved between people
 * over the year, whether a quiet person is quiet throughout or just absent for
 * half of it. A mean over the whole log hides all three.
 *
 * The square-root scale is the default rather than linear because one
 * automated resource performing every event in the log is normal, and on a
 * linear scale it flattens everybody else to white.
 */
export function TimelineView({ payload }: { payload: ResourceProfilesPayload }) {
  const theme = useTheme();
  const size = useSize();
  const p = useParams<Params>({ order: 'events', scale: 'sqrt' });
  const [hover, setHover] = useState<{ row: number; bucket: number } | null>(null);

  useEffect(() => { try { promenade.ready(); } catch { /* host not listening */ } }, []);

  const fg = theme.text ?? '#1c2027';
  const dim = theme['text-dim'] ?? '#697386';
  const bg = theme.bg ?? '#fff';
  const border = theme.border ?? '#e3e6ea';
  const font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  const byResource = useMemo(
    () => new Map(payload.profiles.map((profile) => [profile.resource, profile])),
    [payload.profiles],
  );

  const rows = useMemo(() => {
    const list = [...payload.timeline];
    if (p.order === 'name') {
      return list.sort((a, b) =>
        payload.resources[a.resource].localeCompare(payload.resources[b.resource]));
    }
    if (p.order === 'first') {
      return list.sort((a, b) =>
        (byResource.get(a.resource)?.firstMs ?? 0) - (byResource.get(b.resource)?.firstMs ?? 0));
    }
    return list.sort((a, b) =>
      (byResource.get(b.resource)?.events ?? 0) - (byResource.get(a.resource)?.events ?? 0));
  }, [payload.timeline, payload.resources, p.order, byResource]);

  const max = useMemo(() => {
    let m = 0;
    for (const row of payload.timeline) for (const c of row.counts) if (c > m) m = c;
    return Math.max(1, m);
  }, [payload.timeline]);

  const gutter = Math.min(150, Math.max(78, size.w * 0.16));
  const cellW = Math.max(2, Math.min(18, (size.w - gutter - 26) / Math.max(1, payload.bucketCount)));
  const cellH = Math.max(7, Math.min(20, (size.h - 130) / Math.max(1, rows.length)));
  const gridW = cellW * payload.bucketCount;

  const shade = (count: number) => {
    if (count === 0) return 0;
    const t = count / max;
    return p.scale === 'sqrt' ? Math.sqrt(t) : t;
  };

  // A label every so often, chosen so they never collide however narrow the
  // cells get.
  const labelEvery = Math.max(1, Math.ceil(56 / cellW));
  const bucketLabel = (b: number) => {
    const ms = payload.bucketStartMs + b * payload.bucketMs;
    const d = new Date(ms);
    if (!Number.isFinite(ms)) return '';
    return payload.bucketMs >= DAY_MS * 28
      ? d.toLocaleDateString(undefined, { year: '2-digit', month: 'short' })
      : payload.bucketMs >= DAY_MS
        ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
  };

  const hovered = hover ? rows[hover.row] : null;

  return (
    <div style={{ width: '100%', height: '100%', background: bg, color: fg, font,
                  display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px 8px', borderBottom: `1px solid ${border}`,
                    display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13 }}>Workload timeline</b>
        <span style={{ color: dim, fontSize: 11.5 }}>
          {rows.length} people · {payload.bucketCount} {payload.bucket}
          {payload.bucketCount === 1 ? '' : 's'} · darkest is {fmtCount(max)} events
        </span>
      </div>

      <div style={{ flex: '1 1 auto', overflow: 'auto', padding: '8px 14px 14px' }}>
        <svg width={gutter + gridW + 12} height={rows.length * cellH + 34}
             style={{ display: 'block' }}>
          {Array.from({ length: payload.bucketCount }, (_, b) => (
            b % labelEvery === 0 ? (
              <text key={b} x={gutter + b * cellW} y={12} fontSize={9} fill={dim}>
                {bucketLabel(b)}
              </text>
            ) : null
          ))}

          {rows.map((row, i) => {
            const name = payload.resources[row.resource];
            const colour = resourceColor(name);
            const lit = hover == null || hover.row === i;
            return (
              <g key={row.resource}>
                <text x={gutter - 6} y={20 + i * cellH + cellH * 0.72} textAnchor="end"
                      fontSize={Math.min(10.5, cellH * 0.8)}
                      fill={lit ? (hover?.row === i ? fg : dim) : border}>
                  {name.length > 18 ? `${name.slice(0, 17)}…` : name}
                </text>
                {row.counts.map((count, b) => (
                  count === 0 ? null : (
                    <rect key={b} x={gutter + b * cellW} y={20 + i * cellH}
                          width={Math.max(1, cellW - 0.5)} height={Math.max(1, cellH - 1)}
                          fill={colour} fillOpacity={shade(count) * (lit ? 1 : 0.15)}
                          onMouseEnter={() => setHover({ row: i, bucket: b })}
                          onMouseLeave={() => setHover(null)}>
                      <title>{name} · {bucketLabel(b)} · {count} events</title>
                    </rect>
                  )
                ))}
              </g>
            );
          })}
        </svg>
      </div>

      <div style={{ padding: '7px 14px', borderTop: `1px solid ${border}`,
                    color: dim, fontSize: 11 }}>
        {hovered && hover
          ? <>
              <b style={{ color: fg }}>{payload.resources[hovered.resource]}</b>
              {' · '}{bucketLabel(hover.bucket)}
              {' · '}{hovered.counts[hover.bucket]} events
              {' · '}{fmtCount(byResource.get(hovered.resource)?.events ?? 0)} in total
              {' over '}{byResource.get(hovered.resource)?.activeDays ?? 0} active days
            </>
          : `One row per person, one column per ${payload.bucket}. `
            + `${p.scale === 'sqrt' ? 'Square-root' : 'Linear'} shading.`}
      </div>
    </div>
  );
}
