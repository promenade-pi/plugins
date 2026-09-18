-- Fold: collapse the unfolded variants of one event type back into it.
--
--   (pay invoice, Customer), (pay invoice, Supplier)  ──fold "pay invoice"──▶  pay invoice
--
-- The inverse of unfolding (Khayatbashi, Miri & Jalali, CAiSE Forum 2025, §4),
-- and inverse in the strict sense: unfolding leaves the events it did not
-- match under their original name, so folding restores exactly the log that
-- was unfolded.
--
-- As with rolling up, the match is on the tuple notation — `(activity, …)`.

-- @output events
SELECT
  event_id,
  CASE
    WHEN activity LIKE '(' || CAST(:activity AS VARCHAR) || ', %)'
      THEN CAST(:activity AS VARCHAR)
    ELSE activity
  END AS activity,
  ts
FROM {log.events}

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
