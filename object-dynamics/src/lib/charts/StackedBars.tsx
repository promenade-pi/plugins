export interface StackedBarItem {
  label: string;
  segments: Array<{ key: string; value: number }>;
  /** Precomputed total, when it differs from the sum of `segments` (rare). */
  total?: number;
}

/**
 * The family's one stacked-bar chart, used both ways the spec asks for it:
 * horizontal (Type Signatures: signature × activity) and vertical
 * (Lifecycle Repetition: activity × repetition count). Segment colours come
 * from the host colour registry via `segmentColorDomain`, so the same
 * segment key (an activity name, a "2x" bucket) reads the same everywhere.
 * `percentage` renormalizes each bar's own segments to add up to 100%
 * instead of drawing raw counts. Segment colour comes from the host colour
 * registry when `segmentColorDomain` names one of its domains (an activity
 * name reads the same colour everywhere); otherwise `segmentColor` picks a
 * colour by key/index for a vocabulary the host doesn't register (a "2x"
 * repetition bucket), falling back to a small local palette.
 */
const FALLBACK_PALETTE = ['#2563eb', '#0ea5a3', '#b45309', '#7c3aed', '#dc2626', '#059669', '#c026d3'];

export function StackedBars({
  items, orientation, segmentColorDomain, segmentColor, percentage, height = 220,
}: {
  items: StackedBarItem[];
  orientation: 'horizontal' | 'vertical';
  segmentColorDomain?: string;
  segmentColor?: (key: string, index: number) => string;
  percentage?: boolean;
  height?: number;
}) {
  if (items.length === 0) return null;
  const totals = items.map((it) => it.total ?? it.segments.reduce((s, seg) => s + seg.value, 0));
  const maxTotal = Math.max(1, ...totals);
  const colorFor = (key: string, i: number) => (
    segmentColorDomain ? promenade.color(segmentColorDomain, key)
      : segmentColor ? segmentColor(key, i)
      : FALLBACK_PALETTE[i % FALLBACK_PALETTE.length]
  );

  const bar = (it: StackedBarItem, total: number) => {
    const denom = percentage ? Math.max(1, total) : maxTotal;
    return it.segments.map((seg, i) => {
      const raw = (seg.value / denom) * 100;
      return (
        <div
          key={i}
          className="od-stack-seg"
          title={`${seg.key}: ${seg.value.toLocaleString()}${percentage ? ` (${Math.round((seg.value / Math.max(1, total)) * 100)}%)` : ''}`}
          style={orientation === 'vertical'
            ? { height: `${raw}%`, background: colorFor(seg.key, i) }
            : { width: `${raw}%`, background: colorFor(seg.key, i) }}
        />
      );
    });
  };

  if (orientation === 'vertical') {
    return (
      <div className="od-stack-vertical" style={{ height }}>
        <div className="od-stack-vertical-bars">
          {items.map((it, i) => (
            <div key={i} className="od-stack-vcol">
              <div className="od-stack-vtrack">{bar(it, totals[i])}</div>
            </div>
          ))}
        </div>
        <div className="od-stack-vertical-labels">
          {items.map((it, i) => <div key={i} className="od-histogram-label">{it.label}</div>)}
        </div>
      </div>
    );
  }

  return (
    <div className="od-stack-horizontal">
      {items.map((it, i) => (
        <div className="od-stack-hrow" key={i}>
          <span className="od-barlist-label">{it.label}</span>
          <div className="od-stack-htrack">{bar(it, totals[i])}</div>
          <span className="od-barlist-value">{totals[i].toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

/** Legend for a `StackedBars` chart's segment vocabulary — every stacked
 * chart in the family shows one, so the segment→colour mapping is never
 * left implicit. */
export function StackedBarsLegend({ keys, segmentColorDomain, segmentColor }: {
  keys: string[];
  segmentColorDomain?: string;
  segmentColor?: (key: string, index: number) => string;
}) {
  const colorFor = (key: string, i: number) => (
    segmentColorDomain ? promenade.color(segmentColorDomain, key)
      : segmentColor ? segmentColor(key, i)
      : FALLBACK_PALETTE[i % FALLBACK_PALETTE.length]
  );
  return (
    <div className="od-legend">
      {keys.map((k, i) => (
        <span className="od-legend-item" key={k}>
          <span className="od-legend-swatch" style={{ background: colorFor(k, i) }} />{k}
        </span>
      ))}
    </div>
  );
}
