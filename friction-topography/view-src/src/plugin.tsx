/**
 * Process Friction Topography - entry point.
 *
 * Owns everything stateful: the host handshake, the queries, and the pipeline
 * from log statistics to terrain. The stages are deliberately separate, with
 * separate dependencies, because they cost wildly different amounts:
 *
 *   SQL      -> TopographyData   (seconds on a large log; only the filters
 *                                 and the time window invalidate it)
 *   filter   -> FilteredModel    (microseconds)
 *   ELK      -> Plan             (tens of ms; only the graph's shape does)
 *   field    -> HeightField      (tens of ms; the friction metric does)
 *   geometry -> meshes           (per frame budget; the vertical scale does)
 *
 * The useful consequence is that switching the friction metric - the thing an
 * analyst does most - never touches the database and never moves a station.
 * The mountains rise and fall while the map stays where it was, which is what
 * makes two metrics comparable at all.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { Inspector, type Drill, type Tab } from './Inspector';
import { Labels, type LabelHandle, type LabelItem } from './Labels';
import { Legend, Toolbar } from './Toolbar';
import { bottleneckOf, edgeKey, filterModel, reworkEdgeOf, type FilteredModel } from './model';
import { buildField, graduation, type HeightField } from './field';
import { layoutPlan, type Plan } from './layout';
import {
  loadAttributeBreakdown, loadAttributeKeys, loadBreakdown, loadQueueDepth, loadRoute,
  loadTopography, loadVariants, loadWaits, loadWorstCases,
  type CaseRoute, type Ctx, type Dimension, type VariantRow,
} from './query';
import {
  AXIS_HALF, buildRoute, buildStreams, terrainY, TopographyView, verticalScaleOf,
  type Anchor, type CameraCommand, type ProjectionSink, type RoutePath, type SceneModel,
} from './Scene';
import {
  defaultViewParams, formatCount, formatFriction, FRICTION_AXIS, frictionOf, GRID_OF, isDuration,
  type TopographyData, type ViewParams,
} from './types';
import { SCHEMES } from './viz';

import css from './styles.css';

/**
 * Whether a CSS colour is dark enough to want a dark scene on top of it.
 *
 * Perceptual luminance rather than a naive average: #E69F00 and #0072B2 have
 * near-identical means and nothing like the same brightness. Anything
 * unparseable is treated as dark, which is the palette this view has always
 * defaulted to.
 */
