import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Background, ControlButton, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider,
  useNodesInitialized, useReactFlow, type Edge, type Node,
} from '@xyflow/react';
// @ts-ignore -- esbuild inlines this stylesheet as text for the sandboxed frame.
import reactFlowCss from '@xyflow/react/dist/style.css';
import { StationNode, type StationNodeData } from './StationNode';
import { GatewayNode, type GatewayNodeData } from './GatewayNode';
import { BoundaryNode, type BoundaryNodeData } from './BoundaryNode';
import { MetroEdge, type MetroEdgeData } from './MetroEdge';
// The layout itself — ranking, routing and drawn geometry — is the shared
// `metro-layout` package, not this plugin's own code; see its `index.ts`.
import {
  BOUNDARY_D, COL_W, GATEWAY_D, STATION_BOX_W,
  laneX, peakTrackDemand, refineDrawing, relayoutVisible, routeAll, stationSize, toRoutingNode,
  type Point, type REdge, type RNode,
} from 'metro-layout';
import { ExportMenu } from './lib/ExportMenu';
import { ControlsPanel } from './ControlsPanel';
import { useVariantFilter } from './variants';
import { MetroLoader } from './MetroLoader';
import {
  defaultViewParams, formatDuration,
  type MetroMapPayload, type MmEdge, type MmNode, type VariantSummary, type ViewParams,
} from './types';

/** Lane pitch in px — wider for labelled-rectangle stations so their boxes
 * (and a label's own text) don't collide the way bare dots wouldn't. */
function lanePitch(style: ViewParams['stationStyle']): number {
  return style === 'labels' ? 176 : COL_W;
}

/** The point half-way along a polyline by arc length. */
function midOf(points: Point[]): Point {
  if (points.length < 2) return points[0] ?? { x: 0, y: 0 };
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    seg.push(d);
    total += d;
  }
  let acc = 0;
  for (let i = 0; i < seg.length; i++) {
    if (acc + seg[i] >= total / 2) {
      const t = seg[i] === 0 ? 0 : (total / 2 - acc) / seg[i];
      return { x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t };
    }
    acc += seg[i];
  }
  return points[points.length - 1];
}

const styleTag = document.createElement('style');
styleTag.textContent = reactFlowCss;
document.head.appendChild(styleTag);

const nodeTypes = { station: StationNode, gateway: GatewayNode, boundary: BoundaryNode };
const edgeTypes = { metro: MetroEdge };

const STATION_W = 132;
const BOUNDARY_W = 110;
/** Pixel gap between two parallel lines sharing a column or a channel. */
const LINE_SPACING = 15;
/** Extra room, past what the busiest column's tracks need at `LINE_SPACING`
 * apart, before the next lane's own band starts — see `router.ts`'s column-
 * spread comment for the `- 8` this leaves inside `routeAll` itself; this
 * margin is on top of that, so two adjacent lanes' bands don't just meet
 * edge-to-edge but keep a little visible daylight between them. */
const PITCH_MARGIN = 24;

/** Every object type touching a node — a station can list several (it's
 * shared), a gateway/source/sink exactly one. Used for the "faded" check
 * and for what clicking that node highlights. */
function objectTypesOf(n: MmNode): string[] {
  return n.kind === 'station' ? n.objectTypes : [n.objectType];
}

function sameSet(a: Set<string>, b: string[]): boolean {
  return a.size === b.length && b.every((t) => a.has(t));
}

/**
 * Host state that must be subscribed *before* the handshake.
 *
 * The host answers `promenade.ready()` with one burst — resize, theme,
 * params, then any live-run state — and `on()` keeps a single handler per
 * event. A handler registered from a React effect therefore only works if
 * `ready()` is called from that same effect, which is what this view used to
 * do. It cannot any more: `ready()` has to happen at mount, while the
 * component that wants the params is the one that renders two frames later
 * (see `Root`) — so a params message sent in between would be dropped and
 * the view would silently fall back to its defaults.
 *
 * Registering at module scope, before `ready()`, removes the race entirely
 * rather than patching one instance of it: nothing in the burst can arrive
 * before there is something to receive it. React components read the last
 * value and subscribe for later ones. (`selection` stays in `App` — it is
 * not part of the burst, and only ever arrives from a user action.)
 */
function hostStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<(v: T) => void>();
  return {
    get: () => value,
    set(next: T) { value = next; for (const l of listeners) l(next); },
    subscribe(fn: (v: T) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

/** A view whose params were saved by an ancestor of this one (the metro-map
 * plugin, before its 0.13.2) may still carry a boolean `showNumbers`. */
function migrateParams(next: unknown): Partial<ViewParams> {
  const incoming = { ...(next as Partial<ViewParams> & { showNumbers?: boolean }) };
  if (incoming.edgeLabel === undefined && typeof incoming.showNumbers === 'boolean') {
    incoming.edgeLabel = incoming.showNumbers ? 'frequency' : 'none';
  }
  delete incoming.showNumbers;
  return incoming;
}

const themeStore = hostStore<Record<string, string>>(promenade.theme());
const paramsStore = hostStore<ViewParams>(defaultViewParams);
const liveStore = hostStore<{ message: string; fraction: number | null }>({ message: '', fraction: null });

promenade.on('theme', (payload) => themeStore.set(payload.theme));
promenade.on('params', (next) => paramsStore.set({ ...paramsStore.get(), ...migrateParams(next) }));
promenade.on('liveRunState', (s) => liveStore.set({ message: s.message, fraction: s.fraction }));

/** Subscribes a component to one of the stores above. */
function useHostStore<T>(store: ReturnType<typeof hostStore<T>>): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(store.get);
  useEffect(() => store.subscribe(setValue), [store]);
  return [value, store.set];
}

function App({ map }: { map: MetroMapPayload }) {
  const [theme] = useHostStore(themeStore);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  // Which object types are highlighted right now, or `null` for none. Set by
  // clicking a line (a singleton set) or a node (every object type that
  // node touches — several, for a shared station).
  const [highlightedTypes, setHighlightedTypes] = useState<Set<string> | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const [showMiniMap, setShowMiniMap] = useState(false);
  const [params, setParams] = useHostStore(paramsStore);
  // How many of the most frequent variants are shown, or `null` = "use the
  // seed" (one: the most frequent variant alone). First user move pins it.
  const [position, setPosition] = useState<number | null>(null);

  // The slider's own scale. A payload from before this field existed, or one
  // built from an empty log, degrades to a single position covering
  // everything rather than to a broken slider.
  const variants: VariantSummary[] = useMemo(
    () => (Array.isArray(map.variants) && map.variants.length ? map.variants : [{ rank: 1, executions: 0 }]),
    [map],
  );

  const toggleHighlight = (types: string[]) => {
    setHighlightedTypes((current) => (current && sameSet(current, types) ? null : new Set(types)));
  };

  useEffect(() => {
    promenade.on('selection', (selection) => {
      setSelected(new Set(selection.items.filter((item) => item.kind === 'activity').map((item) => item.id)));
    });
  }, []);

  // Drop anything malformed up front — an OCMetroMap artifact produced by an
  // early 0.10.x build can be missing `kind`/`id` on its nodes (a serde bug
  // since fixed); re-discover it to get a clean payload.
  const cleanNodes = useMemo(
    () => map.nodes.filter((n) => typeof n?.id === 'string' && typeof n?.kind === 'string'),
    [map],
  );
  const cleanEdges = useMemo(
    () => map.edges.filter((e) => typeof e?.id === 'string' && typeof e?.source === 'string' && typeof e?.target === 'string'),
    [map],
  );
  const byId = useMemo(() => new Map(cleanNodes.map((n) => [n.id, n])), [cleanNodes]);

  // Type-visibility (the legend checkboxes) first, then the complexity
  // filter runs over what's left so its coverage readout reflects reality.
  const typeVisibleNodes = useMemo(() => {
    return cleanNodes.filter((n) => {
      if (n.kind === 'station') return n.objectTypes.some((t) => !hiddenTypes.has(t));
      return !hiddenTypes.has(n.objectType);
    });
  }, [cleanNodes, hiddenTypes]);
  const typeVisibleEdges = useMemo(
    () => cleanEdges.filter((e) => !hiddenTypes.has(e.objectType)),
    [cleanEdges, hiddenTypes],
  );

  const filter = useVariantFilter({
    nodes: typeVisibleNodes, edges: typeVisibleEdges, variants, position,
  });

  const keptNodes = useMemo(
    () => typeVisibleNodes.filter((n) => filter.keptNodeIds.has(n.id)),
    [typeVisibleNodes, filter.keptNodeIds],
  );
  const keptIds = useMemo(() => new Set(keptNodes.map((n) => n.id)), [keptNodes]);
  const keptEdges = useMemo(
    () => typeVisibleEdges.filter((e) => filter.keptEdgeIds.has(e.id) && keptIds.has(e.source) && keptIds.has(e.target)),
    [typeVisibleEdges, filter.keptEdgeIds, keptIds],
  );

  // The complexity slider filters, but the Rust layout ran on the *whole*
  // graph — so re-lay-out just the visible subgraph (ranks, lanes and dummy
  // waypoints), then feed that through the unchanged routing pipeline as if
  // it were the payload. Unfiltered (slider at max) this reproduces roughly
  // the same shape the Rust layout gave.
  //
  // `params.preserveStability` (default on) is what makes that re-layout a
  // monotone refinement of the full-graph rank/lane rather than a fresh
  // computation — see `relayoutVisible`'s own doc comment. Off, every
  // slider move computes rank and lane from only what's currently visible,
  // as if the hidden stations and arcs never existed.
  const layout = useMemo(
    () => relayoutVisible(keptNodes, keptEdges, { preserveStability: params.preserveStability }),
    [keptNodes, keptEdges, params.preserveStability],
  );
  const visibleNodes = useMemo(
    () => keptNodes.map((n) => ({ ...n, rank: layout.rank.get(n.id) ?? n.rank, lane: layout.lane.get(n.id) ?? n.lane })),
    [keptNodes, layout],
  );
  const visibleEdgesAll = useMemo(
    () => keptEdges.map((e) => ({
      ...e,
      waypoints: layout.waypoints.get(e.id) ?? [],
    })),
    [keptEdges, layout],
  );
  const byIdLaid = useMemo(() => new Map(visibleNodes.map((n) => [n.id, n as MmNode])), [visibleNodes]);

  const basePitch = lanePitch(params.stationStyle);

  // Built once and shared by all three routing stages below. `peakTrackDemand`,
  // `routeAll` and `refineDrawing` all treat their input as read-only.
  const routerInput = useMemo(
    (): { rNodes: RNode[]; rEdges: REdge[] } => ({
      rNodes: visibleNodes.map((n) => toRoutingNode(n as MmNode, params.stationStyle)),
      rEdges: visibleEdgesAll.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        objectType: e.objectType,
        waypoints: e.waypoints ?? [],
      })),
    }),
    [visibleNodes, visibleEdgesAll, params.stationStyle],
  );

  // Size the lane pitch to the busiest column or channel this graph
  // actually needs, rather than always using `basePitch` regardless of how
  // many object-type lines converge somewhere in the diagram: a fixed
  // pitch is exactly what let a busy column's drawn spread bleed past its
  // own bound once its track count outgrew what that fixed pitch could
  // comfortably hold (see `router.ts`'s `peakTrackDemand` and the
  // column-spread comment in `routeAll`). Every consumer of lane position
  // — this pitch, the router below, and `nodeFor`'s own `laneX` call for
  // drawing the stations themselves — must agree on the same value, or
  // stations and routed lines would drift apart.
  const pitch = useMemo(() => {
    const demand = peakTrackDemand(routerInput.rNodes, routerInput.rEdges);
    return Math.max(basePitch, (demand - 1) * LINE_SPACING + PITCH_MARGIN);
  }, [routerInput, basePitch]);

  // ------------------------------------------------------------- routing
  // One call, one occupancy model. `router.ts` allocates a track to every
  // vertical (per lane column) and every horizontal (per channel between
  // rows) by interval partitioning, so two lines of different object types
  // can never come out collinear-and-overlapping. Row heights fall out of
  // the channel track counts, so the rows are exactly as tall as their
  // traffic needs. Nothing downstream nudges anything.
  const routed = useMemo(
    () => routeAll(routerInput.rNodes, routerInput.rEdges, {
      laneX: (lane) => laneX(lane, pitch),
      spacing: LINE_SPACING,
      minChannel: params.stationStyle === 'labels' ? 96 : 84,
      pitch,
    }),
    [routerInput, pitch, params.stationStyle],
  );

  // The final pixel-level pass the Metro Map plugin has run since 0.17.6 and
  // this one never did: align short unbranched source tails to their arrival
  // port, detour an obstructed vertical run around the node footprints and
  // stop captions it would otherwise cut through, and shorten only those
  // corners whose 45° chamfer would overlap something. It changes no rank,
  // no lane order and no object-type trunk — `metro-layout`'s own check
  // asserts exactly that.
  const drawing = useMemo(
    () => refineDrawing(routerInput.rNodes, routerInput.rEdges, routed, pitch),
    [routerInput, routed, pitch],
  );

  const rankOf = (id: string) => byIdLaid.get(id)?.rank ?? 0;
  const y = useMemo(() => {
    const maxR = visibleNodes.reduce((m, n) => Math.max(m, n.rank), 0);
    const arr: number[] = [];
    for (let r = 0; r <= maxR; r++) arr.push(routed.rowY.get(r) ?? 0);
    return arr;
  }, [routed, visibleNodes]);

  const nodes: Node[] = useMemo(
    () => visibleNodes.map((n) => nodeFor(
      n, drawing.nodeX.get(n.id) ?? laneX(n.lane, pitch), y, theme, selected, highlightedTypes, params, filter.nodeCount.get(n.id),
    )),
    [visibleNodes, drawing, pitch, y, theme, selected, highlightedTypes, params, filter.nodeCount],
  );

  const edges: Edge[] = useMemo(() => {
    // Both figures come from the filter, not from the edge: they are counted
    // over exactly the variants currently shown (see `useVariantFilter`), so
    // the number on an arc always matches the picture around it.
    const labelOf = (e: MmEdge): string | undefined => {
      if (params.edgeLabel === 'frequency') {
        const freq = filter.edgeFreq.get(e.id);
        return freq != null ? freq.toLocaleString('en') : undefined;
      }
      if (params.edgeLabel === 'performance') {
        const secs = filter.edgeDuration.get(e.id);
        return secs != null ? formatDuration(secs) : undefined;
      }
      return undefined;
    };
    const showNum = params.edgeLabel !== 'none';
    const built: Array<{ e: MmEdge; points: Point[] }> = [];
    for (const e of visibleEdgesAll) {
      const pts = drawing.points.get(e.id);
      if (pts && pts.length >= 2) built.push({ e, points: pts });
    }

    // De-overlap the frequency labels: place each at its edge's polyline
    // midpoint, then push colliding ones apart vertically.
    const placed: Array<{ x: number; y: number; w: number }> = [];
    const labelPos = new Map<string, Point>();
    if (showNum) {
      const withLabel = built
        .map(({ e, points }) => ({ id: e.id, text: labelOf(e), points }))
        .filter((l): l is { id: string; text: string; points: Point[] } => l.text !== undefined)
        .map((l) => ({ id: l.id, w: l.text.length * 6.4 + 10, mid: midOf(l.points) }))
        .sort((a, b) => a.mid.x - b.mid.x || a.mid.y - b.mid.y);
      for (const l of withLabel) {
        let ly = l.mid.y;
        for (let iter = 0; iter < 20; iter++) {
          const hit = placed.find((p) => Math.abs(l.mid.x - p.x) < (l.w + p.w) / 2 + 2 && Math.abs(ly - p.y) < 16);
          if (!hit) break;
          ly = ly >= hit.y ? hit.y + 17 : hit.y - 17;
        }
        placed.push({ x: l.mid.x, y: ly, w: l.w });
        labelPos.set(l.id, { x: l.mid.x, y: ly });
      }
    }

    return built.map(({ e, points }) => {
      const dashed = byId.get(e.source)?.kind === 'source' || byId.get(e.target)?.kind === 'sink';
      const data: MetroEdgeData = {
        // The router already ends every polyline exactly on the node's
        // border with a straight run in, so only a hair of trim is needed
        // to keep the arrowhead clear of the outline.
        cornerCuts: drawing.chamferCuts.get(e.id),
        points, objectType: e.objectType, dashed,
        variable: e.variable ?? false,
        sourceRadius: 0,
        targetRadius: 3,
        faded: highlightedTypes != null && !highlightedTypes.has(e.objectType),
        color: promenade.color('objectType', e.objectType),
        label: labelOf(e),
        labelPos: labelPos.get(e.id),
        theme,
        animate: params.animateFlow,
      };
      return { id: e.id, source: e.source, target: e.target, type: 'metro', data } satisfies Edge;
    });
  }, [drawing, visibleEdgesAll, byId, highlightedTypes, params, theme, filter]);

  // Re-fit only when the *set* of drawn nodes actually changes (a legend
  // toggle hiding/showing object types) — not on every render that only
  // changes a `faded` flag (clicking a line to highlight it), which
  // recomputes `nodes` as new object references without changing what's on
  // screen structurally. Re-fitting on a highlight click would zoom/pan the
  // canvas out from under whatever the user was just looking at.
  const structuralKey = visibleNodes.map((n) => n.id).sort().join('|') + `|${params.stationStyle}|${filter.seed}`;
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  useEffect(() => {
    if (!nodes.length || !nodesInitialized) return;
    // `nodesInitialized` means every node has a measured size, so one frame
    // later `fitView` has an accurate bounding box for the whole map.
    const raf = requestAnimationFrame(() => fitView({ padding: 0.16, duration: 0 }));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structuralKey, fitView, nodesInitialized]);

  return (
    <div style={{ width: '100%', height: '100%', background: theme.bg }}>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodeClick={(_, node) => {
          if (node.type === 'station') promenade.select([{ kind: 'activity', id: (node.data as StationNodeData).activity }]);
          const mmNode = byId.get(node.id);
          if (mmNode) toggleHighlight(objectTypesOf(mmNode));
        }}
        onEdgeClick={(_, edge) => toggleHighlight([(edge.data as MetroEdgeData).objectType])}
        onPaneClick={() => setHighlightedTypes(null)}
        fitView fitViewOptions={{ padding: 0.16 }}
        nodeOrigin={[0, 0]} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false}
        panOnDrag panOnScroll={false} zoomOnScroll zoomOnPinch zoomOnDoubleClick={false}
        minZoom={0.05} maxZoom={4} proOptions={{ hideAttribution: true }}
      >
        <Background color={theme.border} gap={20} />
        <Controls showInteractive={false}>
          <ControlButton onClick={() => setShowMiniMap((v) => !v)} title={showMiniMap ? 'Hide overview map' : 'Show overview map'}>
            {showMiniMap ? '▣' : '□'}
          </ControlButton>
          <ExportMenu filename="variant-metro" />
        </Controls>
        {showMiniMap && (
          <MiniMap pannable zoomable style={{ background: theme['bg-soft'] }} nodeColor={() => theme['text-dim']} />
        )}
        <Panel position="top-left">
          <Legend
            map={map} hidden={hiddenTypes} setHidden={setHiddenTypes} open={legendOpen} setOpen={setLegendOpen}
            highlighted={highlightedTypes} onToggleHighlight={toggleHighlight} theme={theme}
          />
        </Panel>
        <Panel position="top-right">
          <ControlsPanel
            theme={theme} params={params}
            onParamsChange={(next) => setParams({ ...paramsStore.get(), ...next })}
            position={position ?? filter.seed} sliderMax={filter.sliderMax}
            onPositionChange={setPosition} coverage={filter.coverage}
            at={variants[(position ?? filter.seed) - 1]}
          />
        </Panel>
      </ReactFlow>
    </div>
  );
}

