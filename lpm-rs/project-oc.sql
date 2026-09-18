-- Standard OCEL flattening by object type: one trace per object of the
-- selected type, its activity sequence being every event that object
-- participates in, ordered by timestamp. Mirrors `plugins/ocim-rs/project.sql`,
-- simplified to a single selected type (LPM discovery runs once per type,
-- not once for a combined selection).
--
-- `:objectType` defaults to `""` (a plain JSON-Schema `default`, resolved
-- before any parameter picker ever mounts) rather than relying on
-- `defaultFromOptions` — that only resolves once an `optionsFrom` control
-- actually renders, which never happens for an action run straight from the
-- "Available actions" list (see `host/actions/registry.ts`'s `defaultParams`,
-- which only reads `default`). An empty selection here falls back to the
-- single most frequent object type, so a first, unconfigured run still
-- produces something instead of failing to bind `:objectType` at all.
-- @output cases
WITH chosen AS (
  SELECT COALESCE(
    NULLIF(:objectType, ''),
    (SELECT object_type FROM {log.objects} GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1)
  ) AS object_type
)
SELECT CAST(ROW_NUMBER() OVER (ORDER BY o.object_id) - 1 AS INTEGER) AS trace_idx,
       o.object_id AS case_id
FROM {log.objects} o, chosen c
WHERE o.object_type = c.object_type

-- @output events
SELECT ROW_NUMBER() OVER (ORDER BY c.trace_idx, e.ts, e.event_id) - 1 AS event_idx,
       c.trace_idx, e.activity, e.ts, CAST(NULL AS VARCHAR) AS lifecycle, CAST(NULL AS VARCHAR) AS resource
FROM {log.event_object} r
JOIN cases c ON c.case_id = r.object_id
JOIN {log.events} e ON e.event_id = r.event_id
