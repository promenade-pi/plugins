"""OC-DFG Discovery (pm4py).

This is a second backend for the `OCDFG` artifact the host's SQL action
already produces. It uses pm4py's `discover_ocdfg` directly on a real OCEL
object and converts pm4py's metric sets to the host's compact graph payload.

The host caches `prepare` by input artifact and `maxEvents`; object-type
selection therefore belongs in `finalize`, where it can change without
accidentally reusing an OCEL prepared for a different type selection.
"""

import pandas as pd
import pm4py
from pm4py.objects.ocel.obj import OCEL


async def prepare(ctx):
    """Fetch every object type and a deterministic, capped event prefix."""
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
        "SELECT COUNT(*) AS n FROM {event} WHERE ts IS NOT NULL"
    ))["n"].iloc[0])

    ctx.progress(0.3, "querying objects")
    objects = await ctx.sql(
        'SELECT object_id AS "ocel:oid", object_type AS "ocel:type" FROM {object}'
    )

    ctx.progress(0.5, "querying event-object relations")
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

    for table, columns in (
        (events, ["ocel:eid", "ocel:activity"]),
        (objects, ["ocel:oid", "ocel:type"]),
        (relations, ["ocel:eid", "ocel:activity", "ocel:oid", "ocel:type"]),
    ):
        for column in columns:
            table[column] = table[column].astype(str)
    events["ocel:timestamp"] = pd.to_datetime(events["ocel:timestamp"], utc=True)
    relations["ocel:timestamp"] = pd.to_datetime(relations["ocel:timestamp"], utc=True)

    ctx.log(f"fetched {fetched} events, {len(objects)} objects, {len(relations)} relations")
    return {
        "events": events, "objects": objects, "relations": relations,
        "fetched": fetched, "total": total,
    }


def finalize(prepared, params, ctx):
    all_types = sorted(prepared["objects"]["ocel:type"].unique().tolist())
    requested = params.get("objectTypes") or []
    selected = [object_type for object_type in requested if object_type in all_types] or all_types

    objects = prepared["objects"]
    objects = objects[objects["ocel:type"].isin(selected)].reset_index(drop=True)
    relations = prepared["relations"]
    relations = relations[relations["ocel:type"].isin(selected)].reset_index(drop=True)
    kept = sorted(relations["ocel:type"].unique().tolist())
    skipped = [object_type for object_type in selected if object_type not in kept]

    if not kept:
        return _empty_payload(selected, skipped, prepared["fetched"], prepared["total"])

    # Retain only events still connected to a selected object type. An event
    # shared with an unselected type remains, but its unselected relation does
    # not: this is the requested object-type projection, not an OCEL rewrite.
    event_ids = set(relations["ocel:eid"])
    events = prepared["events"]
    events = events[events["ocel:eid"].isin(event_ids)].reset_index(drop=True)

    ctx.progress(0.65, "building the OCEL")
    ocel = OCEL(events=events, objects=objects, relations=relations)
    ctx.progress(0.75, "pm4py OC-DFG discovery")
    discovered = pm4py.discover_ocdfg(ocel)
    ctx.progress(0.9, "converting to Promenade's OC-DFG shape")
    payload = _convert(discovered, kept, skipped, prepared["fetched"], prepared["total"])
    ctx.log(f"{len(payload['nodes'])} typed activities / {len(payload['edges'])} typed edges")
    return payload


def _size(value):
    """pm4py metrics are normally sets; accept numeric values defensively."""
    if isinstance(value, (int, float)):
        return int(value)
    return len(value) if value is not None else 0


def _convert(discovered, object_types, skipped, fetched, total):
    """Convert pm4py's OC-DFG metric dictionaries to Promenade's payload.

    `unique_objects` supplies activity/start/end counts, matching the host
    OC-DFG's per-object node count. `total_objects` supplies edge frequency:
    its `(event_a, event_b, object)` triples retain repeated directly-follows
    occurrences instead of collapsing them by event pair.
    """
    activity_counts = discovered.get("activities_ot", {}).get("unique_objects", {})
    starts = discovered.get("start_activities", {}).get("unique_objects", {})
    ends = discovered.get("end_activities", {}).get("unique_objects", {})
    edge_counts = discovered.get("edges", {}).get("total_objects", {})

    nodes = []
    edges = []
    for object_type in object_types:
        for activity, occurrences in sorted(activity_counts.get(object_type, {}).items()):
            nodes.append({
                "objectType": object_type,
                "activity": str(activity),
                "count": _size(occurrences),
                "starts": _size(starts.get(object_type, {}).get(activity)),
                "ends": _size(ends.get(object_type, {}).get(activity)),
            })
        for (src, dst), occurrences in sorted(edge_counts.get(object_type, {}).items()):
            edges.append({
                "objectType": object_type,
                "src": str(src),
                "dst": str(dst),
                "freq": _size(occurrences),
            })

    return {
        "objectTypes": object_types,
        "nodes": nodes,
        "edges": edges,
        "stats": {
            "objectTypes": len(object_types),
            "activities": len({node["activity"] for node in nodes}),
            "edges": len(edges),
        },
        "metadata": {
            "skippedObjectTypes": [
                {"objectType": object_type, "reason": "no timestamped events related to this object type"}
                for object_type in skipped
            ],
            "fetchedEvents": fetched,
            "totalEvents": total,
            "truncated": fetched < total,
        },
    }


def _empty_payload(selected, skipped, fetched, total):
    return {
        "objectTypes": selected,
        "nodes": [],
        "edges": [],
        "stats": {"objectTypes": 0, "activities": 0, "edges": 0},
        "metadata": {
            "skippedObjectTypes": [
                {"objectType": object_type, "reason": "no timestamped events related to this object type"}
                for object_type in skipped or selected
            ],
            "fetchedEvents": fetched,
            "totalEvents": total,
            "truncated": fetched < total,
        },
    }
