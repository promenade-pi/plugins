"""TOTeM Discovery — Temporal Object Type Model mining.

Ported from https://github.com/Grkmr/TOTeM (`src/totem/util.py`'s
`mine_totem`) onto Promenade's OCEL relational tables and the pyodide
runtime, following the same two-stage shape as `run.promenade.ocpn-pm4py`:

    prepare(ctx)                  fetches the OCEL once; parameter-independent, cached
    finalize(prepared, params, c) mines the model at the chosen support threshold

`tau` only affects `finalize`, so changing the support-threshold slider
re-runs just the (pure-Python, no I/O) mining pass, not the fetch.

A TOTeM edge between two object types carries three relation pairs, each a
(forward, inverse) reading:

  - `ec`/`ecInverse` — event cardinality: when an event involves the source
    (target) type, how many objects of the target (source) type does it
    typically also involve, in that same event.
  - `lc`/`lcInverse` — log cardinality: across the whole log, how many
    target-type (source-type) objects does one source-type (target-type)
    object typically relate to, via either co-occurring in an event or an
    explicit O2O link.
  - `tr`/`trInverse` — temporal containment between the two objects'
    lifespans: D/Di (one object's lifespan is nested inside the other's),
    I/Ii (one object's lifespan ends before/around when the other's begins),
    or P (parallel — always true, the fallback).

Each is reported at the *most precise* label whose observed fraction meets
`tau`, falling back to `None` (omitted from the drawing) if nothing clears
the bar.

Two deliberate deviations from the reference, both because they change
nothing about *what* gets computed, just *how*:

  1. The reference builds a full networkx event-object graph purely to get
     an iteration order over every event via its connected components
     (`compute_process_executions_connected_components`). Nothing in the
     tally logic carries state across events, so grouping by process
     execution doesn't change any count — this port iterates `ocel.events`
     directly instead.
  2. The reference recomputes the final edge list once per object type
     (nested one level inside its own outer `for type_source` loop) and
     keeps only the last write per pair (`edge_map[pair_key] = rel  # last
     one wins`). Because the per-pair tallies are already fully populated by
     the time the *last* outer iteration runs, "last one wins" always reads
     the complete tallies — so a single pass after both tally loops finish
     produces identical results with none of the redundant recomputation.

One correction, disclosed because it changes a number: the reference's
explicit-O2O merge step —

    o2o[source_o][type_of_target_o].update([source_o])

— adds the object back into its own bucket instead of the object it is
actually related to. Read against the surrounding code (and its own comment,
"merge o2o and e2o connected objects") this is a self-reference where a
cross-object link was clearly intended, so this port adds the related object
instead. On a log with no explicit O2O relations (most OCEL logs, including
the `Container Logistics` example) this line never runs and nothing changes.
"""

import pandas as pd
from pm4py.objects.ocel.obj import OCEL

# --- relation-label constants (mirrors the reference's naming) --------------

EC_TOTAL, EC_ZERO, EC_ONE, EC_ZERO_ONE, EC_MANY, EC_ZERO_MANY = (
    "total", "0", "1", "0...1", "1..*", "0...*",
)
LC_TOTAL, LC_ZERO, LC_ONE, LC_ZERO_ONE, LC_MANY, LC_ZERO_MANY = (
    "total", "0", "1", "0...1", "1..*", "0...*",
)
TR_TOTAL = "total"
TR_DEPENDENT = "D"
TR_DEPENDENT_INVERSE = "Di"
TR_INITIATING = "I"
TR_INITIATING_INVERSE = "Ii"
TR_PARALLEL = "P"

# Precision order: the first label (most specific) whose support clears tau wins.
_LC_ORDER = (LC_ZERO, LC_ONE, LC_ZERO_ONE, LC_MANY, LC_ZERO_MANY)
_EC_ORDER = (EC_ZERO, EC_ONE, EC_ZERO_ONE, EC_MANY, EC_ZERO_MANY)
_TR_ORDER = (TR_DEPENDENT, TR_DEPENDENT_INVERSE, TR_INITIATING, TR_INITIATING_INVERSE, TR_PARALLEL)


