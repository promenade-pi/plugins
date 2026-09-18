import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Background, ControlButton, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider,
  useReactFlow, type Edge, type Node,
} from '@xyflow/react';
// @ts-ignore esbuild injects the package stylesheet as text for the sandbox.
import reactFlowCss from '@xyflow/react/dist/style.css';
import type { SoundnessReport } from './types';
import { labelOf, buildElkGraph, layoutPetriNet, pathFromSections, SILENT_H, SILENT_W, TRANS_H, TRANS_W } from './layout';
import { PlaceNode, type PlaceNodeData } from './PlaceNode';
import { TransitionNode, type TransitionNodeData } from './TransitionNode';
import { PetriNetEdge, type PetriNetEdgeData } from './PetriNetEdge';
import { Findings } from './Findings';
import { ExportMenu } from './lib/ExportMenu';

const style = document.createElement('style');
style.textContent = reactFlowCss;
document.head.appendChild(style);

const nodeTypes = { place: PlaceNode, transition: TransitionNode };
const edgeTypes = { petri: PetriNetEdge };

/** `result` is the host's inline-action envelope; a reloaded session can carry
 *  more than one, while the view always needs the report itself. */
function normaliseReport(value: unknown): SoundnessReport | null {
  let payload: any = value;
  for (let depth = 0; depth < 4 && payload && typeof payload === 'object' && 'result' in payload; depth++) {
    payload = payload.result;
  }
  if (!payload || typeof payload !== 'object' || !payload.summary || !payload.net) return null;
  return payload as SoundnessReport;
}

