import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Background, ControlButton, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, type Node } from '@xyflow/react';
// @ts-ignore esbuild inlines the package stylesheet into the sandbox bundle.
import flowCss from '@xyflow/react/dist/style.css';
import ELK from 'elkjs/lib/elk-api.js';
// @ts-ignore -- the plugin iframe uses ELK's synchronous worker shim.
import { Worker as ElkSyncWorker } from 'elkjs/lib/elk-worker.min.js';
import { ExportMenu } from './lib/ExportMenu';

const style = document.createElement('style');
style.textContent = flowCss + `
  .dfvm{height:100%;width:100%;position:relative;overflow:hidden;font:13px/1.35 Inter,ui-sans-serif,system-ui,sans-serif}
  .dfvm-node{width:176px;height:58px;box-sizing:border-box;border:2px solid var(--dfvm-col);border-radius:9px;background:var(--dfvm-paper);color:var(--dfvm-text);padding:8px 10px;box-shadow:0 1px 3px #172b4d18;position:relative}.dfvm-node strong{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}.dfvm-node span{color:var(--dfvm-dim);font-size:11px}.dfvm-node em{position:absolute;right:8px;top:20px;color:#bd6510;font-size:11px;font-style:normal;font-weight:700}
  .dfvm-stats{position:absolute;right:14px;top:14px;z-index:8;border:1px solid var(--dfvm-line);border-radius:9px;padding:9px 11px;background:color-mix(in srgb,var(--dfvm-paper) 94%,transparent);box-shadow:0 4px 15px #172b4d12;color:var(--dfvm-text)}.dfvm-stats span{color:var(--dfvm-dim);font-size:11px}
  .dfvm-footer{position:absolute;z-index:8;left:14px;right:18px;bottom:14px;height:43px;display:flex;align-items:center;gap:10px;padding:0 12px;border:1px solid var(--dfvm-line);border-radius:9px;background:color-mix(in srgb,var(--dfvm-paper) 94%,transparent);box-shadow:0 4px 15px #172b4d14;color:var(--dfvm-text)}.dfvm-footer button{cursor:pointer;border:1px solid var(--dfvm-line);border-radius:6px;background:var(--dfvm-paper);color:var(--dfvm-text);font:inherit;padding:5px 9px}.dfvm-footer input{flex:1;accent-color:#2f70f5}.dfvm-clock{min-width:92px;color:var(--dfvm-dim);font-variant-numeric:tabular-nums;white-space:nowrap}.dfvm-source-time{min-width:178px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dfvm-dim);font-variant-numeric:tabular-nums}.dfvm-speed{position:relative}.dfvm-speed-menu{position:absolute;right:0;bottom:36px;min-width:86px;padding:4px;background:var(--dfvm-paper);border:1px solid var(--dfvm-line);border-radius:7px;box-shadow:0 5px 18px #172b4d24}.dfvm-speed-menu button{display:block;width:100%;text-align:left;border:0;border-radius:4px;padding:5px 8px}.dfvm-speed-menu button:hover,.dfvm-speed-menu button.active{background:#2f70f518;color:#1751c7}
  /* The playback bar owns the lower 71 px. React Flow defaults both controls
     and minimap to that corner, which otherwise makes three unrelated UIs
     overlap. */
  .dfvm .react-flow__controls{bottom:72px;z-index:7;box-shadow:0 2px 9px #172b4d18;border:1px solid var(--dfvm-line);overflow:hidden}.dfvm .react-flow__controls-button{background:var(--dfvm-paper);border-bottom-color:var(--dfvm-line);color:var(--dfvm-text)}
  .dfvm .react-flow__minimap{bottom:72px;z-index:7;border:1px solid var(--dfvm-line);border-radius:7px;overflow:hidden;box-shadow:0 2px 10px #172b4d18}
`;
document.head.appendChild(style);

type Theme = Record<string, string>;
type DfgNode = { id: number; label: string; count: number };
type DfgEdge = { source: number; target: number; count: number };
type DfgEvent = { caseId: string; activityId: number; previous?: number | null; timestamp?: number | null; sequence: number };
type Replay = { nodes: DfgNode[]; edges: DfgEdge[]; events: DfgEvent[]; timeline: { start: number; sourceSpanMs: number; durationMs: number; hasTiming?: boolean }; stats: any };
type Point = { x: number; y: number };
type Route = { id: string; samples: Point[]; count: number };

