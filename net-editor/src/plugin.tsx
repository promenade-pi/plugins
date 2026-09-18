/**
 * Petri Net Editor — draw a Petri net or an OCPN and publish it.
 *
 * The document (`model.ts`) is the source of truth and React Flow renders a
 * projection of it. The obvious alternative — let React Flow own the graph and
 * read it back on publish — makes every other feature awkward: undo has to
 * diff a view model, validation has to reconstruct arcs from edges, and the
 * object types have nowhere to live. One direction of data flow, one place to
 * undo, one thing to serialise.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Background, Controls, MiniMap, ReactFlow, applyNodeChanges,
  type Connection, type Edge, type Node, type NodeChange, type ReactFlowInstance,
} from '@xyflow/react';
import flowCss from '@xyflow/react/dist/style.css';

import css from './styles.css';
import { PlaceNode, TransitionNode } from './nodes';
import { decompile } from './decompile';
import { fromPnml, toPnml } from './pnml';
import {
  OBJECT_TYPE_COLORS, compile, emptyDoc, isPlace, isTransition, targetType, validateDoc,
  type EdArc, type NetDoc, type PlaceMarking,
} from './model';

for (const sheet of [flowCss, css]) {
  const style = document.createElement('style');
  style.textContent = sheet;
  document.head.appendChild(style);
}

const NODE_TYPES = { place: PlaceNode, transition: TransitionNode };
const mint = (p: string) => `${p}${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`;

/** Which net this panel's cached document belongs to — the id of the artifact
 *  being edited, or `new` for the blank canvas. A panel that reopens against a
 *  *different* net must not restore the last one's drawing. */
interface Saved { key: string; doc: NetDoc }

/** The artifact this panel was opened against, when it was opened against one.
 *  Null in the standalone view, which starts from nothing. */
interface Source { id: string; name: string; type: string }

