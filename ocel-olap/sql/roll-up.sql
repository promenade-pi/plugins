-- Roll up: collapse the sub-types of one object type back into it.
--
--   (Order, gold), (Order, standard)  ──roll up "Order"──▶  Order
--
-- The inverse of drilling down (Khayatbashi, Miri & Jalali, CAiSE Forum 2025,
-- §4), and inverse in the strict sense: rolling up a type that was drilled
-- down gives back exactly the log that was drilled, because drilling down
-- leaves objects with no value on the parent type rather than inventing one
-- for them.
--
-- The match is on the tuple notation drilling down writes — `(Type, …)`. An
-- object type that happens to be *named* like a tuple would be rolled up too;
-- that is the price of the notation being part of the data rather than beside
-- it, and it is the notation the paper uses.

-- @output objects
SELECT
  object_id,
  CASE
    WHEN object_type LIKE '(' || CAST(:objectType AS VARCHAR) || ', %)'
      THEN CAST(:objectType AS VARCHAR)
    ELSE object_type
  END AS object_type
FROM {log.objects}

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
