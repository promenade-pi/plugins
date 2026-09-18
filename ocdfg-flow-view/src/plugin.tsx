import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Background, ControlButton, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider,
  useReactFlow, type Edge, type Node,
} from '@xyflow/react';
// @ts-ignore -- esbuild inlines this stylesheet as text for the sandboxed frame.
import reactFlowCss from '@xyflow/react/dist/style.css';
import { ActivityNode, type ActivityNodeData } from './ActivityNode';
import { BoundaryNode, type BoundaryNodeData } from './BoundaryNode';
import { OcdfgEdge, type OcdfgEdgeData } from './OcdfgEdge';
import { buildElkGraph, buildFlowGraph, layoutOcdfg, type ElkResult, type FlowDirection } from './layout';
import { ExportMenu } from './lib/ExportMenu';
import type { OcdfgPayload } from './types';

const styleTag = document.createElement('style');
styleTag.textContent = reactFlowCss;
document.head.appendChild(styleTag);

const nodeTypes = { activity: ActivityNode, boundary: BoundaryNode };
const edgeTypes = { ocdfg: OcdfgEdge };

interface ViewParams {
  combineParallelArcs: boolean;
  direction: FlowDirection;
}

const defaultParams: ViewParams = { combineParallelArcs: false, direction: 'RIGHT' };

/**
 * ELK's layered node placement recurses per constraint-graph edge in this
 * build, with no iteration fallback — past a few thousand edges that either
 * overflows the stack outright or, once routed around (see layout.ts), just
 * takes tens of seconds on the single thread this sandboxed plugin has
 * (elkjs needs a real Worker to run off-thread, which the sandbox's CSP
 * doesn't allow — see layout.ts's `ensureElk`). Measured on this preset:
 * ~700 edges lays out in ~2s, ~1300 in ~4s, ~2500 in ~15-26s. 1500 keeps the
 * worst case under about 5s instead of freezing the tab.
 */
const LAYOUT_EDGE_LIMIT = 1500;

type LayoutIssue = { kind: 'too-large'; nodes: number; edges: number } | { kind: 'failed'; message: string };