const options = { 'elk.algorithm':'layered', 'elk.direction':'RIGHT', 'elk.edgeRouting':'SPLINES', 'elk.hierarchyHandling':'INCLUDE_CHILDREN', 'elk.separateConnectedComponents':'true', 'elk.spacing.nodeNode':'48', 'elk.spacing.edgeNode':'24', 'elk.spacing.edgeEdge':'16', 'elk.spacing.componentComponent':'96', 'elk.layered.cycleBreaking.strategy':'GREEDY', 'elk.layered.layering.strategy':'NETWORK_SIMPLEX', 'elk.layered.crossingMinimization.strategy':'LAYER_SWEEP', 'elk.layered.crossingMinimization.greedySwitch.type':'TWO_SIDED', 'elk.layered.crossingMinimization.greedySwitch.activationThreshold':'40', 'elk.layered.nodePlacement.strategy':'NETWORK_SIMPLEX', 'elk.layered.nodePlacement.favorStraightEdges':'true', 'elk.layered.spacing.nodeNodeBetweenLayers':'120', 'elk.layered.spacing.edgeNodeBetweenLayers':'36', 'elk.layered.spacing.edgeEdgeBetweenLayers':'18', 'elk.layered.thoroughness':'15', 'elk.layered.unnecessaryBendpoints':'false' };
let elk: InstanceType<typeof ELK> | null = null;
const engine = () => elk ??= new ELK({ workerFactory: () => new ElkSyncWorker() });
const key = (source: number, target: number) => `e-${source}-${target}`;
const fmt = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K` : String(value);
const clock = (value: number) => { const seconds = Math.floor(value / 1000); return `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`; };
const dateTime = (value: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
const color = (name: string) => promenade.color('activity', name) || '#2f70f5';

function normalise(value: unknown): Replay {
  let replay: any = value; for (let i=0; i<4 && replay && typeof replay === 'object' && 'result' in replay; i++) replay = replay.result;
  return { nodes: Array.isArray(replay?.nodes) ? replay.nodes : [], edges: Array.isArray(replay?.edges) ? replay.edges : [], events: Array.isArray(replay?.events) ? replay.events : [], timeline: replay?.timeline ?? { start:0, sourceSpanMs:1, durationMs:45000 }, stats: replay?.stats ?? {} };
}

function DfgNodeView({ data }: any) {
  return <div className="dfvm-node" style={{ '--dfvm-col': data.color, '--dfvm-paper': data.theme.bg, '--dfvm-text': data.theme.text, '--dfvm-dim': data.theme['text-dim'] } as any}><strong>{data.label}</strong><span>{fmt(data.count)}</span>{data.loop ? <em>↻ {fmt(data.loop)}</em> : null}</div>;
}
const nodeTypes = { activity: DfgNodeView };

function interpolate(samples: Point[], fraction: number) {
  const point = Math.max(0, Math.min(1, fraction)) * Math.max(0, samples.length - 1); const index = Math.floor(point);
  if (index >= samples.length - 1) return samples[samples.length - 1] ?? { x:0, y:0 };
  const a=samples[index], b=samples[index+1], p=point-index; return { x:a.x+(b.x-a.x)*p, y:a.y+(b.y-a.y)*p };
}
function samples(section: any) {
  const raw = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].filter(Boolean);
  if (raw.length < 2) return [];
  // Same ELK spline decoding used by the native React-Flow DFG view. A spline
  // bend list contains cubic control points, not points the path passes
  // through; connecting them directly is what produced the "spikes".
  const controls = [section.startPoint, ...(section.bendPoints ?? [])].filter(Boolean);
  if ((controls.length - 1) % 3 === 2) controls.push(section.endPoint);
  if (controls.length >= 4 && (controls.length - 1) % 3 === 0) {
    const out: Point[] = [];
    const point = (a: Point, b: Point, c: Point, d: Point, t: number): Point => {
      const u = 1 - t;
      return { x: u*u*u*a.x + 3*u*u*t*b.x + 3*u*t*t*c.x + t*t*t*d.x, y: u*u*u*a.y + 3*u*u*t*b.y + 3*u*t*t*c.y + t*t*t*d.y };
    };
    for (let i = 1; i < controls.length; i += 3) for (let step = 0; step < 18; step++) out.push(point(controls[i - 1], controls[i], controls[i + 1], controls[i + 2], step / 18));
    out.push(controls[controls.length - 1]);
    return out;
  }
  return raw;
}

// Route strokes, arrowheads and the token dot are all multiplied by
// `vp.zoom` below — a canvas, unlike React Flow's own SVG edge layer, has no
// automatic viewport transform, so every width/radius stayed a fixed pixel
// size while zooming until this was added.
function Canvas({ routes, replay, theme, running, speed, timeRef }: { routes: Map<string,Route>; replay: Replay; theme: Theme; running: boolean; speed: number; timeRef: React.MutableRefObject<number> }) {
  const ref=useRef<HTMLCanvasElement>(null); const { getViewport }=useReactFlow();
  useEffect(()=>{const canvas=ref.current!, host=canvas.parentElement!, resize=()=>{const r=host.getBoundingClientRect(),d=Math.min(2,devicePixelRatio||1);canvas.width=Math.max(1,Math.round(r.width*d));canvas.height=Math.max(1,Math.round(r.height*d));canvas.style.width=`${r.width}px`;canvas.style.height=`${r.height}px`;};const observer=new ResizeObserver(resize);observer.observe(host);resize();let raf=0,last=performance.now();const draw=(now:number)=>{const d=Math.min(2,devicePixelRatio||1),ctx=canvas.getContext('2d')!,w=canvas.width/d,h=canvas.height/d;if(running)timeRef.current=(timeRef.current+(now-last)*speed)%(replay.timeline.durationMs||45000);last=now;ctx.setTransform(d,0,0,d,0,0);ctx.clearRect(0,0,w,h);const vp=getViewport(),toScreen=(p:Point)=>({x:vp.x+p.x*vp.zoom,y:vp.y+p.y*vp.zoom});ctx.lineCap='round';ctx.lineJoin='round';for(const route of routes.values()){if(route.samples.length<2)continue;ctx.strokeStyle=theme['text-dim']||'#6f7889';ctx.globalAlpha=.72;ctx.lineWidth=(1.2+Math.min(2,Math.log1p(route.count)*.25))*vp.zoom;ctx.beginPath();route.samples.forEach((p,i)=>{const q=toScreen(p);i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y)});ctx.stroke();const end=toScreen(route.samples[route.samples.length-1]),before=toScreen(route.samples[route.samples.length-2]),a=Math.atan2(end.y-before.y,end.x-before.x);ctx.save();ctx.translate(end.x,end.y);ctx.rotate(a);ctx.scale(vp.zoom,vp.zoom);ctx.fillStyle=theme['text-dim']||'#6f7889';ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(-7,-3);ctx.lineTo(-7,3);ctx.closePath();ctx.fill();ctx.restore();}const duration=replay.timeline.durationMs||45000,events=replay.events.filter(e=>e.previous!=null).slice(0,220);events.forEach((event,index)=>{const at=replay.timeline.hasTiming&&event.timestamp!=null?((event.timestamp-replay.timeline.start)/Math.max(1,replay.timeline.sourceSpanMs))*duration:((index*610+(event.sequence%23)*97)%duration);const age=(timeRef.current-at+duration)%duration;if(age>620)return;const route=routes.get(key(Number(event.previous),event.activityId));if(!route)return;const p=toScreen(interpolate(route.samples,age/620));const c=color(replay.nodes.find(n=>n.id===event.activityId)?.label||'');ctx.save();ctx.globalAlpha=.88;ctx.fillStyle=c;ctx.shadowColor=c;ctx.shadowBlur=8*vp.zoom;ctx.beginPath();ctx.arc(p.x,p.y,3.6*vp.zoom,0,Math.PI*2);ctx.fill();ctx.restore();});raf=requestAnimationFrame(draw)};raf=requestAnimationFrame(draw);return()=>{cancelAnimationFrame(raf);observer.disconnect()};},[getViewport,replay,routes,running,speed,theme,timeRef]);return <canvas ref={ref} style={{position:'absolute',inset:0,zIndex:4,pointerEvents:'none'}}/>;
}

function View({ replay }: { replay: Replay }) {
  const [theme,setTheme]=useState<Theme>(promenade.theme());const [result,setResult]=useState<any>(null);const [running,setRunning]=useState(true);const [speed,setSpeed]=useState(1);const [speedMenu,setSpeedMenu]=useState(false);const [showMiniMap,setShowMiniMap]=useState(true);const [display,setDisplay]=useState(0);const timeRef=useRef(0);const {fitView}=useReactFlow();
  useEffect(()=>{promenade.on('theme',(event:any)=>setTheme(event.theme));promenade.ready();},[]);
  const graph=useMemo(()=>({id:'dfg',layoutOptions:options,children:replay.nodes.map(n=>({id:`a-${n.id}`,width:176,height:58})),edges:replay.edges.filter(e=>e.source!==e.target).map(e=>({id:key(e.source,e.target),sources:[`a-${e.source}`],targets:[`a-${e.target}`]}))}),[replay]);
  useEffect(()=>{let dead=false;engine().layout(graph as any).then(value=>{if(!dead)setResult(value)});return()=>{dead=true}},[graph]);
  const loops=useMemo(()=>new Map(replay.edges.filter(e=>e.source===e.target).map(e=>[e.source,e.count])),[replay]);
  const nodes=useMemo<Node[]>(()=> (result?.children??[]).map((child:any)=>{const id=Number(child.id.slice(2)),n=replay.nodes.find(node=>node.id===id)!;return{id:child.id,type:'activity',position:{x:child.x,y:child.y},width:176,height:58,data:{label:n.label,count:n.count,loop:loops.get(id),color:color(n.label),theme}}}),[loops,replay,result,theme]);
  const routes=useMemo(()=>{const out=new Map<string,Route>();for(const edge of result?.edges??[]){if(edge.sections?.[0]){const pair=replay.edges.find(item=>key(item.source,item.target)===edge.id);if(pair)out.set(edge.id,{id:edge.id,samples:samples(edge.sections[0]),count:pair.count})}}return out},[replay,result]);
  useEffect(()=>{if(nodes.length)requestAnimationFrame(()=>fitView({padding:.18,duration:0}));},[fitView,nodes]);useEffect(()=>{const id=setInterval(()=>setDisplay(timeRef.current),160);return()=>clearInterval(id)},[]);
  const duration=replay.timeline.durationMs||45000;
  const sourceTime = replay.timeline.hasTiming
    ? dateTime(replay.timeline.start + display / duration * Math.max(1, replay.timeline.sourceSpanMs))
    : 'Replay time (no event timestamps)';
  const speeds = [.25, .5, 1, 1.5, 2, 4];
  return <div className="dfvm" style={{background:theme.bg,'--dfvm-paper':theme.bg,'--dfvm-text':theme.text,'--dfvm-dim':theme['text-dim'],'--dfvm-line':theme.border} as any}>
    <ReactFlow nodes={nodes} edges={[]} nodeTypes={nodeTypes} nodeOrigin={[0,0]} nodesDraggable={false} nodesConnectable={false} panOnDrag zoomOnScroll zoomOnPinch zoomOnDoubleClick minZoom={.03} maxZoom={4} onlyRenderVisibleElements proOptions={{hideAttribution:true}}><Background color={theme.border} gap={20}/><Controls showInteractive={false}><ControlButton onClick={()=>setShowMiniMap((visible)=>!visible)} title={showMiniMap?'Hide overview map':'Show overview map'}>{showMiniMap?'▣':'□'}</ControlButton><ExportMenu filename="directly-follows-visual-miner" /></Controls>{showMiniMap&&<MiniMap pannable zoomable nodeColor={(node)=>String((node.data as any).color ?? '#2f70f5')} style={{background:theme['bg-soft']}}/>}</ReactFlow>
    <Canvas routes={routes} replay={replay} theme={theme} running={running} speed={speed} timeRef={timeRef}/>
    <div className="dfvm-stats"><strong>Directly-Follows replay</strong><br/><span>{replay.stats.cases??0} cases · {replay.stats.events??0} events · {replay.stats.edges??0} relations</span></div>
    <div className="dfvm-footer"><button onClick={()=>setRunning(!running)}>{running?'Ⅱ':'▶'}</button><button onClick={()=>{timeRef.current=0;setDisplay(0);setRunning(true)}}>↺</button><span className="dfvm-clock">{clock(display)} / {clock(duration)}</span><input aria-label="Replay position" type="range" min="0" max={duration} value={display} onChange={event=>{timeRef.current=Number(event.target.value);setDisplay(timeRef.current)}}/><span className="dfvm-source-time" title={sourceTime}>{sourceTime}</span><div className="dfvm-speed"><button aria-label="Playback speed" aria-expanded={speedMenu} onClick={()=>setSpeedMenu(!speedMenu)}>{speed}×</button>{speedMenu&&<div className="dfvm-speed-menu">{speeds.map(value=><button key={value} className={speed===value?'active':''} onClick={()=>{setSpeed(value);setSpeedMenu(false)}}>{value}×</button>)}</div>}</div><button aria-label="Fit diagram" onClick={()=>fitView({padding:.18,duration:200})}>⛶</button></div>
  </div>;
}

const replay=normalise(promenade.artifact().value);createRoot(document.getElementById('root')!).render(<ReactFlowProvider><View replay={replay}/></ReactFlowProvider>);
