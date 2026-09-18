import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow, ReactFlowProvider, Background, ControlButton, Controls, MiniMap, Panel,
  MarkerType, useReactFlow, type Node, type Edge,
} from '@xyflow/react';
// esbuild's `.css` → text loader (see build.js) turns this into a plain JS
// string; there is no other way to get React Flow's stylesheet into an
// opaque-origin frame that cannot load a subresource of its own.
// @ts-ignore -- text loader, not a real CSS module
import reactFlowCss from '@xyflow/react/dist/style.css';

import type { OcpnPayload } from './types';
import { PlaceNode, type PlaceNodeData } from './PlaceNode';
import { TransitionNode, type TransitionNodeData } from './TransitionNode';
import { OcpnEdge, type OcpnEdgeData } from './OcpnEdge';
import { buildElkGraph, layoutOcpn, pathFromSections, tauSize, TRANS_H, TRANS_W, type ElkResult, type FlowDirection } from './layout';
import { logVersions } from './debug';
import { ExportMenu } from './lib/ExportMenu';

const styleTag = document.createElement('style');
styleTag.textContent = reactFlowCss;
document.head.appendChild(styleTag);

const nodeTypes = { place: PlaceNode, transition: TransitionNode };
const edgeTypes = { ocpn: OcpnEdge };

/**
 * ELK's layered node placement recurses per constraint-graph edge in this
 * build, with no iteration fallback — past a few thousand edges that either
 * overflows the stack outright or, once routed around (see layout.ts), just
 * takes tens of seconds on the single thread this sandboxed plugin has
 * (elkjs needs a real Worker to run off-thread, which the sandbox's CSP
 * doesn't allow). Measured on this preset: ~700 edges lays out in ~2s,
 * ~1300 in ~4s, ~2500 in ~15-26s. 1500 keeps the worst case under about 5s
 * instead of freezing the tab.
 */
const LAYOUT_EDGE_LIMIT = 1500;

interface ViewParams {
  direction: FlowDirection;
}

const defaultParams: ViewParams = { direction: 'RIGHT' };

type LayoutIssue = { kind: 'too-large'; nodes: number; edges: number } | { kind: 'failed'; message: string };

