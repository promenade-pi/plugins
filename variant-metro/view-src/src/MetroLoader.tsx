import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * The standby screen: a schematic Budapest metro, with trains that run
 * station to station and dwell at each one.
 *
 * A copy of `plugins/metro-map/view-src/src/MetroLoader.tsx`, deliberately:
 * these two view trees are forks that have already diverged (`router.ts`,
 * `relayout.ts`, `MetroEdge.tsx` all differ), each plugin packages its own
 * bundle, and nothing else in this repo imports TypeScript across plugin
 * directories. Keep them in sync by hand if the schematic changes.
 *
 * It covers the two waits this view has, and they are different waits:
 *
 *  1. **Before the artifact exists.** The manifest marks this view
 *     `livePreview`, so the host opens a panel bound to the pending
 *     discovery run and feeds it `liveRunState` — see `plugin.tsx`'s `Root`.
 *     This is the long one here: `discover` is a thin wasm kernel behind an
 *     internal *pyodide* variant-extraction stage, so the wait includes
 *     starting Python at all. None of it can describe a half-finished metro
 *     map, so there is nothing truthful to draw *of the result*; a standby
 *     animation plus the run's own progress message is the honest maximum.
 *  2. **After it exists, while this view lays it out.** Filtering, ranking,
 *     routing and refinement are one synchronous pass over the whole graph
 *     (see `plugin.tsx`), with the panel already on screen — which is what
 *     showed as a blank white view.
 *
 * Wait 2 is why every moving part here is a **CSS animation on `transform`
 * or `opacity` of an HTML element**, never an SVG attribute animation, a
 * `requestAnimationFrame` loop or React state. Those all need the main
 * thread, and during wait 2 the main thread is exactly what is not
 * available: the layout pass blocks it from the moment React starts
 * rendering the real view until it commits. A compositor-driven transform
 * keeps running through that block, so the screen stays alive rather than
 * freezing on its last frame. `will-change` is set for the same reason —
 * to get the layer promoted before the block starts, not for smoothness.
 *
 * The geometry is deliberately hand-written and approximate. It is a
 * recognisable Budapest (four lines in their real colours, the Danube
 * between Buda and Pest, its three interchanges ringed), not a survey: no
 * data drives it, and it must not be mistaken for the map being computed.
 */

/** Official BKK line colours. */
const LINES: LineSpec[] = [
  {
    id: 'm1',
    color: '#F5C400',
    // Millennium line: Vörösmarty tér, then the long north-east diagonal.
    points: [[302, 218], [330, 190], [390, 130], [440, 80], [480, 40]],
    stops: [0, 1, 2, 3, 4],
    trains: 2,
    seconds: 15,
  },
  {
    id: 'm2',
    color: '#E4262C',
    // Red line, west to east: Déli — Deák — Keleti — Örs vezér tere.
    points: [[60, 240], [110, 190], [140, 190], [205, 190], [270, 190], [330, 190], [375, 190], [425, 190], [470, 190], [600, 190]],
    stops: [0, 2, 3, 4, 5, 6, 7, 8, 9],
    trains: 2,
    seconds: 21,
  },
  {
    id: 'm3',
    color: '#004B9B',
    darkColor: '#3D87D6',
    // Blue line, Újpest in the north down through Deák and Kálvin to
    // Kőbánya-Kispest in the south-east.
    points: [[330, 28], [330, 120], [330, 190], [330, 228], [370, 268], [430, 328], [480, 378], [560, 378]],
    stops: [0, 1, 2, 3, 4, 5, 6, 7],
    trains: 3,
    seconds: 22,
  },
  {
    id: 'm4',
    color: '#00A64F',
    // Green line, Kelenföld in the south-west across the Danube to Keleti.
    points: [[60, 400], [140, 400], [200, 340], [250, 290], [272, 268], [370, 268], [392, 268], [470, 190]],
    stops: [0, 1, 2, 3, 5, 6, 7],
    trains: 2,
    seconds: 19,
  },
];

/** The Danube, drawn behind everything as one wide soft stroke. */
const DANUBE: Pt[] = [[215, 0], [228, 150], [232, 250], [250, 440]];

/**
 * The three interchanges, drawn as a larger ring than an ordinary station.
 *
 * Deliberately unlabelled. The names were legible enough once haloed, but
 * they are the one thing on this screen that could be mistaken for the map
 * being computed — real station names, in a panel whose whole job is to say
 * "your stations are not ready yet". The rings alone still give the picture
 * its Budapest shape.
 */
const INTERCHANGES: Pt[] = [
  [330, 190],
  [370, 268],
  [470, 190],
];

