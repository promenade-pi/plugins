/**
 * Everything this view knows about the log, it knows through `promenade.sql()`
 * — the single data door of a sandboxed view. A log never crosses the frame
 * boundary, so every statistic the terrain is built from is aggregated in
 * DuckDB and only the aggregate travels.
 *
 * One fragment, `entityStream()`, is shared by every query: the log's events
 * partitioned into the lifecycles whose *gaps* are what "friction" means here
 * — cases for a classic log, objects for an OCEL. Waiting time is defined
 * once, in that fragment, as the gap since the entity's previous event, so
 * the terrain, the drill-downs and the case routes cannot disagree about it.
 */
import type { ActivityStat, EdgeStat, Overview, TopographyData, ViewParams } from './types';

/** Cap on the intervals the concurrency range join considers. */
const QUEUE_SAMPLE = 20000;

export interface Ctx {
  tables: Record<string, string>;
  objectCentric: boolean;
  params: ViewParams;
}

function sqlString(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}
function sqlList(values: readonly string[]): string {
  return values.map(sqlString).join(', ');
}
function num(value: unknown): number {
  if (value == null) return NaN;
  return typeof value === 'bigint' ? Number(value) : Number(value);
}
function n0(value: unknown): number {
  const x = num(value);
  return Number.isFinite(x) ? x : 0;
}
function str(value: unknown, fallback = '(none)'): string {
  return value == null ? fallback : String(value);
}

function timeBound(value: string, endOfDay: boolean): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const padded = endOfDay && /^\d{4}-\d\d-\d\d$/.test(text) ? `${text}T23:59:59.999Z` : text;
  const time = Date.parse(padded);
  return Number.isFinite(time) ? time : null;
}

/*
 * A note on `sum()`.
 *
 * DuckDB widens `sum(BIGINT)` to `HUGEINT`, and a 128-bit integer has no
 * columnar form the host's Arrow bridge can hand a plugin (`toColumns` in
 * `app/src/ui/PluginPanel.tsx` transfers typed arrays and stringifies
 * everything else), so it arrives as text that does not parse - every total
 * silently reads zero. Millisecond sums are therefore cast to DOUBLE in SQL.
 * A double holds an exact integer to 2^53 ms, which is a quarter of a million
 * years of waiting time.
 */

/**
 * The shared `stream` relation: one row per event, carrying the entity it
 * belongs to, its position in that entity's life, and the wait that preceded
 * it.
 *
 * `wait_ms` is NULL on an entity's first event on purpose. A first event has
 * no observed waiting time — imputing zero would drag every start activity's
 * median toward the floor and make the process's entry points look
 * artificially frictionless, which is exactly the kind of averaged-away lie
 * the terrain is supposed to expose.
 */
export function entityStream(ctx: Ctx): string {
  const { tables, objectCentric, params } = ctx;
  const start = timeBound(params.timeStart, false);
  const end = timeBound(params.timeEnd, true);
  const timeFilter =
    (start == null ? '' : ` AND epoch_ms(e.ts) >= ${start}`) +
    (end == null ? '' : ` AND epoch_ms(e.ts) <= ${end}`);

  let base: string;
  if (objectCentric) {
    const types = (params.objectTypes ?? []).filter(Boolean);
    const typeFilter = types.length ? ` AND o.object_type IN (${sqlList(types)})` : '';
    base =
      `SELECT r.object_id AS entity, e.activity AS act, epoch_ms(e.ts) AS t, ` +
      `e.event_id AS ord, CAST(NULL AS VARCHAR) AS res, e.event_id AS ev_id ` +
      `FROM ${tables.event} e ` +
      `JOIN ${tables.e2o} r ON r.event_id = e.event_id ` +
      `JOIN ${tables.object} o ON o.object_id = r.object_id ` +
      `WHERE e.ts IS NOT NULL AND e.activity IS NOT NULL${typeFilter}${timeFilter}`;
  } else {
    base =
      `SELECT CAST(e.trace_idx AS VARCHAR) AS entity, e.activity AS act, epoch_ms(e.ts) AS t, ` +
      `CAST(e.event_idx AS VARCHAR) AS ord, e.resource AS res, CAST(e.event_idx AS VARCHAR) AS ev_id ` +
      `FROM ${tables.event} e ` +
      `WHERE e.ts IS NOT NULL AND e.activity IS NOT NULL${timeFilter}`;
  }

  return (
    `raw AS (${base}), ` +
    `stream AS (SELECT entity, act, t, ord, res, ev_id, ` +
    `LAG(act) OVER w AS prev_act, ` +
    `LEAD(act) OVER w AS next_act, ` +
    `t - LAG(t) OVER w AS wait_ms, ` +
    `ROW_NUMBER() OVER w AS pos, ` +
    `COUNT(*) OVER (PARTITION BY entity) AS entity_len ` +
    `FROM raw WINDOW w AS (PARTITION BY entity ORDER BY t, ord))`
  );
}

