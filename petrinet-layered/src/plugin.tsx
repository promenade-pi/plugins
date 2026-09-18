import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Background, ControlButton, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider,
  useReactFlow, type Edge, type Node,
} from '@xyflow/react';
// @ts-ignore esbuild injects the package stylesheet as text for the sandbox.
import reactFlowCss from '@xyflow/react/dist/style.css';
import type { AcceptingPetriNetPayload } from './types';
import { labelOf, buildElkGraph, layoutPetriNet, pathFromSections, silentSize, TRANS_H, TRANS_W, type FlowDirection } from './layout';
import { PlaceNode, type PlaceNodeData } from './PlaceNode';
import { TransitionNode, type TransitionNodeData } from './TransitionNode';
import { PetriNetEdge, type PetriNetEdgeData } from './PetriNetEdge';
import { ExportMenu } from './lib/ExportMenu';

const style = document.createElement('style');
style.textContent = reactFlowCss;
document.head.appendChild(style);

const nodeTypes = { place: PlaceNode, transition: TransitionNode };
const edgeTypes = { petri: PetriNetEdge };

interface ViewParams {
  direction: FlowDirection;
}

const defaultParams: ViewParams = { direction: 'RIGHT' };

function normaliseNet(value: unknown): AcceptingPetriNetPayload {
  let net: any = value;
  // `result` is the host's inline-action envelope. Older persisted sessions
  // can have more than one, while a renderer always needs the inner net.
  for (let depth = 0; depth < 4 && net && typeof net === 'object' && 'result' in net; depth++) net = net.result;
  return {
    ...(net ?? {}),
    places: Array.isArray(net?.places) ? net.places : [],
    activities: Array.isArray(net?.activities) ? net.activities : [],
  };
}

function App({ net }: { net: AcceptingPetriNetPayload }) {
  const [theme, setTheme] = useState<Record<string, string>>(promenade.theme());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [elk, setElk] = useState<Awaited<ReturnType<typeof layoutPetriNet>> | null>(null);
  const [showMiniMap, setShowMiniMap] = useState(true);
  const [params, setParams] = useState<ViewParams>(defaultParams);
  const { graph, arcs } = useMemo(() => buildElkGraph(net, params.direction), [net, params.direction]);

  useEffect(() => {
    promenade.on('theme', (event) => setTheme(event.theme));
    promenade.on('selection', (selection) => setSelected(new Set(
      selection.items.filter((item) => item.kind === 'place' || item.kind === 'transition' || item.kind === 'activity').map((item) => item.id)
    )));
    promenade.on('params', (next) => setParams((current) => ({ ...current, ...next })));
    promenade.ready();
  }, []);

  useEffect(() => {
    let cancelled = false;
    layoutPetriNet(graph).then((result) => { if (!cancelled) setElk(result); });
    return () => { cancelled = true; };
  }, [graph]);

  const initial = useMemo(() => new Set(net.initial_marking ?? []), [net.initial_marking]);
  const final = useMemo(() => new Set(net.final_marking ?? []), [net.final_marking]);
  const nodes = useMemo<Node[]>(() => {
    if (!elk?.children) return [];
    return elk.children.map((child) => {
      if (child.id.startsWith('p')) {
        const index = Number(child.id.slice(1));
        const data: PlaceNodeData = {
          initial: initial.has(index), final: final.has(index),
          selected: selected.has(child.id), direction: params.direction, theme,
        };
        return { id: child.id, type: 'place', position: { x: child.x, y: child.y }, data, width: child.width, height: child.height };
      }
      const id = Number(child.id.slice(1));
      const activity = labelOf(net, id);
      const data: TransitionNodeData = {
        activity, selected: selected.has(child.id) || (activity != null && selected.has(activity)),
        direction: params.direction,
        color: activity == null ? theme['text-dim'] : promenade.color('activity', activity), theme,
      };
      const size = activity == null ? silentSize(params.direction) : { width: TRANS_W, height: TRANS_H };
      return { id: child.id, type: 'transition', position: { x: child.x, y: child.y }, data, ...size };
    });
  }, [elk, final, initial, net, selected, theme, params.direction]);

  const edges = useMemo<Edge[]>(() => {
    if (!elk?.edges) return [];
    const arcById = new Map(arcs.map((arc) => [arc.id, arc]));
    return elk.edges.flatMap((edge) => {
      const arc = arcById.get(edge.id);
      if (!arc || !edge.sections?.length) return [];
      const data: PetriNetEdgeData = { path: pathFromSections(edge.sections), color: theme['text-dim'] ?? '#6b7280' };
      return [{ id: edge.id, source: arc.source, target: arc.target, type: 'petri', data,
        markerEnd: { type: MarkerType.ArrowClosed, color: data.color, width: 14, height: 14 } }];
    });
  }, [arcs, elk, theme]);

  const { fitView } = useReactFlow();
  const firstFit = useRef(true);
  useEffect(() => {
    if (!nodes.length) return;
    const raf = requestAnimationFrame(() => {
      fitView({ padding: 0.12, duration: firstFit.current ? 0 : 250 });
      firstFit.current = false;
    });
    return () => cancelAnimationFrame(raf);
  }, [fitView, nodes]);

  function onNodeClick(_: unknown, node: Node) {
    if (node.type === 'place') {
      promenade.select([{ kind: 'place', id: node.id }]);
      return;
    }
    const activity = (node.data as TransitionNodeData).activity;
    promenade.select(activity == null ? [{ kind: 'transition', id: node.id }] : [{ kind: 'activity', id: activity }]);
  }

  return <div style={{ width: '100%', height: '100%', background: theme.bg }}>
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodeClick={onNodeClick}
      nodeOrigin={[0, 0]} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false}
      elementsSelectable panOnDrag panOnScroll={false} zoomOnScroll zoomOnPinch zoomOnDoubleClick={false}
      minZoom={0.02} maxZoom={4} onlyRenderVisibleElements proOptions={{ hideAttribution: true }}
    >
      <Background color={theme.border} gap={20} />
      <Controls showInteractive={false}>
        <ControlButton onClick={() => setShowMiniMap((visible) => !visible)} title={showMiniMap ? 'Hide overview map' : 'Show overview map'}>
          {showMiniMap ? '▣' : '□'}
        </ControlButton>
        <ExportMenu filename="petri-net" />
      </Controls>
      {showMiniMap && (
        <MiniMap
          pannable zoomable
          nodeColor={(node) => node.type === 'transition'
            ? ((node.data as TransitionNodeData).activity == null ? theme['text-dim'] : (node.data as TransitionNodeData).color)
            : theme['bg-soft']}
          nodeStrokeColor={(node) => node.type === 'place' ? (theme['text-dim'] ?? '#6b7280') : 'transparent'}
          style={{ background: theme['bg-soft'] }}
        />
      )}
    </ReactFlow>
  </div>;
}

const net = normaliseNet(promenade.artifact().value);
createRoot(document.getElementById('root')!).render(<ReactFlowProvider><App net={net} /></ReactFlowProvider>);
