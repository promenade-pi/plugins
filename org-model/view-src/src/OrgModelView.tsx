import { useEffect, useMemo, useState } from 'react';
import { layoutDendrogram, cutHeight } from './dendrogram';
import { groupNoun, type OrgModelPayload, type Role } from './types';
import { resourceColor } from './palette';
import { useParams, useSize, useTheme } from './bootstrap';

interface Params { show: 'both' | 'groups' | 'dendrogram'; sortBy: 'size' | 'events' | 'cohesion' | 'name' }

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * The organisational model.
 *
 * Two halves that answer different halves of the question. The **dendrogram**
 * says why these groups and not others — where the cut fell, and what the
 * next merge would have joined, which is the only way to tell a decisive cut
 * from an arbitrary one. The **group cards** say what each group is: who is in
 * it, what they do, and whether it holds together, since a clustering will
 * always return the number of groups it was asked for whether or not they
 * mean anything.
 *
 * Cohesion against separation is the honest pair of numbers for that last
 * question, and they are shown side by side per group rather than rolled into
 * one score, because a group can be tight and still sit right next to another.
 */
export function OrgModelView({ payload }: { payload: OrgModelPayload }) {
  const theme = useTheme();
  const size = useSize();
  const p = useParams<Params>({ show: 'both', sortBy: 'size' });
  const [focused, setFocused] = useState<number | null>(null);

  useEffect(() => { try { promenade.ready(); } catch { /* host not listening */ } }, []);

  const fg = theme.text ?? '#1c2027';
  const dim = theme['text-dim'] ?? '#697386';
  const bg = theme.bg ?? '#fff';
  const border = theme.border ?? '#e3e6ea';
  const accent = theme.accent ?? '#0072B2';
  const warn = theme.warn ?? '#c80';

  const noun = groupNoun(payload.grouping);
  const font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  const dendro = useMemo(
    () => layoutDendrogram(payload.resources.length, payload.merges),
    [payload.resources.length, payload.merges],
  );
  const cut = useMemo(
    () => cutHeight(payload.merges, payload.cutBy, payload.cut, payload.resources.length),
    [payload.merges, payload.cutBy, payload.cut, payload.resources.length],
  );

  const roles = useMemo(() => {
    const list = [...payload.roles];
    switch (p.sortBy) {
      case 'events': return list.sort((a, b) => b.events - a.events);
      case 'cohesion': return list.sort((a, b) => b.cohesion - a.cohesion);
      case 'name': return list.sort((a, b) => a.label.localeCompare(b.label));
      default: return list.sort((a, b) => b.size - a.size || b.events - a.events);
    }
  }, [payload.roles, p.sortBy]);

  const showDendro = p.show !== 'groups' && payload.merges.length > 0;
  const showGroups = p.show !== 'dendrogram';

  // The dendrogram gets a fixed slice of the panel; the cards scroll under it.
  const dendroHeight = showDendro ? Math.max(140, Math.min(260, size.h * 0.35)) : 0;
  const width = Math.max(320, size.w);
  const pad = { left: 12, right: 12, top: 14, bottom: 46 };
  const plotW = Math.max(40, width - pad.left - pad.right);
  const plotH = Math.max(40, dendroHeight - pad.top - pad.bottom);
  const leaves = Math.max(1, dendro.order.length);
  const xOf = (slot: number) => pad.left + ((slot + 0.5) / leaves) * plotW;
  const maxY = Math.max(dendro.maxDistance, cut ?? 0, 1e-6);
  const yOf = (d: number) => pad.top + plotH - (d / maxY) * plotH;

  // Colour every dendrogram edge by the group its subtree ends up in, so the
  // cut is legible in the drawing itself rather than only as a line across it.
  const roleColorOf = (clusterId: number): string | null => {
    if (clusterId < payload.resources.length) {
      return resourceColor(payload.resources[clusterId]);
    }
    return null;
  };

  const silhouette = payload.stats.meanSilhouette;
  const silhouetteNote = silhouette > 0.5 ? 'well separated'
    : silhouette > 0.25 ? 'reasonably separated'
    : silhouette > 0 ? 'weakly separated'
    : 'not separated — people are on average closer to another group than their own';

  return (
    <div style={{ width: '100%', height: '100%', background: bg, color: fg, font,
                  display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px 8px', borderBottom: `1px solid ${border}`,
                    display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13 }}>
          {payload.stats.roles} {noun}{payload.stats.roles === 1 ? '' : 's'}
        </b>
        <span style={{ color: dim, fontSize: 11.5 }}>
          {payload.stats.resources} people · from {payload.sourceMetric}
          {' · '}{payload.method === 'components'
            ? `components above ${payload.cut.toFixed(2)}`
            : `${payload.linkage} linkage, cut by ${payload.cutBy}`}
          {payload.stats.singletons > 0 && ` · ${payload.stats.singletons} on their own`}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11.5,
                       color: silhouette > 0.25 ? dim : warn }}>
          silhouette {silhouette.toFixed(3)} — {silhouetteNote}
        </span>
      </div>

      {showDendro && (
        <svg width={width} height={dendroHeight} style={{ display: 'block', flex: '0 0 auto' }}>
          {/* Every join as a bracket: up from each child, across, and the
              parent sits on the crossbar at the distance it happened. */}
          {[...dendro.nodes.values()].map((node) => {
            if (!node.children) return null;
            const [a, b] = node.children.map((id) => dendro.nodes.get(id)!);
            if (!a || !b) return null;
            const above = cut != null && node.y > cut;
            const colour = above ? border : (roleColorOf(node.children[0]) ?? accent);
            return (
              <g key={node.id} stroke={colour} strokeWidth={above ? 1 : 1.4}
                 opacity={above ? 0.8 : 0.9} fill="none">
                <path d={`M ${xOf(a.x)} ${yOf(a.y)} V ${yOf(node.y)} H ${xOf(b.x)} V ${yOf(b.y)}`} />
              </g>
            );
          })}

          {cut != null && (
            <g>
              <line x1={pad.left} y1={yOf(cut)} x2={pad.left + plotW} y2={yOf(cut)}
                    stroke={warn} strokeWidth={1.4} strokeDasharray="5 3" />
              <text x={pad.left + plotW} y={yOf(cut) - 5} textAnchor="end"
                    fontSize={10} fill={warn}>
                cut at {cut.toFixed(3)}
              </text>
            </g>
          )}

          {/* Leaf names, rotated: at twenty people they fit, at two hundred
              they do not, and a rotated label degrades better than a clipped
              one because the start of a name is the part that identifies it. */}
          {dendro.order.map((leaf, slot) => (
            <text key={leaf} transform={`translate(${xOf(slot)},${pad.top + plotH + 6}) rotate(55)`}
                  fontSize={9} fill={focused != null && payload.roleOf[leaf] !== focused ? border : dim}>
              {payload.resources[leaf]?.length > 12
                ? `${payload.resources[leaf].slice(0, 11)}…`
                : payload.resources[leaf]}
            </text>
          ))}
        </svg>
      )}

      {showGroups && (
        <div style={{ flex: '1 1 auto', overflow: 'auto', padding: '10px 14px 16px',
                      display: 'grid', gap: 10,
                      gridTemplateColumns: `repeat(auto-fill, minmax(${Math.min(320, width - 40)}px, 1fr))` }}>
          {roles.map((role) => (
            <RoleCard key={role.id} role={role} payload={payload} noun={noun}
                      focused={focused === role.id}
                      onFocus={() => setFocused(focused === role.id ? null : role.id)}
                      theme={{ fg, dim, border, accent, warn }} />
          ))}
        </div>
      )}
    </div>
  );
}

