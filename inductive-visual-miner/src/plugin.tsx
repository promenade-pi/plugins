import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Background, ControlButton, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider,
  useReactFlow, type Edge, type EdgeProps, type Node,
} from '@xyflow/react';
// @ts-ignore esbuild inlines the package stylesheet into the sandbox bundle.
import flowCss from '@xyflow/react/dist/style.css';
import type { Arc, Point, ReplayEvent, ReplayPayload } from './types';
import { PLACE_D, TAU_H, TAU_W, TRANS_H, TRANS_W, buildGraph, labelOf, layout, pathAndSamples, pointAt } from './layout';
import { ExportMenu } from './lib/ExportMenu';

const sheet = document.createElement('style');
sheet.textContent = flowCss + `
  .ivm{height:100%;width:100%;position:relative;font:13px/1.35 Inter,ui-sans-serif,system-ui,sans-serif;overflow:hidden}
  .ivm .react-flow__controls{bottom:72px;box-shadow:0 2px 9px #172b4d18;border:1px solid var(--ivm-line);overflow:hidden}
  .ivm .react-flow__controls-button{background:var(--ivm-paper);border-bottom-color:var(--ivm-line);color:var(--ivm-text)}
  .ivm .react-flow__minimap{bottom:72px;border:1px solid var(--ivm-line);border-radius:7px;overflow:hidden;box-shadow:0 2px 10px #172b4d18}
  .ivm-panel{position:absolute;z-index:8;left:14px;top:14px;width:210px;background:color-mix(in srgb,var(--ivm-paper) 92%,transparent);border:1px solid var(--ivm-line);box-shadow:0 8px 24px #172b4d18;border-radius:10px;backdrop-filter:blur(8px);overflow:hidden;color:var(--ivm-text)}
  .ivm-panel h2{font-size:13px;margin:0;font-weight:700}.ivm-panel h2 button{width:100%;display:flex;align-items:center;justify-content:space-between;border:0;background:transparent;color:inherit;font:inherit;padding:11px 13px;cursor:pointer}.ivm-panel .section{padding:8px 13px;border-top:1px solid var(--ivm-line)}
  .ivm-panel label{display:flex;align-items:center;gap:7px;margin:5px 0;cursor:pointer}.ivm-panel input[type=radio]{accent-color:#2f70f5}.ivm-panel select{width:100%;border:1px solid var(--ivm-line);border-radius:6px;padding:6px;background:var(--ivm-paper);color:var(--ivm-text)}
  .ivm-help{font-size:11px;color:var(--ivm-dim);line-height:1.4}.ivm-button{cursor:pointer;border:1px solid var(--ivm-line);border-radius:6px;background:var(--ivm-paper);color:var(--ivm-text);font:inherit;padding:6px 8px}.ivm-button:hover{border-color:#2f70f5;color:#1751c7}
  .ivm-footer{position:absolute;z-index:8;left:14px;right:18px;bottom:14px;height:43px;display:flex;align-items:center;gap:11px;padding:0 12px;border:1px solid var(--ivm-line);border-radius:9px;background:color-mix(in srgb,var(--ivm-paper) 94%,transparent);box-shadow:0 4px 15px #172b4d14;color:var(--ivm-text);backdrop-filter:blur(8px)}
  .ivm-footer input[type=range]{flex:1;accent-color:#2f70f5}.ivm-time{font-variant-numeric:tabular-nums;min-width:92px;color:var(--ivm-dim);white-space:nowrap}.ivm-source-time{min-width:178px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ivm-dim);font-variant-numeric:tabular-nums}.ivm-speed{position:relative}.ivm-speed-menu{position:absolute;right:0;bottom:36px;min-width:86px;padding:4px;background:var(--ivm-paper);border:1px solid var(--ivm-line);border-radius:7px;box-shadow:0 5px 18px #172b4d24}.ivm-speed-menu button{display:block;width:100%;text-align:left;border:0;border-radius:4px;padding:5px 8px}.ivm-speed-menu button:hover,.ivm-speed-menu button.active{background:#2f70f518;color:#1751c7}.ivm-footer .ivm-button{min-width:36px;font-size:15px;padding:5px}
  .ivm-place{display:grid;place-items:center;width:100%;height:100%;border-radius:50%;box-sizing:border-box;background:var(--ivm-paper);border:2px solid var(--ivm-accent);position:relative}.ivm-place.initial::before{content:'';height:8px;width:8px;border-radius:50%;background:var(--ivm-accent);box-shadow:0 0 0 2px var(--ivm-paper)}.ivm-place.final::after{content:'';position:absolute;inset:4px;border:1.5px solid var(--ivm-accent);border-radius:50%}
  .ivm-transition{height:100%;width:100%;display:grid;place-items:center;box-sizing:border-box;border:1.5px solid var(--ivm-line);border-radius:7px;background:var(--ivm-paper);color:var(--ivm-text);font-weight:650;text-align:center;padding:4px 8px;box-shadow:0 1px 2px #172b4d0d}.ivm-transition.selected{border-color:#2f70f5;box-shadow:0 0 0 2px #2f70f526}.ivm-tau{height:100%;width:100%;box-sizing:border-box;border-radius:2px;background:var(--ivm-dim);border:1px solid var(--ivm-paper)}
  .ivm-stats{position:absolute;right:14px;top:14px;z-index:8;max-width:300px;background:color-mix(in srgb,var(--ivm-paper) 92%,transparent);border:1px solid var(--ivm-line);border-radius:9px;padding:9px 11px;color:var(--ivm-text);box-shadow:0 5px 17px #172b4d12;backdrop-filter:blur(8px)}.ivm-stats strong{font-size:12px}.ivm-stats span{color:var(--ivm-dim);font-size:11px}.ivm-warning{color:#bd6510!important}
`;
document.head.appendChild(sheet);

