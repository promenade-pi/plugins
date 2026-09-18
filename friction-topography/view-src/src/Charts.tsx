/**
 * The small 2D charts inside the inspector.
 *
 * The terrain answers "where does this process hurt". None of these answer
 * that - they answer "and is that one long wait or two different populations",
 * which a surface fundamentally cannot show, because a surface has one value
 * per point and a distribution does not. Pairing the two is the point: the 3D
 * view finds the peak, and these say what the peak is made of.
 *
 * Inline SVG, no charting dependency: each of these is a dozen lines of
 * arithmetic, and the frame cannot fetch a library anyway.
 */
import { useMemo } from 'react';

import type { Breakdown } from './query';
import { formatCount, formatDuration } from './types';

/**
 * Waiting-time distribution on a log scale, with median and p90 marked.
 *
 * Log scale because waiting times in a real log span six orders of magnitude,
 * and on a linear axis every bar but the last is one pixel tall. The shape is
 * the finding: one hump is a queue, two humps is batching, a long flat tail is
 * a minority of cases being forgotten about.
 */
export function WaitHistogram({
  waits, median, p90, height = 74, bimodal,
}: {
  waits: number[];
  median: number;
  p90: number;
  height?: number;
  bimodal?: boolean;
}) {
  const bins = 30;
  const chart = useMemo(() => {
    const positive = waits.filter((w) => w > 0);
    if (positive.length === 0) return null;
    const logs = positive.map((w) => Math.log10(w));
    let lo = Infinity;
    let hi = -Infinity;
    for (const value of logs) { if (value < lo) lo = value; if (value > hi) hi = value; }
    if (!(hi > lo)) { hi = lo + 1; }
    const hist = new Array<number>(bins).fill(0);
    for (const value of logs) {
      hist[Math.min(bins - 1, Math.max(0, Math.floor(((value - lo) / (hi - lo)) * bins)))]++;
    }
    const peak = Math.max(...hist, 1);
    const at = (ms: number) => (Math.log10(Math.max(1, ms)) - lo) / (hi - lo);
    return {
      hist, peak, lo, hi, zeros: waits.length - positive.length,
      medianAt: at(median), p90At: at(p90),
    };
  }, [waits, median, p90]);

  if (!chart) return <div className="ft-empty">No waiting times recorded here.</div>;

  const width = 100;
  return (
    <div className="ft-chart">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="ft-chart-svg" style={{ height }}>
        {chart.hist.map((count, i) => {
          const barWidth = width / bins;
          const barHeight = (count / chart.peak) * (height - 14);
          return (
            <rect
              key={i}
              x={i * barWidth + 0.3}
              y={height - 12 - barHeight}
              width={barWidth - 0.6}
              height={Math.max(count > 0 ? 0.8 : 0, barHeight)}
              className="ft-hist-bar"
            />
          );
        })}
        {[
          { at: chart.medianAt, className: 'ft-marker-median' },
          { at: chart.p90At, className: 'ft-marker-p90' },
        ].map((marker, i) => (
          marker.at >= 0 && marker.at <= 1 ? (
            <line
              key={i}
              x1={marker.at * width} x2={marker.at * width}
              y1={2} y2={height - 12}
              className={marker.className}
            />
          ) : null
        ))}
        <line x1={0} x2={width} y1={height - 12} y2={height - 12} className="ft-axis-line" />
      </svg>
      <div className="ft-chart-scale">
        <span>{formatDuration(Math.pow(10, chart.lo))}</span>
        <span className="ft-chart-legend">
          <i className="ft-swatch-median" /> median {formatDuration(median)}
          <i className="ft-swatch-p90" /> p90 {formatDuration(p90)}
        </span>
        <span>{formatDuration(Math.pow(10, chart.hi))}</span>
      </div>
      {bimodal && (
        <div className="ft-note">
          Two distinct populations: some entities move on immediately, the rest wait for the next run.
          That is the signature of batching, not of a slow step.
        </div>
      )}
      {chart.zeros > 0 && (
        <div className="ft-note ft-note-quiet">
          {formatCount(chart.zeros)} occurrence{chart.zeros === 1 ? '' : 's'} with no measurable wait,
          off the left of a log axis.
        </div>
      )}
    </div>
  );
}

/**
 * A breakdown as ranked bars: median wait per group, with the share of total
 * wait the group accounts for.
 *
 * Two numbers rather than one, because they answer different questions. The
 * median says how bad it is for one case in that group; the share says whether
 * fixing that group would move the process at all.
 */