/** Restricts the terrain to a user-chosen subset of activities, if any. */
function activityFilter(params: ViewParams, column: string): string {
  const chosen = (params.activities ?? []).filter(Boolean);
  return chosen.length ? ` AND ${column} IN (${sqlList(chosen)})` : '';
}

export function activitiesSql(ctx: Ctx): string {
  const keep = activityFilter(ctx.params, 'act');
  return (
    `WITH ${entityStream(ctx)}, ` +
    `kept AS (SELECT * FROM stream WHERE TRUE${keep}), ` +
    // Rework is a per-entity fact ("did this entity go through A twice?"), so
    // it has to be counted per entity before it can be averaged over them.
    // Computed as its own relation and joined, rather than as a correlated
    // subquery over the grouping key: the join is portable, and its cost is
    // one pass instead of one pass per group.
    `per_entity AS (SELECT act, entity, COUNT(*) AS times FROM kept GROUP BY 1, 2), ` +
    `rework AS (SELECT act, ` +
    ` COUNT(*) FILTER (WHERE times > 1) * 1.0 / NULLIF(COUNT(*), 0) AS rework_rate ` +
    ` FROM per_entity GROUP BY 1), ` +
    `agg AS (SELECT act, ` +
    `COUNT(*) AS occurrences, ` +
    `COUNT(DISTINCT entity) AS entities, ` +
    `COUNT(*) FILTER (WHERE pos = 1) AS starts, ` +
    `COUNT(*) FILTER (WHERE next_act IS NULL) AS ends, ` +
    `COUNT(*) FILTER (WHERE prev_act = act) AS self_loops, ` +
    `COALESCE(median(wait_ms), 0) AS median_wait, ` +
    `COALESCE(quantile_cont(wait_ms, 0.9), 0) AS p90_wait, ` +
    `COALESCE(avg(wait_ms), 0) AS mean_wait, ` +
    `COALESCE(min(wait_ms), 0) AS min_wait, ` +
    `COALESCE(max(wait_ms), 0) AS max_wait, ` +
    `COALESCE(CAST(sum(wait_ms) AS DOUBLE), 0) AS total_wait, ` +
    `COALESCE(median(pos), 1) AS median_pos ` +
    `FROM kept GROUP BY 1) ` +
    `SELECT a.act AS activity, a.occurrences, a.entities, a.starts, a.ends, a.self_loops, ` +
    `a.median_wait, a.p90_wait, a.mean_wait, a.min_wait, a.max_wait, a.total_wait, a.median_pos, ` +
    `COALESCE(r.rework_rate, 0) AS rework_rate ` +
    `FROM agg a LEFT JOIN rework r ON r.act = a.act ` +
    `ORDER BY a.occurrences DESC, activity`
  );
}

export function edgesSql(ctx: Ctx): string {
  const keepSource = activityFilter(ctx.params, 'prev_act');
  const keepTarget = activityFilter(ctx.params, 'act');
  return (
    `WITH ${entityStream(ctx)} ` +
    `SELECT prev_act AS source, act AS target, ` +
    `COUNT(*) AS n, COUNT(DISTINCT entity) AS entities, ` +
    `COALESCE(median(wait_ms), 0) AS median_ms, ` +
    `COALESCE(quantile_cont(wait_ms, 0.9), 0) AS p90_ms, ` +
    `COALESCE(CAST(sum(wait_ms) AS DOUBLE), 0) AS total_ms ` +
    `FROM stream WHERE prev_act IS NOT NULL${keepSource}${keepTarget} ` +
    `GROUP BY 1, 2 ORDER BY n DESC`
  );
}

