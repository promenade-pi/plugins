"""OCPN Discovery (pm4py) — a second discovery backend for the same
`ObjectCentricPetriNet` artifact `run.promenade.ocpn` (Rust) produces.

One action, one stage split:

    prepare(ctx)                  fetches the OCEL once; parameter-independent, cached
    finalize(prepared, params, c) object-type subsetting + pm4py discovery; re-run on every change

Object-type selection happens in `finalize`, not `prepare` — the host's own
cache key for `prepare` (`prepareKey` in `runtimeAdapters.ts`) only varies
with the artifact id and `maxEvents`, so a `prepare` that pre-filtered by
object type would keep serving a stale selection after the user changed it.
`prepare` therefore always fetches every object type up to `maxEvents`
events, and `finalize` subsets the cached DataFrames before handing them to
pm4py.

Unlike `run.promenade.ocpn`'s two-stage design (a relational projection
action feeding a wasm mining action — see `plugins/ocpn-rs`), this needs no
internal prerequisite action at all: pm4py's own `discover_oc_petri_net`
takes a real OCEL object directly and handles every selected object type
internally, so `inputs[0]` here is already `ObjectCentricEventLog` with no
`scans` indirection to a projected log.

No host changes were needed to build this: `pm_plugin` (the host-injected
module `process_tree`/`petri_net` live in) has no OCPN converter, but there
is nothing about writing one that needs host access — the whole conversion
below is plain Python against pm4py's own return value, exactly as any
third-party plugin author could write it.
"""

import pandas as pd
import pm4py
from pm4py.objects.ocel.obj import OCEL