function App({ graph }: { graph: OcdfgPayload }) {
  const [theme, setTheme] = useState<Record<string, string>>(promenade.theme());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [legendOpen, setLegendOpen] = useState(true);
  const [elk, setElk] = useState<ElkResult | null>(null);
  const [params, setParams] = useState<ViewParams>(defaultParams);
  const [layoutIssue, setLayoutIssue] = useState<LayoutIssue | null>(null);
  const [showMiniMap, setShowMiniMap] = useState(true);

  useEffect(() => {
    promenade.on('theme', (payload) => setTheme(payload.theme));
    promenade.on('selection', (selection) => {
      setSelected(new Set(selection.items.filter((item) => item.kind === 'activity').map((item) => item.id)));
    });
    promenade.on('params', (next) => setParams((current) => ({ ...current, ...next })));
    promenade.ready();
  }, []);

  const visibleTypes = useMemo(() => new Set(graph.objectTypes.filter((type) => !hiddenTypes.has(type))), [graph, hiddenTypes]);
  const filtered = useMemo(() => ({
    nodes: graph.nodes.filter((node) => visibleTypes.has(node.objectType)),
    edges: graph.edges.filter((edge) => visibleTypes.has(edge.objectType)),
  }), [graph, visibleTypes]);
  const visibilityKey = [...visibleTypes].sort().join('\u001f');
  const flowGraph = useMemo(
    () => buildFlowGraph(filtered.nodes, filtered.edges, params.combineParallelArcs),
    [filtered, params.combineParallelArcs],
  );
  const flowNodes = useMemo(() => new Map(flowGraph.nodes.map((node) => [node.id, node])), [flowGraph]);

  useEffect(() => {
    let cancelled = false;
    const elkGraph = buildElkGraph(flowGraph, params.direction);
    if (elkGraph.edges.length > LAYOUT_EDGE_LIMIT) {
      setLayoutIssue({ kind: 'too-large', nodes: elkGraph.children.length, edges: elkGraph.edges.length });
      setElk(null);
      return;
    }
    setLayoutIssue(null);
    layoutOcdfg(elkGraph)
      .then((result) => { if (!cancelled) setElk(result); })
      .catch((err) => {
        if (cancelled) return;
        // elkjs can still throw below this size on a pathological graph
        // shape; without this the promise rejection is silently swallowed
        // and the panel just sits empty forever with no visible cause.
        console.error('[ocdfg-flow-view] layout failed', err);
        setLayoutIssue({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, [flowGraph, visibilityKey, params.direction]);

  const nodes: Node[] = useMemo(() => {
    if (!elk?.children) return [];
    const aggregate = new Map<string, { count: number; types: Set<string> }>();
    for (const item of filtered.nodes) {
      const current = aggregate.get(item.activity) ?? { count: 0, types: new Set<string>() };
      current.count += item.count;
      current.types.add(item.objectType);
      aggregate.set(item.activity, current);
    }
    return elk.children.flatMap<Node>((item) => {
      const flowNode = flowNodes.get(item.id);
      if (flowNode?.kind === 'source' || flowNode?.kind === 'sink') {
        const data: BoundaryNodeData = {
          objectType: flowNode.objectType, kind: flowNode.kind,
          color: promenade.color('objectType', flowNode.objectType), selected: false,
          direction: params.direction, theme,
        };
        return [{ id: item.id, type: 'boundary', position: { x: item.x, y: item.y }, data, width: item.width, height: item.height } satisfies Node];
      }
      const aggregateNode = aggregate.get(item.id);
      if (!aggregateNode) return [];
      const data: ActivityNodeData = {
        activity: item.id, count: aggregateNode.count, selected: selected.has(item.id),
        direction: params.direction, theme,
        objectTypes: [...aggregateNode.types].sort().map((name) => ({ name, color: promenade.color('objectType', name) })),
      };
      return [{ id: item.id, type: 'activity', position: { x: item.x, y: item.y }, data, width: item.width, height: item.height } satisfies Node];
    });
  }, [elk, filtered.nodes, flowNodes, selected, theme, params.direction]);

  const edges = useMemo(() => {
    if (!elk?.edges) return [];
    const source = new Map(flowGraph.edges.map((edge) => [edge.id, edge]));
    return elk.edges.flatMap((item) => {
      const model = source.get(item.id);
      if (!model || !item.sections?.length) return [];
      const data: OcdfgEdgeData = {
        sections: item.sections,
        strokes: model.types.map((t) => ({ objectType: t.objectType, freq: t.freq, color: promenade.color('objectType', t.objectType) })),
        width: 1.8, opacity: 0.88,
      };
      return [{
        id: item.id, source: model.source, target: model.target, type: 'ocdfg', data,
      } satisfies Edge];
    });
  }, [elk, flowGraph.edges]);

  const { fitView } = useReactFlow();
  const firstFit = useRef(true);
  useEffect(() => {
    if (!nodes.length) return;
    const frame = requestAnimationFrame(() => {
      fitView({ padding: 0.12, duration: firstFit.current ? 0 : 250 });
      firstFit.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [nodes, fitView]);

  if (layoutIssue) {
    return (
      <div style={{ width: '100%', height: '100%', background: theme.bg, position: 'relative' }}>
        <LayoutIssueNotice issue={layoutIssue} combined={params.combineParallelArcs} theme={theme} />
        <div style={{ position: 'absolute', top: 10, left: 10 }}>
          <Legend graph={graph} hidden={hiddenTypes} setHidden={setHiddenTypes} open={legendOpen} setOpen={setLegendOpen} theme={theme} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', background: theme.bg }}>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodeClick={(_, node) => {
          if (node.type === 'activity') promenade.select([{ kind: 'activity', id: node.id }]);
        }}
        nodeOrigin={[0, 0]} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false}
        panOnDrag panOnScroll={false} zoomOnScroll zoomOnPinch zoomOnDoubleClick={false}
        minZoom={0.02} maxZoom={4} onlyRenderVisibleElements proOptions={{ hideAttribution: true }}
      >
        <Background color={theme.border} gap={20} />
        <Controls showInteractive={false}>
          <ControlButton onClick={() => setShowMiniMap((visible) => !visible)} title={showMiniMap ? 'Hide overview map' : 'Show overview map'}>
            {showMiniMap ? '▣' : '□'}
          </ControlButton>
          <ExportMenu filename="ocdfg" />
        </Controls>
        {showMiniMap && (
          <MiniMap
            pannable zoomable style={{ background: theme['bg-soft'] }}
            nodeColor={(node) => selected.has(node.id) ? theme.accent : theme['text-dim']}
          />
        )}
        <Panel position="top-left">
          <Legend graph={graph} hidden={hiddenTypes} setHidden={setHiddenTypes} open={legendOpen} setOpen={setLegendOpen} theme={theme} />
        </Panel>
      </ReactFlow>
    </div>
  );
}

function LayoutIssueNotice({ issue, combined, theme }: { issue: LayoutIssue; combined: boolean; theme: Record<string, string> }) {
  const suggestions = [
    'Hide some object types in the legend below.',
    !combined && 'Turn on "Combine parallel arcs" in the view parameters — it routes one arc per activity pair instead of one per object type, which cuts the arc count this limit is measuring.',
  ].filter(Boolean) as string[];
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32,
    }}>
      <div style={{ maxWidth: 440, textAlign: 'center', color: theme.text, fontSize: 13 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          {issue.kind === 'too-large' ? 'This graph is too large to lay out automatically' : 'Layout failed'}
        </div>
        <div style={{ color: theme['text-dim'], lineHeight: 1.5 }}>
          {issue.kind === 'too-large'
            ? `${issue.nodes.toLocaleString()} nodes and ${issue.edges.toLocaleString()} arcs would go into the layout engine — past the ${LAYOUT_EDGE_LIMIT.toLocaleString()}-arc point where it reliably stays responsive. Beyond that it can take tens of seconds or exhaust the browser's call stack outright.`
            : issue.message}
        </div>
        {suggestions.length > 0 && (
          <ul style={{ textAlign: 'left', color: theme['text-dim'], marginTop: 12, paddingLeft: 18, lineHeight: 1.6 }}>
            {suggestions.map((s) => <li key={s}>{s}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}

function Legend({ graph, hidden, setHidden, open, setOpen, theme }: {
  graph: OcdfgPayload; hidden: Set<string>; setHidden: (update: (current: Set<string>) => Set<string>) => void;
  open: boolean; setOpen: (value: boolean) => void; theme: Record<string, string>;
}) {
  const toggle = (objectType: string) => setHidden((current) => {
    const next = new Set(current);
    next.has(objectType) ? next.delete(objectType) : next.add(objectType);
    return next;
  });
  return (
    <div style={{ background: theme['bg-soft'], border: `1px solid ${theme.border}`, borderRadius: 8, padding: 10, minWidth: 182, fontSize: 11, color: theme.text, boxShadow: '0 2px 8px rgba(0,0,0,.08)' }}>
      <div onClick={() => setOpen(!open)} style={{ display: 'flex', justifyContent: 'space-between', cursor: 'pointer', fontWeight: 600, marginBottom: open ? 8 : 0 }}>
        <span>Object types</span><span style={{ color: theme['text-dim'] }}>{open ? '−' : '+'}</span>
      </div>
      {open && graph.objectTypes.map((objectType) => (
        <label key={objectType} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, cursor: 'pointer' }}>
          <input type="checkbox" checked={!hidden.has(objectType)} onChange={() => toggle(objectType)} style={{ margin: 0 }} />
          <span style={{ width: 10, height: 10, borderRadius: 2, background: promenade.color('objectType', objectType) }} />
          <span>{objectType}</span>
        </label>
      ))}
      {open && <div style={{ marginTop: 8, paddingTop: 6, borderTop: `1px solid ${theme.border}`, color: theme['text-dim'] }}>
        Arrow colour identifies the object type; markers show where each type starts and ends.
      </div>}
    </div>
  );
}

const graph = promenade.artifact().value as OcdfgPayload;
createRoot(document.getElementById('root')!).render(<ReactFlowProvider><App graph={graph} /></ReactFlowProvider>);