export function overviewSql(ctx: Ctx): string {
  return (
    `WITH ${entityStream(ctx)}, ` +
    `lives AS (SELECT entity, min(t) AS t0, max(t) AS t1 FROM stream GROUP BY 1) ` +
    `SELECT (SELECT COUNT(*) FROM lives) AS entities, ` +
    `(SELECT COUNT(*) FROM stream) AS events, ` +
    `(SELECT COUNT(DISTINCT act) FROM stream) AS activities, ` +
    `(SELECT COALESCE(median(t1 - t0), 0) FROM lives) AS median_cycle, ` +
    `(SELECT COALESCE(quantile_cont(t1 - t0, 0.9), 0) FROM lives) AS p90_cycle, ` +
    `(SELECT COALESCE(min(t0), 0) FROM lives) AS first_ms, ` +
    `(SELECT COALESCE(max(t1), 0) FROM lives) AS last_ms, ` +
    `(SELECT COALESCE(CAST(sum(wait_ms) AS DOUBLE), 0) FROM stream) AS total_wait`
  );
}

export async function loadTopography(ctx: Ctx): Promise<TopographyData> {
  const [actRes, edgeRes, ovRes] = await Promise.all([
    promenade.sql(activitiesSql(ctx)),
    promenade.sql(edgesSql(ctx)),
    promenade.sql(overviewSql(ctx)),
  ]);

  const ac = actRes.columns;
  const activities: ActivityStat[] = [];
  for (let i = 0; i < actRes.numRows; i++) {
    activities.push({
      activity: str(ac.activity[i]),
      occurrences: n0(ac.occurrences[i]),
      entities: n0(ac.entities[i]),
      starts: n0(ac.starts[i]),
      ends: n0(ac.ends[i]),
      selfLoops: n0(ac.self_loops[i]),
      medianWait: n0(ac.median_wait[i]),
      p90Wait: n0(ac.p90_wait[i]),
      meanWait: n0(ac.mean_wait[i]),
      minWait: n0(ac.min_wait[i]),
      maxWait: n0(ac.max_wait[i]),
      totalWait: n0(ac.total_wait[i]),
      reworkRate: n0(ac.rework_rate[i]),
      medianPos: n0(ac.median_pos[i]) || 1,
    });
  }

  const ec = edgeRes.columns;
  const edges: EdgeStat[] = [];
  for (let i = 0; i < edgeRes.numRows; i++) {
    edges.push({
      source: str(ec.source[i]),
      target: str(ec.target[i]),
      count: n0(ec.n[i]),
      entities: n0(ec.entities[i]),
      medianMs: n0(ec.median_ms[i]),
      p90Ms: n0(ec.p90_ms[i]),
      totalMs: n0(ec.total_ms[i]),
    });
  }

  const oc = ovRes.columns;
  const overview: Overview = {
    entities: n0(oc.entities?.[0]),
    events: n0(oc.events?.[0]),
    activities: n0(oc.activities?.[0]),
    medianCycleMs: n0(oc.median_cycle?.[0]),
    p90CycleMs: n0(oc.p90_cycle?.[0]),
    firstMs: n0(oc.first_ms?.[0]),
    lastMs: n0(oc.last_ms?.[0]),
    totalWaitMs: n0(oc.total_wait?.[0]),
  };

  return { overview, activities, edges, objectCentric: ctx.objectCentric };
}

/* ------------------------------------------------------------------ *
 * Drill-down: everything behind a click on a peak.
 * ------------------------------------------------------------------ */

export interface WaitSample {
  waits: number[];
}

/** Raw waits at one activity, for a distribution the aggregate cannot show. */
export async function loadWaits(ctx: Ctx, activity: string, limit = 40000): Promise<number[]> {
  const sql =
    `WITH ${entityStream(ctx)} ` +
    `SELECT wait_ms FROM stream WHERE act = ${sqlString(activity)} AND wait_ms IS NOT NULL ` +
    `USING SAMPLE ${limit} ROWS`;
  const res = await promenade.sql(sql);
  const out: number[] = [];
  const col = res.columns.wait_ms;
  for (let i = 0; i < res.numRows; i++) {
    const value = num(col[i]);
    if (Number.isFinite(value) && value >= 0) out.push(value);
  }
  return out;
}

export interface Breakdown {
  key: string;
  n: number;
  medianWait: number;
  p90Wait: number;
  totalWait: number;
}