type Theme = Record<string, string>;
type AnimatedEdgeData = { path: string; color: string };
type NodeData = { kind: 'place' | 'transition' | 'tau'; label?: string | null; initial?: boolean; final?: boolean; selected?: boolean; theme: Theme };
type SampledEdge = Arc & { path: string; samples: Point[] };
type Scheduled = ReplayEvent & { at: number; incoming: string[]; outgoing: string[] };
type Mode = 'individual' | 'hybrid' | 'flow';
/**
 * The window a token dwells at a place between the firing that produced it
 * and the firing that next consumes it, both plain (non-wrapped) positions
 * in the same `at` domain as `Scheduled.at` and always `end >= start` by
 * construction. Used only to count how many tokens currently sit at a place
 * — not itself an arc animation.
 */
type RestSegment = { placeId: string; start: number; end: number };

function NetEdge({ data, markerEnd }: EdgeProps<Edge<AnimatedEdgeData>>) {
  // Keep the permanent SVG path explicit. BaseEdge is normally enough, but
  // sandbox CSS can suppress its generated edge path; then only the Canvas
  // glow remains visible, which makes the model look broken while idle.
  return <path d={data!.path} fill="none" stroke={data!.color} strokeWidth={1.65} strokeOpacity={.88} strokeLinecap="round" markerEnd={markerEnd} />;
}

function NetNode({ data }: { data: NodeData }) {
  if (data.kind === 'place') return <div className={`ivm-place ${data.initial ? 'initial' : ''} ${data.final ? 'final' : ''}`} style={{ '--ivm-accent': data.theme['accent'] ?? '#4478d8', '--ivm-paper': data.theme.bg } as any} />;
  if (data.kind === 'tau') return <div className="ivm-tau" />;
  return <div className={`ivm-transition ${data.selected ? 'selected' : ''}`}>{data.label}</div>;
}

const nodeTypes = { net: NetNode };
const edgeTypes = { net: NetEdge };
const PALETTE = ['#2476e8', '#00a8c8', '#7856d9', '#c450b5', '#ee7e32', '#1a9a77'];
const PARTICLE_CAP = 220;

