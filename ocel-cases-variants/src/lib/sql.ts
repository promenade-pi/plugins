/**
 * Small SQL helpers shared by every view. `promenade.sql()` is a plain
 * string in, columnar Arrow-ish rows out — there is no parameterisation, so
 * every value that isn't a manifest-declared enum has to be escaped by hand
 * (the single-quote doubling below), same as the host's own dotted-chart
 * example plugin does for its object-type filter.
 */

export function escapeLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A raw DuckDB `TIMESTAMP` column crosses the plugin boundary as a plain
 * number of **microseconds** since epoch — Arrow's native timestamp unit,
 * converted from BigInt64 to Float64 verbatim by the host's `toColumns()`,
 * with no unit conversion. (`epoch_ms(...)` inside SQL returns real
 * milliseconds and needs no conversion — this is only for a `ts` column
 * selected as-is.) `null` passes through unchanged.
 */
export function usToIso(raw: unknown): string | null {
  if (raw == null) return null;
  return new Date(Number(raw) / 1000).toISOString();
}

/** Expands `{event}`, `{object}`, `{o2o}` etc. in a SQL template to the
 * artifact's real (per-artifact-namespaced) DuckDB table names — the only
 * sanctioned way to resolve a logical table name from inside a plugin. */
export function resolveTables(sql: string): string {
  const tables = promenade.artifact().tables;
  return sql.replace(/\{(\w+)\}/g, (_, logical) => {
    const real = tables[logical];
    if (!real) throw new Error(`Unknown logical table "${logical}"`);
    return real;
  });
}

/** `resolveTables` + `query` in one call — the common case everywhere. */
export async function queryTables<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return query<T>(resolveTables(sql));
}

/** Row-major view over `promenade.sql()`'s columnar result — every view here
 * wants "an array of plain objects", not typed columns to zip by hand. */
export async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const res = await promenade.sql(sql);
  const cols = Object.keys(res.columns);
  const out: T[] = new Array(res.numRows);
  for (let i = 0; i < res.numRows; i++) {
    const row: Record<string, unknown> = {};
    for (const c of cols) row[c] = (res.columns[c] as any[])[i];
    out[i] = row as T;
  }
  return out;
}

export async function queryOne<T = Record<string, unknown>>(sql: string): Promise<T | null> {
  const rows = await query<T>(sql);
  return rows[0] ?? null;
}

/** `SELECT COUNT(*) AS n FROM (...)` shape used by every pager. */
export async function count(sql: string): Promise<number> {
  const row = await queryOne<{ n: number | bigint }>(sql);
  return row ? Number(row.n) : 0;
}

/** Debounces search-box/param changes before they trigger a requery — same
 * 140ms idiom `dotted-chart` uses for its own range-slider requeries. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer = 0;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms) as unknown as number;
  };
}

/** A query whose result is only ever wanted if it's still the latest one
 * in flight — every paginated table needs this so a fast page-click or
 * keystroke can't let a stale, slower response paint over a newer one. */
export function makeLatestOnly() {
  let revision = 0;
  return function guard<T>(promise: Promise<T>, onResult: (value: T) => void) {
    const mine = ++revision;
    promise.then((value) => { if (mine === revision) onResult(value); });
  };
}
