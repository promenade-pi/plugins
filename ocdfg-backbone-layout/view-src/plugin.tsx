import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Background, ControlButton, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider,
  useReactFlow, type Edge, type Node,
} from '@xyflow/react';
// @ts-ignore -- esbuild inlines this stylesheet as text; the frame CSP allows
// no external stylesheet, so it is injected as a <style> tag at runtime.
import reactFlowCss from '@xyflow/react/dist/style.css';
import { BackboneEdge, type BackboneEdgeData } from './BackboneEdge.tsx';
import { pathLength, strokeWidth, trimToNodes, type EdgeStyle, type Point, type Rect } from './geometry.ts';
import {
  ActivityNode, BoundaryNode, VirtualNode,
  type ActivityNodeData, type BoundaryNodeData, type VirtualNodeData,
} from './nodes.tsx';
import type { BackboneLayoutPayload, LayoutNode } from './types.ts';

const styleTag = document.createElement('style');
styleTag.textContent = reactFlowCss;
document.head.appendChild(styleTag);

const nodeTypes = { activity: ActivityNode, boundary: BoundaryNode, virtual: VirtualNode };
const edgeTypes = { backbone: BackboneEdge };

interface ViewParams {
  edgeStyle: EdgeStyle;
  showRoutingNodes: boolean;
  edgeLabels: 'none' | 'frequency' | 'duration';
  highlight: 'backbone' | 'backEdges' | 'none';
}

const DEFAULT_PARAMS: ViewParams = {
  edgeStyle: 'polyline',
  showRoutingNodes: false,
  edgeLabels: 'none',
  highlight: 'backbone',
};

function durationLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const units: Array<[number, string]> = [
    [86400, 'd'], [3600, 'h'], [60, 'm'], [1, 's'],
  ];
  for (const [size, suffix] of units) {
    if (seconds >= size) {
      const value = seconds / size;
      return `${value >= 10 ? Math.round(value) : value.toFixed(1)}${suffix}`;
    }
  }
  return `${seconds.toFixed(1)}s`;
}

/**
 * Waits until the container actually has a box before React Flow is mounted.
 *
 * React Flow renders nodes without measuring them, but an edge is only drawn
 * once its endpoints have been measured — so a graph initialised into a
 * zero-size container comes out as nodes with no edges at all, and stays that
 * way, because the measurement that would fix it never happens. React Flow
 * says so itself (error 004, "The parent container needs a width and a height
 * to render the graph"); it is its documented behaviour, not a bug in it, and
 * nothing to do with the layout, whose arcs are all present in the store.
 *
 * A panel frame is exactly the thing that gets mounted without a box: hidden
 * behind another tab, in a collapsed dock, or reparented while off-screen.
 * Gating the mount is what makes it not matter. The poll is there because a
 * hidden frame delivers no ResizeObserver callback either, so there would
 * otherwise be nothing to wake us up.
 */
function useBoxReady(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const check = () => {
      const ok = element.clientWidth > 0 && element.clientHeight > 0;
      if (ok) setReady(true);
      return ok;
    };
    if (check()) return;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    const timer = setInterval(() => { if (check()) clearInterval(timer); }, 200);
    return () => { observer.disconnect(); clearInterval(timer); };
  }, []);
  return [ref, ready];
}

/** Reports each distinct React Flow error once, rather than on every frame. */
function useErrorReporter() {
  const seen = useRef(new Set<string>());
  return (code: string, message: string) => {
    if (seen.current.has(code)) return;
    seen.current.add(code);
    console.error(`[ocdfg-backbone-layout] react-flow ${code}: ${message}`);
  };
}