async def prepare(ctx):
    """Fetches the whole OCEL (every object type, up to `maxEvents` events),
    including object-object relations — the one table `run.promenade.ocpn-pm4py`
    doesn't need but TOTeM's log-cardinality/temporal relations do.
    """
    ctx.progress(0.1, "querying events")
    events = await ctx.sql(
        """
        SELECT event_id AS "ocel:eid", activity AS "ocel:activity", ts AS "ocel:timestamp"
        FROM {event}
        WHERE ts IS NOT NULL
        ORDER BY ts, event_id
        LIMIT {maxEvents}
        """
    )
    fetched = len(events)
    total = int((await ctx.sql(
        'SELECT COUNT(*) AS n FROM {event} WHERE ts IS NOT NULL'
    ))["n"].iloc[0])

    ctx.progress(0.25, "querying objects")
    objects = await ctx.sql(
        'SELECT object_id AS "ocel:oid", object_type AS "ocel:type" FROM {object}'
    )

    ctx.progress(0.45, "querying event-object relations")
    relations = await ctx.sql(
        """
        WITH capped AS (
          SELECT event_id, activity, ts FROM {event}
          WHERE ts IS NOT NULL ORDER BY ts, event_id LIMIT {maxEvents}
        )
        SELECT e.event_id AS "ocel:eid", e.activity AS "ocel:activity", e.ts AS "ocel:timestamp",
               r.object_id AS "ocel:oid", o.object_type AS "ocel:type"
        FROM {e2o} r
        JOIN capped e ON e.event_id = r.event_id
        JOIN {object} o ON o.object_id = r.object_id
        """
    )

    ctx.progress(0.6, "querying object-object relations")
    o2o = await ctx.sql(
        'SELECT source_id AS "ocel:oid", target_id AS "ocel:oid_2" FROM {o2o}'
    )

    events["ocel:eid"] = events["ocel:eid"].astype(str)
    events["ocel:activity"] = events["ocel:activity"].astype(str)
    events["ocel:timestamp"] = pd.to_datetime(events["ocel:timestamp"], utc=True)
    objects["ocel:oid"] = objects["ocel:oid"].astype(str)
    objects["ocel:type"] = objects["ocel:type"].astype(str)
    relations["ocel:eid"] = relations["ocel:eid"].astype(str)
    relations["ocel:activity"] = relations["ocel:activity"].astype(str)
    relations["ocel:oid"] = relations["ocel:oid"].astype(str)
    relations["ocel:type"] = relations["ocel:type"].astype(str)
    relations["ocel:timestamp"] = pd.to_datetime(relations["ocel:timestamp"], utc=True)
    o2o["ocel:oid"] = o2o["ocel:oid"].astype(str)
    o2o["ocel:oid_2"] = o2o["ocel:oid_2"].astype(str)

    ctx.log(
        f"fetched {fetched} events, {len(objects)} objects, "
        f"{len(relations)} relations, {len(o2o)} o2o links"
    )
    return {
        "events": events, "objects": objects, "relations": relations, "o2o": o2o,
        "fetched": fetched, "total": total,
    }


def finalize(prepared, params, ctx):
    ctx.progress(0.7, "building the OCEL")
    ocel = OCEL(
        events=prepared["events"], objects=prepared["objects"],
        relations=prepared["relations"], o2o=prepared["o2o"],
    )

    tau = float(params.get("tau", 0.9))
    ctx.progress(0.8, f"mining TOTeM (tau={tau})")
    totem = mine_totem(ocel, tau)

    totem["parameters"] = {"tau": tau}
    totem["fetchedEvents"] = prepared["fetched"]
    totem["totalEvents"] = prepared["total"]
    totem["truncated"] = prepared["fetched"] < prepared["total"]

    ctx.progress(0.98, "done")
    ctx.log(f"{len(totem['objectTypes'])} object types, {len(totem['edges'])} edges (tau={tau})")
    return totem


# --- algorithm ---------------------------------------------------------------

def _o2o_pairs(ocel):
    o2o = ocel.o2o
    return list(zip(o2o["ocel:oid"], o2o["ocel:oid_2"]))