function hash(text: string) { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return h >>> 0; }
function colorOf(event: ReplayEvent) { return event.deviation ? '#d66b3a' : PALETTE[hash(event.caseId) % PALETTE.length]; }
function circularAge(now: number, start: number, span: number) { return (now - start + span) % span; }
function format(ms: number) { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function dateTime(ms: number) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(ms)); }

/** Inline artifacts from older sessions can still carry one or more host
 * result envelopes. Views consume the model itself, not that envelope. */
function unwrap(value: unknown): any {
  let current: any = value;
  for (let depth = 0; depth < 4 && current && typeof current === 'object' && 'result' in current; depth++) current = current.result;
  return current;
}

function normaliseReplay(value: unknown): ReplayPayload {
  const replay = unwrap(value) ?? {};
  const model = unwrap(replay.model) ?? {};
  return {
    ...replay,
    model: {
      ...model,
      places: Array.isArray(model.places) ? model.places : [],
      activities: Array.isArray(model.activities) ? model.activities : [],
      // The typed Rust DTO follows the browser-facing camelCase convention;
      // the renderer's shared Petri-net type predates it and uses snake_case.
      place_to_transition: Array.isArray(model.place_to_transition) ? model.place_to_transition : (model.placeToTransition ?? []),
      transition_to_place: Array.isArray(model.transition_to_place) ? model.transition_to_place : (model.transitionToPlace ?? []),
      initial_marking: Array.isArray(model.initial_marking) ? model.initial_marking : (model.initialMarking ?? []),
      final_marking: Array.isArray(model.final_marking) ? model.final_marking : (model.finalMarking ?? []),
    },
    events: Array.isArray(replay.events) ? replay.events : [],
    timeline: replay.timeline ?? { start: 0, end: 1, sourceSpanMs: 1, durationMs: 45000 },
    stats: replay.stats ?? { cases: 0, events: 0, alignedEvents: 0, deviations: 0, meanFitness: 0 },
  };
}

/** Canvas overlay is intentionally the sole high-frequency renderer. React Flow
 * owns model semantics and pan/zoom; this loop never schedules React state. */
