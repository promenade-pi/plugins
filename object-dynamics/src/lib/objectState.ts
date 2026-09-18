import { queryTables } from './sql';
import { usToIso, escapeLiteral } from './sql';

/**
 * The reusable dynamic-object-state service (Object Dynamics spec §14).
 *
 * Both the Attribute History view and the object-attribute mode of
 * Attribute Distribution need the same semantics for "what value did this
 * object's attribute hold at a point in time" — this module is the one place
 * that logic is written, in SQL, against `object_attributes`
 * (`{object_attr}`: object_id, name, value, ts). Per the relational schema
 * (`host/relational/schemas.ts`), static and time-varying attributes are not
 * separated: an attribute is time-varying precisely when an object carries
 * more than one row for it, and its per-row `ts` is nullable.
 *
 * Convention (never exposed to callers as a raw sentinel): a NULL `ts` reads
 * as "valid from the start of the object's lifecycle" — sorted and compared
 * as if it were -infinity — never as a literal epoch timestamp. This is the
 * "initial state" the product spec asks for, expressed as "no earlier value
 * beats it", not as a magic date.
 */

export interface HistoryEntry {
  /** ISO-8601. For an `attribute`-kind entry with no event at the exact same
   * instant, this is the attribute row's own timestamp (or the object's
   * earliest known instant, for the initial value of an object with no
   * dated history at all — see `getObjectAttributeHistory`). */
  timestamp: string;
  eventId: string | null;
  eventActivity: string | null;
  kind: 'initial' | 'change' | 'event';
  /** Set for kind 'initial' | 'change'. */
  attribute?: string;
  previousValue?: string | null;
  newValue?: string | null;
}

/**
 * Latest value at or before `timestampIso` for each requested attribute
 * (all recorded attributes if `attributes` is omitted) — one bulk query, not
 * one round trip per attribute.
 */
export async function getObjectStateAt(
  objectId: string, timestampIso: string, attributes?: string[],
): Promise<Record<string, string | null>> {
  const attrFilter = attributes && attributes.length > 0
    ? `AND name IN (${attributes.map(escapeLiteral).join(',')})` : '';
  const rows = await queryTables<{ name: string; value: string | null }>(`
    SELECT name, value FROM (
      SELECT name, value, ts,
        ROW_NUMBER() OVER (PARTITION BY name ORDER BY (ts IS NULL) ASC, ts DESC) AS rn
      FROM {object_attr}
      WHERE object_id = ${escapeLiteral(objectId)}
        AND (ts IS NULL OR ts <= TIMESTAMP '${new Date(timestampIso).toISOString().replace('T', ' ').replace('Z', '')}')
        ${attrFilter}
    ) WHERE rn = 1
  `);
  const out: Record<string, string | null> = {};
  for (const r of rows) out[r.name] = r.value;
  return out;
}

/**
 * Full attribute history for one object, merged with related events per
 * `entries` mode (Object Dynamics spec §14):
 *
 * - `changes`: the initial value and every recorded change, nothing else.
 * - `object_events`: `changes` plus every event this object directly
 *   participates in (via `event_object`).
 * - `all_events`: `object_events` plus the events of objects one hop away
 *   via a declared object-to-object relation (`object_object`) — sibling
 *   and parent/child context, not literally every event in the log (an
 *   unbounded, unscoped "all events" would defeat the point of looking at
 *   one object's lifecycle). This is an explicit product decision, not an
 *   accident of the query — documented in `docs/object-dynamics.md`.
 *
 * A change row's "initial value" is the earliest row for that attribute name
 * (NULL-`ts` first); every later row is `previousValue -> newValue` via
 * `LAG`, computed in SQL rather than reconstructed in React.
 */
