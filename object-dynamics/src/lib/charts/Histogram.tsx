/**
 * The family's one numeric-distribution chart: a plain vertical bar
 * histogram, used for the multiplicity distribution, activity-timing
 * elapsed-time distribution, and numeric attribute distributions. A
 * secondary/optional cumulative line (ECDF) can be overlaid — Activity
 * Timing turns it on; nothing else needs it.
 */
export function Histogram({ bins, height = 180, showCumulative = false, colorDomain, colorKey }: {
  bins: Array<{ label: string; count: number }>;
  height?: number;
  showCumulative?: boolean;
  colorDomain?: string;
  colorKey?: string;
}) {
  if (bins.length === 0) return null;
  const max = Math.max(1, ...bins.map((b) => b.count));
  const total = bins.reduce((s, b) => s + b.count, 0);
  let cum = 0;
  const cumPoints = bins.map((b) => { cum += b.count; return total ? cum / total : 0; });
  const barColor = colorDomain && colorKey ? promenade.color(colorDomain, colorKey) : 'var(--accent, #2563eb)';

  return (
    <div className="od-histogram" style={{ height }}>
      <div className="od-histogram-bars">
        {bins.map((b, i) => (
          <div key={i} className="od-histogram-col" title={`${b.label}: ${b.count.toLocaleString()} (${total ? Math.round((b.count / total) * 100) : 0}%)`}>
            <div className="od-histogram-bar" style={{ height: `${Math.max(1, (b.count / max) * 100)}%`, background: barColor }} />
          </div>
        ))}
        {showCumulative && (
          <svg className="od-histogram-ecdf" viewBox={`0 0 ${bins.length} 100`} preserveAspectRatio="none">
            <polyline
              fill="none" stroke="var(--warn, #b45309)" strokeWidth={1.5} vectorEffect="non-scaling-stroke"
              points={cumPoints.map((p, i) => `${i + 0.5},${100 - p * 100}`).join(' ')}
            />
          </svg>
        )}
      </div>
      <div className="od-histogram-labels">
        {bins.map((b, i) => <div key={i} className="od-histogram-label">{b.label}</div>)}
      </div>
    </div>
  );
}
