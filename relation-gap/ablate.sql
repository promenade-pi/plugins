-- Simulate relation gaps: derive a gapped copy of an object-centric event log.
--
-- Follows §5.1 of Papp, "Object-Centric Event Log Repair Through Graph Neural
-- Networks": events are split into a train and a test partition, and each test
-- event loses k = max(1, floor(n * d_f)) of its n participating objects, with
-- at least one object left behind so no event is emptied.
--
-- Two departures from the notebook this is ported from, both deliberate:
--
--   1. The partition is written into the *log*, not kept beside it. Train
--      events keep every relation, so a reconstruction method trained on this
--      artifact sees exactly what an analyst holding a damaged extract sees,
--      and cannot learn from the links it is later asked to recover. The
--      notebook estimated its statistics from the complete log and then
--      evaluated on holes punched into that same complete data.
--
--   2. Selection is a seeded hash of the identifiers rather than a random
--      number generator's stream position, so the same log, fractions and
--      seed give the same gapped log on any machine, in any order, however
--      many times it is re-run. Reproducibility is the whole point of an
--      artifact that other results are compared against.
--
-- hash() returns a well-distributed UBIGINT, so `hash(id || salt) % 1000000`
-- divided by a million is uniform on [0,1). The two salt strings give the
-- partition draw and the drop draw independent streams from one seed.
--
-- Every parameter is bound through an explicit CAST. DuckDB resolves a
-- prepared statement's parameter type from that cast directly, which is the
-- one form that never depends on what the surrounding expression happens to
-- promote to.

-- One row per (event, object) pair, so an object related to the same event
-- under two qualifiers counts once. O(e) is a set in the paper's formulation,
-- and dropping "an object" has to mean all of its rows or the gap is not a
-- gap at all — the object would still be visible under its other qualifier.
-- @relation pairs
SELECT DISTINCT event_id, object_id
FROM {log.event_object}

-- @relation sizes
SELECT event_id, COUNT(*) AS n
FROM pairs
GROUP BY event_id

-- Events with a single object are never selected: removing their only object
-- would leave an event with no observed context to reconstruct from, which is
-- a different repair problem (an orphaned event) than the one measured here.
-- `singleTarget` hides exactly one object per test event, whatever the event's
-- size. That is the protocol the notebook's evaluation actually used and the
-- one the refactored reference implementation makes the default: it keeps every
-- test event equally weighted, so an eight-object event cannot contribute eight
-- times as much to the metric as a two-object one. `dropFraction` is §5.1's
-- proportional damage, kept because it is what the paper describes.
-- @relation test_events
SELECT
  event_id,
  n,
  CASE
    WHEN CAST(:protocol AS VARCHAR) = 'singleTarget' THEN 1
    ELSE GREATEST(1, LEAST(n - 1, FLOOR(n * CAST(:dropFraction AS DOUBLE))))
  END AS k
FROM sizes
WHERE n >= 2
  AND (hash(event_id || ':partition:' || CAST(:seed AS VARCHAR)) % 1000000) / 1000000.0
      < CAST(:testFraction AS DOUBLE)

-- @relation doomed
SELECT p.event_id, p.object_id
FROM pairs p
JOIN test_events t ON t.event_id = p.event_id
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY p.event_id
  ORDER BY
    hash(p.event_id || '>' || p.object_id || ':drop:' || CAST(:seed AS VARCHAR)),
    p.object_id
) <= t.k

-- @output event_object
SELECT r.event_id, r.object_id, r.qualifier
FROM {log.event_object} r
LEFT JOIN doomed d
  ON d.event_id = r.event_id AND d.object_id = r.object_id
WHERE d.event_id IS NULL

-- Everything else is carried through unchanged. The objects themselves stay in
-- the log even when every one of their relations is gone: an object-centric
-- log records that an object exists independently of which events touched it,
-- and a reconstruction method is entitled to know the object is there. Pruning
-- them would turn one gap into two.
-- @output events
SELECT event_id, activity, ts
FROM {log.events}

-- @output objects
SELECT object_id, object_type
FROM {log.objects}

-- @output object_object
SELECT source_id, target_id, qualifier
FROM {log.object_object}

-- @output event_attributes
SELECT event_id, name, value
FROM {log.event_attributes}

-- @output object_attributes
SELECT object_id, name, value, ts
FROM {log.object_attributes}