function App({ report }: { report: SoundnessReport }) {
  const [theme, setTheme] = useState<Record<string, string>>(promenade.theme());
  const [selected, setSelected] = useState<number | null>(null);
  const [elk, setElk] = useState<Awaited<ReturnType<typeof layoutPetriNet>> | null>(null);
  const [showMiniMap, setShowMiniMap] = useState(true);
  const net = report.net;
  const { graph, arcs } = useMemo(() => buildElkGraph(net), [net]);

  useEffect(() => {
    promenade.on('theme', (event) => setTheme(event.theme));
    promenade.ready();
  }, []);

  // The first error is what the reader came for, so it opens selected. A clean
  // report opens with nothing selected and the plain net on show.
  useEffect(() => {
    const first = report.findings.findIndex((f) => f.severity === 'error');
    if (first >= 0) setSelected(first);
  }, [report]);

  useEffect(() => {
    let cancelled = false;
    layoutPetriNet(graph).then((result) => { if (!cancelled) setElk(result); });
    return () => { cancelled = true; };
  }, [graph]);

  const finding = selected == null ? null : report.findings[selected] ?? null;
  const highlightedPlaces = useMemo(() => new Set(finding?.places ?? []), [finding]);
  const highlightedTransitions = useMemo(() => new Set(finding?.transitions ?? []), [finding]);
  const witnessMarking = useMemo(() => {
    if (!finding?.witness || finding.witness.marking.length === 0) return null;
    return new Map(finding.witness.marking);
  }, [finding]);
  /** First position in the witness's firing sequence, per transition. */
  const witnessSteps = useMemo(() => {
    const steps = new Map<number, number>();
    finding?.witness?.trace.forEach((transition, index) => {
      if (!steps.has(transition)) steps.set(transition, index + 1);
    });
    return steps;
  }, [finding]);

  const initial = useMemo(() => new Set(net.initial_marking ?? []), [net.initial_marking]);
  const final = useMemo(() => new Set(net.final_marking ?? []), [net.final_marking]);
  const dead = useMemo(() => new Set(report.behaviour.deadTransitions), [report]);
  const severity = finding?.severity === 'error' ? 'error' : finding?.severity === 'warning' ? 'warning' : null;

  const nodes = useMemo<Node[]>(() => {
    if (!elk?.children) return [];
    return elk.children.map((child) => {
      if (child.id.startsWith('p')) {
        const index = Number(child.id.slice(1));
        const roles = [
          report.structure.sourcePlaces.includes(index) && 'source place',
          report.structure.sinkPlaces.includes(index) && 'sink place',
          initial.has(index) && 'initially marked',
          final.has(index) && 'in the final marking',
        ].filter(Boolean);
        const data: PlaceNodeData = {
          initial: initial.has(index),
          final: final.has(index),
          highlight: highlightedPlaces.has(index) ? severity : null,
          witnessTokens: witnessMarking ? (witnessMarking.get(index) ?? 0) : null,
          role: `place ${index}${roles.length ? ` — ${roles.join(', ')}` : ''}`,
          theme,
        };
        return { id: child.id, type: 'place', position: { x: child.x, y: child.y }, data, width: child.width, height: child.height };
      }
      const id = Number(child.id.slice(1));
      const activity = labelOf(net, id);
      const data: TransitionNodeData = {
        activity,
        highlight: highlightedTransitions.has(id) ? severity : null,
        dead: dead.has(id),
        step: witnessSteps.get(id) ?? null,
        role: `${activity ?? 'silent transition'}${dead.has(id) ? ' — can never fire' : ''}`,
        theme,
      };
      return { id: child.id, type: 'transition', position: { x: child.x, y: child.y }, data,
        width: activity == null ? SILENT_W : TRANS_W, height: activity == null ? SILENT_H : TRANS_H };
    });
  }, [dead, elk, final, highlightedPlaces, highlightedTransitions, initial, net, report, severity, theme, witnessMarking, witnessSteps]);

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

  // Fit to the whole net first, then to whatever a selected finding names —
  // a two-node highlight in a hundred-node net is otherwise off screen.
  const { fitView } = useReactFlow();
  const firstFit = useRef(true);
  useEffect(() => {
    if (!nodes.length) return;
    const ids = [
      ...[...highlightedPlaces].map((p) => ({ id: `p${p}` })),
      ...[...highlightedTransitions].map((t) => ({ id: `t${t}` })),
    ].filter((node) => nodes.some((n) => n.id === node.id));
    const raf = requestAnimationFrame(() => {
      fitView(ids.length > 0 && !firstFit.current
        ? { nodes: ids, padding: 0.35, duration: 250, maxZoom: 1.5 }
        : { padding: 0.12, duration: firstFit.current ? 0 : 250 });
      firstFit.current = false;
    });
    return () => cancelAnimationFrame(raf);
  }, [fitView, highlightedPlaces, highlightedTransitions, nodes]);

  return <div style={{ width: '100%', height: '100%', display: 'flex', background: theme.bg }}>
    <Findings report={report} theme={theme} selected={selected} onSelect={setSelected} />
    <div style={{ flex: 1, minWidth: 0, height: '100%' }}>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        nodeOrigin={[0, 0]} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false}
        elementsSelectable panOnDrag panOnScroll={false} zoomOnScroll zoomOnPinch zoomOnDoubleClick={false}
        minZoom={0.02} maxZoom={4} onlyRenderVisibleElements proOptions={{ hideAttribution: true }}
      >
        <Background color={theme.border} gap={20} />
        <Controls showInteractive={false}>
          <ControlButton onClick={() => setShowMiniMap((visible) => !visible)} title={showMiniMap ? 'Hide overview map' : 'Show overview map'}>
            {showMiniMap ? '▣' : '□'}
          </ControlButton>
          <ExportMenu filename="soundness" />
        </Controls>
        {showMiniMap && (
          <MiniMap
            pannable zoomable
            nodeColor={(node) => {
              const data = node.data as PlaceNodeData | TransitionNodeData;
              if (data.highlight === 'error') return theme.danger;
              if (data.highlight === 'warning') return theme.warn;
              return node.type === 'transition' ? theme['text-dim'] : theme['bg-soft'];
            }}
            nodeStrokeColor={() => theme['text-dim'] ?? '#6b7280'}
            style={{ background: theme['bg-soft'] }}
          />
        )}
      </ReactFlow>
    </div>
  </div>;
}

function Failure({ message }: { message: string }): ReactNode {
  const theme = promenade.theme();
  return <div style={{
    padding: 20, font: '13px/1.6 system-ui, sans-serif',
    color: theme['text-dim'], background: theme.bg, height: '100%',
  }}>{message}</div>;
}

const report = normaliseReport(promenade.artifact().value);
const root = createRoot(document.getElementById('root')!);
if (report) {
  root.render(<ReactFlowProvider><App report={report} /></ReactFlowProvider>);
} else {
  promenade.ready();
  root.render(<Failure message="This artifact does not carry a soundness report. Run “Check soundness” on an accepting Petri net to produce one." />);
}
