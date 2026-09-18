-- Drill down: split one object type into finer sub-types by an attribute.
--
--   Order  ──drill down on "priority"──▶  (Order, gold), (Order, standard)
--
-- Khayatbashi, Miri & Jalali, "Advancing Object-Centric Process Mining with
-- Multi-Dimensional Data Operations", CAiSE Forum 2025 (arXiv:2412.00393),
-- §4: the object-type dimension of an OCEL is a hierarchy, and drilling down
-- replaces a type by the tuple-style sub-types its attribute values induce.
--
-- Three decisions this program makes, all of them visible in the result:
--
--   1. An object whose attribute has no value **keeps the parent type**.
--      Inventing an "(Order, unknown)" sub-type would put objects into a
--      category the data never claimed, and it is not reversible: rolling up
--      could not tell it from a real value.
--
--   2. A time-dependent attribute (OCEL 2.0 records a value *history*) is
--      read at its **earliest** recorded value. An object cannot belong to
--      two types at once, so some value has to be chosen, and the first one
--      is the only choice that does not depend on when the extract was taken.
--
--   3. Every other relation is carried through unchanged. Drilling down
--      renames types; it does not remove events, objects or relations.

-- The attribute value that decides each object's sub-type.
-- @relation chosen
SELECT object_id, value
FROM {log.object_attributes}
WHERE name = CAST(:attribute AS VARCHAR)
  AND value IS NOT NULL
  AND value <> ''
QUALIFY ROW_NUMBER() OVER (PARTITION BY object_id ORDER BY ts NULLS FIRST, value) = 1

-- @output objects
SELECT
  o.object_id,
  CASE
    WHEN o.object_type = CAST(:objectType AS VARCHAR) AND c.value IS NOT NULL
      THEN '(' || o.object_type || ', ' || c.value || ')'
    ELSE o.object_type
  END AS object_type
FROM {log.objects} o
LEFT JOIN chosen c ON c.object_id = o.object_id

-- @output events
SELECT event_id, activity, ts
FROM {log.events}

-- @output event_object
SELECT event_id, object_id, qualifier
FROM {log.event_object}

-- @output object_object
SELECT source_id, target_id, qualifier
FROM {log.object_object}

-- @output event_attributes
SELECT event_id, name, value
FROM {log.event_attributes}

-- @output object_attributes
SELECT object_id, name, value, ts
FROM {log.object_attributes}
