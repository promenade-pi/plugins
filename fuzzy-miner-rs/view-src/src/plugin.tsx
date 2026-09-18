import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, ControlButton, Controls, MarkerType, MiniMap, Panel, ReactFlow, ReactFlowProvider,
  useReactFlow, type Edge, type Node,
} from '@xyflow/react';
// esbuild's `.css` → text loader (see build.js) turns this into a plain JS
// string; an opaque-origin frame cannot load a subresource of its own.
// @ts-ignore -- text loader, not a real CSS module
import reactFlowCss from '@xyflow/react/dist/style.css';

import { ActivityNode, ACTIVITY_H, ACTIVITY_W, type ActivityNodeData } from './ActivityNode';
import { ClusterNode, CLUSTER_H, CLUSTER_W, type ClusterNodeData } from './ClusterNode';
import { FuzzyEdge, edgeLabelText, type FuzzyEdgeData } from './FuzzyEdge';
import { applyFilters, type FuzzyFilterModel, type FuzzyGraph } from './filters';
import { fuzzyLayoutOptions, layout, midpointOf, NODE_MARGIN, pathFromSections, trimPath, type ElkResult } from './layout';
import { SliderRail } from './SliderRail';
import { ExportMenu } from './lib/ExportMenu';
import { defaultViewParams, format3, type FuzzyModelPayload, type ViewParams } from './types';
import { bootView } from './bootstrap';

const styleTag = document.createElement('style');
styleTag.textContent = reactFlowCss;
document.head.appendChild(styleTag);

const nodeTypes = { activity: ActivityNode, cluster: ClusterNode };
const edgeTypes = { fuzzy: FuzzyEdge };

/**
 * ELK's layered placement runs on this frame's single thread — the sandbox's
 * CSP rules out a real Worker (see `layout.ts`) — and a Fuzzy graph at a low
 * edge cutoff is exactly the dense shape that gets slow. Past this the rail
 * says so rather than freezing the tab; the cutoff slider is right there.
 */
const LAYOUT_EDGE_LIMIT = 1200;

/** Below this path length there is no room for a number between two nodes. */
const MIN_LABELLED_EDGE = 46;