const W = 640;
const H = 440;
/** Seconds a train stands at a station, as a share of one segment's run. */
const DWELL_SHARE = 0.42;

type Pt = [number, number];

interface LineSpec {
  id: string;
  color: string;
  /** Polyline vertices. Corners that are not stations are still vertices. */
  points: Pt[];
  /** Indices into `points` that are actual stations (where trains stop). */
  stops: number[];
  trains: number;
  /** One end-to-end run, in seconds. */
  seconds: number;
  /** Used instead of `color` on a dark background. Only M3 needs one: the
   * official blue is dark enough that it all but vanishes there, and the
   * point of using the real line colours is that they stay recognisable. */
  darkColor?: string;
}

function colorOf(line: LineSpec, dark: boolean): string {
  return (dark && line.darkColor) || line.color;
}

function pathOf(points: Pt[]): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');
}

function angleOf(from: Pt, to: Pt): number {
  return (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;
}

/**
 * One line's keyframes, as CSS text — a full **round trip**, terminus to
 * terminus and back.
 *
 * A one-way timeline would teleport the train back to its first station on
 * every loop; a round trip ends exactly where it began, so `infinite` is
 * seamless and no train ever jumps. It also halves the CSS: a train running
 * the other way is the same animation at a half-cycle delay, not a second
 * set of keyframes.
 *
 * A train runs to a station (interpolated), then holds the same transform
 * for the dwell, which is what reads as "waiting at the platform".
 * Intermediate vertices that are corners rather than stations are passed
 * through without a hold. The heading rides in the same `transform` as the
 * position, so a train turns into its next direction while standing still —
 * the only moment it can. The terminus dwell is placed at the *end* of the
 * cycle so the 100% and 0% keyframes agree on both position and heading.
 *
 * `%` stops come from an accumulated timeline, so dwell and run shares stay
 * exact however uneven the legs are.
 */
function keyframesFor(line: LineSpec, name: string): string {
  // Out and back. The turn-round point (the far terminus) is visited once.
  const path: Pt[] = [...line.points, ...line.points.slice(0, -1).reverse()];
  const last = line.points.length - 1;
  const isStop = (i: number) => line.stops.includes(i <= last ? i : 2 * last - i);

  const legs: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    legs.push(d);
    total += d;
  }
  // A dwell costs the same as `DWELL_SHARE` of an average leg, so a line
  // with many short legs doesn't end up mostly standing still.
  const dwell = (total / Math.max(1, legs.length)) * DWELL_SHARE;
  // Every stop except index 0, whose dwell is the one at 100% instead.
  const dwellCount = path.filter((_, i) => i > 0 && isStop(i)).length;
  const span = total + dwell * dwellCount;

  const frames: string[] = [];
  const emit = (pct: number, p: Pt, angle: number, ease: boolean) => {
    frames.push(
      `${pct.toFixed(3)}%{transform:translate3d(${p[0]}px,${p[1]}px,0) rotate(${angle.toFixed(1)}deg)` +
      `${ease ? ';animation-timing-function:cubic-bezier(.45,.05,.55,.95)' : ''}}`,
    );
  };

  let at = 0;
  for (let i = 0; i < path.length; i++) {
    const out = i < path.length - 1 ? angleOf(path[i], path[i + 1]) : angleOf(path[0], path[1]);
    const arrive = i > 0 ? angleOf(path[i - 1], path[i]) : out;
    if (i > 0) emit((at / span) * 100, path[i], arrive, !isStop(i));
    if (i === 0 || isStop(i)) {
      if (i > 0) at += dwell;
      // Departing (or, at 100%, matching 0% so the loop closes invisibly).
      emit((at / span) * 100, path[i], out, true);
    }
    if (i < path.length - 1) at += legs[i];
  }
  return `@keyframes ${name}{${frames.join('')}}`;
}

interface TrainSpec {
  /** React key. */
  id: string;
  /** The `@keyframes` name — one per line, shared by all of its trains. */
  keyframe: string;
  color: string;
  seconds: number;
  delay: number;
}

function buildAnimation(dark: boolean): { css: string; trains: TrainSpec[] } {
  const css: string[] = [];
  const trains: TrainSpec[] = [];
  for (const line of LINES) {
    const name = `mm-${line.id}`;
    css.push(keyframesFor(line, name));
    // One round trip is two end-to-end runs. Trains are spread evenly over
    // that cycle by a negative delay, so half of them are running each way
    // and none of them start bunched at a terminus.
    const cycle = line.seconds * 2;
    for (let t = 0; t < line.trains; t++) {
      trains.push({
        id: `${name}-${t}`,
        keyframe: name,
        color: colorOf(line, dark),
        seconds: cycle,
        delay: -(cycle / line.trains) * t,
      });
    }
  }
  return { css: css.join(''), trains };
}