export async function getObjectAttributeHistory(
  objectId: string,
  attributes: string[] | undefined,
  entries: 'changes' | 'object_events' | 'all_events',
): Promise<HistoryEntry[]> {
  const idLit = escapeLiteral(objectId);
  const attrFilter = attributes && attributes.length > 0
    ? `AND name IN (${attributes.map(escapeLiteral).join(',')})` : '';

  const changeRows = await queryTables<{ name: string; value: string | null; ts: number | null; prev: string | null }>(`
    SELECT name, value, ts, LAG(value) OVER (PARTITION BY name ORDER BY (ts IS NULL) DESC, ts ASC) AS prev
    FROM {object_attr}
    WHERE object_id = ${idLit} ${attrFilter}
    ORDER BY (ts IS NULL) DESC, ts ASC
  `);

  // An undated (NULL-ts) row has no real instant to place on a timeline; it
  // is anchored to the object's earliest known moment instead (its first
  // related event, or otherwise just before its first dated attribute row),
  // so "initial state" always renders at the very start of the history
  // rather than being silently dropped or sorted as an arbitrary date.
  let anchor: string | null = null;
  const anchorFor = async (): Promise<string> => {
    if (anchor) return anchor;
    const firstDated = changeRows.find((r) => r.ts != null);
    const firstEvent = await queryTables<{ ts: number }>(`
      SELECT MIN(e.ts) AS ts FROM {e2o} r JOIN {event} e ON e.event_id = r.event_id WHERE r.object_id = ${idLit}
    `);
    const candidates = [
      firstDated ? Number(firstDated.ts) : null,
      firstEvent[0]?.ts != null ? Number(firstEvent[0].ts) : null,
    ].filter((v): v is number => v != null);
    anchor = candidates.length > 0 ? usToIso(Math.min(...candidates))! : new Date(0).toISOString();
    return anchor;
  };

  const entriesOut: HistoryEntry[] = [];
  for (const r of changeRows) {
    entriesOut.push({
      timestamp: r.ts != null ? usToIso(r.ts)! : await anchorFor(),
      eventId: null, eventActivity: null,
      kind: r.prev == null ? 'initial' : 'change',
      attribute: r.name, previousValue: r.prev ?? null, newValue: r.value,
    });
  }

  if (entries !== 'changes') {
    const objectIds = [idLit];
    if (entries === 'all_events') {
      const neighbours = await queryTables<{ id: string }>(`
        SELECT target_id AS id FROM {o2o} WHERE source_id = ${idLit}
        UNION SELECT source_id AS id FROM {o2o} WHERE target_id = ${idLit}
      `);
      for (const n of neighbours) objectIds.push(escapeLiteral(n.id));
    }
    const eventRows = await queryTables<{ event_id: string; activity: string; ts: number }>(`
      SELECT DISTINCT e.event_id, e.activity, e.ts
      FROM {e2o} r JOIN {event} e ON e.event_id = r.event_id
      WHERE r.object_id IN (${objectIds.join(',')})
      ORDER BY e.ts
    `);
    for (const e of eventRows) {
      entriesOut.push({ timestamp: usToIso(e.ts)!, eventId: e.event_id, eventActivity: e.activity, kind: 'event' });
    }
  }

  entriesOut.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return entriesOut;
}

/** Attribute names actually recorded for objects of a given type — ground
 * truth from the data, not just the declared schema (which may be stale or
 * absent for an imported/derived log). */
export async function getObjectAttributeNames(objectType: string): Promise<string[]> {
  const rows = await queryTables<{ name: string }>(`
    SELECT DISTINCT a.name FROM {object_attr} a JOIN {object} o ON o.object_id = a.object_id
    WHERE o.object_type = ${escapeLiteral(objectType)} ORDER BY 1
  `);
  return rows.map((r) => r.name);
}

/** Event attribute names actually recorded for one or more activities
 * (all activities if `activities` is omitted). */
export async function getEventAttributeNames(activities?: string[]): Promise<string[]> {
  const filter = activities && activities.length > 0
    ? `WHERE e.activity IN (${activities.map(escapeLiteral).join(',')})` : '';
  const rows = await queryTables<{ name: string }>(`
    SELECT DISTINCT a.name FROM {event_attr} a JOIN {event} e ON e.event_id = a.event_id
    ${filter} ORDER BY 1
  `);
  return rows.map((r) => r.name);
}
