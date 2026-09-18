import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Panel,
  useNodesState, applyEdgeChanges, type Node, type Edge, type EdgeChange,
} from '@xyflow/react';
// esbuild's `.css` → text loader (see build.js) turns this into a plain JS
// string; there is no other way to get React Flow's stylesheet into an
// opaque-origin frame that cannot load a subresource of its own.
// @ts-ignore -- text loader, not a real CSS module
import reactFlowCss from '@xyflow/react/dist/style.css';

import type { TotemPayload } from './types';
import { TotemNode, type TotemNodeData } from './TotemNode';
import { TotemEdge, type TotemEdgeData } from './TotemEdge';
import { trToShape, markerId, MarkerDefs, type MarkerShape } from './markers';
import { forceLayout } from './layout';
import { ExportMenu } from './lib/ExportMenu';

const styleTag = document.createElement('style');
styleTag.textContent = reactFlowCss;
document.head.appendChild(styleTag);

const nodeTypes = { totem: TotemNode };
const edgeTypes = { totem: TotemEdge };

function joinLabel(a: string | null, b: string | null): string {
  return [a, b].filter((x): x is string => !!x).join(' · ');
}

function App({ net }: { net: TotemPayload }) {
  const [theme, setTheme] = useState<Record<string, string>>(promenade.theme());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [legendOpen, setLegendOpen] = useState(true);

  useEffect(() => {
    promenade.on('theme', (p) => setTheme(p.theme));
    promenade.on('selection', (sel) => {
      setSelected(new Set(sel.items.filter((i) => i.kind === 'objectType').map((i) => i.id)));
    });
    promenade.on('resize', () => { /* React Flow observes its own container */ });
    promenade.ready();
  }, []);

  const visibleTypes = useMemo(() => net.objectTypes.filter((t) => !hidden.has(t)), [net, hidden]);
  const visibleEdges = useMemo(
    () => net.edges.filter((e) => !hidden.has(e.source) && !hidden.has(e.target)),
    [net, hidden]
  );

  // A one-shot force-directed layout, recomputed only when the visible set of
  // object types changes (hiding a type re-spreads the remainder) — not on
  // every render, and never overwritten by a later `net` identity change
  // while the user is mid-drag.
  const layout = useMemo(
    () => forceLayout({ objectTypes: visibleTypes, edges: visibleEdges }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleTypes.join(','), visibleEdges.length]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TotemNodeData>>([]);
  useEffect(() => {
    setNodes(visibleTypes.map((t) => {
      const p = layout.get(t) ?? { x: 0, y: 0 };
      const data: TotemNodeData = {
        label: t, color: promenade.color('objectType', t), selected: selected.has(t),
      };
      // Known up front (matches TotemNode's own padding/font) so the
      // floating-edge boundary math (floating.ts) is right from the first
      // frame, not just after React Flow's own DOM measurement lands.
      const width = Math.max(90, Math.round(t.length * 7.5) + 40);
      return {
        id: t, type: 'totem', position: { x: p.x, y: p.y }, data, draggable: true,
        width, height: 38,
      } satisfies Node<TotemNodeData>;
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // Selection highlight alone shouldn't re-run the layout or reset drag
  // positions — patch it into whatever nodes already exist instead.
  useEffect(() => {
    setNodes((prev) => prev.map((n) => (
      n.data.selected === selected.has(n.id) ? n : { ...n, data: { ...n.data, selected: selected.has(n.id) } }
    )));
  }, [selected, setNodes]);

  const [edges, setEdges] = useState<Edge<TotemEdgeData>[]>([]);
  useEffect(() => {
    setEdges(visibleEdges.map((e) => {
      const color = promenade.color('objectType', e.source);
      const startShape = trToShape(e.trInverse);
      const endShape = trToShape(e.tr);
      const data: TotemEdgeData = {
        color,
        startLabel: e.lcInverse,
        endLabel: e.lc,
        midLabel: joinLabel(e.ec, e.ecInverse),
      };
      return {
        id: `${e.source}->${e.target}`, source: e.source, target: e.target, type: 'totem', data,
        markerStart: startShape ? `url(#${markerId(startShape, color)})` : undefined,
        markerEnd: endShape ? `url(#${markerId(endShape, color)})` : undefined,
      } satisfies Edge<TotemEdgeData>;
    }));
  }, [visibleEdges]);
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(changes, eds) as Edge<TotemEdgeData>[]),
    []
  );

  const markerCombos = useMemo(() => {
    const combos: Array<{ shape: MarkerShape; color: string }> = [];
    for (const e of visibleEdges) {
      const color = promenade.color('objectType', e.source);
      const s = trToShape(e.trInverse); if (s) combos.push({ shape: s, color });
      const t = trToShape(e.tr); if (t) combos.push({ shape: t, color });
    }
    return combos;
  }, [visibleEdges]);

  function onNodeClick(_: unknown, node: Node) {
    promenade.select([{ kind: 'objectType', id: node.id }]);
  }

  return (
    <div style={{ width: '100%', height: '100%', background: theme.bg, position: 'relative' }}>
      <MarkerDefs combos={markerCombos} />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodesDraggable
        nodesConnectable={false}
        edgesReconnectable={false}
        elementsSelectable
        panOnDrag
        panOnScroll={false}
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        minZoom={0.1}
        maxZoom={3}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color={theme.border} gap={20} />
        <Controls showInteractive={false}>
          <ExportMenu filename="totem" />
        </Controls>
        <Panel position="top-left">
          <Legend
            net={net} hidden={hidden} setHidden={setHidden}
            open={legendOpen} setOpen={setLegendOpen} theme={theme}
          />
        </Panel>
      </ReactFlow>
    </div>
  );
}

function Legend({
  net, hidden, setHidden, open, setOpen, theme,
}: {
  net: TotemPayload;
  hidden: Set<string>;
  setHidden: (f: (prev: Set<string>) => Set<string>) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
  theme: Record<string, string>;
}) {
  function toggle(t: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  }
  return (
    <div
      style={{
        background: theme['bg-soft'], border: `1px solid ${theme.border}`, borderRadius: 8,
        padding: 10, fontSize: 11, color: theme.text, minWidth: 190, boxShadow: '0 2px 8px rgba(0,0,0,.08)',
      }}
    >
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', fontWeight: 600, marginBottom: open ? 8 : 0 }}
        onClick={() => setOpen(!open)}
      >
        <span>Legend</span>
        <span style={{ color: theme['text-dim'] }}>{open ? '−' : '+'}</span>
      </div>
      {open && (
        <>
          <div style={{ fontWeight: 600, marginBottom: 4, color: theme['text-dim'] }}>Object types</div>
          {net.objectTypes.map((t) => (
            <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, cursor: 'pointer' }}>
              <input type="checkbox" checked={!hidden.has(t)} onChange={() => toggle(t)} style={{ margin: 0 }} />
              <span style={{ width: 10, height: 10, borderRadius: 2, background: promenade.color('objectType', t), flex: '0 0 auto' }} />
              <span>{t}</span>
            </label>
          ))}
          <div style={{ marginTop: 8, borderTop: `1px solid ${theme.border}`, paddingTop: 6, color: theme['text-dim'] }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Temporal relation (arrow at each end)</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <svg width="14" height="10"><polygon points="1,1 13,5 1,9" fill={theme['text-dim']} /></svg>
              <span>parallel (default)</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <svg width="14" height="10"><line x1="7" y1="1" x2="7" y2="9" stroke={theme['text-dim']} strokeWidth="2" /></svg>
              <span>dependent (contains the other)</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <svg width="14" height="10"><circle cx="7" cy="5" r="3" fill="none" stroke={theme['text-dim']} strokeWidth="1.4" /></svg>
              <span>initiating (starts first)</span>
            </div>
            <div style={{ fontWeight: 600, marginBottom: 3 }}>Labels</div>
            <div>Outer: log cardinality (per object)</div>
            <div>Center: event cardinality (per event)</div>
          </div>
        </>
      )}
    </div>
  );
}

const net = promenade.artifact().value as TotemPayload;
createRoot(document.getElementById('root')!).render(
  <ReactFlowProvider>
    <App net={net} />
  </ReactFlowProvider>
);
