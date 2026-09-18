/**
 * Metro Station — entry point.
 *
 * The pipeline is short because the expensive half already happened in Rust:
 * the payload arrives with every platform placed and every route routed. What
 * is left is the third dimension and the chrome.
 *
 *   payload + params  ->  Depth        (seconds to world height; `depth.ts`)
 *   payload + Depth   ->  DrawnRoute[] (3D paths and ribbons; `Scene.tsx`)
 *   DrawnRoute[]      ->  meshes       (per frame)
 *
 * The stages are separate because they cost different amounts and change for
 * different reasons. Switching the depth axis between linear and logarithmic —
 * the thing this view exists to let someone do — rebuilds the first two and
 * moves nothing in plan: every platform stays exactly where it was, which is
 * the only reason the two readings are comparable at all.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { CameraButtons, Inspector, Legend, Toolbar } from './Chrome';
import { buildDepth, planSpan } from './depth';
import { Labels, type LabelHandle, type LabelItem } from './Labels';
import {
  axisAnchor, buildRoutes, planHalf, StationView,
  type Anchor, type CameraCommand, type ProjectionSink, type SceneModel,
} from './Scene';
import { defaultViewParams, formatDuration, type StationMap, type ViewParams } from './types';
import { SCHEMES } from './viz';
import css from './styles.css';

const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);

/**
 * The bound artifact, read exactly once.
 *
 * `promenade.artifact()` builds a fresh object per call, so reading it during
 * render hands every effect that depends on it a new identity on every pass.
 * Read at module scope, where the frame's own lifetime guarantees it cannot
 * change.
 */
const ARTIFACT = promenade.artifact();

/**
 * The payload, however the host happens to be holding it.
 *
 * After a run the result store has an envelope around the kernel's value;
 * after a reload it has the bare value. Both are normal, and a view that only
 * understands one of them works until the panel is reopened.
 */
function payloadOf(value: unknown): StationMap | null {
  const seen = new Set<unknown>();
  let candidate: unknown = value;
  for (let depth = 0; depth < 4 && candidate && typeof candidate === 'object'; depth++) {
    if (seen.has(candidate)) break;
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    if (Array.isArray(record.platforms) && Array.isArray(record.lines)) return record as unknown as StationMap;
    candidate = record.payload ?? record.value ?? record.result ?? null;
  }
  return null;
}

