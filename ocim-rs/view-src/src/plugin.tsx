import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, ControlButton, MiniMap, Panel,
  useReactFlow, type Node, type Edge,
} from '@xyflow/react';
// esbuild's `.css` -> text loader (see build.js) turns this into a plain JS
// string; there is no other way to get React Flow's stylesheet into an
// opaque-origin frame that cannot load a subresource of its own.
// @ts-ignore -- text loader, not a real CSS module
import reactFlowCss from '@xyflow/react/dist/style.css';

import type { OcptPayload } from './types';
import { layoutTree, leafTypeFlags } from './layout';
import { OperatorNode, type OperatorNodeData } from './OperatorNode';
import { LeafNode, type LeafNodeData } from './LeafNode';
import { ExportMenu } from './lib/ExportMenu';

const styleTag = document.createElement('style');
styleTag.textContent = reactFlowCss;
document.head.appendChild(styleTag);

const nodeTypes = { operator: OperatorNode, leaf: LeafNode };

interface Params {
  orientation: 'vertical' | 'horizontal';
  showInteractionTable: boolean;
  compactSilent: boolean;
}

// A leaf's own `related` list is what the discovery core annotated it
// with; an operator carries no such list in the payload (only leaves do),
// so its color ring is the union of every real (non-tau) leaf under it,
// computed once per tree here rather than in Rust — purely a rendering
// concern. A tau leaf's own list is empty too (see ocim-core's `flatten`),
// so for hover-matching and any future coloring it inherits its parent
// operator's union — the tau represents "this same subject matter, but
// skipped", not an absence of subject matter.
function relatedTypeSets(tree: OcptPayload): { byNode: Map<number, string[]>; parent: Map<number, number> } {
  const byNode = new Map<number, string[]>();
  const parent = new Map<number, number>();
  function collect(i: number): Set<string> {
    const n = tree.nodes[i];
    for (const c of n.children) parent.set(c, i);
    if (n.operator == null) {
      const set = new Set(n.label != null ? n.related : []);
      byNode.set(i, [...set]);
      return set;
    }
    const acc = new Set<string>();
    for (const c of n.children) for (const t of collect(c)) acc.add(t);
    byNode.set(i, [...acc]);
    return acc;
  }
  collect(tree.root);
  for (const [id, n] of tree.nodes.entries()) {
    if (n.operator == null && n.label == null) {
      const p = parent.get(id);
      if (p != null) byNode.set(id, byNode.get(p) ?? []);
    }
  }
  return { byNode, parent };
}