function nodeFor(
  n: MmNode, cx: number, y: number[], theme: Record<string, string>,
  selected: Set<string>, highlightedTypes: Set<string> | null, params: ViewParams,
  count: number | undefined,
): Node {
  const cy = y[n.rank] ?? 0;
  const faded = highlightedTypes != null && !objectTypesOf(n).some((t) => highlightedTypes.has(t));

  if (n.kind === 'station') {
    const objectTypes = [...n.objectTypes].sort().map((name) => ({ name, color: promenade.color('objectType', name) }));
    const { w, h } = stationSize(params.stationStyle, objectTypes.length);
    const data: StationNodeData = {
      activity: n.activity, objectTypes, selected: selected.has(n.activity), faded, theme,
      style: params.stationStyle, count, showNumber: params.edgeLabel === 'frequency',
    };
    const boxW = params.stationStyle === 'labels' ? w : STATION_W;
    return {
      id: n.id, type: 'station', data,
      position: { x: cx - boxW / 2, y: cy - h / 2 },
      width: boxW, height: h + (params.stationStyle === 'labels' ? 8 : 30),
    };
  }
  if (n.kind === 'gateway') {
    const data: GatewayNodeData = {
      gatewayType: n.gatewayType, direction: n.direction, color: promenade.color('objectType', n.objectType), faded, theme,
    };
    return {
      id: n.id, type: 'gateway', data,
      position: { x: cx - GATEWAY_D / 2, y: cy - GATEWAY_D / 2 },
      width: GATEWAY_D, height: GATEWAY_D,
    };
  }
  const data: BoundaryNodeData = {
    objectType: n.objectType, kind: n.kind, color: promenade.color('objectType', n.objectType), faded, theme,
    count, showNumber: params.edgeLabel === 'frequency',
  };
  return {
    id: n.id, type: 'boundary', data,
    position: { x: cx - BOUNDARY_W / 2, y: cy - BOUNDARY_D / 2 },
    width: BOUNDARY_W, height: BOUNDARY_D + 26,
  };
}