function RoleCard({ role, payload, noun, focused, onFocus, theme }: {
  role: Role; payload: OrgModelPayload; noun: string; focused: boolean;
  onFocus: () => void;
  theme: { fg: string; dim: string; border: string; accent: string; warn: string };
}) {
  // A group is only worth the name if its members are closer to each other
  // than to everyone else. Saying so per group is more use than one number
  // for the whole model, because it is usually one or two groups that are bad.
  const holds = role.size === 1 ? null : role.cohesion > role.separation;
  const topShare = role.profile[0]?.[1] ?? 0;

  return (
    <div onClick={onFocus}
         style={{
           border: `1px solid ${focused ? theme.accent : theme.border}`,
           borderRadius: 6, padding: '9px 11px', cursor: 'pointer',
           boxShadow: focused ? `0 0 0 1px ${theme.accent}` : undefined,
         }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 6 }}>
        <b style={{ fontSize: 12.5 }}>{role.label}</b>
        <span style={{ color: theme.dim, fontSize: 11 }}>
          {role.size} {role.size === 1 ? 'person' : 'people'} · {fmt(role.events)} events
        </span>
        {holds === false && (
          <span style={{ marginLeft: 'auto', color: theme.warn, fontSize: 10.5 }}
                title="Members are on average no closer to each other than to people outside this group">
            loose
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 7 }}>
        {role.members.map((m) => (
          <span key={m} style={{
            fontSize: 10.5, padding: '1px 6px', borderRadius: 9,
            background: `color-mix(in srgb, ${resourceColor(payload.resources[m])} 22%, transparent)`,
            border: `1px solid color-mix(in srgb, ${resourceColor(payload.resources[m])} 55%, transparent)`,
          }}>
            {payload.resources[m]}
          </span>
        ))}
      </div>

      {/* The activity mix, as bars: what this group actually does, which is
          the thing a name alone cannot carry. */}
      {role.profile.slice(0, 5).map(([activity, share]) => (
        <div key={activity} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <div style={{ flex: '1 1 auto', minWidth: 0, fontSize: 10.5, color: theme.dim,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {payload.activities[activity] ?? `#${activity}`}
          </div>
          <div style={{ flex: '0 0 84px', height: 6, background: theme.border, borderRadius: 3 }}>
            <div style={{
              width: `${topShare > 0 ? (share / topShare) * 100 : 0}%`, height: '100%',
              background: theme.accent, borderRadius: 3,
            }} />
          </div>
          <div style={{ flex: '0 0 34px', textAlign: 'right', fontSize: 10, color: theme.dim }}>
            {(share * 100).toFixed(0)}%
          </div>
        </div>
      ))}
      {role.profile.length > 5 && (
        <div style={{ fontSize: 10, color: theme.dim, marginTop: 2 }}>
          +{role.profile.length - 5} more activities
        </div>
      )}

      <div style={{ marginTop: 7, fontSize: 10.5, color: theme.dim }}>
        {role.size === 1
          ? `alone — the network related nobody else to them closely enough to share a ${noun}`
          : `cohesion ${role.cohesion.toFixed(3)} vs separation ${role.separation.toFixed(3)}`}
      </div>
    </div>
  );
}
