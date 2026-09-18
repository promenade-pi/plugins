import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, ControlButton, MiniMap, Panel,
  MarkerType, useNodesState, type Node, type Edge,
} from '@xyflow/react';
// @ts-ignore -- esbuild's .css -> text loader, see build.js
import reactFlowCss from '@xyflow/react/dist/style.css';

import { injectCss } from '../lib/styleInject';
// @ts-ignore -- esbuild's .css -> text loader, see build.js
import baseCss from '../lib/base.css';
import { useHostTheme } from '../lib/theme';
import { queryTables } from '../lib/sql';
import { typeColorOf, attrTypeColor } from '../lib/colors';
import { useElkLayout } from '../lib/TypeGraph/useElkLayout';
import { TypeNode, NODE_WIDTH, nodeHeightOf, type TypeNodeData } from '../lib/TypeGraph/TypeNode';
import { ExportMenu } from '../lib/ExportMenu';
import type { DeclaredType } from '../promenade';

injectCss(reactFlowCss);
injectCss(baseCss);

const nodeTypes = { type: TypeNode };

interface RelationRow { event_type: string; object_type: string; n: number }

function App({ eventTypes, objectTypes }: { eventTypes: DeclaredType[]; objectTypes: DeclaredType[] }) {
  useHostTheme();
  const [viewMode, setViewMode] = useState<'graph' | 'list'>('graph');
  const [sortAlpha, setSortAlpha] = useState(false);
  const [selectedObjectTypes, setSelectedObjectTypes] = useState<Set<string>>(new Set());
  const [showMiniMap, setShowMiniMap] = useState(true);
  const [relations, setRelations] = useState<RelationRow[]>([]);

  useEffect(() => { promenade.ready(); }, []);

  const filterKey = [...selectedObjectTypes].sort().join(',');
  useEffect(() => {
    if (selectedObjectTypes.size === 0) { setRelations([]); return; }
    let cancelled = false;
    const list = [...selectedObjectTypes].map((t) => `'${t.replace(/'/g, "''")}'`).join(',');
    queryTables<RelationRow>(`
      SELECT e.activity AS event_type, o.object_type AS object_type, COUNT(*) AS n
      FROM {e2o} r
      JOIN {event} e ON e.event_id = r.event_id
      JOIN {object} o ON o.object_id = r.object_id
      WHERE o.object_type IN (${list})
      GROUP BY 1, 2
    `).then((rows) => { if (!cancelled) setRelations(rows); }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  const shownEventTypes = useMemo(() => {
    if (selectedObjectTypes.size === 0) return eventTypes;
    const names = new Set(relations.map((r) => r.event_type));
    return eventTypes.filter((t) => names.has(t.name));
  }, [eventTypes, relations, selectedObjectTypes]);

  const shownObjectTypes = useMemo(
    () => objectTypes.filter((t) => selectedObjectTypes.has(t.name)),
    [objectTypes, selectedObjectTypes]
  );

  const { layoutNodes, layoutEdges } = useMemo(() => {
    const ln = [
      ...shownEventTypes.map((t) => ({ id: `e:${t.name}`, width: NODE_WIDTH, height: nodeHeightOf(t.attributes.length) })),
      ...shownObjectTypes.map((t) => ({ id: `o:${t.name}`, width: NODE_WIDTH, height: nodeHeightOf(t.attributes.length) })),
    ];
    const le = relations
      .filter((r) => shownEventTypes.some((t) => t.name === r.event_type))
      .map((r) => ({ id: `${r.event_type}>${r.object_type}`, source: `e:${r.event_type}`, target: `o:${r.object_type}` }));
    return { layoutNodes: ln, layoutEdges: le };
  }, [shownEventTypes, shownObjectTypes, relations]);

  const positions = useElkLayout(layoutNodes, layoutEdges);

  // See the identical comment in object-types/plugin.tsx: a controlled
  // `nodes` prop with no `onNodesChange` never applies a drag's resulting
  // position, so `nodesDraggable` alone looked draggable but wasn't.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TypeNodeData>>([]);
  useEffect(() => {
    if (!positions) return;
    setNodes([
      ...shownEventTypes.map((t): Node<TypeNodeData> => {
        const p = positions.get(`e:${t.name}`);
        return { id: `e:${t.name}`, type: 'type', position: { x: p?.x ?? 0, y: p?.y ?? 0 }, data: { name: t.name, attributes: t.attributes, kind: 'event' as const } };
      }),
      ...shownObjectTypes.map((t): Node<TypeNodeData> => {
        const p = positions.get(`o:${t.name}`);
        return { id: `o:${t.name}`, type: 'type', position: { x: p?.x ?? 0, y: p?.y ?? 0 }, data: { name: t.name, attributes: t.attributes, kind: 'object' as const, colorIndex: objectTypes.indexOf(t) } };
      }),
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, shownEventTypes, shownObjectTypes, objectTypes]);

  const edges = useMemo(() => {
    if (!positions) return [] as Edge[];
    return relations
      .filter((r) => positions.has(`e:${r.event_type}`) && positions.has(`o:${r.object_type}`))
      .map((r) => ({
        id: `${r.event_type}>${r.object_type}`, source: `e:${r.event_type}`, target: `o:${r.object_type}`,
        label: String(r.n), markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: '#8b7355' },
        labelStyle: { fontSize: 10 }, labelBgStyle: { fillOpacity: 0.85 },
      }));
  }, [positions, relations]);

  return (
    <>
      <div className="oc-toolbar">
        <div className="oc-btn-group">
          <button className={`oc-btn${viewMode === 'graph' ? ' active' : ''}`} onClick={() => setViewMode('graph')}>Graph</button>
          <button className={`oc-btn${viewMode === 'list' ? ' active' : ''}`} onClick={() => setViewMode('list')}>List</button>
        </div>
        {viewMode === 'list' && (
          <label><input type="checkbox" checked={sortAlpha} onChange={(e) => setSortAlpha(e.target.checked)} /> Sort alphabetically</label>
        )}
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Only show event types with object types:</span>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {objectTypes.map((t) => (
            <button
              key={t.name}
              className={`oc-btn${selectedObjectTypes.has(t.name) ? ' active' : ''}`}
              onClick={() => setSelectedObjectTypes((s) => { const n = new Set(s); n.has(t.name) ? n.delete(t.name) : n.add(t.name); return n; })}
            >
              {t.name}
            </button>
          ))}
        </div>
        <div className="oc-toolbar-spacer" />
      </div>
      <div className="oc-relative">
        {viewMode === 'graph' ? (
          <ReactFlowProvider>
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} nodesDraggable nodesConnectable={false} panOnDrag zoomOnScroll onlyRenderVisibleElements fitView>
              <Background />
              <Controls>
                <ControlButton onClick={() => setShowMiniMap((v) => !v)} title={showMiniMap ? 'Hide overview map' : 'Show overview map'}>
                  {showMiniMap ? '▣' : '□'}
                </ControlButton>
                <ExportMenu filename="event-types" />
              </Controls>
              {showMiniMap && <MiniMap pannable zoomable nodeColor={(n) => { const d = n.data as TypeNodeData; return d.kind === 'event' ? '#8b5e3c' : typeColorOf(d.colorIndex ?? 0).icon; }} />}
              {selectedObjectTypes.size > 0 && (
                <Panel position="top-left">
                  <div style={{ fontSize: 11, display: 'flex', gap: 12, background: 'var(--bg)', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)' }}>
                    <span><svg width="10" height="10"><rect width="10" height="10" fill="#8b5e3c" /></svg> Event type</span>
                    <span><svg width="10" height="10"><rect width="10" height="10" fill="#7c3aed" /></svg> Object type</span>
                  </div>
                </Panel>
              )}
            </ReactFlow>
          </ReactFlowProvider>
        ) : (
          <div className="oc-body">
            {[...shownEventTypes].sort((a, b) => sortAlpha ? a.name.localeCompare(b.name) : 0).map((t) => (
              <div key={t.name} className="oc-card">
                <div className="oc-card-title">{t.name}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {t.attributes.map((a) => (
                    <span key={a.name} className="oc-chip">
                      <span className="oc-badge" style={{ background: attrTypeColor(a.type) }}>{a.type}</span> {a.name}
                    </span>
                  ))}
                  {t.attributes.length === 0 && <span style={{ color: 'var(--text-dim)' }}>No declared attributes.</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

const artifact = promenade.artifact();
const eventTypes = artifact.semantics?.eventTypes ?? [];
const objectTypes = artifact.semantics?.objectTypes ?? [];
createRoot(document.getElementById('root')!).render(<App eventTypes={eventTypes} objectTypes={objectTypes} />);