function App({ tree }: { tree: OcptPayload }) {
  const [theme, setTheme] = useState<Record<string, string>>(promenade.theme());
  const [selected, setSelected] = useState<string | null>(null);
  const [hoveredType, setHoveredType] = useState<string | null>(null);
  const [params, setParams] = useState<Params>({ orientation: 'vertical', showInteractionTable: true, compactSilent: false });
  const [legendOpen, setLegendOpen] = useState(true);
  const [showMiniMap, setShowMiniMap] = useState(true);

  useEffect(() => {
    promenade.on('theme', (p) => setTheme(p.theme));
    promenade.on('params', (p) => setParams((prev) => ({ ...prev, ...(p as Partial<Params>) })));
    promenade.on('selection', (sel) => {
      const hit = sel.items.find((i) => i.kind === 'activity');
      setSelected(hit ? hit.id : null);
    });
    promenade.ready();
  }, []);

  const layout = useMemo(
    () => layoutTree(tree, params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, params.orientation, params.showInteractionTable, params.compactSilent],
  );

  const { byNode: relatedTypes } = useMemo(() => relatedTypeSets(tree), [tree]);
  const isDimmed = (id: number) => hoveredType != null && !(relatedTypes.get(id) ?? []).includes(hoveredType);

  const nodes: Node[] = useMemo(() => layout.positioned.map((p) => {
    const n = tree.nodes[p.id];
    if (p.kind === 'operator') {
      const data: OperatorNodeData = {
        operator: n.operator as OperatorNodeData['operator'],
        relatedTypes: relatedTypes.get(p.id) ?? [],
        typeColor: (t: string) => promenade.color('objectType', t),
        theme,
        horizontal: params.orientation === 'horizontal',
        dimmed: isDimmed(p.id),
      };
      return { id: String(p.id), type: 'operator', position: { x: p.x, y: p.y }, data, width: p.w, height: p.h, selectable: false } satisfies Node;
    }
    const data: LeafNodeData = {
      label: n.label,
      types: params.showInteractionTable ? leafTypeFlags(n) : [],
      showInteractionTable: params.showInteractionTable,
      compactSilent: params.compactSilent,
      selected: n.label != null && selected === n.label,
      dimmed: isDimmed(p.id),
      theme,
      horizontal: params.orientation === 'horizontal',
      color: n.label ? promenade.color('activity', n.label) : '',
      typeColor: (t: string) => promenade.color('objectType', t),
    };
    return { id: String(p.id), type: 'leaf', position: { x: p.x, y: p.y }, data, width: p.w, height: p.h, selectable: n.label != null } satisfies Node;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [layout, tree, theme, params, selected, relatedTypes, hoveredType]);

  const edges: Edge[] = useMemo(() => layout.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    // Straight (not stepped/orthogonal) so a node's children fan out on
    // diagonals, matching every other process-tree rendering in Promenade
    // (see the classic dendrogram-style OCPT diagrams elsewhere).
    type: 'straight',
    style: {
      stroke: '#000',
      strokeWidth: 1.5,
      opacity: isDimmed(Number(e.target)) ? 0.1 : 1,
      transition: 'opacity 150ms',
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  } satisfies Edge)), [layout, hoveredType, relatedTypes]);

  function onNodeClick(_: unknown, node: Node) {
    if (node.type !== 'leaf') return;
    const n = tree.nodes[Number(node.id)];
    if (n.label == null) return;
    promenade.select([{ kind: 'activity', id: n.label }]);
  }
  function onPaneClick() {
    promenade.select([]);
  }

  const { fitView } = useReactFlow();
  const firstFit = useRef(true);
  useEffect(() => {
    if (!nodes.length) return;
    const raf = requestAnimationFrame(() => {
      fitView({ padding: 0.12, duration: firstFit.current ? 0 : 250 });
      firstFit.current = false;
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, fitView]);

  return (
    <div style={{ width: '100%', height: '100%', background: theme.bg }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
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
          <ControlButton onClick={() => setShowMiniMap((visible) => !visible)} title={showMiniMap ? 'Hide overview map' : 'Show overview map'}>
            {showMiniMap ? '▣' : '□'}
          </ControlButton>
          <ExportMenu filename="process-tree" />
        </Controls>
        {showMiniMap && (
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => (n.type === 'leaf' ? (n.data as unknown as LeafNodeData).color || (theme['text-dim'] ?? '#888') : (theme['text-dim'] ?? '#888'))}
            style={{ background: theme['bg-soft'] }}
          />
        )}
        <Panel position="top-left">
          <Legend
            tree={tree}
            open={legendOpen}
            setOpen={setLegendOpen}
            theme={theme}
            hoveredType={hoveredType}
            setHoveredType={setHoveredType}
          />
        </Panel>
      </ReactFlow>
    </div>
  );
}

function Legend({
  tree, open, setOpen, theme, hoveredType, setHoveredType,
}: {
  tree: OcptPayload;
  open: boolean;
  setOpen: (v: boolean) => void;
  theme: Record<string, string>;
  hoveredType: string | null;
  setHoveredType: (t: string | null) => void;
}) {
  const s = tree.stats;
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
        <span>Object-Centric Process Tree</span>
        <span style={{ color: theme['text-dim'] }}>{open ? '−' : '+'}</span>
      </div>
      {open && (
        <>
          <div style={{ color: theme['text-dim'], marginBottom: 8, lineHeight: 1.6 }}>
            {s.objectTypes} object types &middot; {s.operators} operators &middot; {s.leaves} leaves
            {s.silent > 0 ? <> &middot; {s.silent} silent</> : null}
          </div>
          {tree.objectTypes.map((t) => (
            <div
              key={t}
              onMouseEnter={() => setHoveredType(t)}
              onMouseLeave={() => setHoveredType(null)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, padding: '2px 4px', borderRadius: 4,
                cursor: 'default', fontWeight: hoveredType === t ? 700 : 400,
                background: hoveredType === t ? (theme['accent-soft'] ?? '#e8efff') : 'transparent',
              }}
            >
              <span style={{ width: 10, height: 10, borderRadius: 2, background: promenade.color('objectType', t), flex: '0 0 auto' }} />
              <span>{t}</span>
            </div>
          ))}
          <div style={{ marginTop: 8, borderTop: `1px solid ${theme.border}`, paddingTop: 6, color: theme['text-dim'] }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', border: `2px solid ${theme['text-dim']}` }} />
              <span>operator, ringed by its object type(s) (→ seq, &times; choice, &and; parallel, ↻ loop)</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <span style={{ width: 12, height: 12, borderRadius: 3, border: `1.5px dashed ${theme['text-dim']}` }} />
              <span>silent step (&tau;)</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>Div / Con / Def</span>
              <span>divergent / convergent / deficient</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const tree = promenade.artifact().value as OcptPayload;
createRoot(document.getElementById('root')!).render(
  <ReactFlowProvider>
    <App tree={tree} />
  </ReactFlowProvider>,
);
