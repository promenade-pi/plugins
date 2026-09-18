-- One object lifecycle per selected object, plus the global interaction facts
-- OCIM needs. The auxiliary output becomes metadata on the projected log and
-- is forwarded to the WASM action's equally named parameter by the host.
-- @output cases
SELECT CAST((list_position(string_split(:objectTypes, chr(31)), o.object_type) - 1) * 8000000
       + (ROW_NUMBER() OVER (PARTITION BY o.object_type ORDER BY o.object_id) - 1) AS INTEGER) AS trace_idx,
       o.object_id AS case_id
FROM {log.objects} o
WHERE o.object_type = ANY(string_split(:objectTypes, chr(31)))

-- @output events
SELECT ROW_NUMBER() OVER (ORDER BY c.trace_idx, e.ts, e.event_id) - 1 AS event_idx,
       c.trace_idx, e.activity, e.ts, CAST(NULL AS VARCHAR) AS lifecycle, CAST(NULL AS VARCHAR) AS resource
FROM {log.event_object} r
JOIN cases c ON c.case_id = r.object_id
JOIN {log.events} e ON e.event_id = r.event_id

-- Columns: activity, object type, related, divergent, convergent, deficient.
-- This follows Niklas van Detten's `interaction_patterns.py`: related means
-- “occurs in at least one event”; deficient records absence from some events.
-- Divergence means one identical typed-object set occurred with distinct full
-- event-object sets, not merely that different typed objects were observed.
-- @output interactionPatterns
WITH selected AS (
  SELECT object_type FROM {log.objects}
  WHERE object_type = ANY(string_split(:objectTypes, chr(31))) GROUP BY object_type
), activity_events AS (
  SELECT activity, COUNT(*) AS all_events FROM {log.events} GROUP BY activity
), event_objects AS (
  SELECT r.event_id,
         string_agg(o.object_type || ':' || o.object_id, '|' ORDER BY o.object_type, o.object_id) AS all_objects
  FROM {log.event_object} r
  JOIN {log.objects} o ON o.object_id = r.object_id
  GROUP BY r.event_id
), per_event_type AS (
  SELECT e.event_id, e.activity, o.object_type,
         COUNT(DISTINCT o.object_id) AS n_objects,
         string_agg(o.object_id, '|' ORDER BY o.object_id) AS typed_object_set,
         eo.all_objects
  FROM {log.events} e
  JOIN {log.event_object} r ON r.event_id = e.event_id
  JOIN {log.objects} o ON o.object_id = r.object_id
  JOIN event_objects eo ON eo.event_id = e.event_id
  WHERE o.object_type IN (SELECT object_type FROM selected)
  GROUP BY e.event_id, e.activity, o.object_type, eo.all_objects
), typed_sets AS (
  SELECT activity, object_type, typed_object_set,
         COUNT(*) AS events_with_type,
         MAX(n_objects) > 1 AS convergent,
         COUNT(DISTINCT all_objects) > 1 AS divergent
  FROM per_event_type GROUP BY activity, object_type, typed_object_set
), per_activity_type AS (
  SELECT activity, object_type,
         SUM(events_with_type) AS events_with_type,
         BOOL_OR(convergent) AS convergent,
         BOOL_OR(divergent) AS divergent
  FROM typed_sets GROUP BY activity, object_type
)
SELECT p.activity, p.object_type,
       TRUE AS related,
       p.divergent, p.convergent,
       p.events_with_type < a.all_events AS deficient
FROM per_activity_type p JOIN activity_events a USING (activity)
