import { useEffect, useMemo, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, MarkerType, type Node, type Edge } from '@xyflow/react';
import { queryTables, escapeLiteral, resolveTables, debounce } from '../lib/sql';
import { typeColorOf } from '../lib/colors';
import type { DeclaredType } from '../promenade';

type NodeKey = `object:${string}` | `event:${string}`;
interface GraphNodeInfo { key: NodeKey; kind: 'object' | 'event'; id: string; subtype: string; ring: number }
interface GraphEdgeInfo { key: string; source: NodeKey; target: NodeKey; qualifier: string | null }

const RADIUS_STEP = 190;

function keyOf(kind: 'object' | 'event', id: string): NodeKey { return `${kind}:${id}` as NodeKey; }

async function expandNeighborhood(
  focus: { kind: 'object' | 'event'; id: string },
  depth: number,
  direction: 'both' | 'out' | 'in'
): Promise<{ nodes: Map<NodeKey, GraphNodeInfo>; edges: Map<string, GraphEdgeInfo> }> {
  const t = promenade.artifact().tables;
  const nodes = new Map<NodeKey, GraphNodeInfo>();
  const edges = new Map<string, GraphEdgeInfo>();
  const focusKey = keyOf(focus.kind, focus.id);
  nodes.set(focusKey, { key: focusKey, kind: focus.kind, id: focus.id, subtype: '', ring: 0 });

  let frontier: GraphNodeInfo[] = [nodes.get(focusKey)!];
  for (let ring = 1; ring <= depth && frontier.length > 0; ring++) {
    const objectIds = frontier.filter((n) => n.kind === 'object').map((n) => n.id);
    const eventIds = frontier.filter((n) => n.kind === 'event').map((n) => n.id);
    const nextFrontier: GraphNodeInfo[] = [];
    const idList = (ids: string[]) => ids.map(escapeLiteral).join(',');

    const addNode = (key: NodeKey, kind: 'object' | 'event', id: string, subtype: string) => {
      if (nodes.has(key)) return nodes.get(key)!;
      const info: GraphNodeInfo = { key, kind, id, subtype, ring };
      nodes.set(key, info);
      nextFrontier.push(info);
      return info;
    };
    const addEdge = (source: NodeKey, target: NodeKey, qualifier: string | null) => {
      const k = `${source}>${target}`;
      if (!edges.has(k)) edges.set(k, { key: k, source, target, qualifier });
    };

    const queries: Promise<void>[] = [];
    if (objectIds.length > 0) {
      if (direction !== 'in') {
        queries.push(queryTables<{ source_id: string; target_id: string; qualifier: string | null; target_type: string }>(`
          SELECT r.source_id, r.target_id, r.qualifier, ot.object_type AS target_type
          FROM {o2o} r JOIN {object} ot ON ot.object_id = r.target_id
          WHERE r.source_id IN (${idList(objectIds)})
        `).then((rows) => {
          for (const r of rows) {
            const target = addNode(keyOf('object', r.target_id), 'object', r.target_id, r.target_type);
            addEdge(keyOf('object', r.source_id), target.key, r.qualifier);
          }
        }));
      }
      if (direction !== 'out') {
        queries.push(queryTables<{ source_id: string; target_id: string; qualifier: string | null; source_type: string }>(`
          SELECT r.source_id, r.target_id, r.qualifier, os.object_type AS source_type
          FROM {o2o} r JOIN {object} os ON os.object_id = r.source_id
          WHERE r.target_id IN (${idList(objectIds)})
        `).then((rows) => {
          for (const r of rows) {
            const source = addNode(keyOf('object', r.source_id), 'object', r.source_id, r.source_type);
            addEdge(source.key, keyOf('object', r.target_id), r.qualifier);
          }
        }));
      }
      // Events are added regardless of the direction filter — an object's
      // own events aren't "outgoing"/"incoming" in the O2O sense.
      queries.push(queryTables<{ object_id: string; event_id: string; qualifier: string | null; activity: string }>(`
        SELECT r.object_id, r.event_id, r.qualifier, e.activity
        FROM {e2o} r JOIN {event} e ON e.event_id = r.event_id
        WHERE r.object_id IN (${idList(objectIds)})
      `).then((rows) => {
        for (const r of rows) {
          const ev = addNode(keyOf('event', r.event_id), 'event', r.event_id, r.activity);
          addEdge(keyOf('object', r.object_id), ev.key, r.qualifier);
        }
      }));
    }
    if (eventIds.length > 0) {
      // An event's other related objects — this is what makes events real
      // hubs in the graph rather than dead ends (beyond what Ocelot itself
      // draws, per the explicit ask to include events here).
      queries.push(queryTables<{ event_id: string; object_id: string; qualifier: string | null; object_type: string }>(`
        SELECT r.event_id, r.object_id, r.qualifier, o.object_type
        FROM {e2o} r JOIN {object} o ON o.object_id = r.object_id
        WHERE r.event_id IN (${idList(eventIds)})
      `).then((rows) => {
        for (const r of rows) {
          const obj = addNode(keyOf('object', r.object_id), 'object', r.object_id, r.object_type);
          addEdge(keyOf('event', r.event_id), obj.key, r.qualifier);
        }
      }));
    }
    await Promise.all(queries);
    frontier = nextFrontier;
  }

  return { nodes, edges };
}