/** How dark a relation's ink is drawn, from its significance. */
function edgeColor(theme: Record<string, string>, significance: number): string {
  const dark = (theme.bg ?? '#fff').match(/^#0|^#1|^#2/) != null;
  // Significance runs 0..1; keep even the faintest arc visible.
  const t = 0.35 + Math.min(1, Math.max(0, significance)) * 0.65;
  return dark
    ? `rgba(190, 205, 215, ${t})`
    : `rgba(60, 72, 84, ${t})`;
}

type LayoutIssue = { kind: 'too-large'; edges: number } | { kind: 'failed'; message: string };

function App({ payload }: { payload: FuzzyModelPayload }) {
  const [theme, setTheme] = useState<Record<string, string>>(promenade.theme());
  const [params, setParams] = useState<ViewParams>(defaultViewParams);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openCluster, setOpenCluster] = useState<number | null>(null);
  const [showMiniMap, setShowMiniMap] = useState(true);
  const [railOpen, setRailOpen] = useState(true);
  const [elk, setElk] = useState<ElkResult | null>(null);
  const [issue, setIssue] = useState<LayoutIssue | null>(null);

  useEffect(() => {
    promenade.on('theme', (p) => setTheme(p.theme));
    promenade.on('selection', (sel) => {
      setSelected(new Set(sel.items.filter((i) => i.kind === 'activity').map((i) => i.id)));
    });
    promenade.on('params', (next) => setParams((current) => ({ ...current, ...(next as Partial<ViewParams>) })));
    promenade.ready();
  }, []);

  /**
   * The rail owns these params (`views[].ownsControls`), but they are still
   * host state: writing them back is what persists a slider position with the
   * saved view instead of losing it when the panel closes.
   */
  const change = (patch: Partial<ViewParams>) => {
    setParams((current) => ({ ...current, ...patch }));
    promenade.setParams(patch as Record<string, unknown>);
  };

  const model: FuzzyFilterModel = useMemo(() => ({
    n: payload.activities.length,
    activities: payload.activities,
    counts: payload.counts ?? [],
    nodeSignificance: payload.nodeSignificance ?? [],
    edgeSignificance: payload.edgeSignificance ?? [],
    edgeCorrelation: payload.edgeCorrelation ?? [],
  }), [payload]);

  const graph: FuzzyGraph = useMemo(() => applyFilters(model, params), [model, params]);

  // Only the parts of `params` that change the *shape* belong in the layout's
  // dependency list — re-running ELK because an edge label appeared would
  // reshuffle the whole diagram for a purely cosmetic change.
  const shapeKey = useMemo(
    () => JSON.stringify([
      graph.nodes.map((n) => n.index),
      graph.clusters.map((c) => [c.index, c.primitives.length]),
      graph.edges.map((e) => [e.source, e.target]),
    ]),
    [graph]
  );

  useEffect(() => {
    if (graph.edges.length > LAYOUT_EDGE_LIMIT) {
      setIssue({ kind: 'too-large', edges: graph.edges.length });
      setElk(null);
      return;
    }
    let cancelled = false;
    setIssue(null);
    // ELK lays out the node at its real, drawn size. Padding this box
    // (an earlier version of this code did) routes edges to a *larger*
    // virtual boundary while the real node stays smaller and centred inside
    // it — the gap between where an edge stops and where the node starts is
    // exactly the padding, and multiple ports spread across the padded
    // boundary compress onto a narrower band of the real node's width, or
    // miss it entirely near the corners. Real size in, real size out; the
    // clearance below (`trimPath`) is applied to the drawn path only.
    const children = [
      ...graph.nodes.map((n) => ({ id: `a${n.index}`, width: ACTIVITY_W, height: ACTIVITY_H })),
      ...graph.clusters.map((c) => ({ id: `c${c.index}`, width: CLUSTER_W, height: CLUSTER_H })),
    ];
    const idOf = (index: number) => (index < model.n ? `a${index}` : `c${index}`);
    const present = new Set(children.map((c) => c.id));
    const edges = graph.edges
      .filter((e) => present.has(idOf(e.source)) && present.has(idOf(e.target)))
      // ELK has nothing to route for a self-loop and its own handling of one
      // is a large detour; those are drawn separately, below.
      .filter((e) => e.source !== e.target)
      .map((e) => ({ id: `${e.source}>${e.target}`, sources: [idOf(e.source)], targets: [idOf(e.target)] }));

    if (!children.length) { setElk({ children: [], edges: [] }); return; }

    layout({ id: 'root', layoutOptions: fuzzyLayoutOptions, children, edges })
      .then((r) => { if (!cancelled) setElk(r); })
      .catch((err) => {
        if (cancelled) return;
        // elkjs can still throw below this size on a pathological shape;
        // without this the rejection is swallowed and the panel sits empty.
        console.error('[fuzzy-miner] layout failed', err);
        setIssue({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeKey]);

  const nodeIx = useMemo(() => new Map(graph.nodes.map((n) => [`a${n.index}`, n])), [graph]);
  const clusterIx = useMemo(() => new Map(graph.clusters.map((c) => [`c${c.index}`, c])), [graph]);

  const highlighted = useMemo(() => {
    if (!selected.size) return null;
    return new Set(graph.nodes.filter((n) => selected.has(n.label)).map((n) => `a${n.index}`));
  }, [graph, selected]);

  const flowNodes: Node[] = useMemo(() => {
    if (!elk?.children) return [];
    // The layout is asynchronous, so between a slider move and the layout that
    // answers it there is a render where `graph` is already the new one and
    // `elk` is still the old. Its children can name an activity that has since
    // been clustered away — skip those rather than indexing past them; the
    // next layout replaces the whole set a frame later.
    return elk.children.flatMap((c): Node[] => {
      const activity = nodeIx.get(c.id);
      if (activity) {
        const data: ActivityNodeData = {
          label: activity.label,
          significance: activity.significance,
          count: activity.count,
          selected: selected.has(activity.label),
          faded: highlighted != null && !highlighted.has(c.id),
        };
        return [{
          id: c.id, type: 'activity', position: { x: c.x, y: c.y }, data,
          width: ACTIVITY_W, height: ACTIVITY_H,
        } satisfies Node];
      }
      const cluster = clusterIx.get(c.id);
      if (!cluster) return [];
      const data: ClusterNodeData = {
        count: cluster.primitives.length,
        significance: cluster.significance,
        members: cluster.primitives.map((i) => model.activities[i] ?? `a${i}`),
        expanded: openCluster === cluster.index,
        faded: highlighted != null,
      };
      return [{
        id: c.id, type: 'cluster', position: { x: c.x, y: c.y }, data,
        width: CLUSTER_W, height: CLUSTER_H,
      } satisfies Node];
    });
  }, [elk, nodeIx, clusterIx, selected, highlighted, openCluster, model.activities]);

  const flowEdges: Edge[] = useMemo(() => {
    if (!elk?.edges) return [];
    const byKey = new Map(graph.edges.map((e) => [`${e.source}>${e.target}`, e]));
    const idOf = (index: number) => (index < model.n ? `a${index}` : `c${index}`);
    return elk.edges.flatMap((e) => {
      const rec = byKey.get(e.id);
      if (!rec || !e.sections?.length) return [];
      const color = edgeColor(theme, rec.significance);
      // The full route, exactly as ELK solved it against the nodes' real
      // boundaries — used for the midpoint below, so the label lands on the
      // relation's true geometry, not on the shorter line actually drawn.
      const fullPath = pathFromSections(e.sections);
      // What gets painted: the same route with room at each end for the
      // arrowhead, so it sits in front of the node rather than under it.
      const path = trimPath(fullPath, NODE_MARGIN);
      const outline = e.sections.flatMap((sec) => [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint]);
      const mid = midpointOf(fullPath, outline);
      const source = idOf(rec.source);
      const target = idOf(rec.target);
      const data: FuzzyEdgeData = {
        path,
        significance: rec.significance,
        correlation: rec.correlation,
        // A hop too short to hold a number legibly gets none: the label would
        // sit on one of the two nodes it runs between and read as belonging
        // to it.
        label: mid.length < MIN_LABELLED_EDGE
          ? null
          : edgeLabelText(params.edgeLabel, rec.significance, rec.correlation),
        labelX: mid.x,
        labelY: mid.y,
        color,
        labelBg: theme.bg ?? '#fff',
        labelColor: theme['text-dim'] ?? '#667',
        faded: highlighted != null && !highlighted.has(source) && !highlighted.has(target),
        highlighted: highlighted != null && (highlighted.has(source) || highlighted.has(target)),
      };
      return [{
        id: e.id, source, target, type: 'fuzzy', data,
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 13, height: 13 },
      } satisfies Edge];
    });
  }, [elk, graph, theme, params.edgeLabel, highlighted, model.n]);

  const { fitView } = useReactFlow();
  const firstFit = useRef(true);
  useEffect(() => {
    if (!flowNodes.length) return;
    // A turn for React Flow's own effect to sync the just-changed props into
    // its store; fitting in the same commit measures the previous graph.
    const raf = requestAnimationFrame(() => {
      // Capped: a heavily simplified graph is a handful of nodes, and fitting
      // those to the panel blows them up to poster size. Filling the panel is
      // not the goal — a node drawn at about its natural size is.
      fitView({ padding: 0.12, maxZoom: 1.15, duration: firstFit.current ? 0 : 220 });
      firstFit.current = false;
    });
    return () => cancelAnimationFrame(raf);
    // `railOpen` is in here because collapsing the rail hands the canvas ~180
    // more pixels; React Flow keeps the old transform unless something refits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowNodes, fitView, railOpen]);

  function onNodeClick(_: unknown, node: Node) {
    const activity = nodeIx.get(node.id);
    if (activity) {
      setOpenCluster(null);
      promenade.select([{ kind: 'activity', id: activity.label }]);
      return;
    }
    const cluster = clusterIx.get(node.id);
    if (cluster) setOpenCluster((current) => (current === cluster.index ? null : cluster.index));
  }

  const rail = (
    <SliderRail
      theme={theme}
      params={params}
      onChange={change}
      open={railOpen}
      onToggle={() => setRailOpen((v) => !v)}
      summary={{
        activities: graph.nodes.length,
        clusters: graph.clusters.length,
        relations: graph.edges.length,
        removed: graph.removed,
      }}
      stats={payload.stats ?? { hasResources: true, hasTimestamps: true, truncated: false }}
    />
  );

  if (issue) {
    return (
      <div style={{ display: 'flex', width: '100%', height: '100%', background: theme.bg }}>
        <div style={{
          flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', padding: 32,
        }}>
          <div style={{ maxWidth: 420, textAlign: 'center', color: theme.text, fontSize: 13 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>
              {issue.kind === 'too-large' ? 'Too many relations to lay out' : 'Layout failed'}
            </div>
            <div style={{ color: theme['text-dim'], lineHeight: 1.5 }}>
              {issue.kind === 'too-large'
                ? `${issue.edges.toLocaleString()} relations survived the filters — past the ${LAYOUT_EDGE_LIMIT.toLocaleString()} this frame's single-threaded layout stays responsive at. Lower the edge cutoff, or raise the node cutoff, to simplify further.`
                : issue.message}
            </div>
          </div>
        </div>
        {rail}
      </div>
    );
  }

  const cluster = openCluster == null ? null : graph.clusters.find((c) => c.index === openCluster);

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', background: theme.bg }}>
      {/* `minWidth: 0` so the canvas yields to the rail instead of overflowing
          the frame — a flex item's default `min-width: auto` would not. */}
      <div style={{ flex: '1 1 auto', minWidth: 0, height: '100%', position: 'relative' }}>
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          onPaneClick={() => setOpenCluster(null)}
          // ELK decided every coordinate; React Flow is the interaction host
          // here, not a second layout engine. `[0, 0]` must match ELK's own
          // top-left convention for `position` to mean the same on both sides.
          nodeOrigin={[0, 0]}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          elementsSelectable
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          zoomOnDoubleClick={false}
          minZoom={0.03}
          maxZoom={4}
          onlyRenderVisibleElements
          proOptions={{ hideAttribution: true }}
        >
          <Background color={theme.border} gap={20} />
          <Controls showInteractive={false}>
            <ControlButton
              onClick={() => setShowMiniMap((v) => !v)}
              title={showMiniMap ? 'Hide overview map' : 'Show overview map'}
            >
              {showMiniMap ? '▣' : '□'}
            </ControlButton>
            <ExportMenu filename="fuzzy-model" />
          </Controls>
          {showMiniMap && (
            <MiniMap
              pannable zoomable
              nodeColor={(n) => (n.type === 'cluster' ? '#4bedb7' : '#6bd9ec')}
              style={{ background: theme['bg-soft'] }}
            />
          )}
          {/* Top-left, not top-right: the rail now owns the right edge, and a
              popover butting up against it reads as part of it. */}
          {cluster && (
            <Panel position="top-left">
              <div style={{
                background: theme['bg-soft'], border: `1px solid ${theme.border}`, borderRadius: 8,
                padding: 10, fontSize: 11, color: theme.text, maxWidth: 260, maxHeight: '70%',
                overflowY: 'auto', boxShadow: '0 2px 8px rgba(0,0,0,.08)',
              }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>
                  Cluster of {cluster.primitives.length}
                </div>
                <div style={{ color: theme['text-dim'], marginBottom: 8 }}>
                  mean significance {format3(cluster.significance)}
                </div>
                {cluster.primitives
                  .map((i) => ({ label: model.activities[i] ?? `a${i}`, sig: model.nodeSignificance[i] ?? 0 }))
                  .sort((a, b) => b.sig - a.sig)
                  .map((m) => (
                    <div key={m.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 2 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
                      <span style={{ color: theme['text-dim'], fontVariantNumeric: 'tabular-nums' }}>{format3(m.sig)}</span>
                    </div>
                  ))}
              </div>
            </Panel>
          )}
        </ReactFlow>
      </div>
      {rail}
    </div>
  );
}

bootView((payload) => <ReactFlowProvider><App payload={payload} /></ReactFlowProvider>);
