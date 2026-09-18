export interface Metric { label: string; value: string; title?: string }

/** The one summary-stat strip every view uses above its primary chart —
 * "ViewSummaryMetrics" from the shared-component list: min/median/max,
 * matched/unmatched, whatever the view's own semantics call for, always
 * rendered the same way. */
export function ViewSummaryMetrics({ metrics }: { metrics: Metric[] }) {
  if (metrics.length === 0) return null;
  return (
    <div className="od-metrics">
      {metrics.map((m) => (
        <div className="od-metric" key={m.label} title={m.title}>
          <div className="od-metric-value">{m.value}</div>
          <div className="od-metric-label">{m.label}</div>
        </div>
      ))}
    </div>
  );
}
