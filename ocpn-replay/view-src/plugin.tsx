import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow, ReactFlowProvider, Background, MarkerType, Panel,
  useReactFlow, useStore, type Node, type Edge,
} from '@xyflow/react';
// @ts-ignore -- esbuild text loader, not a CSS module
import reactFlowCss from '@xyflow/react/dist/style.css';

import type { OcpnPayload } from './types';
import type { ReplayEvidence, TraceFrame } from './evidence';
import { TokenSim } from './evidence';
import { PlaceNode, type PlaceNodeData } from './PlaceNode';
import { TransitionNode, type TransitionNodeData, type FireState } from './TransitionNode';
import { OcpnEdge, type OcpnEdgeData } from './OcpnEdge';
import {
  buildElkGraph, layoutOcpn, pathFromSections, TRANS_W, TRANS_H, type ElkResult,
} from './layout';
import { SupportTimeline, MoveBreakdown, InteractionHeatmap } from './charts';

const styleTag = document.createElement('style');
styleTag.textContent = reactFlowCss;
document.head.appendChild(styleTag);

const nodeTypes = { place: PlaceNode, transition: TransitionNode };
const edgeTypes = { ocpn: OcpnEdge };

/** elkjs runs on this frame's only thread (CSP blocks Workers); past a few
 * thousand edges its layered placement takes tens of seconds. */
const LAYOUT_EDGE_LIMIT = 1500;

const SPEEDS = [0.5, 1, 2, 4, 8];
/** ms between frames at speed 1 */
const BASE_INTERVAL = 550;

interface EvidenceState {
  evidence: ReplayEvidence | null;
  net: OcpnPayload | null;
  frames: TraceFrame[];
  truncated: boolean;
  totalEvents: number | null;
}

function readInitial(): EvidenceState {
  const raw = promenade.artifact().value as any;
  const evidence: ReplayEvidence | null = raw && raw.schemaVersion ? (raw as ReplayEvidence) : null;
  // Finished artifact carries `net`; a live run's seed carries the OCPN model
  // input under `inputs.model` so the view can lay the net out before frame 1.
  const net: OcpnPayload | null = evidence?.net ?? raw?.net ?? raw?.inputs?.model ?? null;
  return {
    evidence,
    net,
    frames: evidence?.trace?.frames ?? [],
    truncated: !!evidence?.trace?.truncated,
    totalEvents: evidence?.events?.length ?? null,
  };
}

