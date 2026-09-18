/** A single-series ranked horizontal bar list — categorical attribute
 * distributions, top-N breakdowns. Sorted by the caller; this only draws. */
export function BarList({ items, colorDomain }: {
  items: Array<{ label: string; value: number; hint?: string }>;
  colorDomain?: string;
}) {
  if (items.length === 0) return null;
  const max = Math.max(1, ...items.map((i) => i.value));
  const total = items.reduce((s, i) => s + i.value, 0);
  return (
    <div className="od-barlist">
      {items.map((it, i) => (
        <div className="od-barlist-row" key={i} title={it.hint}>
          <span className="od-barlist-label">{it.label}</span>
          <div className="od-barlist-track">
            <div
              className="od-barlist-fill"
              style={{ width: `${Math.max(2, (it.value / max) * 100)}%`, background: colorDomain ? promenade.color(colorDomain, it.label) : 'var(--accent, #2563eb)' }}
            />
          </div>
          <span className="od-barlist-value">{it.value.toLocaleString()}{total ? <span className="od-muted"> ({Math.round((it.value / total) * 100)}%)</span> : null}</span>
        </div>
      ))}
    </div>
  );
}