def _normalize_cell(v):
    if v is None or (not isinstance(v, (list, set, tuple)) and pd.isna(v)):
        return []
    if isinstance(v, list):
        return v
    if isinstance(v, (set, tuple)):
        return list(v)
    return [v]


def _event_dict(ocel):
    """One row per event, object-type columns as plain object-id lists —
    pm4py's `get_extended_table()` pivoted and normalised, keyed by event id.
    """
    df = ocel.get_extended_table()
    df = df.rename(columns={"ocel:timestamp": "timestamp"})
    df["timestamp"] = pd.to_datetime(df["timestamp"]).dt.tz_localize(None)

    type_cols = [c for c in df.columns if c.startswith("ocel:type:")]
    rename_map = {c: c.replace("ocel:type:", "") for c in type_cols}
    df = df.rename(columns=rename_map)
    object_cols = list(rename_map.values())

    if object_cols:
        df.loc[:, object_cols] = df.loc[:, object_cols].apply(lambda col: col.map(_normalize_cell))
        df["objects"] = df[object_cols].apply(lambda row: [x for xs in row for x in xs], axis=1)
    else:
        df["objects"] = [[] for _ in range(len(df))]

    return df.set_index(ocel.event_id_column).to_dict(orient="index")


def _most_precise(directed, tau, table, order):
    entry = table.get(directed)
    if not entry:
        return None
    total = entry.get("total", 0)
    if total == 0:
        return None
    for label in order:
        if entry.get(label, 0) / total >= tau:
            return label
    return None