function Legend({ map, hidden, setHidden, open, setOpen, highlighted, onToggleHighlight, theme }: {
  map: MetroMapPayload; hidden: Set<string>; setHidden: (update: (current: Set<string>) => Set<string>) => void;
  open: boolean; setOpen: (value: boolean) => void;
  highlighted: Set<string> | null; onToggleHighlight: (types: string[]) => void;
  theme: Record<string, string>;
}) {
  const toggle = (objectType: string) => setHidden((current) => {
    const next = new Set(current);
    next.has(objectType) ? next.delete(objectType) : next.add(objectType);
    return next;
  });
  // Isolating one line at a time (or clearing back to all) is by far the
  // most common thing you want while narrowing down *which* line is
  // responsible for something on screen — doing it one checkbox at a time
  // is exactly the kind of friction that discourages checking in the first
  // place.
  const showAll = () => setHidden(() => new Set());
  const showNone = () => setHidden(() => new Set(map.objectTypes));
  const showOnly = (objectType: string) => setHidden(() => new Set(map.objectTypes.filter((t) => t !== objectType)));
  return (
    <div style={{ background: theme['bg-soft'], border: `1px solid ${theme.border}`, borderRadius: 8, padding: 10, minWidth: 182, fontSize: 11, color: theme.text, boxShadow: '0 2px 8px rgba(0,0,0,.08)' }}>
      <div onClick={() => setOpen(!open)} style={{ display: 'flex', justifyContent: 'space-between', cursor: 'pointer', fontWeight: 600, marginBottom: open ? 6 : 0 }}>
        <span>Objects</span><span style={{ color: theme['text-dim'] }}>{open ? '−' : '+'}</span>
      </div>
      {open && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 6, fontSize: 10, color: theme['text-dim'] }}>
          <span onClick={showAll} style={{ cursor: 'pointer', textDecoration: 'underline' }}>All</span>
          <span onClick={showNone} style={{ cursor: 'pointer', textDecoration: 'underline' }}>None</span>
        </div>
      )}
      {open && map.objectTypes.map((objectType) => (
        <div key={objectType} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <input type="checkbox" checked={!hidden.has(objectType)} onChange={() => toggle(objectType)} style={{ margin: 0, cursor: 'pointer' }} />
          <span
            onClick={() => onToggleHighlight([objectType])}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
              opacity: highlighted != null && !highlighted.has(objectType) ? 0.4 : 1,
              fontWeight: highlighted?.has(objectType) ? 700 : 400,
            }}
          >
            <span style={{ width: 14, height: 3, borderRadius: 2, background: promenade.color('objectType', objectType) }} />
            <span>{objectType}</span>
          </span>
          <span
            onClick={() => showOnly(objectType)}
            style={{ marginLeft: 'auto', cursor: 'pointer', textDecoration: 'underline', color: theme['text-dim'], fontSize: 10 }}
          >
            only
          </span>
        </div>
      ))}
      {open && <div style={{ marginTop: 8, paddingTop: 6, borderTop: `1px solid ${theme.border}`, color: theme['text-dim'], lineHeight: 1.45 }}>
        Based on the <b>OC-DFG of the k most frequent variants</b>, where k is
        the slider on the right: at the top, every variant in the log; at the
        bottom, the most frequent one alone. A dashed segment is a line's very
        first or very last arc; a line running backward up the page is a
        genuine loop (rework), not a mining artefact.
      </div>}
    </div>
  );
}