function breakdownRows(res: Awaited<ReturnType<typeof promenade.sql>>): Breakdown[] {
  const c = res.columns;
  const out: Breakdown[] = [];
  for (let i = 0; i < res.numRows; i++) {
    out.push({
      key: str(c.key[i]),
      n: n0(c.n[i]),
      medianWait: n0(c.median_wait[i]),
      p90Wait: n0(c.p90_wait[i]),
      totalWait: n0(c.total_wait[i]),
    });
  }
  return out;
}

/**
 * How the wait at one activity splits by a chosen dimension.
 *
 * These are the questions a 2D performance-annotated model cannot answer at
 * all: the peak says *that* the process stalls here, and only the split says
 * whether it stalls for everyone, for one hand-off, for one team, or only at
 * certain hours.
 */
export type Dimension = 'predecessor' | 'resource' | 'hour' | 'weekday' | 'position';

export function dimensionExpression(dim: Dimension): string {
  switch (dim) {
    case 'predecessor': return `COALESCE(prev_act, '(start of case)')`;
    case 'resource': return `COALESCE(res, '(no resource)')`;
    case 'hour': return `lpad(CAST(hour(to_timestamp(t / 1000.0)) AS VARCHAR), 2, '0') || ':00'`;
    case 'weekday': return `dayname(to_timestamp(t / 1000.0))`;
    case 'position': return `CASE WHEN pos = 1 THEN 'first step' WHEN pos <= 3 THEN 'step 2-3' WHEN pos <= 6 THEN 'step 4-6' ELSE 'step 7+' END`;
  }
}

export async function loadBreakdown(ctx: Ctx, activity: string, dim: Dimension): Promise<Breakdown[]> {
  const sql =
    `WITH ${entityStream(ctx)} ` +
    `SELECT ${dimensionExpression(dim)} AS key, COUNT(*) AS n, ` +
    `COALESCE(median(wait_ms), 0) AS median_wait, ` +
    `COALESCE(quantile_cont(wait_ms, 0.9), 0) AS p90_wait, ` +
    `COALESCE(CAST(sum(wait_ms) AS DOUBLE), 0) AS total_wait ` +
    `FROM stream WHERE act = ${sqlString(activity)} ` +
    `GROUP BY 1 ORDER BY total_wait DESC LIMIT 24`;
  return breakdownRows(await promenade.sql(sql));
}

/** Case attribute keys available for a per-value wait breakdown. */
export async function loadAttributeKeys(ctx: Ctx): Promise<string[]> {
  const table = ctx.objectCentric ? ctx.tables.object_attr : ctx.tables.trace_attr;
  if (!table) return [];
  const column = ctx.objectCentric ? 'name' : 'key';
  const res = await promenade.sql(
    `SELECT ${column} AS key, COUNT(*) AS n FROM ${table} GROUP BY 1 ` +
    `HAVING COUNT(DISTINCT value) BETWEEN 2 AND 40 ORDER BY n DESC LIMIT 30`
  );
  const out: string[] = [];
  for (let i = 0; i < res.numRows; i++) out.push(str(res.columns.key[i]));
  return out;
}

/** Wait at one activity, split by the value of one case/object attribute. */
export async function loadAttributeBreakdown(
  ctx: Ctx, activity: string, key: string
): Promise<Breakdown[]> {
  const attrTable = ctx.objectCentric ? ctx.tables.object_attr : ctx.tables.trace_attr;
  if (!attrTable) return [];
  const join = ctx.objectCentric
    ? `LEFT JOIN ${attrTable} a ON a.object_id = s.entity AND a.name = ${sqlString(key)}`
    : `LEFT JOIN ${attrTable} a ON CAST(a.trace_idx AS VARCHAR) = s.entity AND a.key = ${sqlString(key)}`;
  const sql =
    `WITH ${entityStream(ctx)} ` +
    `SELECT COALESCE(a.value, '(unset)') AS key, COUNT(*) AS n, ` +
    `COALESCE(median(s.wait_ms), 0) AS median_wait, ` +
    `COALESCE(quantile_cont(s.wait_ms, 0.9), 0) AS p90_wait, ` +
    `COALESCE(CAST(sum(s.wait_ms) AS DOUBLE), 0) AS total_wait ` +
    `FROM stream s ${join} WHERE s.act = ${sqlString(activity)} ` +
    `GROUP BY 1 ORDER BY total_wait DESC LIMIT 24`;
  return breakdownRows(await promenade.sql(sql));
}

