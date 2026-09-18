-- Unfold: split one event type by the kind of object it touches.
--
--   pay invoice  ──unfold by "Customer"──▶  (pay invoice, Customer)
--                                           pay invoice     ← the events that touch none
--
-- Khayatbashi, Miri & Jalali, "Advancing Object-Centric Process Mining with
-- Multi-Dimensional Data Operations", CAiSE Forum 2025 (arXiv:2412.00393),
-- §4: the event-type dimension of an OCEL can be refined by the object types
-- an event relates to. It is what separates "the same activity performed on
-- two different kinds of thing" in a model that would otherwise merge them.
--
-- Only events of the named activity are touched, and only those with at least
-- one relation to an object of the named type. An event of that activity with
-- no such relation keeps its name — the unfolded log then distinguishes the
-- two groups, which is the whole point of the operation.
--
-- The optional qualifier restricts which relations count: "unfold `pay` by the
-- `Customer` it was paid *for*", not by every customer mentioned. An empty
-- qualifier means any.

-- Events of the target activity that touch the target object type.
-- @relation matched
SELECT DISTINCT r.event_id
FROM {log.event_object} r
JOIN {log.objects} o ON o.object_id = r.object_id
WHERE o.object_type = CAST(:objectType AS VARCHAR)
  AND (CAST(:qualifier AS VARCHAR) = '' OR r.qualifier = CAST(:qualifier AS VARCHAR))

-- @output events
SELECT
  e.event_id,
  CASE
    WHEN e.activity = CAST(:activity AS VARCHAR) AND m.event_id IS NOT NULL
      THEN '(' || e.activity || ', ' || CAST(:objectType AS VARCHAR) || ')'
    ELSE e.activity
  END AS activity,
  e.ts
FROM {log.events} e
LEFT JOIN matched m ON m.event_id = e.event_id

-- @output objects
SELECT object_id, object_type
FROM {log.objects}

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
