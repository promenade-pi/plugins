import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow, ReactFlowProvider, Background, ControlButton, Controls, MiniMap, Panel,
  MarkerType, useReactFlow, type Node, type Edge,
} from '@xyflow/react';
// @ts-ignore -- text loader (see build.js), not a real CSS module
import reactFlowCss from '@xyflow/react/dist/style.css';

import type { BpmnMetadata, BpmnPayload } from './types';
import { TaskNode, type TaskNodeData } from './TaskNode';
import { GatewayNode, type GatewayNodeData } from './GatewayNode';
import { EventNode, type EventNodeData } from './EventNode';
import { BpmnEdge, type BpmnEdgeData } from './BpmnEdge';
import { buildElkGraph, layoutBpmn, pathFromSections, LAYOUT_EDGE_LIMIT, type ElkResult } from './layout';
import { ExportMenu } from './lib/ExportMenu';

const styleTag = document.createElement('style');
styleTag.textContent = reactFlowCss;
document.head.appendChild(styleTag);

const nodeTypes = { task: TaskNode, gateway: GatewayNode, event: EventNode };
const edgeTypes = { bpmn: BpmnEdge };

/** A fresh action run leaves an envelope (`{value: ...}`); a page reload
 * leaves the bare payload already there. Same normalization every bundled
 * view in this repo does locally (see `fuzzy-miner-rs/view-src/src/plugin.tsx`). */
function payloadOf(value: unknown): BpmnPayload | null {
  const v = value as any;
  if (v && typeof v === 'object' && !Array.isArray(v.nodes) && v.value) return v.value as BpmnPayload;
  if (v && typeof v === 'object' && Array.isArray(v.nodes)) return v as BpmnPayload;
  return null;
}

type LayoutIssue = { kind: 'too-large'; nodes: number; edges: number } | { kind: 'failed'; message: string };