export interface VariantRow {
  signature: string;
  activities: string[];
  entities: number;
  medianCycleMs: number;
  /** Wait contributed by the drilled-into activity, within this variant. */
  medianWaitHere: number;
  /** One entity id, so the variant can be drawn as a route. */
  exampleEntity: string;
}

/**
 * Variants, optionally only those that pass through one activity.
 *
 * A variant is the whole ordered activity sequence of an entity — the unit an
 * analyst actually reasons about ("which paths are stuck at this step?").
 */
export async function loadVariants(
  ctx: Ctx, activity: string | null, limit = 40
): Promise<VariantRow[]> {
  const focus = activity ? sqlString(activity) : null;
  const sql =
    `WITH ${entityStream(ctx)}, ` +
    `lives AS (SELECT entity, string_agg(act, ' » ' ORDER BY t, ord) AS signature, ` +
    ` max(t) - min(t) AS cycle_ms, ` +
    (focus
      ? ` COALESCE(median(CASE WHEN act = ${focus} THEN wait_ms END), 0) AS wait_here, ` +
        ` COUNT(*) FILTER (WHERE act = ${focus}) AS hits `
      : ` 0 AS wait_here, 1 AS hits `) +
    ` FROM stream GROUP BY entity) ` +
    `SELECT signature, COUNT(*) AS entities, ` +
    `COALESCE(median(cycle_ms), 0) AS median_cycle, ` +
    `COALESCE(median(wait_here), 0) AS median_wait_here, ` +
    `min(entity) AS example_entity ` +
    `FROM lives WHERE hits > 0 GROUP BY 1 ORDER BY entities DESC LIMIT ${limit}`;
  const res = await promenade.sql(sql);
  const c = res.columns;
  const out: VariantRow[] = [];
  for (let i = 0; i < res.numRows; i++) {
    const signature = str(c.signature[i], '');
    out.push({
      signature,
      activities: signature ? signature.split(' » ') : [],
      entities: n0(c.entities[i]),
      medianCycleMs: n0(c.median_cycle[i]),
      medianWaitHere: n0(c.median_wait_here[i]),
      exampleEntity: str(c.example_entity[i], ''),
    });
  }
  return out;
}

export interface CaseRow {
  entity: string;
  label: string;
  steps: number;
  cycleMs: number;
  /** Wait observed at the drilled-into activity in this entity. */
  waitHere: number;
}

/** The entities that waited longest at one activity — the worst offenders. */
export async function loadWorstCases(
  ctx: Ctx, activity: string, limit = 60
): Promise<CaseRow[]> {
  const label = ctx.objectCentric
    ? `s.entity`
    : `COALESCE(tr.case_id, s.entity)`;
  const join = ctx.objectCentric || !ctx.tables.trace
    ? ''
    : `LEFT JOIN ${ctx.tables.trace} tr ON CAST(tr.trace_idx AS VARCHAR) = s.entity `;
  const sql =
    `WITH ${entityStream(ctx)}, ` +
    `here AS (SELECT entity, max(wait_ms) AS wait_here FROM stream ` +
    ` WHERE act = ${sqlString(activity)} AND wait_ms IS NOT NULL GROUP BY 1), ` +
    `lives AS (SELECT entity, COUNT(*) AS steps, max(t) - min(t) AS cycle_ms FROM stream GROUP BY 1) ` +
    `SELECT s.entity AS entity, ${label} AS label, l.steps AS steps, l.cycle_ms AS cycle_ms, ` +
    `s.wait_here AS wait_here ` +
    `FROM here s JOIN lives l ON l.entity = s.entity ${join}` +
    `ORDER BY s.wait_here DESC LIMIT ${limit}`;
  const res = await promenade.sql(sql);
  const c = res.columns;
  const out: CaseRow[] = [];
  for (let i = 0; i < res.numRows; i++) {
    out.push({
      entity: str(c.entity[i], ''),
      label: str(c.label[i], ''),
      steps: n0(c.steps[i]),
      cycleMs: n0(c.cycle_ms[i]),
      waitHere: n0(c.wait_here[i]),
    });
  }
  return out;
}