export function MetroLoader({
  theme, title, message, fraction,
}: {
  theme: Record<string, string>;
  title: string;
  /** The run's own progress message, or a description of the local work. */
  message: string;
  /** 0..1 when known; `null` for a genuinely indefinite wait. */
  fraction: number | null;
}) {
  const dark = theme.scheme === 'dark';
  const { css, trains } = useMemo(() => buildAnimation(dark), [dark]);
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  // Fit the fixed-size schematic into whatever the panel happens to be.
  // Runs before the blocking layout pass, and a resize during that pass is
  // simply late rather than wrong.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      setScale(Math.min(1, Math.min(r.width / (W + 40), (r.height - 64) / (H + 40))));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const dim = theme['text-dim'] || '#667';
  const line = theme.border || '#ccd';

  return (
    <div
      ref={box}
      style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 14, overflow: 'hidden',
        background: theme.bg || '#fff', color: theme.text || '#111',
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
      }}
    >
      <style>{`
        ${css}
        .mm-train {
          position: absolute; top: 0; left: 0; width: 16px; height: 8px;
          margin: -4px 0 0 -8px; border-radius: 4px;
          /* A ring in the page background, so a train standing on a station
             still reads as a separate thing rather than filling the dot. */
          box-shadow: 0 0 0 1.6px ${theme.bg || '#fff'};
          will-change: transform;
          animation-iteration-count: infinite;
          animation-timing-function: linear;
        }
        .mm-stage { position: relative; width: ${W}px; height: ${H}px; }
        /* Delayed fade-in: a layout pass that finishes quickly swaps this out
           before it is ever visible, so a small map never flashes a loader. */
        .mm-fade { opacity: 0; animation: mm-in .35s ease .25s forwards; will-change: opacity; }
        @keyframes mm-in { to { opacity: 1; } }
        .mm-bar { animation: mm-bar-slide 1.3s cubic-bezier(.4,0,.2,1) infinite; will-change: transform; }
        @keyframes mm-bar-slide {
          0% { transform: translate3d(-110%,0,0); }
          60% { transform: translate3d(200%,0,0); }
          100% { transform: translate3d(320%,0,0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .mm-train, .mm-bar { animation: none; }
          .mm-fade { opacity: 1; animation: none; }
        }
      `}</style>

      <div className="mm-fade" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
        <div className="mm-stage" style={{ transform: `scale(${scale})`, transformOrigin: 'center center' }}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: 'absolute', inset: 0 }}>
            <path
              d={pathOf(DANUBE)} fill="none" stroke="#4BA3E3" strokeWidth={34}
              strokeLinecap="round" strokeLinejoin="round" opacity={0.26}
            />
            {LINES.map((l) => (
              <path
                key={l.id} d={pathOf(l.points)} fill="none" stroke={colorOf(l, dark)}
                strokeWidth={6} strokeLinecap="round" strokeLinejoin="round"
              />
            ))}
            {LINES.map((l) => l.stops.map((i) => (
              <circle
                key={`${l.id}-${i}`} cx={l.points[i][0]} cy={l.points[i][1]} r={4.6}
                fill={theme.bg || '#fff'} stroke={colorOf(l, dark)} strokeWidth={2.4}
              />
            )))}
            {INTERCHANGES.map(([cx, cy]) => (
              <circle
                key={`${cx},${cy}`} cx={cx} cy={cy} r={7.5}
                fill={theme.bg || '#fff'} stroke={theme.text || '#111'} strokeWidth={2.6}
              />
            ))}
          </svg>
          {trains.map((t) => (
            <div
              key={t.id}
              className="mm-train"
              style={{
                background: t.color,
                animationName: t.keyframe,
                animationDuration: `${t.seconds}s`,
                animationDelay: `${t.delay}s`,
              }}
            />
          ))}
        </div>

        <div style={{ textAlign: 'center', maxWidth: 420 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
          <div style={{ fontSize: 11.5, color: dim, marginTop: 3, minHeight: 15 }}>{message}</div>
          <div style={{
            marginTop: 9, height: 3, borderRadius: 2, overflow: 'hidden',
            background: line, position: 'relative',
          }}>
            {fraction == null ? (
              <div className="mm-bar" style={{ position: 'absolute', inset: 0, width: '35%', borderRadius: 2, background: theme.accent || '#4BA3E3' }} />
            ) : (
              <div style={{
                height: '100%', width: `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`,
                background: theme.accent || '#4BA3E3', transition: 'width .2s linear',
              }} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
