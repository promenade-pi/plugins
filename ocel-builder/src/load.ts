import { docFromLog, type LoadedLogRows } from './hydrate.ts';
import type { Doc } from './model.ts';

/**
 * Reading an existing log out of the host's DuckDB, for the "Edit log" view.
 *
 * Hand-editing is a whole-document operation: undo, validation, referential
 * repair and publishing all reason about the log as one value, so the rows
 * are loaded into the frame rather than paged from SQL as the user scrolls.
 * That is a deliberate trade with a limit attached — `EDIT_ROW_CAP` — because
 * the honest answer for a log of ten million events is not a slow editor, it
 * is that hand-editing is the wrong tool and a transformation is the right
 * one. Within the cap, the grid's own paging and search keep the DOM small;
 * beyond it, the panel says so and names the counts instead of trying.
 */

/** What `promenade.sql()` resolves to. */
interface SqlResult { numRows: number; columns: Record<string, ArrayLike<unknown>> }
type Sql = (query: string) => Promise<SqlResult>;

export interface LogTables {
  event?: string;
  object?: string;
  e2o?: string;
  o2o?: string;
  event_attr?: string;
  object_attr?: string;
}

/**
 * Rows a log may hold and still be editable by hand.
 *
 * Sized from what the editor has to do per row rather than from a guess: the
 * whole document is re-validated on every keystroke, and validation is linear
 * in the rows. At this cap that stays imperceptible; an order of magnitude
 * higher it would not.
 */
export const EDIT_ROW_CAP = 25_000;

export type LoadOutcome =
  | { ok: true; doc: Doc }
  | { ok: false; tooBig: { events: number; objects: number; cap: number } };

function text(result: SqlResult, column: string, i: number): string {
  const v = result.columns[column]?.[i];
  return v == null ? '' : String(v);
}

function num(result: SqlResult, column: string, i: number): number | null {
  const v = result.columns[column]?.[i];
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowsOf<T>(result: SqlResult, read: (i: number) => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < result.numRows; i++) out.push(read(i));
  return out;
}

/**
 * Loads a log into an editable document, or reports that it is too large.
 *
 * `epoch_ms()` on every timestamp, because that is the only form that
 * survives the boundary intact: a DuckDB timestamp arrives as a value whose
 * unit depends on the carrier, while a number of milliseconds is just a
 * number (the same reason the host's writer works in milliseconds).
 */
export async function loadLogDoc(
  input: { name: string; tables: LogTables; semantics?: LoadedLogRows['semantics'] },
  sql: Sql,
): Promise<LoadOutcome> {
  const { event, object, e2o, o2o, event_attr: eventAttr, object_attr: objectAttr } = input.tables;
  if (!event || !object) throw new Error('This log has no event or object table to read.');

  const counts = await sql(
    `SELECT (SELECT COUNT(*) FROM ${event}) AS events, (SELECT COUNT(*) FROM ${object}) AS objects`,
  );
  const events = num(counts, 'events', 0) ?? 0;
  const objects = num(counts, 'objects', 0) ?? 0;
  if (events > EDIT_ROW_CAP || objects > EDIT_ROW_CAP) {
    return { ok: false, tooBig: { events, objects, cap: EDIT_ROW_CAP } };
  }

  const [eventRows, objectRows, e2oRows, o2oRows, eventAttrRows, objectAttrRows] = await Promise.all([
    sql(`SELECT event_id, activity, epoch_ms(ts) AS ts_ms FROM ${event} ORDER BY ts NULLS LAST, event_id`),
    sql(`SELECT object_id, object_type FROM ${object} ORDER BY object_type, object_id`),
    e2o ? sql(`SELECT event_id, object_id, qualifier FROM ${e2o}`) : null,
    o2o ? sql(`SELECT source_id, target_id, qualifier FROM ${o2o}`) : null,
    eventAttr ? sql(`SELECT event_id, name, value FROM ${eventAttr}`) : null,
    objectAttr ? sql(`SELECT object_id, name, value, epoch_ms(ts) AS ts_ms FROM ${objectAttr} ORDER BY ts`) : null,
  ]);

  const empty: SqlResult = { numRows: 0, columns: {} };
  const rows: LoadedLogRows = {
    name: input.name,
    semantics: input.semantics ?? null,
    events: rowsOf(eventRows, (i) => ({
      event_id: text(eventRows, 'event_id', i),
      activity: text(eventRows, 'activity', i),
      ts: num(eventRows, 'ts_ms', i),
    })),
    objects: rowsOf(objectRows, (i) => ({
      object_id: text(objectRows, 'object_id', i),
      object_type: text(objectRows, 'object_type', i),
    })),
    e2o: rowsOf(e2oRows ?? empty, (i) => ({
      a: text(e2oRows!, 'event_id', i), b: text(e2oRows!, 'object_id', i),
      qualifier: text(e2oRows!, 'qualifier', i),
    })),
    o2o: rowsOf(o2oRows ?? empty, (i) => ({
      a: text(o2oRows!, 'source_id', i), b: text(o2oRows!, 'target_id', i),
      qualifier: text(o2oRows!, 'qualifier', i),
    })),
    eventAttrs: rowsOf(eventAttrRows ?? empty, (i) => ({
      owner: text(eventAttrRows!, 'event_id', i), name: text(eventAttrRows!, 'name', i),
      value: text(eventAttrRows!, 'value', i),
    })),
    objectAttrs: rowsOf(objectAttrRows ?? empty, (i) => ({
      owner: text(objectAttrRows!, 'object_id', i), name: text(objectAttrRows!, 'name', i),
      value: text(objectAttrRows!, 'value', i), ts: num(objectAttrRows!, 'ts_ms', i),
    })),
  };

  return { ok: true, doc: docFromLog(rows) };
}