function FlowCanvas({ edges, nodes, scheduled, rest, showTokenCounts, durationRef, playheadRef, runningRef, speedRef, modeRef, theme }: {
  edges: Map<string, SampledEdge>; nodes: Map<string, Node>; scheduled: Scheduled[]; rest: RestSegment[]; showTokenCounts: boolean; durationRef: React.MutableRefObject<number>;
  playheadRef: React.MutableRefObject<number>; runningRef: React.MutableRefObject<boolean>; speedRef: React.MutableRefObject<number>; modeRef: React.MutableRefObject<Mode>; theme: Theme;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { getViewport } = useReactFlow();
  useEffect(() => {
    const canvas = canvasRef.current!;
    const host = canvas.parentElement!;
    const resize = () => { const r = host.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1); canvas.width = Math.max(1, Math.round(r.width * dpr)); canvas.height = Math.max(1, Math.round(r.height * dpr)); canvas.style.width = `${r.width}px`; canvas.style.height = `${r.height}px`; };
    const observer = new ResizeObserver(resize); observer.observe(host); resize();
    let raf = 0, last = performance.now();
    function draw(now: number) {
      const dpr = Math.min(2, devicePixelRatio || 1), ctx = canvas.getContext('2d')!;
      const w = canvas.width / dpr, h = canvas.height / dpr;
      if (runningRef.current) playheadRef.current = (playheadRef.current + (now - last) * speedRef.current) % durationRef.current;
      last = now;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      const viewport = getViewport(), duration = durationRef.current, nowMs = playheadRef.current;
      const active = new Map<string, number>(); const particles: Array<{ edge: SampledEdge; progress: number; color: string; enter?: boolean }> = [];
      const pulses: Array<{ node: Node; strength: number; color: string }> = [];
      // Deterministic visual sampling: every replay event remains counted
      // (the traffic-glow `active` map below sees all of them), but only a
      // bounded representative subset gets an individual particle. That
      // subset is chosen by a hash of the event itself, not `index % N` —
      // real alignments fire a fixed number of moves per case (here: every
      // case is sync, sync, silent, sync — always 4), so a positional stride
      // that happens to divide evenly into that count (e.g. 8 into 4)
      // deterministically always lands on the same relative step and never
      // the others. That silently starved whichever step touched the sink,
      // reading as "no tokens" even though every event was still scheduled
      // and counted — a hash is uncorrelated with position-within-case, so
      // it can't resonate with any particular alignment shape.
      const drawEvery = Math.max(1, Math.ceil(scheduled.length / PARTICLE_CAP));
      for (let index = 0; index < scheduled.length; index++) {
        const event = scheduled[index], age = circularAge(nowMs, event.at - 430, duration);
        const representative = modeRef.current === 'individual' || hash(`${event.caseId}:${event.sequence}`) % drawEvery === 0;
        const collect = (ids: string[], progress: number, entering = false) => ids.forEach((id, branch) => {
          active.set(id, (active.get(id) ?? 0) + 1);
          const edge = edges.get(id);
          if (edge && representative && modeRef.current !== 'flow' && particles.length < PARTICLE_CAP) particles.push({ edge, progress: Math.max(0, Math.min(1, progress - branch * .035)), color: colorOf(event), enter: entering });
        });
        if (age <= 350) collect(event.incoming, age / 350, true);
        else if (age <= 560) { const node = nodes.get(`t${event.transitionId}`); if (node) pulses.push({ node, strength: 1 - Math.abs(age - 455) / 105, color: colorOf(event) }); }
        else if (age <= 970) collect(event.outgoing, (age - 560) / 410);
      }
      const screen = (p: Point) => ({ x: viewport.x + p.x * viewport.zoom, y: viewport.y + p.y * viewport.zoom });
      // Every stroke/radius below is multiplied by `viewport.zoom` so the
      // overlay matches React Flow's own DOM layer, which scales nodes and
      // edges through the same viewport transform automatically — without
      // this the canvas layer would stay a fixed pixel size while zooming.
      const z = viewport.zoom;
      // React Flow's SVG edge layer is not consistently painted inside the
      // opaque plugin iframe (the animated Canvas routes below prove that ELK
      // did produce the geometry). Draw the quiet, permanent graph here too:
      // this canvas already owns the high-frequency overlay and receives the
      // exact same spline samples, so static edges cannot disappear while the
      // replay is idle.
      ctx.save();
      ctx.strokeStyle = theme['text-dim'] ?? '#6f7889';
      ctx.globalAlpha = .82;
      ctx.lineWidth = 1.55 * z;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const edge of edges.values()) {
        if (edge.samples.length < 2) continue;
        ctx.beginPath();
        edge.samples.forEach((point, index) => {
          const p = screen(point);
          index ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
        });
        ctx.stroke();
        const end = screen(edge.samples[edge.samples.length - 1]);
        const before = screen(edge.samples[edge.samples.length - 2]);
        const angle = Math.atan2(end.y - before.y, end.x - before.x);
        ctx.save(); ctx.translate(end.x, end.y); ctx.rotate(angle); ctx.scale(z, z);
        ctx.fillStyle = theme['text-dim'] ?? '#6f7889';
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-8, -3.7); ctx.lineTo(-8, 3.7); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      ctx.restore();
      // A restrained wide under-stroke marks traffic; width uses log load so a
      // busy edge never turns into an unreadable ribbon.
      for (const [id, count] of active) {
        const edge = edges.get(id); if (!edge?.samples.length) continue;
        const normalized = Math.min(1, Math.log1p(count) / Math.log(7));
        ctx.save(); ctx.strokeStyle = `${theme['accent'] ?? '#2f70f5'}${Math.round(18 + normalized * 34).toString(16).padStart(2, '0')}`; ctx.lineWidth = (3 + normalized * 3) * z; ctx.lineCap = 'round';
        ctx.beginPath(); edge.samples.forEach((p, i) => { const q = screen(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.stroke(); ctx.restore();
      }
      // Optional, off by default: a plain number above each place showing
      // how many tokens are currently resting there. A dot (an earlier
      // version) is indistinguishable from the ".initial" marker every place
      // already carries, making every place momentarily read as a start
      // place; a filled badge circle (the version after that) just looked
      // heavy sitting on top of a place. A count is exact either way — it
      // is not limited to the representative-sampled subset the moving
      // particles use.
      if (showTokenCounts) {
        const counts = new Map<string, number>();
        for (const seg of rest) {
          if (nowMs < seg.start || nowMs > seg.end) continue;
          counts.set(seg.placeId, (counts.get(seg.placeId) ?? 0) + 1);
        }
        for (const [placeId, count] of counts) {
          const node = nodes.get(placeId); if (!node) continue;
          const center = screen({ x: node.position.x + (node.width ?? PLACE_D) / 2, y: node.position.y + (node.height ?? PLACE_D) / 2 });
          const top = center.y - (node.height ?? PLACE_D) / 2 * z;
          ctx.save();
          ctx.fillStyle = theme.text ?? '#1c2027';
          ctx.font = `600 ${Math.max(9, 10.5 * z)}px system-ui, sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
          ctx.fillText(String(count), center.x, top - Math.max(3, 4 * z));
          ctx.restore();
        }
      }
      for (const particle of particles) {
        const p = screen(pointAt(particle.edge.samples, particle.progress)); const r = Math.max(1, 3.7 * z);
        const fade = particle.enter ? Math.min(1, (1 - particle.progress) * 6) : Math.min(1, particle.progress * 6);
        ctx.save(); ctx.globalAlpha = .4 + fade * .6; ctx.shadowColor = particle.color; ctx.shadowBlur = 7 * z; ctx.fillStyle = particle.color; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
      for (const pulse of pulses) {
        const pos = screen({ x: pulse.node.position.x + (pulse.node.width ?? TRANS_W) / 2, y: pulse.node.position.y + (pulse.node.height ?? TRANS_H) / 2 });
        const width = (pulse.node.width ?? TRANS_W) * z, height = (pulse.node.height ?? TRANS_H) * z;
        ctx.save(); ctx.globalAlpha = Math.max(0, pulse.strength) * .33; ctx.strokeStyle = pulse.color; ctx.lineWidth = 2 * z; ctx.shadowColor = pulse.color; ctx.shadowBlur = 10 * z; ctx.strokeRect(pos.x - width / 2 - 3 * z, pos.y - height / 2 - 3 * z, width + 6 * z, height + 6 * z); ctx.restore();
      }
      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw); return () => { cancelAnimationFrame(raf); observer.disconnect(); };
  }, [durationRef, edges, getViewport, modeRef, nodes, playheadRef, rest, runningRef, scheduled, showTokenCounts, speedRef, theme]);
  return <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 4 }} aria-hidden="true" />;
}

function Graph({ replay }: { replay: ReplayPayload }) {
  const [theme, setTheme] = useState<Theme>(promenade.theme());
  const [elk, setElk] = useState<Awaited<ReturnType<typeof layout>> | null>(null);
  const [mode, setMode] = useState<Mode>('hybrid'); const [speed, setSpeed] = useState(1); const [speedMenu, setSpeedMenu] = useState(false); const [panelOpen, setPanelOpen] = useState(true); const [showMiniMap, setShowMiniMap] = useState(true); const [running, setRunning] = useState(() => !matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [displayTime, setDisplayTime] = useState(0); const [selected, setSelected] = useState<string | null>(null);
  const playheadRef = useRef(0), runningRef = useRef(running), speedRef = useRef(speed), modeRef = useRef(mode), durationRef = useRef(Math.max(18000, replay.timeline?.durationMs ?? 45000));
  const { graph, arcs } = useMemo(() => buildGraph(replay.model), [replay.model]);
  const [showTokenCounts, setShowTokenCounts] = useState(false);
  const { fitView } = useReactFlow(); const hasFitted = useRef(false);
  useEffect(() => {
    promenade.on('theme', (event) => setTheme(event.theme));
    promenade.on('params', (next) => { if (typeof next?.showTokenCounts === 'boolean') setShowTokenCounts(next.showTokenCounts); });
    promenade.ready();
  }, []);
  useEffect(() => { let cancelled = false; layout(graph).then((answer) => { if (!cancelled) setElk(answer); }); return () => { cancelled = true; }; }, [graph]);
  useEffect(() => { runningRef.current = running; }, [running]); useEffect(() => { speedRef.current = speed; }, [speed]); useEffect(() => { modeRef.current = mode; }, [mode]);
  // Deliberately slow UI sync; animated positions remain in the Canvas loop.
  useEffect(() => { const id = setInterval(() => setDisplayTime(playheadRef.current), 140); return () => clearInterval(id); }, []);

  const initial = useMemo(() => new Set(replay.model.initial_marking ?? []), [replay.model]);
  const final = useMemo(() => new Set(replay.model.final_marking ?? []), [replay.model]);
  const nodes = useMemo<Node<NodeData>[]>(() => (elk?.children ?? []).map((child) => {
    if (child.id.startsWith('p')) { const id = Number(child.id.slice(1)); return { id: child.id, type: 'net', position: { x: child.x, y: child.y }, width: child.width, height: child.height, data: { kind: 'place', initial: initial.has(id), final: final.has(id), theme } }; }
    const id = Number(child.id.slice(1)), label = labelOf(replay.model, id);
    return { id: child.id, type: 'net', position: { x: child.x, y: child.y }, width: child.width, height: child.height, data: { kind: label == null ? 'tau' : 'transition', label, selected: selected === child.id, theme } };
  }), [elk, final, initial, replay.model, selected, theme]);
  const arcById = useMemo(() => new Map(arcs.map((arc) => [arc.id, arc])), [arcs]);
  const sampledEdges = useMemo(() => new Map<string, SampledEdge>((elk?.edges ?? []).flatMap((edge) => { const arc = arcById.get(edge.id); return arc && edge.sections?.length ? [[edge.id, { ...arc, ...pathAndSamples(edge.sections) }]] : []; })), [arcById, elk]);
  const edges = useMemo<Edge<AnimatedEdgeData>[]>(() => [...sampledEdges.values()].map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: 'net', data: { path: edge.path, color: theme['text-dim'] ?? '#6f7889' }, markerEnd: { type: MarkerType.ArrowClosed, color: theme['text-dim'] ?? '#6f7889', width: 13, height: 13 } })), [sampledEdges, theme]);
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const scheduled = useMemo<Scheduled[]>(() => {
    const duration = durationRef.current, start = replay.timeline?.start ?? 0, span = Math.max(1, replay.timeline?.sourceSpanMs ?? 1);
    const inputs = new Map<number, string[]>(), outputs = new Map<number, string[]>();
    for (const edge of sampledEdges.values()) { if (edge.target.startsWith('t')) { const id = Number(edge.target.slice(1)); inputs.set(id, [...(inputs.get(id) ?? []), edge.id]); } if (edge.source.startsWith('t')) { const id = Number(edge.source.slice(1)); outputs.set(id, [...(outputs.get(id) ?? []), edge.id]); } }
    // Silent (τ) transitions fire real token moves too — Inductive Miner
    // routes loop re-entry and skips through them by construction, so they
    // sit disproportionately at the boundary next to source/sink. Excluding
    // them here (as an earlier version did) is why tokens never appeared to
    // leave the source or arrive at the sink: those hops are silent far more
    // often than internal ones. ProM's own Inductive Visual Miner animates
    // every firing regardless of visibility, which this now matches.
    return replay.events.map((event, index) => {
      const at = replay.timeline?.hasTiming && event.timestamp != null
        ? ((event.timestamp - start) / span) * (duration * .9) + duration * .05
        : ((index * 740 + hash(event.caseId) % 2300) % duration);
      return { ...event, at, incoming: inputs.get(event.transitionId) ?? [], outgoing: outputs.get(event.transitionId) ?? [] };
    });
  }, [replay.events, replay.timeline, sampledEdges]);
  /**
   * The place a case's token dwells at between two consecutive firings: the
   * place `a`'s outgoing arcs lead into, when it's also where `b`'s incoming
   * arcs come from. Concurrency (an AND-split producing more than one live
   * token per case) isn't modelled — `shared` is simply empty then, which
   * falls back to the old disappear-and-reappear look for that hop only,
   * same as every hop looked before this existed.
   */
  const rest = useMemo<RestSegment[]>(() => {
    const duration = durationRef.current;
    const byCase = new Map<string, Scheduled[]>();
    for (const event of scheduled) byCase.set(event.caseId, [...(byCase.get(event.caseId) ?? []), event]);
    const segments: RestSegment[] = [];
    for (const events of byCase.values()) {
      events.sort((x, y) => x.sequence - y.sequence);
      for (let i = 0; i < events.length - 1; i++) {
        const a = events[i], b = events[i + 1];
        const produced = a.outgoing.map((id) => sampledEdges.get(id)?.target).filter((t): t is string => !!t);
        const consumed = new Set(b.incoming.map((id) => sampledEdges.get(id)?.source).filter((s): s is string => !!s));
        const shared = produced.filter((placeId) => consumed.has(placeId));
        if (!shared.length) continue;
        // `a.at`/`b.at` are already plain, non-wrapped positions within one
        // pass of the loop (the timeline mapping above never wraps them),
        // and consecutive events in a case have non-decreasing timestamps —
        // so `end` genuinely precedes `start` only when the two firings are
        // effectively simultaneous (silent moves carry the previous event's
        // timestamp forward, so this is common), never because the window
        // "wraps around" the loop. Treating it as a wrap — `% duration` —
        // turned a ~0ms gap into a ~duration-970ms one instead: every place
        // with any back-to-back or same-timestamp hop looked permanently,
        // almost-fully occupied. There is nothing here for `% duration` to
        // usefully wrap in the first place, so it's gone, not patched.
        const start = a.at + 540, end = b.at - 430, span = end - start;
        if (span < 40) continue; // fired back to back — nothing to visibly rest
        for (const placeId of shared) segments.push({ placeId, start, end });
      }
    }
    return segments;
  }, [scheduled, sampledEdges]);
  useEffect(() => { if (!nodes.length || hasFitted.current) return; const id = requestAnimationFrame(() => { fitView({ padding: .16, duration: 0 }); hasFitted.current = true; }); return () => cancelAnimationFrame(id); }, [fitView, nodes]);

  const onNodeClick = useCallback((_: unknown, node: Node<NodeData>) => { setSelected(node.id); const activity = node.data.label; promenade.select(activity ? [{ kind: 'activity', id: activity }] : [{ kind: node.data.kind === 'place' ? 'place' : 'transition', id: node.id }]); }, []);
  const scrub = (event: React.ChangeEvent<HTMLInputElement>) => { playheadRef.current = Number(event.target.value); setDisplayTime(playheadRef.current); };
  const reset = () => { playheadRef.current = 0; setDisplayTime(0); setRunning(true); };
  const stats = replay.stats ?? {};
  const sourceTime = replay.timeline?.hasTiming
    ? dateTime((replay.timeline.start ?? 0) + displayTime / durationRef.current * Math.max(1, replay.timeline.sourceSpanMs ?? 1))
    : 'Replay time (no event timestamps)';
  const speeds = [.25, .5, 1, 1.5, 2, 4];
  return <div className="ivm" style={{ background: theme.bg, '--ivm-paper': theme.bg, '--ivm-text': theme.text, '--ivm-dim': theme['text-dim'], '--ivm-line': theme.border } as any}>
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodeClick={onNodeClick} nodeOrigin={[0, 0]} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} panOnDrag zoomOnScroll zoomOnPinch zoomOnDoubleClick minZoom={.03} maxZoom={4} onlyRenderVisibleElements proOptions={{ hideAttribution: true }}>
      <Background color={theme.border} gap={20} /><Controls showInteractive={false}><ControlButton onClick={() => setShowMiniMap((visible) => !visible)} title={showMiniMap ? 'Hide overview map' : 'Show overview map'}>{showMiniMap ? '▣' : '□'}</ControlButton><ExportMenu filename="inductive-visual-miner" /></Controls>{showMiniMap && <MiniMap pannable zoomable nodeColor={(n) => n.data.kind === 'tau' ? theme['text-dim'] : theme['bg-soft']} nodeStrokeColor={() => theme['text-dim']} style={{ background: theme['bg-soft'] }} />}
    </ReactFlow>
    <FlowCanvas edges={sampledEdges} nodes={nodeMap} scheduled={scheduled} rest={rest} showTokenCounts={showTokenCounts} durationRef={durationRef} playheadRef={playheadRef} runningRef={runningRef} speedRef={speedRef} modeRef={modeRef} theme={theme} />
    <aside className="ivm-panel"><h2><button aria-expanded={panelOpen} onClick={() => setPanelOpen((open) => !open)}>Token animation <span>{panelOpen ? '⌃' : '⌄'}</span></button></h2>{panelOpen && <><div className="section">
      {([['individual', 'Individual'], ['hybrid', 'Hybrid (recommended)'], ['flow', 'Flow only']] as Array<[Mode, string]>).map(([key, label]) => <label key={key}><input type="radio" checked={mode === key} onChange={() => setMode(key)} />{label}</label>)}
    </div><div className="section ivm-help">
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginBottom: 5 }}>
        {PALETTE.map((c) => <span key={c} style={{ width: 7, height: 7, borderRadius: '50%', background: c, flex: '0 0 auto' }} />)}
        <span>token colour = case, cycled across {PALETTE.length} colours (two cases can share one)</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 5 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#d66b3a', flex: '0 0 auto' }} />
        <span>orange = a deviation from the log at that step</span>
      </div>
      Representative animation: at most {PARTICLE_CAP} particles are drawn. Flow glow retains activity where many aligned cases overlap.
    </div></>}</aside>
    <div className="ivm-stats"><strong>Alignment replay</strong><br /><span>{stats.cases ?? 0} cases · {stats.events ?? 0} events · fitness {Number(stats.meanFitness ?? 0).toFixed(2)}</span>{stats.deviations ? <><br /><span className="ivm-warning">{stats.deviations} deviations in sample</span></> : null}{stats.fallbackCases ? <><br /><span className="ivm-warning">label fallback in {stats.fallbackCases} cases</span></> : null}{stats.truncated ? <><br /><span className="ivm-warning">sample truncated by event limit</span></> : null}</div>
    <div className="ivm-footer"><button className="ivm-button" onClick={() => setRunning(!running)} aria-label={running ? 'Pause animation' : 'Play animation'}>{running ? 'Ⅱ' : '▶'}</button><button className="ivm-button" onClick={reset} aria-label="Restart animation">↺</button><span className="ivm-time">{format(displayTime)} / {format(durationRef.current)}</span><input aria-label="Replay time" type="range" min="0" max={durationRef.current} value={displayTime} onChange={scrub} /><span className="ivm-source-time" title={sourceTime}>{sourceTime}</span><div className="ivm-speed"><button className="ivm-button" aria-label="Playback speed" aria-expanded={speedMenu} onClick={() => setSpeedMenu(!speedMenu)}>{speed}×</button>{speedMenu && <div className="ivm-speed-menu">{speeds.map((value) => <button key={value} className={speed === value ? 'active' : ''} onClick={() => { setSpeed(value); setSpeedMenu(false); }}>{value}×</button>)}</div>}</div><button className="ivm-button" onClick={() => fitView({ padding: .16, duration: 220 })} aria-label="Fit model">⛶</button></div>
  </div>;
}

const replay = normaliseReplay(promenade.artifact().value);
createRoot(document.getElementById('root')!).render(<ReactFlowProvider><Graph replay={replay} /></ReactFlowProvider>);
