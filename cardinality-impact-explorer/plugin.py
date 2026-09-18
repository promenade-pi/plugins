"""Cardinality Impact Explorer for Object-Centric Event Logs.

The report deliberately separates observed evidence from the interactive
scenario model.  The action derives the object-type palette, event-level
co-occurrence cardinalities and target-object lifecycle evidence.  The view
then lets an analyst vary a relation without pretending that the resulting
counterfactual is an observed fact: deltas are explicitly marked estimates,
anchored in the observed baseline cardinality and lifecycle measures.
"""

from collections import Counter
import math
import pandas as pd


def _safe_number(value, fallback=0.0):
    try:
        n = float(value)
        return n if math.isfinite(n) else fallback
    except (TypeError, ValueError):
        return fallback


def _quantile(series, q, default=1):
    if series is None or len(series) == 0:
        return default
    return max(1, int(round(_safe_number(series.quantile(q), default))))


def _label(value):
    value = str(value or "Object")
    return value[:1].upper() + value[1:]


async def prepare(ctx):
    ctx.progress(.08, "querying events")
    total = int((await ctx.sql("SELECT COUNT(*) AS n FROM {event}"))["n"].iloc[0])
    events = await ctx.sql("""
        SELECT event_id, activity, ts FROM {event}
        ORDER BY ts NULLS LAST, event_id LIMIT {maxEvents}
    """)
    ctx.progress(.25, "querying object types")
    objects = await ctx.sql("SELECT object_id, object_type FROM {object}")
    ctx.progress(.43, "querying event-object relations")
    relations = await ctx.sql("""
        WITH capped AS (SELECT event_id FROM {event} ORDER BY ts NULLS LAST, event_id LIMIT {maxEvents})
        SELECT r.event_id, r.object_id, o.object_type
        FROM {e2o} r JOIN capped c ON c.event_id = r.event_id
        JOIN {object} o ON o.object_id = r.object_id
    """)
    # Attribute tables are optional in Promenade's relational OCEL view.
    object_attrs = pd.DataFrame(columns=["object_id", "name", "value"])
    if "object_attr" in ctx.tables:
        object_attrs = await ctx.sql("SELECT object_id, name, value FROM {object_attr} WHERE value IS NOT NULL")
    return {"events": events, "objects": objects, "relations": relations, "objectAttrs": object_attrs,
            "truncated": total > len(events), "total": total}


def _pair_evidence(relations, object_types):
    """Event-local cardinality distributions for every ordered type pair."""
    by_event = {}
    for row in relations[["event_id", "object_id", "object_type"]].dropna().itertuples(index=False):
        by_event.setdefault(str(row.event_id), {}).setdefault(str(row.object_type), set()).add(str(row.object_id))
    values = {(a, b): [] for a in object_types for b in object_types if a != b}
    for typed in by_event.values():
        for a, source_ids in typed.items():
            for b, target_ids in typed.items():
                if a != b and source_ids:
                    values[(a, b)].extend([len(target_ids)] * len(source_ids))
    evidence = {}
    for pair, counts in values.items():
        series = pd.Series(counts, dtype="float64")
        if len(series):
            evidence["\u241f".join(pair)] = {
                "observations": int(len(series)), "median": _quantile(series, .5),
                "p25": _quantile(series, .25), "p75": _quantile(series, .75),
                "support": round(float((series > 0).mean()) * 100, 1)
            }
    return evidence


def _lifecycles(events, relations, objects):
    typed = relations.merge(objects[["object_id", "object_type"]], on="object_id", how="inner", suffixes=("", "_known"))
    typed = typed.merge(events[["event_id", "activity", "ts"]], on="event_id", how="inner")
    typed["ts"] = pd.to_datetime(typed["ts"], errors="coerce", utc=True)
    result = {}
    for typ, frame in typed.groupby("object_type", sort=True):
        frame = frame.sort_values(["object_id", "ts", "event_id"], kind="stable")
        grouped = frame.groupby("object_id", sort=False)
        sequences, durations, rework, activity_counts = [], [], [], Counter()
        for _, life in grouped:
            acts = [str(x) for x in life["activity"].dropna().tolist()]
            if not acts:
                continue
            sequences.append(" \u2192 ".join(acts))
            activity_counts.update(acts)
            rework.append(any(n > 1 for n in Counter(acts).values()))
            times = life["ts"].dropna()
            if len(times) >= 2:
                durations.append((times.max() - times.min()).total_seconds() / 3600)
        variant_counts = Counter(sequences)
        common = [name for name, _ in activity_counts.most_common(7)]
        repeated = [name for name, n in activity_counts.most_common() if n > max(2, len(sequences) * .15)][:4]
        result[str(typ)] = {
            "objects": int(grouped.ngroups), "variants": int(len(variant_counts)),
            "leadHours": round(float(pd.Series(durations).median()), 1) if durations else 0,
            "reworkRate": round(100 * sum(rework) / len(rework), 1) if rework else 0,
            "activities": common or ["Start", "Complete"], "reworkActivities": repeated or common[2:4],
            "topVariants": [{"sequence": sequence, "count": int(count)} for sequence, count in variant_counts.most_common(4)]
        }
    return result


def _breakdowns(attrs, objects):
    """Offer optional dimensions whose names match familiar operational terms."""
    if attrs.empty:
        return []
    linked = attrs.merge(objects[["object_id", "object_type"]], on="object_id", how="inner")
    tokens = [("Picker", ("picker", "worker", "resource")), ("Warehouse", ("warehouse", "site", "location")),
              ("Customer segment", ("segment", "customer", "client"))]
    answer = []
    for title, matches in tokens:
        candidates = linked[linked["name"].astype(str).str.lower().apply(lambda n: any(x in n for x in matches))]
        if candidates.empty:
            continue
        name = str(candidates["name"].mode().iloc[0])
        values = candidates.loc[candidates["name"].astype(str) == name, "value"].astype(str).value_counts().head(8)
        answer.append({"title": title, "attribute": name, "values": [str(v) for v in values.index.tolist()]})
    return answer


def finalize(prepared, params, ctx):
    events, objects, relations = prepared["events"].copy(), prepared["objects"].copy(), prepared["relations"].copy()
    if objects.empty or relations.empty:
        return {"schemaVersion": 1, "objectTypes": [], "pairEvidence": {}, "lifecycles": {}, "breakdowns": [],
                "meta": {"message": "This log has no linked object lifecycle evidence yet."}}
    objects["object_id"] = objects["object_id"].astype(str)
    objects["object_type"] = objects["object_type"].astype(str)
    relations["object_id"] = relations["object_id"].astype(str)
    relations["object_type"] = relations["object_type"].astype(str)
    types = sorted(objects["object_type"].dropna().unique().tolist(), key=lambda x: (-int((objects["object_type"] == x).sum()), x))
    ctx.progress(.62, "measuring cardinality evidence")
    evidence = _pair_evidence(relations, types)
    ctx.progress(.77, "profiling target lifecycles")
    lifecycles = _lifecycles(events, relations, objects)
    ctx.progress(.91, "assembling explorer")
    return {
        "schemaVersion": 1,
        "objectTypes": [{"id": typ, "label": _label(typ), "instances": int((objects["object_type"] == typ).sum())} for typ in types],
        "pairEvidence": evidence, "lifecycles": lifecycles,
        "breakdowns": _breakdowns(prepared["objectAttrs"], objects),
        "meta": {"eventCount": int(len(events)), "totalEvents": int(prepared["total"]), "truncated": bool(prepared["truncated"]),
                 "message": "Scenario deltas are estimates anchored in observed event-level cardinality and target-lifecycle evidence."}
    }