function App() {
  const [doc, setDocRaw] = useState<NetDoc>(emptyDoc);
  const [selected, setSelected] = useState<string | null>(null);
  /**
   * React Flow measures each node itself and hands the result back as a
   * `dimensions` change; in controlled mode it keeps that measurement only for
   * as long as the node we pass *in* still carries it. Rendered pixel sizes
   * have no business in the document, so they live here and are merged into
   * the projection. Without this every render resets the measurement, no node
   * is ever "initialized", and React Flow draws the nodes and silently zero
   * edges — which looks exactly like a broken arc model.
   */
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const flow = useRef<ReactFlowInstance | null>(null);
  /** Set when the whole document is replaced, cleared once the view has been
   *  fitted to it. `fitView` as a prop only runs on the first render, so an
   *  imported or restored net would otherwise open somewhere off-screen and
   *  look like it had failed to load. */
  const [fitWanted, setFitWanted] = useState(false);

  /** Undo/redo over whole documents. A net this size is a few KB; a command
   *  log would be more code and more ways to be subtly wrong. */
  const past = useRef<NetDoc[]>([]);
  const future = useRef<NetDoc[]>([]);
  /** True while a node drag is in flight, so its stream of position changes
   *  collapses into the single undo step it looks like on screen. */
  const mid = useRef(false);
  const docRef = useRef(doc);
  docRef.current = doc;

  const setDoc = useCallback((next: NetDoc | ((d: NetDoc) => NetDoc), record = true) => {
    setDocRaw((current) => {
      const value = typeof next === 'function' ? (next as (d: NetDoc) => NetDoc)(current) : next;
      if (record) { past.current.push(current); future.current = []; }
      return value;
    });
    setStatus(null);
  }, []);

  /** A wholesale replacement: an import, or the state of an earlier session.
   *  The measurements belong to nodes that no longer exist, so they go too. */
  const replaceDoc = useCallback((next: NetDoc, record: boolean) => {
    setMeasured({});
    setDoc(next, record);
    setFitWanted(true);
  }, [setDoc]);

  // The artifact this view is bound to, if any. `standalone` views get none,
  // which is exactly the difference between "New…" and "Edit net".
  const bound = useMemo(() => {
    const a = promenade.artifact();
    return a && a.id && a.value !== undefined && a.value !== null
      ? ({ id: a.id, name: a.name, type: a.type, value: a.value })
      : null;
  }, []);
  const cacheKey = bound?.id ?? 'new';

  useEffect(() => {
    promenade.on('theme', () => { /* tokens are CSS variables; nothing to recompute */ });
    (async () => {
      if (bound) setSource({ id: bound.id, name: bound.name, type: bound.type });
      let restored = false;
      try {
        const cached = (await promenade.cachedState()) as Saved | null;
        // The layout lives here rather than in the artifact: a published net
        // carries no coordinates by design, so this is the only place an
        // author's arrangement survives closing the panel. It is keyed, so a
        // panel reopened against another net lays that one out instead of
        // showing the previous drawing.
        if (cached?.key === cacheKey && cached.doc?.nodes) {
          setDocRaw(cached.doc);
          setFitWanted(true);
          restored = true;
        }
      } catch { /* an empty cache is the normal first open */ }

      if (!restored && bound) {
        try {
          const { doc: next, notes: found } = decompile(bound.type, bound.value, bound.name);
          setDocRaw(next);
          setNotes(found);
          setFitWanted(true);
        } catch (err: any) {
          setStatus({ kind: 'error', text: String(err?.message ?? err) });
        }
      }
      promenade.ready();
    })();
  }, [bound, cacheKey]);

  useEffect(() => {
    const t = setTimeout(() => promenade.setCachedState({ key: cacheKey, doc } satisfies Saved), 400);
    return () => clearTimeout(t);
  }, [doc, cacheKey]);

  // Fitting before React Flow has measured the new nodes fits to nothing, so
  // this waits for the measurements the projection is already collecting.
  useEffect(() => {
    if (!fitWanted || !doc.nodes.length) return;
    if (!doc.nodes.every((n) => measured[n.id])) return;
    void flow.current?.fitView({ padding: 0.15, duration: 250 });
    setFitWanted(false);
  }, [fitWanted, doc.nodes, measured]);

  const problems = useMemo(() => validateDoc(doc), [doc]);
  const faulty = useMemo(() => new Set(problems.map((p) => p.id).filter(Boolean) as string[]), [problems]);
  const colorOf = useCallback(
    (type: string | null) => doc.objectTypes.find((t) => t.name === type)?.color ?? null,
    [doc.objectTypes]
  );

  /* ---------------------------------------------------------------- *
   * The React Flow projection.
   * ---------------------------------------------------------------- */
  const nodes: Node[] = useMemo(() => doc.nodes.map((n) => ({
    id: n.id,
    type: n.kind,
    position: { x: n.x, y: n.y },
    selected: selected === n.id,
    measured: measured[n.id],
    data: isPlace(n)
      ? { label: n.name, objectType: n.objectType, color: colorOf(n.objectType), marking: n.marking, faulty: faulty.has(n.id) }
      : {
        label: n.name, silent: n.silent, faulty: faulty.has(n.id),
        colors: [...new Set(doc.arcs
          .filter((a) => (a.source === n.id || a.target === n.id) && a.objectType)
          .map((a) => colorOf(a.objectType)).filter(Boolean) as string[])],
      },
  })), [doc, selected, colorOf, faulty, measured]);

  const edges: Edge[] = useMemo(() => doc.arcs.map((a) => ({
    id: a.id,
    source: a.source,
    target: a.target,
    selected: selected === a.id,
    label: a.objectType ?? undefined,
    animated: a.variable,
    style: {
      stroke: colorOf(a.objectType) ?? 'var(--text-dim, #6b7280)',
      // A variable arc is drawn thicker as well as animated: "more than one
      // token may move" is a property of the arc, and animation alone is
      // invisible in a screenshot or a printed figure.
      strokeWidth: a.variable ? 3 : 1.6,
    },
    markerEnd: { type: 'arrowclosed' as const, color: colorOf(a.objectType) ?? '#6b7280' },
  })), [doc.arcs, selected, colorOf]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const applied = applyNodeChanges(changes, nodes);

    setMeasured((current) => {
      let next = current;
      for (const n of applied) {
        const m = n.measured;
        if (!m?.width || !m.height) continue;
        if (current[n.id]?.width === m.width && current[n.id]?.height === m.height) continue;
        next = next === current ? { ...current } : next;
        next[n.id] = { width: m.width, height: m.height };
      }
      return next;
    });

    // A measurement is not an edit: it must not land in the document, in the
    // undo stack or in the cached state, so only a move writes back.
    const positions = changes.filter((c) => c.type === 'position');
    if (!positions.length) return;
    // One drag is one undo step, and the snapshot is taken when the drag
    // *starts*: taking it at the end would push the already-moved document,
    // and undo would restore the last intermediate frame instead of the
    // position the node was dragged from.
    const record = !mid.current;
    mid.current = positions.some((c) => c.dragging);
    setDoc((d) => ({
      ...d,
      nodes: d.nodes.map((n) => {
        const found = applied.find((a) => a.id === n.id);
        return found ? { ...n, x: found.position.x, y: found.position.y } : n;
      }),
    }), record);
  }, [nodes, setDoc]);

  const onConnect = useCallback((c: Connection) => {
    const from = doc.nodes.find((n) => n.id === c.source);
    const to = doc.nodes.find((n) => n.id === c.target);
    if (!from || !to || from.kind === to.kind) {
      setStatus({ kind: 'error', text: 'An arc runs between a place and a transition.' });
      return;
    }
    // The place end decides the type: a typed arc that disagreed with its own
    // place is the most common way to build an invalid OCPN, so the editor
    // simply never creates one.
    const place = isPlace(from) ? from : isPlace(to) ? to : null;
    const arc: EdArc = {
      id: mint('a'), source: c.source!, target: c.target!,
      objectType: place?.objectType ?? null, variable: false,
    };
    setDoc((d) => ({ ...d, arcs: [...d.arcs, arc] }));
    setSelected(arc.id);
  }, [doc.nodes, setDoc]);

  const addNode = (kind: 'place' | 'transition') => {
    const id = mint(kind === 'place' ? 'p' : 't');
    const count = doc.nodes.filter((n) => n.kind === kind).length;
    const base = { id, x: 120 + (count % 5) * 170, y: kind === 'place' ? 90 : 240 + Math.floor(count / 5) * 150 };
    setDoc((d) => ({
      ...d,
      nodes: [...d.nodes, kind === 'place'
        ? { ...base, kind: 'place', name: `p${count + 1}`, objectType: d.objectTypes[0]?.name ?? null, marking: 'none' }
        : { ...base, kind: 'transition', name: '', silent: false }],
    }));
    setSelected(id);
  };

  const remove = useCallback((id: string) => {
    setDoc((d) => ({
      ...d,
      nodes: d.nodes.filter((n) => n.id !== id),
      // An arc whose end is gone is not a net, so deleting a node deletes the
      // arcs that referenced it rather than leaving them dangling.
      arcs: d.arcs.filter((a) => a.id !== id && a.source !== id && a.target !== id),
    }));
    setSelected(null);
  }, [setDoc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const editing = e.target instanceof HTMLElement
        && /input|textarea|select/i.test(e.target.tagName);
      if (editing) return;
      if ((e.key === 'Backspace' || e.key === 'Delete') && selected) { e.preventDefault(); remove(selected); return; }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          const next = future.current.pop();
          if (next) { past.current.push(docRef.current); setDocRaw(next); }
        } else {
          const prev = past.current.pop();
          if (prev) { future.current.push(docRef.current); setDocRaw(prev); }
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected, remove]);

  /* ---------------------------------------------------------------- *
   * Object types.
   * ---------------------------------------------------------------- */
  const addType = () => setDoc((d) => ({
    ...d,
    objectTypes: [...d.objectTypes, {
      name: `type ${d.objectTypes.length + 1}`,
      color: OBJECT_TYPE_COLORS[d.objectTypes.length % OBJECT_TYPE_COLORS.length],
    }],
  }));

  /**
   * Object types are addressed by position, not by name.
   *
   * The name is the thing being edited, so it cannot also be the handle: a
   * row keyed by its name gets a new key on every keystroke, and React
   * unmounts the input the author is typing into. Position is stable while
   * the name is in flux — and it also makes a rename exact, where matching on
   * the old name would merge two rows the moment a half-typed name collided
   * with an existing one.
   */
  const renameType = (index: number, to: string) => setDoc((d) => {
    const from = d.objectTypes[index]?.name;
    if (from === undefined) return d;
    return {
      ...d,
      objectTypes: d.objectTypes.map((t, i) => (i === index ? { ...t, name: to } : t)),
      // Renaming is a rename, not a break: everything pointing at the old name
      // follows it, or the author would have to retype it on every place.
      nodes: d.nodes.map((n) => (isPlace(n) && n.objectType === from ? { ...n, objectType: to } : n)),
      arcs: d.arcs.map((a) => (a.objectType === from ? { ...a, objectType: to } : a)),
    };
  });

  const recolorType = (index: number, color: string) => setDoc((d) => ({
    ...d,
    objectTypes: d.objectTypes.map((t, i) => (i === index ? { ...t, color } : t)),
  }), false);

  const removeType = (index: number) => setDoc((d) => {
    const name = d.objectTypes[index]?.name;
    if (name === undefined) return d;
    return {
      ...d,
      objectTypes: d.objectTypes.filter((_, i) => i !== index),
      nodes: d.nodes.map((n) => (isPlace(n) && n.objectType === name ? { ...n, objectType: null } : n)),
      arcs: d.arcs.map((a) => (a.objectType === name ? { ...a, objectType: null } : a)),
    };
  });

  /* ---------------------------------------------------------------- *
   * PNML and publishing.
   * ---------------------------------------------------------------- */
  const importPnml = async (file: File) => {
    try {
      const { doc: next, notes: found } = fromPnml(await file.text());
      replaceDoc(next, true);
      setNotes(found);
      setSelected(null);
      setStatus({ kind: 'ok', text: `Imported ${next.nodes.length} nodes and ${next.arcs.length} arcs from ${file.name}.` });
    } catch (err: any) {
      setStatus({ kind: 'error', text: String(err?.message ?? err) });
    }
  };

  const exportPnml = () => {
    const blob = new Blob([toPnml(doc)], { type: 'application/xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(doc.name || 'net').replace(/[^A-Za-z0-9_.-]/g, '_')}.pnml`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const publish = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const type = targetType(doc);
      const result = await promenade.publishArtifact({
        type, name: doc.name || 'Untitled net', value: compile(doc),
        // An artifact is a node in the provenance DAG, not a file: editing one
        // publishes a *new* net whose input is the one it was edited from, and
        // the original is left exactly as it was.
        inputs: source ? [source.id] : undefined,
        // Counts, because the artifact tree builds a row's subtitle from a
        // provenance line and a handful of meta keys — and a net drawn from
        // nothing has no provenance to show. Without these the row is the one
        // artifact in the list with nothing under its name.
        meta: {
          authored: true,
          places: doc.nodes.filter(isPlace).length,
          transitions: doc.nodes.filter(isTransition).length,
          totalEdges: doc.arcs.length,
          objectTypes: doc.objectTypes.map((t) => t.name),
          ...(source ? { editedFrom: source.id } : {}),
        },
      });
      setStatus({
        kind: 'ok',
        text: source
          ? `Published “${result.name}” as a new ${type}. “${source.name}” is unchanged.`
          : `Published “${result.name}” as ${type}.`,
      });
    } catch (err: any) {
      setStatus({ kind: 'error', text: String(err?.message ?? err) });
    } finally {
      setBusy(false);
    }
  };

  /* ---------------------------------------------------------------- *
   * Inspector.
   * ---------------------------------------------------------------- */
  const node = doc.nodes.find((n) => n.id === selected);
  const arc = doc.arcs.find((a) => a.id === selected);
  const patchNode = (patch: Record<string, unknown>) => setDoc((d) => ({
    ...d,
    nodes: d.nodes.map((n) => (n.id === selected
      // Renaming a node gives up the id it arrived under: that id named the
      // old thing, and carrying it onto the new one would publish a rename as
      // if nothing had changed. See `publishedId` in model.ts.
      ? { ...n, ...patch, ...('name' in patch ? { publishedId: undefined } : {}) } as typeof n
      : n)),
  }));
  const patchArc = (patch: Partial<EdArc>) => setDoc((d) => ({
    ...d, arcs: d.arcs.map((a) => (a.id === selected ? { ...a, ...patch } : a)),
  }));

  const typed = doc.objectTypes.length > 0;

  return (
    <div className="ne">
      <div className="ne-bar">
        <input
          className="ne-name" value={doc.name} aria-label="Net name"
          onChange={(e) => setDoc((d) => ({ ...d, name: e.target.value }), false)}
        />
        <span className="ne-bar-spacer" />
        <input
          ref={fileRef} type="file" accept=".pnml,.xml,application/xml" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void importPnml(f); e.target.value = ''; }}
        />
        <button onClick={() => fileRef.current?.click()}>Import PNML…</button>
        <button onClick={exportPnml} disabled={doc.nodes.length === 0}>Export PNML</button>
        <button
          className="primary" onClick={publish}
          disabled={busy || problems.length > 0}
          title={problems.length
            ? 'Fix the problems below first'
            : source
              // Said on the control rather than after the fact: someone who
              // opened an existing net will expect a save to overwrite it, and
              // it never does.
              ? `Publish a new ${targetType(doc)}; “${source.name}” stays as it is`
              : `Publish as ${targetType(doc)}`}
        >
          {busy ? 'Publishing…' : `Publish ${source ? 'as a new ' : 'as '}${typed ? 'OCPN' : 'Petri net'}`}
        </button>
      </div>

      <div className="ne-body">
        <div className="ne-side">
          <div>
            <h4>Add</h4>
            <div className="ne-add">
              <button onClick={() => addNode('place')}>Place</button>
              <button onClick={() => addNode('transition')}>Transition</button>
            </div>
            <p className="ne-hint">Drag from a node's right edge to another to draw an arc. Backspace deletes what is selected.</p>
          </div>

          <div>
            <h4>Object types</h4>
            <div className="ne-types">
              {doc.objectTypes.map((t, i) => (
                <div className="ne-type" key={i}>
                  <input
                    className="ne-swatch" type="color" value={t.color} aria-label={`${t.name} colour`}
                    onChange={(e) => recolorType(i, e.target.value)}
                  />
                  <input type="text" value={t.name} aria-label="Object type name"
                         onChange={(e) => renameType(i, e.target.value)} />
                  <button className="x" title="Remove" onClick={() => removeType(i)}>×</button>
                </div>
              ))}
            </div>
            <div className="ne-add" style={{ marginTop: 6 }}>
              <button onClick={addType}>Add object type</button>
            </div>
            <p className="ne-hint">
              {typed
                ? 'Typed: this publishes as an Object-Centric Petri Net.'
                : 'None declared, so this publishes as a plain Petri net. Add one to make it object-centric.'}
            </p>
          </div>
        </div>

        <div
          className="ne-canvas"
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void importPnml(f);
          }}
        >
          {dragging && <div className="ne-drop">Drop a .pnml file to open it</div>}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelected(n.id)}
            onEdgeClick={(_, e) => setSelected(e.id)}
            onPaneClick={() => setSelected(null)}
            onInit={(instance) => { flow.current = instance; }}
            fitView
            // An imported net is laid out in the coordinates its author chose,
            // which can span far more than a panel: React Flow's default floor
            // of 0.5 would clamp the fit and leave part of the net outside the
            // viewport with no way to zoom out to it.
            minZoom={0.05}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>

        <div className="ne-inspector">
          <h4>{node ? (isPlace(node) ? 'Place' : 'Transition') : arc ? 'Arc' : 'Nothing selected'}</h4>

          {node && isPlace(node) && (
            <>
              <label className="ne-field">
                <span>Name</span>
                <input type="text" value={node.name} onChange={(e) => patchNode({ name: e.target.value })} />
              </label>
              <label className="ne-field">
                <span>Object type</span>
                <select
                  value={node.objectType ?? ''}
                  onChange={(e) => {
                    const value = e.target.value || null;
                    // Retyping a place retypes the arcs that touch it, since
                    // they are required to agree and the author meant the
                    // place, not a contradiction.
                    setDoc((d) => ({
                      ...d,
                      nodes: d.nodes.map((n) => (n.id === node.id ? { ...n, objectType: value } : n)),
                      arcs: d.arcs.map((a) => (a.source === node.id || a.target === node.id ? { ...a, objectType: value } : a)),
                    }));
                  }}
                  disabled={!typed}
                >
                  <option value="">{typed ? '— none —' : 'no object types declared'}</option>
                  {doc.objectTypes.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                </select>
              </label>
              <label className="ne-field">
                <span>Marking</span>
                <select value={node.marking} onChange={(e) => patchNode({ marking: e.target.value as PlaceMarking })}>
                  <option value="none">none</option>
                  <option value="initial">initial {typed ? '(source)' : ''}</option>
                  <option value="final">final {typed ? '(sink)' : ''}</option>
                </select>
              </label>
            </>
          )}

          {node && isTransition(node) && (
            <>
              <label className="ne-field">
                <span>Activity</span>
                <input
                  type="text" value={node.name} disabled={node.silent}
                  onChange={(e) => patchNode({ name: e.target.value })}
                />
              </label>
              <label className="ne-check">
                <input type="checkbox" checked={node.silent} onChange={(e) => patchNode({ silent: e.target.checked })} />
                Silent (τ)
              </label>
              {typed && node.silent && (
                <p className="ne-hint">A silent transition must touch exactly one object type.</p>
              )}
            </>
          )}

          {arc && (
            <>
              <label className="ne-field">
                <span>Object type</span>
                <select
                  value={arc.objectType ?? ''} disabled={!typed}
                  onChange={(e) => patchArc({ objectType: e.target.value || null })}
                >
                  <option value="">{typed ? '— none —' : 'no object types declared'}</option>
                  {doc.objectTypes.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                </select>
              </label>
              <label className="ne-check">
                <input
                  type="checkbox" checked={arc.variable} disabled={!typed}
                  onChange={(e) => patchArc({ variable: e.target.checked })}
                />
                Variable arc
              </label>
              <p className="ne-hint">A variable arc moves more than one token of its type in a single firing.</p>
            </>
          )}

          {!node && !arc && <p className="ne-hint">Click a place, transition or arc to edit it.</p>}
        </div>
      </div>

      <div className="ne-problems">
        {status && <div className={status.kind === 'ok' ? 'ne-ok' : 'ne-error'}>{status.text}</div>}
        {notes.map((n) => <div className="ne-problem" key={n}>Import: {n}</div>)}
        {problems.map((p, i) => (
          <div
            className="ne-problem" key={i}
            onClick={() => p.id && setSelected(p.id)}
            style={p.id ? { cursor: 'pointer' } : undefined}
          >
            {p.message}
          </div>
        ))}
        {!status && problems.length === 0 && doc.nodes.length > 0 && (
          <div className="ne-ok">Ready to publish as {targetType(doc)}.</div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