function isDarkGround(bg: string | undefined): boolean {
  const hex = /^#?([0-9a-f]{6})$/i.exec((bg ?? '').trim().replace(/^#/, '#'));
  if (!hex) return true;
  const n = parseInt(hex[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
}


const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);

/** How close a click has to land to a station to count as hitting it. */
const PICK_RADIUS = 0.19;

interface CachedState {
  data: TopographyData;
  key: string;
}

function dataKey(params: ViewParams): string {
  return JSON.stringify([params.activities, params.objectTypes, params.timeStart, params.timeEnd]);
}

/**
 * The bound artifact, read exactly once.
 *
 * `promenade.artifact()` builds a fresh object per call, so reading it during
 * render hands every effect that depends on `artifact.tables` a new identity
 * on every pass - which turns the load effect into a loop that re-queries the
 * log after each render it caused. Read at module scope, where the frame's own
 * lifetime guarantees it cannot change.
 */
const ARTIFACT = promenade.artifact();

function App() {
  const artifact = ARTIFACT;
  const objectCentric = artifact.type === 'ObjectCentricEventLog';

  const [theme, setTheme] = useState<Record<string, string>>(() => promenade.theme());
  const [params, setParams] = useState<ViewParams>(defaultViewParams);
  const [data, setData] = useState<TopographyData | null>(null);
  const [status, setStatus] = useState<string>('Reading the log…');
  const [error, setError] = useState<string | null>(null);
  const [backend, setBackend] = useState<string>('');

  const [plan, setPlan] = useState<Plan | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [drill, setDrill] = useState<Drill | null>(null);
  const [activeVariant, setActiveVariant] = useState<VariantRow | null>(null);
  const [route, setRoute] = useState<CaseRoute | null>(null);
  const [command, setCommand] = useState<CameraCommand>({ nonce: 0, kind: 'reset' });

  const paramsRef = useRef(params);
  paramsRef.current = params;
  const labelRef = useRef<LabelHandle>(null);
  const revision = useRef(0);

  const ctx: Ctx = useMemo(
    () => ({ tables: artifact.tables, objectCentric, params }),
    [artifact.tables, objectCentric, params]
  );

  /* -------------------------------------------------------------- *
   * Host handshake.
   * -------------------------------------------------------------- */
  useEffect(() => {
    promenade.on('theme', (payload) => setTheme(payload.theme));
    promenade.on('params', (next) => {
      setParams((current) => ({ ...current, ...(next as Partial<ViewParams>) }));
    });
    promenade.on('selection', (selection) => {
      // Linked selection across panels: another view naming an activity moves
      // this one's focus to the same peak, which is the whole point of the bus.
      const activity = selection.items.find((item) => item.kind === 'activity');
      if (activity) setSelected(String(activity.id));
    });
    promenade.ready();
  }, []);

  /** Writes a param back into host state, the same one the Inspector owns. */
  const change = useCallback((patch: Partial<ViewParams>) => {
    setParams((current) => ({ ...current, ...patch }));
    promenade.setParams(patch as Record<string, unknown>);
  }, []);

  /* -------------------------------------------------------------- *
   * Stage 1: the log statistics.
   * -------------------------------------------------------------- */
  const key = dataKey(params);
  useEffect(() => {
    let cancelled = false;
    const mine = ++revision.current;

    (async () => {
      // A reopened panel gets whatever the previous frame chose to keep, so
      // the terrain is on screen before the first query even starts.
      if (!data) {
        try {
          const cached = (await promenade.cachedState()) as CachedState | null;
          if (!cancelled && cached?.data && cached.key === key) {
            setData(cached.data);
            setStatus('');
          }
        } catch {
          /* An empty cache is the normal first-open case, not an error. */
        }
      }
      if (cancelled || mine !== revision.current) return;

      if (!artifact.tables?.event) {
        setError('This log has no queryable event table.');
        setStatus('');
        return;
      }
      setStatus('Measuring waiting times…');
      try {
        const loaded = await loadTopography({ tables: artifact.tables, objectCentric, params: paramsRef.current });
        if (cancelled || mine !== revision.current) return;
        setData(loaded);
        setError(loaded.activities.length === 0 ? 'No timestamped events in this window.' : null);
        setStatus('');
        promenade.setCachedState({ data: loaded, key } satisfies CachedState);
      } catch (err) {
        if (cancelled || mine !== revision.current) return;
        setError(`Could not read the log: ${(err as Error)?.message ?? err}`);
        setStatus('');
      }
    })();

    return () => { cancelled = true; };
    // `data` is deliberately not a dependency: it is written by this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, artifact.tables, objectCentric]);

  /* -------------------------------------------------------------- *
   * Stage 2 and 3: filter, then lay out.
   * -------------------------------------------------------------- */
  const model: FilteredModel | null = useMemo(
    () => (data ? filterModel(data, params) : null),
    [data, params.maxActivities, params.edgeCoverage, params.frictionMetric]
  );

  // Only the graph's *shape* may trigger a relayout. Re-running ELK because
  // the friction metric changed would reshuffle every station under the
  // analyst, and comparing two metrics on two different maps is worthless.
  const shapeKey = useMemo(
    () => (model
      ? JSON.stringify([
        model.activities.map((a) => a.activity),
        model.edges.map((e) => [e.source, e.target]),
      ])
      : ''),
    [model]
  );

  useEffect(() => {
    if (!model || model.activities.length === 0) { setPlan(null); return; }
    let cancelled = false;
    layoutPlan(model)
      .then((laid) => { if (!cancelled) setPlan(laid); })
      .catch((err) => { if (!cancelled) setError(`Layout failed: ${(err as Error)?.message ?? err}`); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeKey]);

  /* -------------------------------------------------------------- *
   * Stage 4: the terrain.
   * -------------------------------------------------------------- */
  const reliefKey = useMemo(
    () => (model ? [...model.relief.values()].map((v) => v.toFixed(5)).join(',') : ''),
    [model]
  );
  const field: HeightField | null = useMemo(() => {
    if (!model || !plan || plan.nodes.length === 0) return null;
    return buildField({
      model, plan, n: GRID_OF[params.terrainDetail] ?? 160, curve: params.elevationCurve,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, reliefKey, params.terrainDetail, params.elevationCurve]);

  const yScale = verticalScaleOf(params);
  const streams = useMemo(
    () => (field && plan && model ? buildStreams(field, plan, model, yScale) : []),
    [field, plan, model, yScale]
  );

  const routePath: RoutePath | null = useMemo(() => {
    if (!field || !plan || !route) return null;
    return buildRoute(field, plan, route.steps, route.entity, route.label, yScale);
    // The variant preview reuses the same machinery with a synthetic step list.
  }, [field, plan, route, yScale]);

  const variantRoute: RoutePath | null = useMemo(() => {
    if (!field || !plan || !activeVariant || route) return null;
    const steps = activeVariant.activities.map((activity) => ({ activity, t: 0, waitMs: 0, resource: '' }));
    return buildRoute(field, plan, steps, activeVariant.signature, 'variant', yScale);
  }, [field, plan, activeVariant, route, yScale]);

  /* -------------------------------------------------------------- *
   * Drill-down.
   * -------------------------------------------------------------- */
  const activity = useMemo(
    () => model?.activities.find((a) => a.activity === selected) ?? null,
    [model, selected]
  );
  const summit = useMemo(
    () => (model ? bottleneckOf(model, params.frictionMetric) : null),
    [model, params.frictionMetric]
  );

  useEffect(() => {
    if (!selected || !data) { setDrill(null); return; }
    let cancelled = false;
    const dimension: Dimension = 'predecessor';
    setDrill({
      activity: selected, loadingCore: true, loadingTab: false, error: null,
      waits: [], byPredecessor: [], byResource: [], byHour: [], byDimension: [],
      dimension, attributeKeys: [], attributeKey: null, byAttribute: [],
      queue: null, variants: null, cases: null,
    });

    (async () => {
      try {
        const [waits, byPredecessor, byResource, byHour, queue, attributeKeys] = await Promise.all([
          loadWaits(ctx, selected),
          loadBreakdown(ctx, selected, 'predecessor'),
          loadBreakdown(ctx, selected, 'resource'),
          loadBreakdown(ctx, selected, 'hour'),
          loadQueueDepth(ctx, selected),
          loadAttributeKeys(ctx).catch(() => [] as string[]),
        ]);
        if (cancelled) return;
        setDrill((current) => current && current.activity === selected
          ? {
            ...current, loadingCore: false, waits, byPredecessor, byResource, byHour,
            byDimension: byPredecessor, attributeKeys, queue,
          }
          : current);
      } catch (err) {
        if (cancelled) return;
        setDrill((current) => current && current.activity === selected
          ? { ...current, loadingCore: false, error: `Drill-down failed: ${(err as Error)?.message ?? err}` }
          : current);
      }
    })();

    return () => { cancelled = true; };
  }, [selected, ctx, data]);

  // Tab-specific queries, on first visit only.
  useEffect(() => {
    if (!selected || !drill) return;
    if (tab === 'variants' && drill.variants === null) {
      let cancelled = false;
      loadVariants(ctx, selected)
        .then((variants) => {
          if (!cancelled) setDrill((c) => (c && c.activity === selected ? { ...c, variants } : c));
        })
        .catch(() => {
          if (!cancelled) setDrill((c) => (c && c.activity === selected ? { ...c, variants: [] } : c));
        });
      return () => { cancelled = true; };
    }
    if (tab === 'cases' && drill.cases === null) {
      let cancelled = false;
      loadWorstCases(ctx, selected)
        .then((cases) => {
          if (!cancelled) setDrill((c) => (c && c.activity === selected ? { ...c, cases } : c));
        })
        .catch(() => {
          if (!cancelled) setDrill((c) => (c && c.activity === selected ? { ...c, cases: [] } : c));
        });
      return () => { cancelled = true; };
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, selected, drill?.variants, drill?.cases, ctx]);

  const pickDimension = useCallback((dimension: Dimension) => {
    if (!selected) return;
    setDrill((c) => (c ? { ...c, dimension, attributeKey: null, loadingTab: true } : c));
    loadBreakdown(ctx, selected, dimension)
      .then((rows) => setDrill((c) => (c && c.activity === selected
        ? { ...c, byDimension: rows, loadingTab: false } : c)))
      .catch(() => setDrill((c) => (c ? { ...c, loadingTab: false } : c)));
  }, [ctx, selected]);

  const pickAttribute = useCallback((attributeKey: string) => {
    if (!selected) return;
    setDrill((c) => (c ? { ...c, attributeKey, loadingTab: true } : c));
    loadAttributeBreakdown(ctx, selected, attributeKey)
      .then((rows) => setDrill((c) => (c && c.activity === selected
        ? { ...c, byAttribute: rows, loadingTab: false } : c)))
      .catch(() => setDrill((c) => (c ? { ...c, loadingTab: false } : c)));
  }, [ctx, selected]);

  const pickCase = useCallback((entity: string) => {
    setActiveVariant(null);
    loadRoute(ctx, entity)
      .then(setRoute)
      .catch((err) => setDrill((c) => (c ? { ...c, error: `Could not load that route: ${(err as Error)?.message}` } : c)));
  }, [ctx]);

  /* -------------------------------------------------------------- *
   * Picking on the terrain.
   * -------------------------------------------------------------- */
  const nearestStation = useCallback((x: number, z: number): string | null => {
    if (!plan) return null;
    let best: string | null = null;
    let bestDistance = PICK_RADIUS;
    for (const node of plan.nodes) {
      const distance = Math.hypot(node.x - x, node.y - z);
      if (distance < bestDistance) { bestDistance = distance; best = node.activity; }
    }
    return best;
  }, [plan]);

  const pickPoint = useCallback((x: number, z: number) => {
    const hit = nearestStation(x, z);
    setSelected(hit);
    setActiveVariant(null);
    if (hit) {
      setTab('overview');
      promenade.select([{ kind: 'activity', id: hit }]);
    } else {
      promenade.select([]);
    }
  }, [nearestStation]);

  const hoverPoint = useCallback((x: number | null, z: number) => {
    setHovered(x == null ? null : nearestStation(x, z));
  }, [nearestStation]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelected(null);
        setActiveVariant(null);
        setRoute(null);
        promenade.select([]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* -------------------------------------------------------------- *
   * Labels.
   * -------------------------------------------------------------- */
  /**
   * `auto` follows Promenade's own appearance setting.
   *
   * The host already pushes its palette tokens into the frame and re-pushes
   * them when the user switches System/Light/Dark, so the honest source of
   * truth is `--bg`: light ground means the relief scheme, dark means the
   * topographic one. Deciding from the token rather than from a second
   * setting is what keeps a light app from opening a black panel in the
   * middle of it — which, until now, it always did.
   */
  const palette = params.palette === 'auto'
    ? (isDarkGround(theme.bg) ? 'topographic' : 'relief')
    : params.palette;
  const scheme = SCHEMES[palette as 'topographic' | 'relief'] ?? SCHEMES.topographic;
  /**
   * `auto` is resolved exactly once, here, and never travels further.
   *
   * The scene re-reads `params.palette` in eight places — the hypsometric
   * ramp the terrain raster is painted from, the light intensities, the flow
   * widths — each as a plain `=== 'topographic'` or a `RAMPS[…]` lookup. Both
   * forms fail quietly on an unknown value rather than loudly: the comparison
   * says "not dark" and the lookup falls back *to* the dark ramp, which is how
   * a first cut of this produced a black terrain sitting on a white sky. So
   * everything downstream is handed a palette that is only ever one of the two
   * real ones.
   */
  const sceneParams = useMemo(() => ({ ...params, palette }), [params, palette]);
  const metric = params.frictionMetric;

  const scale = useMemo(
    () => graduation(model?.maxFriction ?? 1, params.elevationCurve),
    [model?.maxFriction, params.elevationCurve]
  );

  const reworkEdge = useMemo(() => {
    if (!model || !plan) return null;
    const backward = new Set(plan.edges.filter((e) => e.backward).map((e) => e.key));
    return reworkEdgeOf(model, backward);
  }, [model, plan]);

  const { anchors, labels } = useMemo(() => {
    const anchorList: Anchor[] = [];
    const labelList: LabelItem[] = [];
    if (!plan || !model || !field) return { anchors: anchorList, labels: labelList };

    const busiest = Math.max(1, ...model.activities.map((a) => a.occurrences));
    for (const node of plan.nodes) {
      const stat = model.activities.find((a) => a.activity === node.activity);
      if (!stat) continue;
      const y = terrainY(field, node.x, node.y, yScale);
      const isSummit = summit?.activity === node.activity;
      // Deliberately keyed on the click, not the hover: a hovered label's
      // detail text and priority used to shift with the pointer, which could
      // move the label out from under the cursor and fire the opposite hover
      // state next frame - an oscillation that visibly "jumped" every label on
      // the map, not just the one being pointed at. A click is a discrete,
      // one-off event with nothing to feed back into, so it can safely affect
      // layout the same way; hover still highlights the station's own ring in
      // 3D (`Stations`, below) without touching anything here.
      const clicked = selected === node.activity;
      // "Station labels" off hides just the per-activity name pills; the
      // station's own clickable ring (`Stations`, below) is a separate 3D
      // system keyed on `plan.nodes` directly, not on this anchor/label pair,
      // so turning names off does not turn off picking.
      if (!params.showLabels) continue;
      anchorList.push({ id: `a:${node.activity}`, world: [node.x, y + 0.055, node.y] });
      labelList.push({
        id: `a:${node.activity}`,
        text: node.activity,
        detail: clicked || isSummit ? formatFriction(frictionOf(stat, metric), metric) : undefined,
        kind: isSummit ? 'summit' : 'station',
        priority: (isSummit ? 1000 : 0) + (clicked ? 500 : 0) + stat.occurrences / busiest,
        // Above the station first, then the four diagonals: a dense cluster
        // then keeps most of its names instead of hiding all but one.
        offsets: [[0, -20], [0, 20], [58, -14], [-58, -14], [58, 16], [-58, 16]],
        activity: node.activity,
      });
    }

    // The two callouts the reference sketch calls for: the summit's queue, and
    // the strongest flow that goes backwards.
    if (summit && plan.byActivity.has(summit.activity)) {
      const node = plan.byActivity.get(summit.activity)!;
      const y = terrainY(field, node.x, node.y, yScale);
      anchorList.push({ id: 'c:queue', world: [node.x, y + 0.075, node.y] });
      labelList.push({
        id: 'c:queue',
        text: `${isDuration(metric) ? 'Queue' : 'Repeats'} ${formatFriction(frictionOf(summit, metric), metric)}`,
        kind: 'callout-queue',
        priority: 2000,
        offsets: [[132, -34], [-132, -34], [132, 30], [-132, 30], [0, -54]],
        leader: true,
        activity: summit.activity,
      });
    }
    if (reworkEdge) {
      const stream = streams.find((s) => s.key === edgeKey(reworkEdge.source, reworkEdge.target));
      const middle = stream?.path[Math.floor((stream?.path.length ?? 1) / 2)];
      if (middle) {
        anchorList.push({ id: 'c:rework', world: [middle.x, middle.y + 0.03, middle.z] });
        labelList.push({
          id: 'c:rework',
          text: 'Rework',
          // Short on purpose: a callout wide enough to spell out both activity
          // names has nowhere to go on a narrow panel, and the flow's own
          // endpoints are one hover away.
          detail: `${formatCount(reworkEdge.entities)} ${objectCentric ? 'objects' : 'cases'}`,
          kind: 'callout-rework',
          priority: 1900,
          offsets: [[126, 34], [-126, 34], [126, -30], [-126, -30], [0, 52]],
          leader: true,
        });
      }
    }

    // Elevation axis: the pole is 3D (`AxisPole`), its numbers are DOM.
    anchorList.push({ id: 't:caption', world: [-AXIS_HALF, yScale * 1.1, AXIS_HALF] });
    labelList.push({
      id: 't:caption',
      text: FRICTION_AXIS[metric].split('\n')[0],
      detail: FRICTION_AXIS[metric].split('\n')[1],
      kind: 'caption',
      priority: 1500,
      offsets: [[-6, -30], [-6, 30], [90, -30]],
    });
    scale.ticks.forEach((tick, i) => {
      anchorList.push({ id: `t:${i}`, world: [-AXIS_HALF, tick.altitude * yScale, AXIS_HALF] });
      labelList.push({
        id: `t:${i}`,
        text: formatFriction(tick.value, metric),
        kind: 'tick',
        priority: 1400 - i,
        offsets: [[-30, 0], [34, 0]],
      });
    });

    return { anchors: anchorList, labels: labelList };
  }, [plan, model, field, yScale, summit, selected, hovered, metric, scale, reworkEdge, streams, params.showLabels]);

  const sink: ProjectionSink = useCallback((projected, size) => {
    labelRef.current?.place(projected, size);
  }, []);

  const focusSelected = useCallback(() => {
    if (!plan || !field || !selected) return;
    const node = plan.byActivity.get(selected);
    if (!node) return;
    setCommand((current) => ({
      nonce: current.nonce + 1,
      kind: 'focus',
      target: { x: node.x, y: terrainY(field, node.x, node.y, yScale), z: node.y },
    }));
  }, [plan, field, selected, yScale]);

  /* -------------------------------------------------------------- *
   * Render.
   * -------------------------------------------------------------- */
  const sceneModel: SceneModel | null = useMemo(() => {
    if (!field || !plan || !model) return null;
    return {
      field, plan, model, scheme, params: sceneParams, streams,
      route: routePath ?? variantRoute,
      hovered, selected,
      variantPath: activeVariant?.activities ?? null,
    };
  }, [field, plan, model, scheme, sceneParams, streams, routePath, variantRoute, hovered, selected, activeVariant]);

  const dark = palette === 'topographic';

  return (
    <div className={`ft-root ${dark ? 'ft-dark' : 'ft-light'}`} style={{ ['--ft-ink' as string]: scheme.ink }}>
      {sceneModel && (
        <TopographyView
          scene={sceneModel}
          anchors={anchors}
          sink={sink}
          command={command}
          graduation={scale}
          onPickPoint={pickPoint}
          onHoverPoint={hoverPoint}
          onInteract={() => setHovered(null)}
          onBackend={setBackend}
          onDeviceLost={(reason) => {
            // Rebuild on WebGL 2 rather than leave a frozen canvas behind. The
            // `renderer` param is what keys the Canvas, so writing it back
            // through the normal param path is the whole of the recovery — and
            // it persists, so a machine whose WebGPU keeps dying stops trying.
            setBackend(`WebGL 2 · recovered (${reason})`);
            if (paramsRef.current.renderer !== 'webgl2') change({ renderer: 'webgl2' });
          }}
        />
      )}

      {sceneModel && (
        <Labels
          ref={labelRef}
          items={labels}
          onPick={(name) => { setSelected(name); setTab('overview'); promenade.select([{ kind: 'activity', id: name }]); }}
          onHover={setHovered}
        />
      )}

      <Toolbar
        params={params}
        onChange={change}
        onReset={() => setCommand((c) => ({ nonce: c.nonce + 1, kind: 'reset' }))}
        onTop={() => {
          change({ viewMode: params.viewMode === 'top' ? '3d' : 'top' });
          setCommand((c) => ({ nonce: c.nonce + 1, kind: params.viewMode === 'top' ? 'reset' : 'top' }));
        }}
        onFlyToSummit={() => {
          if (!summit) return;
          setSelected(summit.activity);
          setTab('overview');
          promenade.select([{ kind: 'activity', id: summit.activity }]);
          const node = plan?.byActivity.get(summit.activity);
          if (node && field) {
            setCommand((c) => ({
              nonce: c.nonce + 1,
              kind: 'focus',
              target: { x: node.x, y: terrainY(field, node.x, node.y, yScale), z: node.y },
            }));
          }
        }}
        summit={summit?.activity ?? null}
        backend={backend}
      />

      {model && <Legend metric={metric} objectCentric={objectCentric} hasRoute={!!sceneModel?.route} />}

      {data && model && (
        <Inspector
          data={data}
          model={model}
          metric={metric}
          activity={activity}
          isSummit={summit?.activity === activity?.activity}
          drill={drill}
          tab={tab}
          onTab={setTab}
          onDimension={pickDimension}
          onAttributeKey={pickAttribute}
          onPickVariant={(variant) => { setRoute(null); setActiveVariant(variant); }}
          onPickCase={pickCase}
          activeVariant={activeVariant?.signature ?? null}
          route={route ? { label: route.label, steps: route.steps } : null}
          onClearRoute={() => { setRoute(null); setActiveVariant(null); }}
          onClose={() => { setSelected(null); setActiveVariant(null); setRoute(null); promenade.select([]); }}
          onFocus={focusSelected}
        />
      )}

      {(status || error) && (
        <div className={`ft-status ${error ? 'is-error' : ''}`}>
          {error ?? status}
        </div>
      )}
    </div>
  );
}

const container = document.getElementById('root')!;
createRoot(container).render(<App />);