function App() {
  const [theme, setTheme] = useState<Record<string, string>>(() => promenade.theme());
  const [params, setParams] = useState<ViewParams>(defaultViewParams);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [backend, setBackend] = useState('');
  const [command, setCommand] = useState<CameraCommand>({ nonce: 0, kind: 'reset' });
  const labels = useRef<LabelHandle>(null);

  const map = useMemo(() => payloadOf(ARTIFACT.value), []);

  /* ------------------------------------------------------------ *
   * Host handshake.
   * ------------------------------------------------------------ */
  useEffect(() => {
    promenade.on('theme', (payload) => setTheme(payload.theme));
    promenade.on('params', (next) => {
      setParams((current) => ({ ...current, ...(next as Partial<ViewParams>) }));
    });
    promenade.on('selection', (selection) => {
      // Linked selection across panels: another view naming an activity moves
      // this one's focus to the same platform, which is the point of the bus.
      const activity = selection.items.find((item) => item.kind === 'activity');
      if (activity) setSelected(String(activity.id));
      const type = selection.items.find((item) => item.kind === 'objectType');
      if (type) setHighlight(String(type.id));
    });
    promenade.ready();
  }, []);

  const change = useCallback((patch: Partial<ViewParams>) => {
    setParams((current) => ({ ...current, ...patch }));
    promenade.setParams(patch as Record<string, unknown>);
  }, []);

  /* ------------------------------------------------------------ *
   * Colours, depth, geometry.
   * ------------------------------------------------------------ */
  const colors = useMemo(() => {
    const out = new Map<string, string>();
    for (const type of map?.objectTypes ?? []) {
      out.set(type.name, promenade.color('objectType', type.name));
    }
    return out;
    // `theme` is a dependency because the host's palette is theme-dependent:
    // a route drawn in the light scheme's colours on the dark ground is the
    // one part of this diagram that has to follow the app.
  }, [map, theme]);

  const span = useMemo(() => (map ? planSpan(map) : 1), [map]);
  const depth = useMemo(() => (map ? buildDepth(map, params, span) : null), [map, params, span]);
  const flat = params.viewMode === 'flat';

  const centre = useMemo(() => {
    if (!map || map.platforms.length === 0) return { x: 0, z: 0 };
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const platform of map.platforms) {
      minX = Math.min(minX, platform.x);
      maxX = Math.max(maxX, platform.x);
      minZ = Math.min(minZ, platform.z);
      maxZ = Math.max(maxZ, platform.z);
    }
    return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
  }, [map]);

  const scene: SceneModel | null = useMemo(() => {
    if (!map || !depth) return null;
    return {
      map,
      depth,
      params,
      scheme: SCHEMES[params.palette] ?? SCHEMES.daylight,
      colors,
      highlight,
      selected,
      hovered,
      flat,
      centre,
    };
  }, [map, depth, params, colors, highlight, selected, hovered, flat, centre]);

  // Only the payload, the depth mapping and the route widths may rebuild the
  // geometry. Selecting a platform or lighting one object type must not: those
  // change materials, and rebuilding every ribbon to change a colour is how a
  // diagram that orbits smoothly starts stuttering the moment it is used.
  const geometry = useMemo(() => {
    if (!scene) return { routes: [], links: [] };
    return buildRoutes(scene);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, depth, params.lineWidth, params.shafts, flat, centre]);

  const half = useMemo(
    () => (scene ? planHalf(scene, geometry.routes) : { x: 1, y: 1, z: 1 }),
    [scene, geometry.routes]
  );

  /* ------------------------------------------------------------ *
   * Labels.
   * ------------------------------------------------------------ */
  const { anchors, items } = useMemo(() => {
    const anchorList: Anchor[] = [];
    const labelList: LabelItem[] = [];
    if (!map || !depth || !scene) return { anchors: anchorList, items: labelList };

    const yOf = (id: string) => (flat ? 0 : depth.y.get(id) ?? 0);
    const busiest = Math.max(1, ...map.platforms.map((p) => p.count));

    if (params.showLabels) {
      for (const platform of map.platforms) {
        anchorList.push({
          id: `p:${platform.id}`,
          world: [platform.x - centre.x, yOf(platform.id) + 0.006, platform.z - centre.z],
        });
        labelList.push({
          id: `p:${platform.id}`,
          text: platform.activity,
          kind: 'platform',
          // The busiest platforms keep their names in a crowd, and a selected
          // one always does.
          priority: 100 + platform.count / busiest + (selected === platform.id ? 500 : 0),
          offsets: [[0, 0], [0, -30], [0, 30], [72, -16], [-72, -16]],
          platform: platform.id,
        });
      }
    }

    // Shaft chips. Only for the descents actually drawn as shafts — a chip on
    // every hand-off would bury the diagram in numbers, and the ones worth
    // reading are exactly the ones deep enough to have earned a lift.
    if (!flat && depth.unit === 'time') {
      for (const link of geometry.links) {
        if (link.descent !== 'shaft') continue;
        const shaft = map.shafts.find((s) => s.link === link.key);
        // Only the hand-off that *set* the target's depth is labelled, and it
        // is labelled with its own measured wait — which for that one hand-off
        // is exactly the drop drawn. Every other route into the same platform
        // descends further than it waited, because a platform has one depth
        // and it is the deepest of the paths that reach it; putting that drop
        // on the diagram as if it were a wait would be a number the log does
        // not support. The Inspector says so in full for whichever platform is
        // selected.
        if (!shaft || !shaft.critical) continue;
        const a = link.path[link.dropIndex];
        const b = link.path[link.dropIndex + 1];
        if (!a || !b) continue;
        const lit = !highlight || shaft.objectTypes.includes(highlight);
        if (!lit) continue;
        anchorList.push({ id: `s:${link.key}`, world: [a.x, (a.y + b.y) / 2, a.z] });
        labelList.push({
          id: `s:${link.key}`,
          text: formatDuration(shaft.waitSecs ?? Math.abs(shaft.tBottom - shaft.tTop)),
          kind: 'shaft',
          priority: 400 + Math.abs(shaft.tBottom - shaft.tTop),
          offsets: [[62, 0], [-62, 0], [62, -22], [-62, -22]],
          color: colors.get(shaft.objectTypes[0] ?? '') ?? undefined,
        });
      }
    }

    // The depth axis: its pole is 3D (`Guides`), its numbers are DOM.
    if (!flat) {
      const pole = axisAnchor(half);
      for (const [index, tick] of depth.ticks.entries()) {
        anchorList.push({ id: `t:${index}`, world: [pole.x, tick.y, pole.z] });
        labelList.push({
          id: `t:${index}`,
          text: tick.label,
          kind: 'tick',
          priority: 700 - index,
          offsets: [[-30, 0], [34, 0]],
        });
      }
      for (const [index, band] of depth.bands.entries()) {
        anchorList.push({
          id: `b:${index}`,
          world: [pole.x, (band.top + band.bottom) / 2, pole.z],
        });
        labelList.push({
          id: `b:${index}`,
          text: band.label,
          kind: 'band',
          priority: 800 - index,
          // A fallback on the inboard side: on a narrow panel the axis pole
          // itself is close enough to the edge that there is no room outboard
          // of it, and a band label that simply vanishes takes the reading of
          // the whole axis with it.
          offsets: [[-78, 0], [-104, 0], [56, 0], [82, 0]],
        });
      }
    }

    return { anchors: anchorList, items: labelList };
  }, [map, depth, scene, params.showLabels, flat, centre, geometry.links, half, highlight, colors, selected]);

  const sink: ProjectionSink = useCallback((projected, size) => {
    labels.current?.place(projected, size);
  }, []);

  /* ------------------------------------------------------------ *
   * Interaction.
   * ------------------------------------------------------------ */
  const pick = useCallback((id: string | null) => {
    setSelected(id);
    promenade.select(id ? [{ kind: 'activity', id }] : []);
  }, []);

  const follow = useCallback((name: string | null) => {
    setHighlight(name);
    promenade.select(name ? [{ kind: 'objectType', id: name }] : []);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setSelected(null);
      setHighlight(null);
      promenade.select([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const focus = useCallback(() => {
    if (!map || !depth || !selected) return;
    const platform = map.platforms.find((p) => p.id === selected);
    if (!platform) return;
    setCommand((current) => ({
      nonce: current.nonce + 1,
      kind: 'focus',
      target: {
        x: platform.x - centre.x,
        y: flat ? 0 : depth.y.get(platform.id) ?? 0,
        z: platform.z - centre.z,
      },
    }));
  }, [map, depth, selected, centre, flat]);

  /* ------------------------------------------------------------ *
   * Render.
   * ------------------------------------------------------------ */
  if (!map) {
    return (
      <div className="ms-root">
        <div className="ms-status is-error">
          This artifact does not carry a station map. Run “Discover station map” on an
          object-centric event log to make one.
        </div>
      </div>
    );
  }
  if (!scene || !depth || map.platforms.length === 0) {
    return (
      <div className="ms-root">
        <div className="ms-status">Nothing to draw: no activity survived the abstraction.</div>
      </div>
    );
  }

  const platform = map.platforms.find((p) => p.id === selected) ?? null;

  return (
    <div className={`ms-root ${params.palette === 'night' ? 'is-night' : 'is-day'}`}>
      <StationView
        scene={scene}
        routes={geometry.routes}
        links={geometry.links}
        half={half}
        anchors={anchors}
        sink={sink}
        command={command}
        onPick={pick}
        onHover={setHovered}
        onInteract={() => setHovered(null)}
        onBackend={setBackend}
      />
      <Labels ref={labels} items={items} onPick={pick} onHover={setHovered} />

      <Toolbar name={ARTIFACT.name || 'Metro Station'} map={map} params={params} onChange={change} backend={backend} />
      <Legend
        map={map}
        depth={depth}
        colors={colors}
        highlight={highlight}
        onHighlight={follow}
        params={params}
      />
      <CameraButtons
        params={params}
        onChange={change}
        onZoom={(by) => setCommand((c) => ({ nonce: c.nonce + 1, kind: 'zoom', by }))}
        onReset={() => setCommand((c) => ({ nonce: c.nonce + 1, kind: 'reset' }))}
      />
      {platform && (
        <Inspector
          platform={platform}
          map={map}
          depth={depth}
          colors={colors}
          onClose={() => pick(null)}
          onFocus={focus}
          onHighlight={follow}
        />
      )}
      {map.stats.droppedActivities > 0 && !platform && (
        <div className="ms-status" style={{ top: 'auto', bottom: 16, left: '50%', transform: 'translateX(-50%)' }}>
          Showing {map.stats.activities} of {map.stats.activities + map.stats.droppedActivities} activities,
          covering {Math.round(map.stats.coverage * 100)}% of hand-offs.
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
