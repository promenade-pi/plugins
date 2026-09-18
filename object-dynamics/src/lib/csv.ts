/** CSV export for aggregated result sets — the family never invents a second
 * export mechanism; PNG/SVG figure export lives in `exportFigure.ts`, and this
 * is its tabular-data counterpart. */
export function exportCsv(rows: ReadonlyArray<object>, filename: string) {
  if (rows.length === 0) return;
  const data = rows as Array<Record<string, unknown>>;
  const columns = [...new Set(data.flatMap((r) => Object.keys(r)))];
  const escape = (v: unknown) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    columns.join(','),
    ...data.map((r) => columns.map((c) => escape(r[c])).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