function App({ bpmn }: { bpmn: BpmnPayload }) {
  const [theme, setTheme] = useState<Record<string, string>>(promenade.theme());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showMiniMap, setShowMiniMap] = useState(true);
  const [elk, setElk] = useState<ElkResult | null>(null);
  const [layoutIssue, setLayoutIssue] = useState<LayoutIssue | null>(null);

  useEffect(() => {
    promenade.on('theme', (p) => setTheme(p.theme));
    promenade.on('selection', (sel) => {
      setSelected(new Set(sel.items.filter((i) => i.kind === 'node').map((i) => i.id)));
    });
    promenade.ready();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const graph = buildElkGraph(bpmn);
    if (graph.edges.length > LAYOUT_EDGE_LIMIT) {
      setLayoutIssue({ kind: 'too-large', nodes: graph.children.length, edges: graph.edges.length });
      setElk(null);
      return;
    }
    setLayoutIssue(null);
    layoutBpmn(graph)
      .then((r) => { if (!cancelled) setElk(r); })
      .catch((err) => {
        if (cancelled) return;
        console.error('[bpmn-view] layout failed', err);
        setLayoutIssue({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, [bpmn]);

  const nodeIx = useMemo(() => new Map(bpmn.nodes.map((n) => [n.id, n])), [bpmn]);

  const nodes: Node[] = useMemo(() => {
    if (!elk?.children) return [];
    return elk.children.map((c) => {
      const n = nodeIx.get(c.id)!;
      if (n.kind === 'task') {
        const data: TaskNodeData = { label: n.label ?? '', selected: selected.has(n.id), theme };
        return { id: c.id, type: 'task', position: { x: c.x, y: c.y }, data, width: c.width, height: c.height } satisfies Node;
      }
      if (n.kind === 'startEvent' || n.kind === 'endEvent') {
        const data: EventNodeData = { kind: n.kind, selected: selected.has(n.id), theme };
        return { id: c.id, type: 'event', position: { x: c.x, y: c.y }, data, width: c.width, height: c.height } satisfies Node;
      }
      const data: GatewayNodeData = { kind: n.kind as GatewayNodeData['kind'], selected: selected.has(n.id), theme };
      return { id: c.id, type: 'gateway', position: { x: c.x, y: c.y }, data, width: c.width, height: c.height } satisfies Node;
    });
  }, [elk, nodeIx, selected, theme]);

  const edges: Edge[] = useMemo(() => {
    if (!elk?.edges) return [];
    const byId = new Map(bpmn.flows.map((f) => [f.id, f]));
    return elk.edges.flatMap((e) => {
      const flow = byId.get(e.id);
      if (!flow || !e.sections?.length) return [];
      const color = theme.text ?? '#333';
      const data: BpmnEdgeData = { path: pathFromSections(e.sections), color, label: flow.label };
      return [{
        id: e.id, source: flow.source, target: flow.target, type: 'bpmn', data,
        label: flow.label ?? undefined,
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 },
      } satisfies Edge];
    });
  }, [elk, bpmn.flows, theme]);

  function onNodeClick(_: unknown, node: Node) {
    promenade.select([{ kind: 'node', id: node.id }]);
  }

  const { fitView } = useReactFlow();
  const firstFit = useRef(true);
  useEffect(() => {
    if (!nodes.length) return;
    const raf = requestAnimationFrame(() => {
      fitView({ padding: 0.15, duration: firstFit.current ? 0 : 250 });
      firstFit.current = false;
    });
    return () => cancelAnimationFrame(raf);
  }, [nodes, fitView]);

  if (layoutIssue) {
    return (
      <div style={{ width: '100%', height: '100%', background: theme.bg, position: 'relative' }}>
        <LayoutIssueNotice issue={layoutIssue} theme={theme} />
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', background: theme.bg }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        nodeOrigin={[0, 0]}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesReconnectable={false}
        elementsSelectable
        panOnDrag
        panOnScroll={false}
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        minZoom={0.05}
        maxZoom={4}
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
      >
        <Background color={theme.border} gap={20} />
        <Controls showInteractive={false}>
          <ControlButton onClick={() => setShowMiniMap((v) => !v)} title={showMiniMap ? 'Hide overview map' : 'Show overview map'}>
            {showMiniMap ? '▣' : '□'}
          </ControlButton>
          <ExportMenu filename="bpmn" />
        </Controls>
        {showMiniMap && (
          <MiniMap pannable zoomable style={{ background: theme['bg-soft'] }} />
        )}
        {(!bpmn.metadata.structured || bpmn.metadata.warnings.length > 0) && (
          <Panel position="top-left">
            <StructureWarning metadata={bpmn.metadata} theme={theme} />
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}

/** Why a diagram isn't a clean XOR/AND block structure depends entirely on
 *  where it came from — a conversion that could not do better, or a miner that
 *  was never trying to. Saying "the source Petri net wasn't sound" over a
 *  diagram mined from an event log is simply false, so the headline follows
 *  `sourceType`.
 *
 *  A producer's own warnings show whenever there are any. They used to ride
 *  along with the structure notice, which meant a perfectly block-structured
 *  diagram could carry a warning nobody ever saw. */
function StructureWarning({ metadata, theme }: { metadata: BpmnMetadata; theme: Record<string, string> }) {
  const unstructured = !metadata.structured;
  const explanation = metadata.sourceType === 'AcceptingPetriNet'
    ? "The source Petri net wasn't a sound free-choice workflow net, so this diagram is a behavior-preserving translation, not a clean single XOR/AND block structure."
    : 'This diagram is not a single nested XOR/AND block structure. That is not necessarily a fault: a discovered model is only block-structured when the behaviour it found happens to be.';
  return (
    <div style={{
      background: theme['bg-soft'], border: `1px solid ${theme.border}`, borderRadius: 8,
      padding: 10, fontSize: 11, color: theme.text, maxWidth: 280, boxShadow: '0 2px 8px rgba(0,0,0,.08)',
    }}>
      {unstructured && (
        <>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Not block-structured</div>
          <div style={{ color: theme['text-dim'], lineHeight: 1.5 }}>{explanation}</div>
        </>
      )}
      {metadata.warnings.length > 0 && (
        <ul style={{ marginTop: unstructured ? 6 : 0, paddingLeft: 16, color: theme['text-dim'], lineHeight: 1.5 }}>
          {metadata.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
    </div>
  );
}

function LayoutIssueNotice({ issue, theme }: { issue: LayoutIssue; theme: Record<string, string> }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <div style={{ maxWidth: 440, textAlign: 'center', color: theme.text, fontSize: 13 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          {issue.kind === 'too-large' ? 'This diagram is too large to lay out automatically' : 'Layout failed'}
        </div>
        <div style={{ color: theme['text-dim'], lineHeight: 1.5 }}>
          {issue.kind === 'too-large'
            ? `${issue.nodes.toLocaleString()} nodes and ${issue.edges.toLocaleString()} flows would go into the layout engine — past the ${LAYOUT_EDGE_LIMIT.toLocaleString()}-edge point where it reliably stays responsive.`
            : issue.message}
        </div>
      </div>
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  const theme = (() => { try { return promenade.theme(); } catch { return {} as Record<string, string>; } })();
  try { promenade.ready(); } catch { /* the host may not be listening yet */ }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%',
      background: theme.bg ?? '#fff', color: theme.text ?? '#222', padding: 24,
    }}>
      <div style={{ maxWidth: 420, textAlign: 'center', fontSize: 13 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div>
        <div style={{ color: theme['text-dim'] ?? '#888', lineHeight: 1.5 }}>{body}</div>
      </div>
    </div>
  );
}

const artifact = promenade.artifact();
const payload = payloadOf(artifact?.value);
const root = createRoot(document.getElementById('root')!);
root.render(
  payload
    ? <ReactFlowProvider><App bpmn={payload} /></ReactFlowProvider>
    : <Notice title="No BPMN diagram in memory" body="This artifact has no computed result to render." />
);