function App() {
  const [theme, setTheme] = useState<Record<string, string>>(promenade.theme());
  const [state, setState] = useState<EvidenceState>(readInitial);
  const [runState, setRunState] = useState(promenade.artifact().runState ?? (state.evidence ? 'done' : 'running'));
  const [elk, setElk] = useState<ElkResult | null>(null);
  const [layoutFailed, setLayoutFailed] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState<{ nodes: number; edges: number } | null>(null);

  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedIx, setSpeedIx] = useState(1);
  const [following, setFollowing] = useState(true);
  const [railOpen, setRailOpen] = useState(true);

  useEffect(() => {
    promenade.on('theme', (p) => setTheme(p.theme));
    promenade.on('resize', () => { /* React Flow observes its own container */ });
    promenade.on('liveFrame', (p) => {
      const incoming = (p.frames as TraceFrame[]) ?? [];
      if (!incoming.length) return;
      setState((s) => ({ ...s, frames: [...s.frames, ...incoming] }));
    });
    promenade.on('liveRunState', (p) => setRunState(p.state));
    promenade.ready();
  }, []);

  const live = runState === 'running';

  // ---- net layout -------------------------------------------------------
  const net = state.net;
  useEffect(() => {
    if (!net) return;
    let cancelled = false;
    const visibleTypes = new Set(net.objectTypes);
    const graph = buildElkGraph(net, visibleTypes, true);
    if (graph.edges.length > LAYOUT_EDGE_LIMIT) {
      setTooLarge({ nodes: graph.children.length, edges: graph.edges.length });
      return;
    }
    setTooLarge(null);
    layoutOcpn(graph)
      .then((r) => { if (!cancelled) { setElk(r); setLayoutFailed(null); } })
      .catch((err) => { if (!cancelled) setLayoutFailed(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [net]);

  // ---- token simulator -------------------------------------------------
  const sim = useMemo(() => (net ? new TokenSim(net, state.frames) : null), [net]);
  useEffect(() => { sim?.setFrames(state.frames); }, [sim, state.frames]);

  const frameCount = state.frames.length;

  // Follow the tail while a live run streams in.
  useEffect(() => {
    if (live && following) setCursor(frameCount);
  }, [live, following, frameCount]);

  // Playback clock.
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setCursor((c) => {
        if (c >= frameCount) {
          if (!live) { setPlaying(false); return c; }
          return c;
        }
        return c + 1;
      });
    }, BASE_INTERVAL / SPEEDS[speedIx]);
    return () => window.clearInterval(id);
  }, [playing, speedIx, frameCount, live]);

  const view = useMemo(() => {
    if (!sim) return null;
    sim.seekTo(cursor);
    return {
      tokens: sim.placeTokens(),
      effect: sim.effect,
      frame: sim.currentFrame(),
    };
  }, [sim, cursor, frameCount]);

  // ---- React Flow nodes / edges --------------------------------------
  const placeIx = useMemo(() => new Map((net?.places ?? []).map((p) => [p.id, p])), [net]);
  const transitionIx = useMemo(() => new Map((net?.transitions ?? []).map((t) => [t.id, t])), [net]);

  const nodes: Node[] = useMemo(() => {
    if (!elk?.children || !net) return [];
    const tokens = view?.tokens;
    const eff = view?.effect;
    return elk.children.map((c) => {
      const place = placeIx.get(c.id);
      if (place) {
        const pt = tokens?.get(c.id);
        const data: PlaceNodeData = {
          kind: place.kind, objectType: place.objectType,
          color: promenade.color('objectType', place.objectType), theme,
          tokens: pt?.count ?? 0, objects: pt?.objects ?? 0,
        };
        return { id: c.id, type: 'place', position: { x: c.x, y: c.y }, data, width: c.width, height: c.height } satisfies Node;
      }
      const t = transitionIx.get(c.id)!;
      let fireState: FireState = 'idle';
      if (eff?.firedTransitions.has(c.id)) fireState = 'fire';
      else if (eff?.silentTransitions.has(c.id)) fireState = 'silent';
      else if (eff?.logMoveTransitions.has(c.id)) fireState = 'logmove';
      const data: TransitionNodeData = { activity: t.activity, fireState, theme };
      return { id: c.id, type: 'transition', position: { x: c.x, y: c.y }, data,
        width: t.activity == null ? 24 : TRANS_W, height: TRANS_H } satisfies Node;
    });
  }, [elk, net, placeIx, transitionIx, theme, view]);

  const edges: Edge[] = useMemo(() => {
    if (!elk?.edges || !net) return [];
    const byId = new Map(net.arcs.map((a) => [a.id, a]));
    return elk.edges.flatMap((e) => {
      const arc = byId.get(e.id);
      if (!arc || !e.sections?.length) return [];
      const color = promenade.color('objectType', arc.objectType);
      const data: OcpnEdgeData = { path: pathFromSections(e.sections), color, variable: arc.variable };
      return [{
        id: e.id, source: arc.source.id, target: arc.target.id, type: 'ocpn', data,
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      } satisfies Edge];
    });
  }, [elk, net]);

  const { fitView, zoomIn, zoomOut, setViewport } = useReactFlow();
  const paneW = useStore((s) => s.width);
  const paneH = useStore((s) => s.height);
  const firstFit = useRef(true);

  // An OCPN over a short process is a long, ~1-2 track ribbon. `fitView` would
  // shrink it to fit width at an unreadable zoom, so instead pick a zoom that
  // fills ~78% of the pane height (clamped), then centre — the user pans
  // left→right to follow the token game. A tall/blocky net just fits normally.
  const frameNet = useCallback((animate: boolean) => {
    if (!elk?.children?.length || !paneW || !paneH) return;
    const maxX = Math.max(...elk.children.map((c) => c.x + c.width));
    const maxY = Math.max(...elk.children.map((c) => c.y + c.height));
    const wide = maxX / Math.max(1, maxY) > 2.4;
    if (!wide) {
      fitView({ padding: 0.14, maxZoom: 1.6, duration: animate ? 250 : 0 });
      return;
    }
    // Still a ribbon after wrapping: pick a zoom that keeps rows readable and
    // left-align so the animation's opening moves are on screen from frame 0.
    const zoom = Math.max(0.4, Math.min(1.4, (paneH * 0.82) / maxY));
    setViewport(
      { x: paneW * 0.06, y: paneH / 2 - (maxY / 2) * zoom, zoom },
      { duration: animate ? 250 : 0 },
    );
  }, [elk, paneW, paneH, fitView, setViewport]);

  useEffect(() => {
    if (!elk?.children?.length) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => frameNet(!firstFit.current)); });
    const t = window.setTimeout(() => { frameNet(!firstFit.current); firstFit.current = false; }, 140);
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); window.clearTimeout(t); };
  }, [elk, frameNet]);

  // ---- transport handlers ------------------------------------------
  const seek = useCallback((n: number) => {
    setPlaying(false);
    setFollowing(false);
    setCursor(Math.max(0, Math.min(frameCount, n)));
  }, [frameCount]);

  const togglePlay = useCallback(() => {
    setPlaying((p) => {
      const next = !p;
      if (next && cursor >= frameCount && !live) setCursor(0);
      if (next) setFollowing(true);
      return next;
    });
  }, [cursor, frameCount, live]);

  // ---- render ------------------------------------------------------
  if (!net) {
    return <Splash theme={theme} title={live ? 'Waiting for the replay to start…' : 'This evidence has no net'} />;
  }
  if (tooLarge) {
    return <Splash theme={theme} title="This net is too large to lay out here"
      body={`${tooLarge.nodes.toLocaleString()} nodes / ${tooLarge.edges.toLocaleString()} arcs exceed the ${LAYOUT_EDGE_LIMIT.toLocaleString()}-arc single-thread ceiling.`} />;
  }
  if (layoutFailed) return <Splash theme={theme} title="Layout failed" body={layoutFailed} />;

  const curFrame = view?.frame ?? null;
  const cursorFrac = frameCount ? cursor / frameCount : null;

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', background: theme.bg, color: theme.text }}>
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          nodeOrigin={[0, 0]} nodesDraggable={false} nodesConnectable={false}
          elementsSelectable={false} panOnDrag panOnScroll={false}
          zoomOnScroll zoomOnPinch zoomOnDoubleClick={false}
          minZoom={0.02} maxZoom={4} onlyRenderVisibleElements
          proOptions={{ hideAttribution: true }}
        >
          <Background color={theme.border} gap={20} />
          <Panel position="top-left">
            <StatusPill live={live} runState={runState} truncated={state.truncated}
              frameCount={frameCount} totalEvents={state.totalEvents} theme={theme} />
          </Panel>
          <Panel position="top-right" style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => frameNet(true)} style={pillButton(theme)} title="Fit net to view">Fit</button>
            <button onClick={() => zoomIn({ duration: 150 })} style={pillButton(theme)} title="Zoom in">+</button>
            <button onClick={() => zoomOut({ duration: 150 })} style={pillButton(theme)} title="Zoom out">−</button>
            {state.evidence && (
              <button onClick={() => setRailOpen((o) => !o)} style={pillButton(theme)}>
                {railOpen ? 'Hide charts ›' : '‹ Charts'}
              </button>
            )}
          </Panel>
        </ReactFlow>

        <Transport
          theme={theme} playing={playing} onTogglePlay={togglePlay}
          cursor={cursor} frameCount={frameCount} onSeek={seek}
          speed={SPEEDS[speedIx]} onCycleSpeed={() => setSpeedIx((i) => (i + 1) % SPEEDS.length)}
          following={following} onFollow={() => { setFollowing(true); setCursor(frameCount); }}
          live={live} frame={curFrame}
        />
      </div>

      {state.evidence && railOpen && (
        <aside style={{
          width: 260, flex: '0 0 260px', borderLeft: `1px solid ${theme.border}`,
          padding: 12, overflowY: 'auto', background: theme['bg-soft'], display: 'grid', gap: 16, alignContent: 'start',
        }}>
          <SupportTimeline events={state.evidence.events} theme={theme} cursorFrac={cursorFrac} />
          <MoveBreakdown events={state.evidence.events} theme={theme} />
          {!!state.evidence.expectedFields?.length && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 2 }}>Expected interaction fields</div>
              <div style={{ fontSize: 10, color: theme['text-dim'], marginBottom: 4 }}>
                replayed-event mass by lifecycle phase
              </div>
              {state.evidence.expectedFields.map((f) => (
                <InteractionHeatmap key={`${f.pair.a}~${f.pair.b}`} field={f} theme={theme} />
              ))}
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

function Transport({
  theme, playing, onTogglePlay, cursor, frameCount, onSeek, speed, onCycleSpeed,
  following, onFollow, live, frame,
}: {
  theme: Record<string, string>;
  playing: boolean; onTogglePlay: () => void;
  cursor: number; frameCount: number; onSeek: (n: number) => void;
  speed: number; onCycleSpeed: () => void;
  following: boolean; onFollow: () => void;
  live: boolean; frame: { e: string; a: string; t: number } | null;
}) {
  const disabled = frameCount === 0;
  return (
    <div style={{
      position: 'absolute', left: 12, right: 12, bottom: 12,
      background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 10,
      boxShadow: '0 4px 16px rgba(0,0,0,.12)', padding: '8px 12px',
      display: 'grid', gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={onTogglePlay} disabled={disabled} style={pillButton(theme, true)} title={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button onClick={() => onSeek(cursor - 1)} disabled={disabled} style={pillButton(theme)} title="Step back">‹</button>
        <button onClick={() => onSeek(cursor + 1)} disabled={disabled} style={pillButton(theme)} title="Step forward">›</button>
        <button onClick={onCycleSpeed} style={pillButton(theme)} title="Playback speed">{speed}×</button>
        <input
          type="range" min={0} max={Math.max(1, frameCount)} value={cursor} disabled={disabled}
          onChange={(e) => onSeek(Number(e.target.value))}
          style={{ flex: 1, accentColor: theme.accent }}
        />
        <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 11, color: theme['text-dim'], minWidth: 92, textAlign: 'right' }}>
          {cursor.toLocaleString()} / {frameCount.toLocaleString()}
        </span>
        {live && !following && (
          <button onClick={onFollow} style={pillButton(theme)} title="Jump to the live edge">⇥ live</button>
        )}
      </div>
      <div style={{ fontSize: 11, color: theme['text-dim'], minHeight: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {frame
          ? <>event <b style={{ color: theme.text }}>{frame.e}</b> · {frame.a} · {new Date(frame.t).toISOString().replace('T', ' ').replace('.000Z', '')}</>
          : disabled ? 'no animation trace in this evidence' : 'at the initial marking'}
      </div>
    </div>
  );
}

function StatusPill({ live, runState, truncated, frameCount, totalEvents, theme }: {
  live: boolean; runState: string; truncated: boolean;
  frameCount: number; totalEvents: number | null; theme: Record<string, string>;
}) {
  const label = live ? 'replaying…' : runState === 'error' ? 'run failed' : 'replay complete';
  const dot = live ? theme.warn : runState === 'error' ? theme.danger : theme.ok;
  return (
    <div style={{
      background: theme['bg-soft'], border: `1px solid ${theme.border}`, borderRadius: 8,
      padding: '6px 10px', fontSize: 11, color: theme.text, boxShadow: '0 2px 8px rgba(0,0,0,.08)', maxWidth: 240,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot }} />
        {label}
      </div>
      {truncated && totalEvents != null && (
        <div style={{ color: theme['text-dim'], marginTop: 3 }}>
          animation covers the first {frameCount.toLocaleString()} of {totalEvents.toLocaleString()} events
        </div>
      )}
    </div>
  );
}

function Splash({ theme, title, body }: { theme: Record<string, string>; title: string; body?: string }) {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: theme.bg, padding: 32 }}>
      <div style={{ maxWidth: 420, textAlign: 'center', color: theme.text }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>
        {body && <div style={{ fontSize: 12, color: theme['text-dim'], lineHeight: 1.5 }}>{body}</div>}
      </div>
    </div>
  );
}

function pillButton(theme: Record<string, string>, primary = false): CSSProperties {
  return {
    border: `1px solid ${theme.border}`, borderRadius: 6, cursor: 'pointer',
    background: primary ? theme.accent : theme.bg,
    color: primary ? theme.bg : theme.text,
    fontSize: 11, padding: '3px 8px', lineHeight: 1.4,
  };
}

createRoot(document.getElementById('root')!).render(
  <ReactFlowProvider>
    <App />
  </ReactFlowProvider>,
);