async def prepare(ctx):
    """Fetches the whole OCEL (every object type, up to `maxEvents` events).

    `{event}` / `{object}` / `{e2o}` are this artifact's own logical tables
    (see `host/relational/schemas.ts`); `{maxEvents}` is the action's own
    param, substituted the same way by `ctx.sql()`'s `.format()`.
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

    ctx.log(f"fetched {fetched} events, {len(objects)} objects, {len(relations)} relations")
    return {
        "events": events, "objects": objects, "relations": relations,
        "fetched": fetched, "total": total,
    }


def finalize(prepared, params, ctx):
    object_types_param = params.get("objectTypes") or []
    all_types = sorted(prepared["objects"]["ocel:type"].unique().tolist())
    selected = [t for t in object_types_param if t in all_types] or all_types

    objects = prepared["objects"]
    objects = objects[objects["ocel:type"].isin(selected)].reset_index(drop=True)
    relations = prepared["relations"]
    relations = relations[relations["ocel:type"].isin(selected)].reset_index(drop=True)

    present = set(relations["ocel:type"].unique().tolist())
    skipped = [t for t in selected if t not in present]
    kept = [t for t in selected if t in present]

    ctx.progress(0.6, "building the OCEL")
    ocel = OCEL(events=prepared["events"], objects=objects, relations=relations)

    variant = "imf" if params.get("minerVariant", "imf") == "imf" else "im"
    noise = float(params.get("noiseThreshold", 0.2))
    ctx.progress(0.7, f"pm4py OCPN discovery ({variant}, noise {noise if variant == 'imf' else 0})")

    ocpn = pm4py.discover_oc_petri_net(
        ocel,
        inductive_miner_variant=variant,
        noise_threshold=noise if variant == "imf" else 0.0,
        multi_processing=False,
    )

    ctx.progress(0.9, "converting to Promenade's OCPN shape")
    traces_by_ot = objects.groupby("ocel:type").size().to_dict()
    events_by_ot = relations.groupby("ocel:type")["ocel:eid"].nunique().to_dict()
    payload = _convert(
        ocpn, kept, skipped, variant, noise,
        prepared["fetched"], prepared["total"], traces_by_ot, events_by_ot,
    )
    ctx.log(
        f"{len(payload['places'])} places / {len(payload['transitions'])} transitions / "
        f"{len(payload['arcs'])} arcs ({sum(1 for a in payload['arcs'] if a['variable'])} variable)"
    )
    return payload


def _as_dict(ocpn):
    """pm4py's `discover_oc_petri_net` returns an `OCPetriNet` in recent
    versions (dict-compatible via `Mapping`/`to_dict()`) and a plain dict in
    older ones. Normalising once here keeps the converter below independent
    of which pm4py release is actually installed (`pythonDeps` names no
    exact version — see this plugin's README)."""
    if isinstance(ocpn, dict):
        return ocpn
    to_dict = getattr(ocpn, "to_dict", None)
    if callable(to_dict):
        return to_dict()
    # `OCPetriNet` also implements `Mapping.__getitem__` directly.
    return {
        "petri_nets": ocpn["petri_nets"],
        "double_arcs_on_activity": ocpn["double_arcs_on_activity"],
    }


def _convert(ocpn, object_types, skipped, variant, noise, fetched, total, traces_by_ot, events_by_ot):
    """pm4py's per-object-type `(PetriNet, Marking, Marking)` triples ->
    Promenade's `OcpnPayload` (`host/artifact/ocpn.ts`).

    Id conventions mirror `ocpn-rs` (`crates/ocpn-core/src/lib.rs`) exactly
    — `t:<activity>` as the cross-object-type merge key, `t:silent:<ot>:<n>`
    namespaced per object type, `p:<ot>:src` / `p:<ot>:snk` / `p:<ot>:<n>` —
    not because the schema requires those specific strings, but so a
    transition genuinely shared by two object types (the whole point of a
    "shared activity" in an OCPN) merges here exactly like it would in the
    Rust plugin's output, rather than by accident.
    """
    d = _as_dict(ocpn)
    petri_nets = d["petri_nets"]
    double_arcs = d.get("double_arcs_on_activity", {})

    places = []
    transitions = {}
    arcs = []
    per_ot = {}
    silent_seq = {}

    for ot, (net, im, fm) in petri_nets.items():
        place_id = {}
        norm_seq = 0
        for p in net.places:
            if p in im:
                pid, kind = f"p:{ot}:src", "source"
            elif p in fm:
                pid, kind = f"p:{ot}:snk", "sink"
            else:
                pid, kind = f"p:{ot}:{norm_seq}", "normal"
                norm_seq += 1
            place_id[p] = pid
            places.append({"id": pid, "objectType": ot, "kind": kind})

        trans_id = {}
        for t in net.transitions:
            if t.label is None:
                n = silent_seq.get(ot, 0)
                silent_seq[ot] = n + 1
                tid = f"t:silent:{ot}:{n}"
                transitions[tid] = {"id": tid, "activity": None, "objectTypes": [ot]}
            else:
                tid = f"t:{t.label}"
                entry = transitions.get(tid)
                if entry is None:
                    entry = {"id": tid, "activity": t.label, "objectTypes": []}
                    transitions[tid] = entry
                if ot not in entry["objectTypes"]:
                    entry["objectTypes"].append(ot)
            trans_id[t] = tid

        variable_by_activity = double_arcs.get(ot, {})
        n_arcs = n_variable = 0
        for a in net.arcs:
            if a.source in place_id:
                source = {"kind": "place", "id": place_id[a.source]}
                target = {"kind": "transition", "id": trans_id[a.target]}
                label = a.target.label
            else:
                source = {"kind": "transition", "id": trans_id[a.source]}
                target = {"kind": "place", "id": place_id[a.target]}
                label = a.source.label
            variable = bool(variable_by_activity.get(label, False)) if label is not None else False
            arcs.append({
                "id": f"a:{ot}:{len(arcs)}",
                "source": source, "target": target,
                "objectType": ot, "variable": variable,
            })
            n_arcs += 1
            if variable:
                n_variable += 1

        per_ot[ot] = {
            "places": len(place_id),
            "transitions": len(trans_id),
            "arcs": n_arcs,
            "silentTransitions": silent_seq.get(ot, 0),
            "variableArcs": n_variable,
            # One case per object of this type, same convention `ocpn-rs`
            # uses — "traces" here means object count, not OCEL's own
            # unrelated notion of a trace.
            "traces": int(traces_by_ot.get(ot, 0)),
            "events": int(events_by_ot.get(ot, 0)),
        }

    return {
        "objectTypes": object_types,
        "places": places,
        "transitions": list(transitions.values()),
        "arcs": arcs,
        "metadata": {
            "perObjectType": per_ot,
            "skippedObjectTypes": [
                {"objectType": ot, "reason": "no events related to this object type"} for ot in skipped
            ],
            "parameters": {
                # The artifact schema (`host/artifact/ocpn.ts`) wants exactly
                # "IM" or "IMf" — not a blanket .upper(), which would give
                # "IMF".
                "variant": "IMf" if variant == "imf" else "IM",
                "noiseThreshold": noise, "objectTypes": object_types,
            },
            "fetchedEvents": fetched,
            "totalEvents": total,
            "truncated": fetched < total,
        },
    }