function App({ net }: { net: OcpnPayload }) {
  const [theme, setTheme] = useState<Record<string, string>>(promenade.theme());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showSilent, setShowSilent] = useState(true);
  const [legendOpen, setLegendOpen] = useState(true);
  const [showMiniMap, setShowMiniMap] = useState(true);
  const [elk, setElk] = useState<ElkResult | null>(null);
  const [layoutIssue, setLayoutIssue] = useState<LayoutIssue | null>(null);
  const [params, setParams] = useState<ViewParams>(defaultParams);

  useEffect(() => {
    promenade.on('theme', (p) => setTheme(p.theme));
    promenade.on('selection', (sel) => {
      setSelected(new Set(
        sel.items.filter((i) => i.kind === 'place' || i.kind === 'transition').map((i) => i.id)
      ));
    });
    promenade.on('resize', () => { /* React Flow observes its own container */ });
    promenade.on('params', (next) => setParams((current) => ({ ...current, ...next })));
    logVersions();
    promenade.ready();
  }, []);

  const visibleTypes = useMemo(
    () => new Set(net.objectTypes.filter((t) => !hidden.has(t))),
    [net, hidden]
  );
  const hiddenKey = [...hidden].sort().join(',');

  useEffect(() => {
    let cancelled = false;
    const graph = buildElkGraph(net, visibleTypes, showSilent, params.direction);
    if (graph.edges.length > LAYOUT_EDGE_LIMIT) {
      setLayoutIssue({ kind: 'too-large', nodes: graph.children.length, edges: graph.edges.length });
      setElk(null);
      return;
    }
    setLayoutIssue(null);
    layoutOcpn(graph)
      .then((r) => { if (!cancelled) setElk(r); })
      .catch((err) => {
        if (cancelled) return;
        // elkjs can still throw below this size on a pathological graph
        // shape; without this the promise rejection is silently swallowed
        // and the panel just sits empty forever with no visible cause.
        console.error('[ocpn-flow-view] layout failed', err);
        setLayoutIssue({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [net, hiddenKey, showSilent, params.direction]);

  const placeIx = useMemo(() => new Map(net.places.map((p) => [p.id, p])), [net]);
  const transitionIx = useMemo(() => new Map(net.transitions.map((t) => [t.id, t])), [net]);

  const nodes: Node[] = useMemo(() => {
    if (!elk?.children) return [];
    return elk.children.map((c) => {
      const place = placeIx.get(c.id);
      if (place) {
        const data: PlaceNodeData = {
          kind: place.kind, objectType: place.objectType, color: promenade.color('objectType', place.objectType),
          selected: selected.has(c.id), direction: params.direction, theme,
        };
        return { id: c.id, type: 'place', position: { x: c.x, y: c.y }, data,
          width: c.width, height: c.height } satisfies Node;
      }
      const t = transitionIx.get(c.id)!;
      const data: TransitionNodeData = {
        activity: t.activity, selected: selected.has(c.id), direction: params.direction,
      };
      const size = t.activity == null ? tauSize(params.direction) : { width: TRANS_W, height: TRANS_H };
      return { id: c.id, type: 'transition', position: { x: c.x, y: c.y }, data,
        ...size } satisfies Node;
    });
  }, [elk, placeIx, transitionIx, selected, theme, params.direction]);

  const edges: Edge[] = useMemo(() => {
    if (!elk?.edges) return [];
    const byId = new Map(net.arcs.map((a) => [a.id, a]));
    return elk.edges.flatMap((e) => {
      const arc = byId.get(e.id);
      // An edge can come back with more than one disconnected section (ELK
      // may split routing around obstacles); every one of them is real
      // geometry the layout computed, not a fragment to pick one of.
      if (!arc || !e.sections?.length) return [];
      const color = promenade.color('objectType', arc.objectType);
      const data: OcpnEdgeData = { path: pathFromSections(e.sections), color, variable: arc.variable };
      return [{
        id: e.id, source: arc.source.id, target: arc.target.id, type: 'ocpn', data,
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      } satisfies Edge];
    });
  }, [elk, net.arcs]);

  function onNodeClick(_: unknown, node: Node) {
    const kind = node.type === 'place' ? 'place' : 'transition';
    promenade.select([{ kind, id: node.id }]);
  }

  // Refit exactly when a real layout lands — a new set of node positions,
  // not a selection or hover change (`nodes` only changes when `elk` does,
  // which itself only updates on `net`/visibility/silent-toggle changes,
  // never on `selected`). The `requestAnimationFrame` gives React Flow's own
  // effect a turn to sync the just-changed `nodes`/`edges` props into its
  // internal store first — calling `fitView()` in the same commit as the
  // prop change is a known React Flow race (it measures current internal
  // node state, not the just-passed props). The very first layout gets an
  // instant fit (no point animating from an empty canvas); every later one
  // (an object-type toggle, say) animates so the change reads as a
  // response, not a jump.
  const { fitView } = useReactFlow();
  const firstFit = useRef(true);
  useEffect(() => {
    if (!nodes.length) return;
    const raf = requestAnimationFrame(() => {
      fitView({ padding: 0.12, duration: firstFit.current ? 0 : 250 });
      firstFit.current = false;
    });
    return () => cancelAnimationFrame(raf);
  }, [nodes, fitView]);

  if (layoutIssue) {
    return (
      <div style={{ width: '100%', height: '100%', background: theme.bg, position: 'relative' }}>
        <LayoutIssueNotice issue={layoutIssue} theme={theme} />
        <div style={{ position: 'absolute', top: 10, left: 10 }}>
          <Legend
            net={net} hidden={hidden} setHidden={setHidden}
            showSilent={showSilent} setShowSilent={setShowSilent}
            open={legendOpen} setOpen={setLegendOpen}
            theme={theme}
          />
        </div>
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
        // ELK already decided every coordinate; React Flow is the
        // interaction/rendering host here, not a second layout engine.
        // nodeOrigin `[0, 0]` made explicit rather than relied on as a
        // library default — it must match ELK's own top-left `x`/`y`
        // convention for `position` to mean the same thing on both sides.
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
        minZoom={0.02}
        maxZoom={4}
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
      >
        <Background color={theme.border} gap={20} />
        <Controls showInteractive={false}>
          <ControlButton onClick={() => setShowMiniMap((visible) => !visible)} title={showMiniMap ? 'Hide overview map' : 'Show overview map'}>
            {showMiniMap ? '▣' : '□'}
          </ControlButton>
          <ExportMenu filename="ocpn" />
        </Controls>
        {showMiniMap && (
          <MiniMap
            pannable zoomable
            nodeColor={(n) => (n.type === 'place'
              ? (n.data as PlaceNodeData).color
              : (theme['text-dim'] ?? '#888'))}
            style={{ background: theme['bg-soft'] }}
          />
        )}
        <Panel position="top-left">
          <Legend
            net={net} hidden={hidden} setHidden={setHidden}
            showSilent={showSilent} setShowSilent={setShowSilent}
            open={legendOpen} setOpen={setLegendOpen}
            theme={theme}
          />
        </Panel>
      </ReactFlow>
    </div>
  );
}

function LayoutIssueNotice({ issue, theme }: { issue: LayoutIssue; theme: Record<string, string> }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32,
    }}>
      <div style={{ maxWidth: 440, textAlign: 'center', color: theme.text, fontSize: 13 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          {issue.kind === 'too-large' ? 'This net is too large to lay out automatically' : 'Layout failed'}
        </div>
        <div style={{ color: theme['text-dim'], lineHeight: 1.5 }}>
          {issue.kind === 'too-large'
            ? `${issue.nodes.toLocaleString()} places/transitions and ${issue.edges.toLocaleString()} arcs would go into the layout engine — past the ${LAYOUT_EDGE_LIMIT.toLocaleString()}-arc point where it reliably stays responsive. Beyond that it can take tens of seconds or exhaust the browser's call stack outright.`
            : issue.message}
        </div>
        <ul style={{ textAlign: 'left', color: theme['text-dim'], marginTop: 12, paddingLeft: 18, lineHeight: 1.6 }}>
          <li>Hide some object types in the legend below.</li>
          <li>Turn off "Show silent transitions" to drop tau nodes and their arcs.</li>
        </ul>
      </div>
    </div>
  );
}

function Legend({
  net, hidden, setHidden, showSilent, setShowSilent, open, setOpen, theme,
}: {
  net: OcpnPayload;
  hidden: Set<string>;
  setHidden: (f: (prev: Set<string>) => Set<string>) => void;
  showSilent: boolean;
  setShowSilent: (v: boolean) => void;
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
        padding: 10, fontSize: 11, color: theme.text, minWidth: 170, boxShadow: '0 2px 8px rgba(0,0,0,.08)',
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
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={showSilent} onChange={(e) => setShowSilent(e.target.checked)} style={{ margin: 0 }} />
            <span>Show silent transitions</span>
          </label>
          <div style={{ marginTop: 8, borderTop: `1px solid ${theme.border}`, paddingTop: 6, color: theme['text-dim'] }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <svg width="12" height="12"><polygon points="1,1 11,6 1,11" fill={theme['text-dim']} /></svg>
              <span>source place</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <svg width="10" height="10"><rect width="10" height="10" fill={theme['text-dim']} /></svg>
              <span>sink place</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <span style={{ width: 14, height: 8, borderRadius: 2, background: theme['text-dim'] }} />
              <span>silent transition</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke={theme['text-dim']} strokeWidth="1.5" strokeDasharray="4 2" /></svg>
              <span>variable arc</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const net = promenade.artifact().value as OcpnPayload;
createRoot(document.getElementById('root')!).render(
  <ReactFlowProvider>
    <App net={net} />
  </ReactFlowProvider>
);
