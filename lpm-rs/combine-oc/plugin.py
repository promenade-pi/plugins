"""Merges two per-object-type Local Process Model sets into object-centric
fragments.

`ObjectCentricLPMs` (a fork of the traditional LocalProcessModelDiscovery)
does not invent an object-centric search — it re-runs the single-perspective
algorithm once per object type on a flattened log (`run.promenade.lpm.discover
-oc`, this plugin's own reuse of that same per-type flattening), then:

  1. looks for structurally isomorphic fragments across the per-type results
     ("place completion" in the original — here, same discovered tree shape)
     and merges them into one multi-type fragment;
  2. tags each (activity, object type) pair on that fragment as a "variable
     arc" when a statistical heuristic says the activity often relates to
     more than one object of that type (threshold 0.95 in the original).

Both steps happen here, over exactly two per-type sets at a time (chain
`combine-oc` pairwise for more than two object types).
"""

import json

VARIABLE_ARC_THRESHOLD_DEFAULT = 0.95


async def prepare(ctx):
    inputs = ctx.inputs
    set_a = (inputs.get("setA") or [None])[0]
    set_b = (inputs.get("setB") or [None])[0]
    if not isinstance(set_a, dict) or not isinstance(set_b, dict):
        raise ValueError("Combine needs two Local Process Model sets (setA, setB)")

    threshold = float(ctx.params.get("variableArcThreshold", VARIABLE_ARC_THRESHOLD_DEFAULT))

    ctx.progress(0.15, "reading event-object relations")
    # Per (activity, object type): fraction of events where the activity
    # relates to more than one object of that type — ObjectCentricLPMs'
    # statistical variable-arc heuristic (`VariableArcIdentificator`).
    stats = await ctx.sql("""
        SELECT e.activity AS activity, x.object_type AS object_type,
               AVG(CASE WHEN x.n > 1 THEN 1.0 ELSE 0.0 END) AS frac
        FROM (
            SELECT r.event_id, o.object_type, COUNT(*) AS n
            FROM {e2o} r JOIN {object} o ON o.object_id = r.object_id
            GROUP BY r.event_id, o.object_type
        ) x
        JOIN {event} e ON e.event_id = x.event_id
        GROUP BY e.activity, x.object_type
    """)

    variable_pairs = set()
    for row in stats.to_dict("records"):
        if float(row["frac"]) >= threshold:
            variable_pairs.add((str(row["activity"]), str(row["object_type"])))

    return {"setA": set_a, "setB": set_b, "variablePairs": variable_pairs}


def _tree_key(tree):
    """Structural identity independent of key order or float formatting —
    two per-type runs discover the exact same operator tree in JSON for a
    truly shared pattern, since the tree only ever names activities, never
    object-type-specific detail."""
    return json.dumps(tree, sort_keys=True)


def _object_type_of(result):
    return (result.get("stats") or {}).get("objectType")


def _average_scores(score_dicts):
    keys = score_dicts[0].keys()
    n = len(score_dicts)
    return {k: sum(s[k] for s in score_dicts) / n for k in keys}


def finalize(prepared, params, ctx):
    set_a, set_b = prepared["setA"], prepared["setB"]
    type_a, type_b = _object_type_of(set_a), _object_type_of(set_b)
    if not type_a or not type_b:
        raise ValueError(
            'Both inputs must be per-object-type results from "Discover Local Process Models '
            '(object-centric)" — neither carries a meta.objectType tag.'
        )
    if type_a == type_b:
        raise ValueError(f'Both inputs are tagged object type "{type_a}" — select two different object types.')

    variable_pairs = prepared["variablePairs"]

    by_key = {}
    for entry in set_a.get("entries", []):
        by_key.setdefault(_tree_key(entry["tree"]), []).append((entry, type_a))
    for entry in set_b.get("entries", []):
        by_key.setdefault(_tree_key(entry["tree"]), []).append((entry, type_b))

    ctx.progress(0.6, "merging isomorphic fragments across object types")
    merged = []
    for group in by_key.values():
        types = sorted({ot for _, ot in group})
        if len(types) < 2:
            continue  # only found under one type — not an object-centric fragment
        representative = max((e for e, _ in group), key=lambda e: e["scores"]["weightedScore"])
        variable_arcs = [
            {"activity": a, "objectType": ot}
            for a in representative["activities"]
            for ot in types
            if (a, ot) in variable_pairs
        ]
        merged.append({
            "rank": 0,
            "tree": representative["tree"],
            "pretty": representative["pretty"],
            "activities": representative["activities"],
            "scores": _average_scores([e["scores"] for e, _ in group]),
            "objectTypes": types,
            "variableArcs": variable_arcs,
        })

    merged.sort(key=lambda e: e["scores"]["weightedScore"], reverse=True)
    for i, entry in enumerate(merged):
        entry["rank"] = i

    ctx.log(f"merged {len(merged)} object-centric fragment(s) across types {type_a!r}, {type_b!r}")
    ctx.progress(1, "merge complete")
    return {
        "entries": merged,
        "stats": {
            "objectTypes": [type_a, type_b],
            "mergedCount": len(merged),
            "candidatesA": len(set_a.get("entries", [])),
            "candidatesB": len(set_b.get("entries", [])),
            "variableArcThreshold": float(params.get("variableArcThreshold", VARIABLE_ARC_THRESHOLD_DEFAULT)),
        },
    }