export interface RouteStep {
  activity: string;
  t: number;
  waitMs: number;
  resource: string;
}

export interface CaseRoute {
  entity: string;
  label: string;
  steps: RouteStep[];
}

/** One entity's actual path, in order — the illuminated route on the terrain. */
export async function loadRoute(ctx: Ctx, entity: string): Promise<CaseRoute> {
  const sql =
    `WITH ${entityStream(ctx)} ` +
    `SELECT act, t, wait_ms, res FROM stream WHERE entity = ${sqlString(entity)} ` +
    `ORDER BY t, ord`;
  const res = await promenade.sql(sql);
  const c = res.columns;
  const steps: RouteStep[] = [];
  for (let i = 0; i < res.numRows; i++) {
    steps.push({
      activity: str(c.act[i]),
      t: n0(c.t[i]),
      waitMs: n0(c.wait_ms[i]),
      resource: str(c.res[i], ''),
    });
  }
  let label = entity;
  if (!ctx.objectCentric && ctx.tables.trace) {
    try {
      const nameRes = await promenade.sql(
        `SELECT case_id FROM ${ctx.tables.trace} WHERE CAST(trace_idx AS VARCHAR) = ${sqlString(entity)} LIMIT 1`
      );
      if (nameRes.numRows > 0) label = str(nameRes.columns.case_id[0], entity);
    } catch {
      /* A log without a case_id column keeps the ingest id as its label. */
    }
  }
  return { entity, label, steps };
}

/**
 * Concurrency at one activity: how many entities were waiting for it at the
 * same time, bucketed over the log's calendar.
 *
 * This is the difference between "each case waits 14 hours because the step
 * itself takes 14 hours" and "each case waits 14 hours because thirty of them
 * are queued in front of it" - the same median, two entirely different fixes.
 *
 * The bucketing happens in SQL rather than by pulling the intervals across the
 * frame boundary: the host hands a plugin one column per field (`toColumns` in
 * `app/src/ui/PluginPanel.tsx`), and a `LIST` column has no columnar form
 * there, so it would arrive stringified. Counting overlaps is a range join,
 * which is what the database is for anyway.
 */
export async function loadQueueDepth(
  ctx: Ctx, activity: string, buckets = 80
): Promise<{ tMin: number; tMax: number; depth: number[]; peak: number; mean: number }> {
  const sql =
    `WITH ${entityStream(ctx)}, ` +
    `waits AS (SELECT t - wait_ms AS t0, t AS t1 FROM stream ` +
    ` WHERE act = ${sqlString(activity)} AND wait_ms IS NOT NULL AND wait_ms > 0), ` +
    `sampled AS (SELECT * FROM waits USING SAMPLE ${QUEUE_SAMPLE} ROWS), ` +
    `span AS (SELECT min(t0) AS lo, max(t1) AS hi FROM sampled), ` +
    `grid AS (SELECT i, ` +
    ` (SELECT lo FROM span) + i * ((SELECT hi FROM span) - (SELECT lo FROM span)) / ${buckets}.0 AS b_lo, ` +
    ` (SELECT lo FROM span) + (i + 1) * ((SELECT hi FROM span) - (SELECT lo FROM span)) / ${buckets}.0 AS b_hi ` +
    ` FROM range(0, ${buckets}) t(i)) ` +
    `SELECT g.i AS bucket, COUNT(w.t0) AS depth, ` +
    `(SELECT lo FROM span) AS lo, (SELECT hi FROM span) AS hi ` +
    `FROM grid g LEFT JOIN sampled w ON w.t0 < g.b_hi AND w.t1 >= g.b_lo ` +
    `GROUP BY 1 ORDER BY 1`;
  const res = await promenade.sql(sql);
  const depth = new Array<number>(buckets).fill(0);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < res.numRows; i++) {
    const bucket = n0(res.columns.bucket[i]);
    if (bucket >= 0 && bucket < buckets) depth[bucket] = n0(res.columns.depth[i]);
    lo = n0(res.columns.lo[i]);
    hi = n0(res.columns.hi[i]);
  }
  const peak = depth.reduce((m, v) => Math.max(m, v), 0);
  const mean = depth.reduce((sum, v) => sum + v, 0) / buckets;
  return { tMin: lo, tMax: hi, depth, peak, mean };
}
