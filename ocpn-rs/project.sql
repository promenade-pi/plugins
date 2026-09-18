-- Projects an ObjectCentricEventLog onto every selected object type at
-- once, into one combined TraditionalEventLog-shaped result the mining
-- action's generic wasm dispatch scans directly. See
-- plugins/ocpn-rs/docs/architecture.md's "WASM data boundary" section for
-- why this is one combined case-id space rather than one artifact per type.
--
-- `:objectTypes` is never empty by the time it reaches this query — an empty
-- picker selection is resolved to the full type list before binding, by
-- `host/plugins/runtimeAdapters.ts`'s `relationalActionRuntime` (DuckDB-Wasm
-- cannot infer a bound parameter's type from an empty list, so this SQL
-- never has to special-case one). The parameter's order is retained: the
-- mining kernel receives that same list from the projected artifact's meta
-- and uses its position to recover the object type from each trace id.
--
-- trace_idx encodes which object type a case belongs to directly in the
-- number: `type_idx * 8000000 + local_ordinal`. `plugins/ocpn-rs/src/lib.rs`
-- decodes it the same way (`case_id.div_euclid(8_000_000)`) — the two sides
-- of this constant are documented together, not duplicated by accident.
-- Eight million objects per type keeps the packed index inside the signed
-- 32-bit range even for 268 selected object types. `type_idx` is the one-based
-- position of the type in `:objectTypes`, minus one. This must not be replaced with an alphabetical rank: the picker
-- resolves an empty selection in frequency order, and the Rust kernel decodes
-- the case id using that preserved parameter order.

-- @output cases
SELECT
  CAST(
    (list_position(string_split(:objectTypes, chr(31)), o.object_type) - 1) * 8000000
      + (ROW_NUMBER() OVER (PARTITION BY o.object_type ORDER BY o.object_id) - 1)
    AS INTEGER
  ) AS trace_idx,
  o.object_id AS case_id
FROM {log.objects} o
WHERE o.object_type = ANY(string_split(:objectTypes, chr(31)))

-- @output events
SELECT
  ROW_NUMBER() OVER (ORDER BY c.trace_idx, e.ts, e.event_id) - 1 AS event_idx,
  c.trace_idx AS trace_idx,
  e.activity AS activity,
  e.ts AS ts,
  CAST(NULL AS VARCHAR) AS lifecycle,
  CAST(NULL AS VARCHAR) AS resource
FROM {log.event_object} r
JOIN cases c ON c.case_id = r.object_id
JOIN {log.events} e ON e.event_id = r.event_id

-- Not part of the projected log's own schema (`TraditionalEventLog` has no
-- "variableMultiplicity" relation) — an auxiliary fact only computable here,
-- from the *original* OCEL log's event-object relation, before this action's
-- own output collapses each object type down to a one-object-per-case
-- projection that can no longer tell "this event touched one Item" from
-- "this event touched three". Recorded into the projected artifact's `meta`
-- (see `materializeRelationalLog` in `worker/data-worker.ts`) and forwarded
-- to the mining action's own `variableMultiplicity` param generically, the
-- same upstream-meta-over-param rule `objectTypes` already uses (see
-- `wasmActionRuntime` in `host/plugins/runtimeAdapters.ts`).
--
-- An (object_type, activity) pair is variable when at least one event of
-- that activity touched more than one object of that type.
-- @output variableMultiplicity
SELECT object_type, activity
FROM (
  SELECT r.event_id AS event_id, o.object_type AS object_type, e.activity AS activity,
         COUNT(DISTINCT r.object_id) AS n
  FROM {log.event_object} r
  JOIN {log.events} e ON e.event_id = r.event_id
  JOIN {log.objects} o ON o.object_id = r.object_id
  WHERE o.object_type = ANY(string_split(:objectTypes, chr(31)))
  GROUP BY r.event_id, o.object_type, e.activity
) per_event
WHERE n > 1
GROUP BY object_type, activity