def mine_totem(ocel, tau: float = 0.9) -> dict:
    h_temporal_relations: dict[tuple[str, str], dict[str, int]] = {}
    h_event_cardinalities: dict[tuple[str, str], dict[str, int]] = {}
    h_log_cardinalities: dict[tuple[str, str], dict[str, int]] = {}

    o_min_times: dict[str, object] = {}
    o_max_times: dict[str, object] = {}

    type_relations: set[frozenset] = set()
    o2o: dict[str, dict[str, set]] = {}
    type_to_object: dict[str, set] = {}

    object_types = sorted(ocel.objects["ocel:type"].unique().tolist())
    for t in object_types:
        type_to_object.setdefault(t, set())

    event_dict = _event_dict(ocel)

    for ev in ocel.events[ocel.event_id_column].tolist():
        info = event_dict.get(ev)
        if info is None:
            continue
        ev_timestamp = info["timestamp"]
        objects_of_event = info["objects"]

        for obj in objects_of_event:
            o2o.setdefault(obj, {})
            for t in object_types:
                o2o[obj].setdefault(t, set())
                o2o[obj][t].update(info.get(t, []))
            if obj not in o_min_times or ev_timestamp < o_min_times[obj]:
                o_min_times[obj] = ev_timestamp
            if obj not in o_max_times or ev_timestamp > o_max_times[obj]:
                o_max_times[obj] = ev_timestamp

        involved_types = []
        obj_count_per_type: dict[str, int] = {}
        for t in object_types:
            obj_list = info.get(t, [])
            if not obj_list:
                continue
            type_to_object[t].update(obj_list)
            involved_types.append(t)
            obj_count_per_type[t] = len(obj_list)

        for t1 in involved_types:
            for t2 in involved_types:
                if t1 != t2:
                    type_relations.add(frozenset({t1, t2}))

        for type_source in involved_types:
            for type_target in object_types:
                bucket = h_event_cardinalities.setdefault((type_source, type_target), {})
                bucket[EC_TOTAL] = bucket.get(EC_TOTAL, 0) + 1
                cardinality = obj_count_per_type.get(type_target, 0)
                if cardinality == 0:
                    labels = (EC_ZERO, EC_ZERO_ONE, EC_ZERO_MANY)
                elif cardinality == 1:
                    labels = (EC_ONE, EC_ZERO_ONE, EC_MANY, EC_ZERO_MANY)
                else:
                    labels = (EC_MANY, EC_ZERO_MANY)
                for label in labels:
                    bucket[label] = bucket.get(label, 0) + 1

    # Explicit O2O links, merged in on top of the event-co-occurrence-derived
    # relations above (see module docstring for the corrected self-reference).
    for source_o, target_o in _o2o_pairs(ocel):
        target_type = None
        for t in object_types:
            if target_o in type_to_object.get(t, ()):
                target_type = t
                break
        if target_type is None:
            continue
        o2o.setdefault(source_o, {})
        o2o[source_o].setdefault(target_type, set())
        o2o[source_o][target_type].add(target_o)

    for type_source in object_types:
        for type_target in object_types:
            tr_bucket = h_temporal_relations.setdefault((type_source, type_target), {})
            for obj in type_to_object[type_source]:
                lc_bucket = h_log_cardinalities.setdefault((type_source, type_target), {})
                lc_bucket[LC_TOTAL] = lc_bucket.get(LC_TOTAL, 0) + 1

                related = o2o.get(obj, {}).get(type_target, set())
                cardinality = len(related)
                if cardinality == 0:
                    labels = (LC_ZERO, LC_ZERO_ONE, LC_ZERO_MANY)
                elif cardinality == 1:
                    labels = (LC_ONE, LC_ZERO_ONE, LC_MANY, LC_ZERO_MANY)
                else:
                    labels = (LC_MANY, LC_ZERO_MANY)
                for label in labels:
                    lc_bucket[label] = lc_bucket.get(label, 0) + 1

                for obj_target in related:
                    if obj not in o_min_times or obj_target not in o_min_times:
                        continue  # an O2O-only object with no event of its own has no lifespan to compare
                    tr_bucket[TR_TOTAL] = tr_bucket.get(TR_TOTAL, 0) + 1
                    if o_min_times[obj_target] <= o_min_times[obj] <= o_max_times[obj] <= o_max_times[obj_target]:
                        tr_bucket[TR_DEPENDENT] = tr_bucket.get(TR_DEPENDENT, 0) + 1
                    if o_min_times[obj] <= o_min_times[obj_target] <= o_max_times[obj_target] <= o_max_times[obj]:
                        tr_bucket[TR_DEPENDENT_INVERSE] = tr_bucket.get(TR_DEPENDENT_INVERSE, 0) + 1
                    if (o_min_times[obj] <= o_max_times[obj] <= o_min_times[obj_target] <= o_max_times[obj_target]) or (
                        o_min_times[obj] < o_min_times[obj_target] <= o_max_times[obj] < o_max_times[obj_target]
                    ):
                        tr_bucket[TR_INITIATING] = tr_bucket.get(TR_INITIATING, 0) + 1
                    if (o_min_times[obj_target] <= o_max_times[obj_target] <= o_min_times[obj] <= o_max_times[obj]) or (
                        o_min_times[obj_target] < o_min_times[obj] <= o_max_times[obj_target] < o_max_times[obj]
                    ):
                        tr_bucket[TR_INITIATING_INVERSE] = tr_bucket.get(TR_INITIATING_INVERSE, 0) + 1
                    tr_bucket[TR_PARALLEL] = tr_bucket.get(TR_PARALLEL, 0) + 1

    edges = []
    for pair in type_relations:
        t1, t2 = tuple(pair)
        # frozenset order is arbitrary; make it deterministic instead of
        # reproducing the reference's incidental hash-order source/target.
        if object_types.index(t1) > object_types.index(t2):
            t1, t2 = t2, t1
        edges.append({
            "source": t1, "target": t2,
            "lc": _most_precise((t1, t2), tau, h_log_cardinalities, _LC_ORDER),
            "lcInverse": _most_precise((t2, t1), tau, h_log_cardinalities, _LC_ORDER),
            "ec": _most_precise((t1, t2), tau, h_event_cardinalities, _EC_ORDER),
            "ecInverse": _most_precise((t2, t1), tau, h_event_cardinalities, _EC_ORDER),
            "tr": _most_precise((t1, t2), tau, h_temporal_relations, _TR_ORDER),
            "trInverse": _most_precise((t2, t1), tau, h_temporal_relations, _TR_ORDER),
        })
    edges.sort(key=lambda e: (e["source"], e["target"]))

    return {"objectTypes": object_types, "edges": edges}