function App({ layout }: { layout: BackboneLayoutPayload }) {
  const [theme, setTheme] = useState<Record<string, string>>(promenade.theme());
  const [params, setParams] = useState<ViewParams>(DEFAULT_PARAMS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [legendOpen, setLegendOpen] = useState(true);
  const [metricsOpen, setMetricsOpen] = useState(true);
  const [showMiniMap, setShowMiniMap] = useState(true);
  const [boxRef, boxReady] = useBoxReady();
  const reportError = useErrorReporter();

  useEffect(() => {
    promenade.on('theme', (payload) => setTheme(payload.theme));
    promenade.on('params', (next) => setParams((current) => ({ ...current, ...next })));
    promenade.on('selection', (selection) => {
      setSelected(new Set(
        selection.items.filter((item) => item.kind === 'activity').map((item) => item.id),
      ));
    });
    promenade.ready();
  }, []);

  const colorOf = useMemo(() => {
    const cache = new Map<string, string>();
    return (objectType: string) => {
      let value = cache.get(objectType);
      if (!value) {
        value = promenade.color('objectType', objectType);
        cache.set(objectType, value);
      }
      return value;
    };
  }, []);

  const visible = useMemo(
    () => new Set(layout.objectTypes.filter((type) => !hiddenTypes.has(type))),
    [layout.objectTypes, hiddenTypes],
  );

  const byId = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node])),
    [layout.nodes],
  );

  /**
   * A node is dimmed rather than removed when its object types are hidden.
   * The layout is fixed — recomputing it for a subset is a different run, and
   * one of the paper's selling points is precisely that positions do not move
   * when the view is filtered ([2] Sect. 1, Fig. 3). Removing nodes would
   * leave holes that read as movement; dimming shows the same drawing with
   * one type brought forward.
   */
  const nodeVisible = (node: LayoutNode) => {
    if (node.kind === 'activity') {
      return node.objectTypes.length === 0
        || node.objectTypes.some((type) => visible.has(type));
    }
    return node.objectType == null || visible.has(node.objectType);
  };

  const maxFreq = useMemo(
    () => layout.edges.reduce((peak, edge) => Math.max(peak, edge.freq), 0),
    [layout.edges],
  );

  const nodes: Node[] = useMemo(() => layout.nodes.flatMap<Node>((node) => {
    if (node.kind === 'virtual' && !params.showRoutingNodes) return [];
    const dimmed = !nodeVisible(node);
    const position = { x: node.x - node.width / 2, y: node.y - node.height / 2 };
    if (node.kind === 'activity') {
      const data: ActivityNodeData = {
        node, dimmed, theme, selected: selected.has(node.label ?? node.id),
        trunkColor: node.backboneOf ? colorOf(node.backboneOf) : null,
        types: node.objectTypes.map((name) => ({ name, color: colorOf(name) })),
      };
      return [{
        id: node.id, type: 'activity', position, data,
        width: node.width, height: node.height, selectable: false,
      } satisfies Node];
    }
    if (node.kind === 'virtual') {
      const data: VirtualNodeData = {
        node, dimmed, color: colorOf(node.objectType ?? ''),
      };
      return [{
        id: node.id, type: 'virtual',
        position: { x: node.x - node.width / 2, y: node.y - node.width / 2 },
        data, width: node.width, height: node.width, selectable: false,
      } satisfies Node];
    }
    const data: BoundaryNodeData = {
      node, dimmed, theme, color: colorOf(node.objectType ?? ''),
    };
    return [{
      id: node.id, type: 'boundary', position, data,
      width: node.width, height: node.height, selectable: false,
    } satisfies Node];
  }), [layout.nodes, params.showRoutingNodes, theme, selected, visible, colorOf]);

  const edges: Edge[] = useMemo(() => layout.edges.flatMap<Edge>((edge) => {
    const source = byId.get(edge.src);
    const target = byId.get(edge.dst);
    if (!source || !target || edge.waypoints.length < 2) return [];
    const sourceBox: Rect = { x: source.x, y: source.y, width: source.width, height: source.height };
    const targetBox: Rect = { x: target.x, y: target.y, width: target.width, height: target.height };
    const points: Point[] = trimToNodes(edge.waypoints, sourceBox, targetBox);
    const dimmed = !visible.has(edge.objectType);
    const highlighted = params.highlight === 'backbone'
      ? edge.backbone
      : params.highlight === 'backEdges' ? edge.back : false;
    const label = params.edgeLabels === 'frequency'
      ? edge.freq.toLocaleString()
      : params.edgeLabels === 'duration' && edge.avgSecs != null
        ? durationLabel(edge.avgSecs)
        : null;
    const middle = points[Math.floor(points.length / 2)];
    const data: BackboneEdgeData = {
      points, color: colorOf(edge.objectType), style: params.edgeStyle,
      width: strokeWidth(edge.freq, maxFreq, edge.backbone),
      backbone: edge.backbone, back: edge.back, horizontal: edge.horizontal,
      dimmed, highlighted, label, labelAt: middle ?? null, theme,
    };
    return [{
      id: edge.id, source: edge.src, target: edge.dst, type: 'backbone', data,
      markerEnd: dimmed ? undefined : arrowFor(edge.back ? (theme.warn ?? '#d2544b') : colorOf(edge.objectType)),
      selectable: false, zIndex: edge.backbone ? 2 : 1,
    } satisfies Edge];
  }), [layout.edges, byId, visible, params, theme, maxFreq, colorOf]);

  const markers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const objectType of layout.objectTypes) seen.set(markerId(colorOf(objectType)), colorOf(objectType));
    seen.set(markerId(theme.warn ?? '#d2544b'), theme.warn ?? '#d2544b');
    return [...seen.entries()];
  }, [layout.objectTypes, theme, colorOf]);

  const shown = useMemo(() => {
    const drawn = layout.edges.filter((edge) => visible.has(edge.objectType));
    return {
      edges: drawn.length,
      backEdges: drawn.filter((edge) => edge.back).length,
      horizontal: drawn.filter((edge) => edge.horizontal).length,
      length: Math.round(drawn.reduce((total, edge) => total + pathLength(edge.waypoints), 0)),
    };
  }, [layout.edges, visible]);

  const { fitView } = useReactFlow();
  const first = useRef(true);
  useEffect(() => {
    if (!nodes.length) return;
    const frame = requestAnimationFrame(() => {
      fitView({ padding: 0.1, duration: first.current ? 0 : 220 });
      first.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [layout, fitView]);

  if (!layout.nodes.length) {
    return (
      <div style={{
        width: '100%', height: '100%', background: theme.bg, color: theme['text-dim'],
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13, textAlign: 'center', padding: 24,
      }}>
        {layout.diagnostics.reason ?? 'This layout is empty.'}
      </div>
    );
  }

  return (
    <div ref={boxRef} style={{ width: '100%', height: '100%', background: theme.bg }}>
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
        <defs>
          {markers.map(([id, color]) => (
            <marker
              key={id} id={id} viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse"
            >
              <path d="M 0 0.6 L 10 5 L 0 9.4 z" fill={color} />
            </marker>
          ))}
        </defs>
      </svg>
      {!boxReady ? null : (
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodeClick={(_, node) => {
          const model = byId.get(node.id);
          if (model?.kind === 'activity' && model.label) {
            promenade.select([{ kind: 'activity', id: model.label }]);
          }
        }}
        nodeOrigin={[0, 0]} nodesDraggable={false} nodesConnectable={false}
        edgesReconnectable={false} panOnDrag panOnScroll={false}
        zoomOnScroll zoomOnPinch zoomOnDoubleClick={false}
        minZoom={0.02} maxZoom={4} onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
        onError={reportError}
      >
        <Background color={theme.border} gap={22} />
        <Controls showInteractive={false}>
          <ControlButton
            onClick={() => setShowMiniMap((value) => !value)}
            title={showMiniMap ? 'Hide overview map' : 'Show overview map'}
          >
            {showMiniMap ? '▣' : '□'}
          </ControlButton>
        </Controls>
        {showMiniMap && (
          <MiniMap
            pannable zoomable style={{ background: theme['bg-sunken'] }}
            nodeColor={(node) => {
              const model = byId.get(node.id);
              if (model?.backboneOf) return colorOf(model.backboneOf);
              return theme['text-dim'];
            }}
          />
        )}
        <Panel position="top-left">
          <Legend
            layout={layout} hidden={hiddenTypes} setHidden={setHiddenTypes}
            open={legendOpen} setOpen={setLegendOpen} theme={theme} colorOf={colorOf}
          />
        </Panel>
        <Panel position="top-right">
          <Metrics
            layout={layout} shown={shown} open={metricsOpen} setOpen={setMetricsOpen}
            theme={theme}
          />
        </Panel>
      </ReactFlow>
      )}
    </div>
  );
}

function markerId(color: string): string {
  return `arrow-${color.replace(/[^a-zA-Z0-9]/g, '')}`;
}

function arrowFor(color: string): string {
  return `url(#${markerId(color)})`;
}

const panelStyle = (theme: Record<string, string>) => ({
  background: theme['bg-soft'], border: `1px solid ${theme.border}`, borderRadius: 8,
  padding: 10, fontSize: 11, color: theme.text, boxShadow: '0 2px 8px rgba(0,0,0,.08)',
  maxWidth: 260,
});

const headerStyle = (theme: Record<string, string>, open: boolean) => ({
  display: 'flex', justifyContent: 'space-between', gap: 10, cursor: 'pointer',
  fontWeight: 600, marginBottom: open ? 8 : 0, color: theme.text,
});

function Legend({ layout, hidden, setHidden, open, setOpen, theme, colorOf }: {
  layout: BackboneLayoutPayload;
  hidden: Set<string>;
  setHidden: (update: (current: Set<string>) => Set<string>) => void;
  open: boolean;
  setOpen: (value: boolean) => void;
  theme: Record<string, string>;
  colorOf: (objectType: string) => string;
}) {
  const toggle = (objectType: string) => setHidden((current) => {
    const next = new Set(current);
    if (next.has(objectType)) next.delete(objectType);
    else next.add(objectType);
    return next;
  });
  const axes = layout.axes;
  return (
    <div style={panelStyle(theme)}>
      <div onClick={() => setOpen(!open)} style={headerStyle(theme, open)}>
        <span>Object type axes</span>
        <span style={{ color: theme['text-dim'] }}>{open ? '−' : '+'}</span>
      </div>
      {open && (
        <>
          {axes.map((axis) => (
            <label
              key={axis.objectType}
              title={`axis ${axis.axis} · ${axis.activities} activities · `
                + `${axis.components} components (${axis.componentsLeft} left of the trunk)`}
              style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, cursor: 'pointer' }}
            >
              <input
                type="checkbox" checked={!hidden.has(axis.objectType)}
                onChange={() => toggle(axis.objectType)} style={{ margin: 0 }}
              />
              <span style={{
                width: 3, height: 11, borderRadius: 1, background: colorOf(axis.objectType),
              }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {axis.objectType}
              </span>
              {layout.mainObjectType === axis.objectType && (
                <span title="the main object type: it initialises the layout" style={{ color: theme['text-dim'] }}>
                  main
                </span>
              )}
            </label>
          ))}
          <div style={{
            marginTop: 8, paddingTop: 6, borderTop: `1px solid ${theme.border}`,
            color: theme['text-dim'], lineHeight: 1.5,
          }}>
            Each type occupies its own vertical axis, with its backbone drawn as a
            straight trunk in the type's colour. Dashed red arrows run upwards
            against the flow. Hiding a type dims it — positions never move.
          </div>
        </>
      )}
    </div>
  );
}

function Metrics({ layout, shown, open, setOpen, theme }: {
  layout: BackboneLayoutPayload;
  shown: { edges: number; backEdges: number; horizontal: number; length: number };
  open: boolean;
  setOpen: (value: boolean) => void;
  theme: Record<string, string>;
}) {
  const metrics = layout.metrics;
  const rank = layout.diagnostics.rank ?? {};
  const filtered = shown.edges !== layout.edges.length;
  const rows: Array<[string, string, string]> = [
    ['Back edges', String(metrics.backEdges), 'Arcs running against the top-down flow. The rank IP minimises these.'],
    ['Horizontal edges', String(metrics.horizontalEdges), 'Mutually dependent activity pairs sharing a rank.'],
    ['Crossings', String(metrics.crossings), 'Edge crossings over the rank/order assignment.'],
    ['Edge length', metrics.edgeLength.toLocaleString(), 'Summed drawn length of every routed segment.'],
    ['Edge orthogonality', metrics.edgeOrthogonality.toFixed(3), '1 = every segment is axis-aligned.'],
    ['Node orthogonality', metrics.nodeOrthogonality.toFixed(3), 'Share of the rank/order grid that nodes occupy.'],
    ['Balance', metrics.balance.toFixed(3), `1 = the main trunk splits the layout evenly (${metrics.leftNodes} left / ${metrics.rightNodes} right).`],
  ];
  if (metrics.objectTypeCompactness != null) {
    rows.push(['Type compactness', metrics.objectTypeCompactness.toFixed(3),
      "Silhouette score of each type's activities in x: higher means tighter, better-separated bands."]);
  }
  if (metrics.objectTypeInteractionPreservation != null) {
    rows.push(['Interaction preservation', metrics.objectTypeInteractionPreservation.toFixed(3),
      'How well the axis order reproduces which object types share activities.']);
  }

  return (
    <div style={panelStyle(theme)}>
      <div onClick={() => setOpen(!open)} style={headerStyle(theme, open)}>
        <span>Layout quality</span>
        <span style={{ color: theme['text-dim'] }}>{open ? '−' : '+'}</span>
      </div>
      {open && (
        <>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <tbody>
              {rows.map(([label, value, hint]) => (
                <tr key={label} title={hint}>
                  <td style={{ color: theme['text-dim'], padding: '1px 6px 1px 0' }}>{label}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered && (
            <div style={{ marginTop: 6, color: theme['text-dim'] }}>
              Showing {shown.edges.toLocaleString()} of {layout.edges.length.toLocaleString()} arcs
              ({shown.backEdges} back, {shown.horizontal} horizontal, length {shown.length.toLocaleString()}).
              The figures above are for the whole layout.
            </div>
          )}
          <div style={{
            marginTop: 8, paddingTop: 6, borderTop: `1px solid ${theme.border}`,
            color: theme['text-dim'], lineHeight: 1.5,
          }}>
            {rank.solver ?? 'unknown solver'}
            {rank.optimal === true && ' · proven optimal'}
            {rank.optimal === false && rank.solver?.startsWith('HiGHS') && ' · best found within the time limit'}
            {rank.objectiveValue != null && rank.heuristicObjective != null && (
              <> · objective {rank.objectiveValue.toLocaleString()} vs {rank.heuristicObjective.toLocaleString()} for the heuristic layering</>
            )}
            {rank.fallback && <div style={{ color: theme.warn, marginTop: 4 }}>{rank.fallback}</div>}
            {!!rank.droppedChainConstraints?.length && (
              <div style={{ marginTop: 4 }}>
                {rank.droppedChainConstraints.length} backbone constraint
                {rank.droppedChainConstraints.length === 1 ? '' : 's'} dropped: two object
                types traverse shared activities in opposite orders.
              </div>
            )}
            {layout.diagnostics.positioning
              && layout.diagnostics.positioning.straightTrunks < layout.diagnostics.positioning.trunks && (
              <div style={{ marginTop: 4 }}>
                {layout.diagnostics.positioning.straightTrunks} of{' '}
                {layout.diagnostics.positioning.trunks} trunks are straight.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const layout = promenade.artifact().value as BackboneLayoutPayload;
createRoot(document.getElementById('root')!).render(
  <ReactFlowProvider><App layout={layout} /></ReactFlowProvider>,
);
