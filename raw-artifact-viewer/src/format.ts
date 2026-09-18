/** Compact byte sizes, the way a file listing wants them. */
export function fmtBytes(b: number | null | undefined): string {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Grouped digits. Row counts are the one number here that must stay exact. */
export function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Whether a DuckDB type should be read right-aligned.
 *
 * Values arrive already rendered as text (see `ParquetTable`), so alignment is
 * the only thing left carrying the distinction between a quantity and a label
 * — and a column of right-aligned numbers is legible in a way that a ragged
 * one is not.
 */
export function isNumericType(type: string): boolean {
  return /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL)/i
    .test(type.trim());
}