/**
 * What this panel is: the real artifact, or a run-bound live preview.
 *
 * The manifest marks this view `livePreview`, so the host also opens it for a
 * discovery run that has not finished yet — the panel appears immediately
 * instead of after a long stretch of nothing but a top-bar progress bar. That
 * matters more here than for an ordinary wasm action: `discover` runs the
 * pyodide variant-extraction stage first (`scans: OCVariantDFG`), so the wait
 * includes starting Python. In that case `value` is the run's seed (the
 * inputs), not an `OCVariantMetro`, and `runState` is 'running'. The host
 * swaps the whole panel for the real artifact's tab when the run lands, so
 * this branch never has to become the map itself; it only has to wait well.
 *
 * The payload check is not redundant with `runState`: a genuinely empty or
 * malformed artifact reaches the same standby screen rather than an exception
 * thrown out of the layout pass.
 */
function Root() {
  const artifact = promenade.artifact();
  const payload = artifact.value as MetroMapPayload | null;
  const pending = artifact.runState === 'running' || !payload || !Array.isArray(payload.nodes);

  const [theme] = useHostStore(themeStore);
  const [live] = useHostStore(liveStore);
  // False until the loader has had a frame of its own to paint in.
  const [laidOut, setLaidOut] = useState(false);

  // Hand the main thread back for two frames before starting the layout
  // pass, so the loader below is actually painted rather than merely
  // rendered. One frame is not enough: the first `requestAnimationFrame`
  // callback runs *before* the paint it was scheduled alongside.
  useEffect(() => {
    if (pending) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setLaidOut(true));
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [pending]);

  if (pending || !laidOut) {
    const stations = payload && Array.isArray(payload.nodes)
      ? payload.nodes.filter((n) => n?.kind === 'station').length
      : 0;
    const variants = payload && Array.isArray(payload.variants) ? payload.variants.length : 0;
    return (
      <MetroLoader
        theme={theme}
        title={pending ? 'Discovering the variant metro map…' : 'Drawing the variant metro map…'}
        message={pending
          ? (live.message || 'Extracting variants in Python, then routing their lines.')
          : `Routing ${stations.toLocaleString('en')} stations`
            + (variants ? ` across ${variants.toLocaleString('en')} variants` : '')
            + '.'}
        fraction={pending ? live.fraction : null}
      />
    );
  }
  return <ReactFlowProvider><App map={payload!} /></ReactFlowProvider>;
}

// The handshake, once the module-scope handlers above are all in place and
// before anything renders — `App`'s first render is the layout pass this
// whole screen exists to cover, so it is far too late to do it from there.
promenade.ready();
createRoot(document.getElementById('root')!).render(<Root />);