function radialLayout(nodes: Map<NodeKey, GraphNodeInfo>, focusKey: NodeKey): Map<NodeKey, { x: number; y: number }> {
  const byRing = new Map<number, GraphNodeInfo[]>();
  for (const n of nodes.values()) {
    if (!byRing.has(n.ring)) byRing.set(n.ring, []);
    byRing.get(n.ring)!.push(n);
  }
  const positions = new Map<NodeKey, { x: number; y: number }>();
  positions.set(focusKey, { x: 0, y: 0 });
  for (const [ring, ringNodes] of byRing) {
    if (ring === 0) continue;
    const r = ring * RADIUS_STEP;
    ringNodes.forEach((n, i) => {
      const angle = (i / ringNodes.length) * Math.PI * 2;
      positions.set(n.key, { x: Math.cos(angle) * r, y: Math.sin(angle) * r });
    });
  }
  return positions;
}

function InstanceNode({ data }: { data: { kind: 'object' | 'event'; id: string; subtype: string; focused: boolean; colorIndex: number } }) {
  const color = data.kind === 'event' ? '#8b5e3c' : typeColorOf(data.colorIndex).icon;
  const bg = data.kind === 'event' ? '#f3ede4' : typeColorOf(data.colorIndex).bg;
  return (
    <div style={{
      padding: '8px 12px', borderRadius: data.kind === 'event' ? 8 : 999, background: bg,
      border: `2px solid ${data.focused ? 'var(--accent, #2563eb)' : color}`, minWidth: 90, textAlign: 'center',
      boxShadow: data.focused ? '0 0 0 3px var(--accent-soft, #dbeafe)' : undefined, cursor: 'pointer',
    }}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <div style={{ fontWeight: 650, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.id}</div>
      <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{data.subtype}</div>
    </div>
  );
}
const nodeTypes = { instance: InstanceNode };

export function RelationsExplorer({ rootObjectType, rootObjectId, objectTypes, onNavigate }: {
  rootObjectType: string;
  rootObjectId: string;
  objectTypes: DeclaredType[];
  onNavigate: (objectType: string, objectId: string, tab: 'overview' | 'relations') => void;
}) {
  const rootKey = keyOf('object', rootObjectId);
  const [history, setHistory] = useState<NodeKey[]>([rootKey]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [depth, setDepth] = useState(1);
  const [direction, setDirection] = useState<'both' | 'out' | 'in'>('both');
  const [showLabels, setShowLabels] = useState(true);
  const [searchInput, setSearchInput] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ object_id: string; object_type: string }>>([]);
  const [graph, setGraph] = useState<{ nodes: Map<NodeKey, GraphNodeInfo>; edges: Map<string, GraphEdgeInfo> } | null>(null);

  const focusKey = history[historyIndex];
  const [focusKind, focusId] = focusKey.split(/:(.+)/) as ['object' | 'event', string];

  useEffect(() => {
    let cancelled = false;
    setGraph(null);
    expandNeighborhood({ kind: focusKind, id: focusId }, depth, direction).then((g) => { if (!cancelled) setGraph(g); });
    return () => { cancelled = true; };
  }, [focusKey, depth, direction]);

  const search = useMemo(() => debounce((q: string) => {
    if (!q) { setSearchResults([]); return; }
    queryTables<{ object_id: string; object_type: string }>(resolveTables(
      `SELECT object_id, object_type FROM {object} WHERE object_id ILIKE ${escapeLiteral(`%${q}%`)} LIMIT 8`
    )).then(setSearchResults);
  }, 200), []);

  const focusNode = (key: NodeKey) => {
    setHistory((h) => {
      const truncated = h.slice(0, historyIndex + 1);
      if (truncated[truncated.length - 1] === key) return h;
      const existingAt = truncated.indexOf(key);
      if (existingAt !== -1) { setHistoryIndex(existingAt); return truncated; }
      const next = [...truncated, key];
      setHistoryIndex(next.length - 1);
      return next;
    });
    setSearchInput(''); setSearchResults([]);
  };

  const positions = useMemo(() => graph ? radialLayout(graph.nodes, focusKey) : null, [graph, focusKey]);

  const { nodes, edges } = useMemo(() => {
    if (!graph || !positions) return { nodes: [] as Node[], edges: [] as Edge[] };
    const nodes: Node[] = [...graph.nodes.values()].map((n) => {
      const p = positions.get(n.key) ?? { x: 0, y: 0 };
      const colorIndex = n.kind === 'object' ? objectTypes.findIndex((t) => t.name === n.subtype) : 0;
      return {
        id: n.key, type: 'instance', position: p, draggable: true,
        data: { kind: n.kind, id: n.id, subtype: n.subtype, focused: n.key === focusKey, colorIndex: Math.max(0, colorIndex) },
      };
    });
    const edges: Edge[] = [...graph.edges.values()].map((e) => ({
      id: e.key, source: e.source, target: e.target,
      label: showLabels && e.qualifier ? e.qualifier : undefined,
      markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: '#8b7355' },
      labelStyle: { fontSize: 10 }, labelBgStyle: { fillOpacity: 0.85 },
    }));
    return { nodes, edges };
  }, [graph, positions, focusKey, objectTypes, showLabels]);

  const focusedInfo = graph?.nodes.get(focusKey);
  const neighbors = useMemo(() => {
    if (!graph) return [];
    const out: GraphNodeInfo[] = [];
    for (const e of graph.edges.values()) {
      if (e.source === focusKey && direction !== 'in') { const n = graph.nodes.get(e.target); if (n) out.push(n); }
      if (e.target === focusKey && direction !== 'out') { const n = graph.nodes.get(e.source); if (n) out.push(n); }
    }
    return out;
  }, [graph, focusKey, direction]);

  return (
    <div style={{ display: 'flex', height: 520, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div className="oc-toolbar" style={{ position: 'relative' }}>
          <input
            className="oc-input" placeholder="Search objects…" style={{ width: 160 }}
            value={searchInput} onChange={(e) => { setSearchInput(e.target.value); search(e.target.value); }}
          />
          {searchResults.length > 0 && (
            <div className="oc-card" style={{ position: 'absolute', top: 36, left: 8, zIndex: 10, padding: 4, minWidth: 200 }}>
              {searchResults.map((r) => (
                <div key={r.object_id} className="oc-id-link" style={{ display: 'block', padding: '4px 6px', cursor: 'pointer' }}
                     onClick={() => focusNode(keyOf('object', r.object_id))}>
                  {r.object_id} <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{r.object_type}</span>
                </div>
              ))}
            </div>
          )}
          <label>Depth
            <select className="oc-input" style={{ marginLeft: 5 }} value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
              <option value={1}>1</option><option value={2}>2</option><option value={3}>3</option>
            </select>
          </label>
          <label>Direction
            <select className="oc-input" style={{ marginLeft: 5 }} value={direction} onChange={(e) => setDirection(e.target.value as any)}>
              <option value="both">Both</option><option value="out">Outgoing</option><option value="in">Incoming</option>
            </select>
          </label>
          <label><input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> Labels</label>
        </div>
        <div className="oc-breadcrumb">
          {history.map((k, i) => {
            const [, id] = k.split(/:(.+)/);
            return (
              <span key={k}>
                {i > 0 && <span> › </span>}
                <button onClick={() => setHistoryIndex(i)} style={{ fontWeight: i === historyIndex ? 700 : 400 }}>{id}</button>
              </span>
            );
          })}
          {history.length > 1 && (
            <button style={{ marginLeft: 10, color: 'var(--text-dim)' }} onClick={() => { setHistory([rootKey]); setHistoryIndex(0); }}>Clear history</button>
          )}
        </div>
        <div className="oc-relative">
          {graph ? (
            <ReactFlowProvider>
              <ReactFlow
                nodes={nodes} edges={edges} nodeTypes={nodeTypes}
                nodesDraggable nodesConnectable={false} panOnDrag zoomOnScroll fitView
                onNodeClick={(_, node) => focusNode(node.id as NodeKey)}
              >
                <Background /><Controls />
              </ReactFlow>
            </ReactFlowProvider>
          ) : <div className="oc-loading">Loading…</div>}
        </div>
      </div>
      <div style={{ width: 220, borderLeft: '1px solid var(--border)', padding: 12, overflow: 'auto', flex: '0 0 auto' }}>
        <div className="oc-card-title" style={{ fontSize: 12 }}>Selected {focusKind}</div>
        {focusedInfo && (
          <div className="oc-kv-grid" style={{ gridTemplateColumns: '1fr', gap: 8, marginBottom: 12 }}>
            <div><div className="oc-kv-label">ID</div><div className="oc-kv-value">{focusedInfo.id}</div></div>
            <div><div className="oc-kv-label">{focusKind === 'object' ? 'Object type' : 'Activity'}</div><div className="oc-kv-value">{focusedInfo.subtype}</div></div>
            <div><div className="oc-kv-label">Relationships</div><div className="oc-kv-value">{neighbors.length}</div></div>
            <div><div className="oc-kv-label">Depth</div><div className="oc-kv-value">{depth}</div></div>
          </div>
        )}
        <div className="oc-card-title" style={{ fontSize: 12 }}>Neighbors</div>
        {neighbors.map((n, i) => (
          <div key={`${n.key}:${i}`} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 0', fontSize: 12 }}>
            <button className="oc-id-link" style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }} onClick={() => focusNode(n.key)}>
              {n.id}
            </button>
            {n.kind === 'object' && (
              <button className="oc-close-btn" title="Open object" onClick={() => onNavigate(n.subtype, n.id, 'relations')}>↗</button>
            )}
          </div>
        ))}
        {neighbors.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>No neighbors at this depth.</div>}
        {focusKind === 'object' && focusId !== rootObjectId && (
          <button className="oc-btn active" style={{ marginTop: 12, width: '100%' }} onClick={() => onNavigate(focusedInfo?.subtype ?? rootObjectType, focusId, 'overview')}>
            View details
          </button>
        )}
      </div>
    </div>
  );
}