export function BreakdownBars({
  rows, unit = 'duration', onPick, emptyLabel,
}: {
  rows: Breakdown[];
  unit?: 'duration';
  onPick?: (key: string) => void;
  emptyLabel?: string;
}) {
  const maxMedian = Math.max(1e-9, ...rows.map((r) => r.medianWait));
  const totalWait = rows.reduce((sum, r) => sum + r.totalWait, 0);

  if (rows.length === 0) {
    return <div className="ft-empty">{emptyLabel ?? 'Nothing to split by here.'}</div>;
  }
  return (
    <div className="ft-bars">
      {rows.slice(0, 14).map((row) => (
        <button
          key={row.key}
          type="button"
          className="ft-bar-row"
          onClick={() => onPick?.(row.key)}
          disabled={!onPick}
          title={
            `${row.key}\n` +
            `median ${formatDuration(row.medianWait)}  p90 ${formatDuration(row.p90Wait)}\n` +
            `${formatCount(row.n)} occurrences, ${formatDuration(row.totalWait)} total`
          }
        >
          <span className="ft-bar-key">{row.key}</span>
          <span className="ft-bar-track">
            <span className="ft-bar-fill" style={{ width: `${(row.medianWait / maxMedian) * 100}%` }} />
            <span
              className="ft-bar-share"
              style={{ width: `${totalWait > 0 ? (row.totalWait / totalWait) * 100 : 0}%` }}
            />
          </span>
          <span className="ft-bar-value">{unit === 'duration' ? formatDuration(row.medianWait) : row.medianWait}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Concurrency over the log's calendar: how many entities were waiting for this
 * step at the same time.
 *
 * The single most useful chart in the panel and the one hardest to guess from
 * a model. A high, flat line means the step is permanently backed up and the
 * fix is capacity; spikes mean arrivals are bursty and the fix is scheduling.
 * Both look identical in the median.
 */
export function QueueDepth({
  depth, peak, mean, height = 56,
}: {
  depth: number[];
  peak: number;
  mean: number;
  height?: number;
}) {
  if (peak <= 0) return <div className="ft-empty">No overlapping waits observed.</div>;
  const width = 100;
  const path = depth
    .map((value, i) => {
      const x = (i / Math.max(1, depth.length - 1)) * width;
      const y = height - 10 - (value / peak) * (height - 16);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
  const meanY = height - 10 - (mean / peak) * (height - 16);

  return (
    <div className="ft-chart">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="ft-chart-svg" style={{ height }}>
        <path d={`${path} L ${width} ${height - 10} L 0 ${height - 10} Z`} className="ft-queue-area" />
        <path d={path} className="ft-queue-line" />
        <line x1={0} x2={width} y1={meanY} y2={meanY} className="ft-marker-median" />
        <line x1={0} x2={width} y1={height - 10} y2={height - 10} className="ft-axis-line" />
      </svg>
      <div className="ft-chart-scale">
        <span>start of window</span>
        <span className="ft-chart-legend">peak {peak} &middot; mean {mean.toFixed(1)}</span>
        <span>end</span>
      </div>
    </div>
  );
}

/**
 * The climb profile of one case: cumulative elapsed time step by step.
 *
 * The 2D twin of the illuminated route. On the terrain the route shows *where*
 * the case lost time; here the same journey is read off as a staircase, and a
 * near-vertical riser is unmistakable in a way a bright line over a mountain
 * is not.
 */
export function ClimbProfile({
  steps, onHoverStep, height = 88,
}: {
  steps: Array<{ activity: string; waitMs: number }>;
  onHoverStep?: (index: number | null) => void;
  height?: number;
}) {
  if (steps.length < 2) return <div className="ft-empty">This case has a single step.</div>;
  const width = 100;
  const cumulative: number[] = [];
  let total = 0;
  for (const step of steps) {
    total += Math.max(0, step.waitMs);
    cumulative.push(total);
  }
  const peak = Math.max(1, total);
  const points = cumulative.map((value, i) => ({
    x: (i / (steps.length - 1)) * width,
    y: height - 12 - (value / peak) * (height - 20),
    value,
  }));
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');

  // The single biggest riser is the answer to "where did this case lose its
  // time", so it is marked rather than left to be spotted.
  let worst = 0;
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].waitMs > steps[worst].waitMs) worst = i;
  }

  return (
    <div className="ft-chart">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="ft-chart-svg" style={{ height }}>
        <path d={`${path} L ${width} ${height - 12} L 0 ${height - 12} Z`} className="ft-climb-area" />
        <path d={path} className="ft-climb-line" />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p.x} cy={p.y} r={i === worst ? 2.2 : 1.2}
            className={i === worst ? 'ft-climb-worst' : 'ft-climb-dot'}
            onMouseOver={() => onHoverStep?.(i)}
            onMouseOut={() => onHoverStep?.(null)}
          />
        ))}
        <line x1={0} x2={width} y1={height - 12} y2={height - 12} className="ft-axis-line" />
      </svg>
      <div className="ft-chart-scale">
        <span>{steps[0].activity}</span>
        <span className="ft-chart-legend">
          steepest climb at {steps[worst].activity} ({formatDuration(steps[worst].waitMs)})
        </span>
        <span>{formatDuration(total)}</span>
      </div>
    </div>
  );
}
