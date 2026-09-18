"""Alignment-backed replay for the Inductive Visual Miner view.

The original Inductive Visual Miner mines a *process tree*, expands it for
enqueue/start/complete lifecycle alignment, and renders its sound process-tree
semantics.  Promenade already has several producers of accepting Petri nets,
so this action deliberately accepts that common model interchange format.  It
reconstructs a pm4py Petri net, runs pm4py's A*-style alignment per sampled
case and writes a compact, renderer-independent replay timeline.

The viewer never executes an alignment.  It consumes this payload and uses a
bounded particle pool: particles are a representative visualisation, while
the recorded alignment and statistics keep their real counts.
"""

from collections import defaultdict
from datetime import datetime

import pandas as pd
import pm4py
import pm_plugin
from pm4py.objects.log.obj import Event, Trace, EventLog
from pm4py.objects.petri_net.obj import PetriNet, Marking
from pm4py.objects.petri_net.utils import petri_utils


def _value(inputs, key):
    value = (inputs.get(key) or [None])[0]
    if not isinstance(value, dict):
        raise ValueError(f"missing inline {key} artifact")
    return value


async def prepare_replay(ctx):
    model = _value(ctx.inputs, "model")
    _validate_model(model)
    return await _prepare_for_model(ctx, model)


async def prepare_replay_process_tree(ctx):
    """The original Inductive Visual Miner consumes a process tree.

    Keep that native route first-class: process-tree operators retain the
    structured, sound semantics from Inductive Miner, and pm4py performs the
    standard conversion only for replay/layout. The resulting normalised net
    is included in the replay artifact so the viewer does not need the source
    tree to stay installed or open.
    """
    tree_payload = _value(ctx.inputs, "tree")
    ctx.progress(0.03, "converting process tree for replay")
    tree = pm_plugin.parse_process_tree(tree_payload)
    net, initial, final = pm4py.convert_to_petri_net(tree)
    return await _prepare_for_model(ctx, pm_plugin.petri_net(net, initial, final))


async def _prepare_for_model(ctx, model):
    max_cases = max(10, min(5000, int(ctx.params.get("maxCases", 400))))
    max_events = max(1000, min(500000, int(ctx.params.get("maxEvents", 100000))))
    ctx.progress(0.05, "querying replay sample")
    # The primary input is the log; stable log order is vital when timestamps
    # are missing or share a value.  Restrict cases before events so an early,
    # unusually long trace cannot starve all later cases.
    cases = await ctx.sql(f"""
        SELECT trace_idx
        FROM {{trace}}
        ORDER BY trace_idx
        LIMIT {max_cases}
    """)
    if len(cases) == 0:
        raise ValueError("the selected log has no cases")
    ids = ", ".join(str(int(v)) for v in cases["trace_idx"].tolist())
    df = await ctx.sql(f"""
        SELECT trace_idx, event_idx, activity, ts
        FROM {{event}}
        WHERE trace_idx IN ({ids}) AND activity IS NOT NULL
        ORDER BY trace_idx, event_idx
        LIMIT {max_events}
    """)
    if len(df) == 0:
        raise ValueError("the selected cases contain no labelled events")
    return {"model": model, "events": df, "cases": len(cases), "maxCases": max_cases, "maxEvents": max_events}


def finalize_replay(prepared, params, ctx):
    model = prepared["model"]
    df = prepared["events"]
    ctx.progress(0.14, "reconstructing accepting Petri net")
    net, initial, final, id_by_name, ids_by_label = _to_pm4py(model)
    traces, event_totals = _traces_from_frame(df)
    if not traces:
        raise ValueError("no non-empty traces remain after applying the event limit")

    ctx.progress(0.2, f"aligning {len(traces)} cases")
    replay, quality = _align(net, initial, final, traces, id_by_name, ids_by_label, ctx)
    ctx.progress(0.94, "normalising animation timeline")
    timeline = _timeline(replay)
    used_fallback = quality["fallbackCases"] > 0
    stats = {
        "cases": len(traces), "events": event_totals, "alignedEvents": quality["synchronous"],
        "deviations": quality["deviations"], "meanFitness": quality["fitness"] / len(traces) if traces else 0,
        "truncated": len(df) >= prepared["maxEvents"], "fallbackCases": quality["fallbackCases"],
        "alignment": "pm4py Petri-net alignment (A*)" if not used_fallback else "label replay fallback for one or more cases",
    }
    ctx.log(f"aligned {event_totals} events in {len(traces)} cases; {quality['deviations']} deviations")
    return {
        "model": model, "events": replay, "timeline": timeline, "stats": stats,
        "method": {
            "name": "alignment-backed token replay",
            "exact": not used_fallback,
            "note": ("Each sampled case is aligned with pm4py against the accepting Petri net. "
                     if not used_fallback else "One or more cases used deterministic label replay because the alignment backend failed. ")
                    + "The on-screen particle count is capped and representational; counts and deviations remain exact for this sample."
        }
    }


def _validate_model(model):
    required = ("places", "activities", "place_to_transition", "transition_to_place")
    missing = [key for key in required if not isinstance(model.get(key), list)]
    if missing:
        raise ValueError("AcceptingPetriNet payload missing " + ", ".join(missing))


def _to_pm4py(model):
    net = PetriNet("promenade")
    places = []
    for index, _ in enumerate(model.get("places", [])):
        place = PetriNet.Place(f"p{index}")
        net.places.add(place)
        places.append(place)
    labels = model.get("labels") or []
    transitions, id_by_name, ids_by_label = {}, {}, defaultdict(list)
    for transition_id in model.get("activities", []):
        tid = int(transition_id)
        label = labels[tid] if tid < len(labels) else None
        transition = PetriNet.Transition(f"t{tid}", label)
        net.transitions.add(transition)
        transitions[tid] = transition
        id_by_name[transition.name] = tid
        if label is not None:
            ids_by_label[str(label)].append(tid)
    for place, transition in model.get("place_to_transition", []):
        if int(place) < len(places) and int(transition) in transitions:
            petri_utils.add_arc_from_to(places[int(place)], transitions[int(transition)], net)
    for transition, place in model.get("transition_to_place", []):
        if int(place) < len(places) and int(transition) in transitions:
            petri_utils.add_arc_from_to(transitions[int(transition)], places[int(place)], net)
    initial = Marking({places[int(p)]: 1 for p in model.get("initial_marking", []) if int(p) < len(places)})
    final = Marking({places[int(p)]: 1 for p in model.get("final_marking", []) if int(p) < len(places)})
    return net, initial, final, id_by_name, ids_by_label


def _traces_from_frame(df):
    traces, total = [], 0
    for case_id, rows in df.groupby("trace_idx", sort=True):
        trace = Trace(attributes={"concept:name": str(case_id)})
        for _, row in rows.iterrows():
            timestamp = _timestamp(row.get("ts"))
            event = Event({"concept:name": str(row["activity"]), "__pm_time": timestamp, "__pm_index": int(row["event_idx"])})
            trace.append(event)
            total += 1
        if trace:
            traces.append(trace)
    return traces, total


def _timestamp(value):
    if value is None or pd.isna(value):
        return None
    try:
        return int(pd.Timestamp(value).value // 1_000_000)
    except Exception:
        return None


def _align(net, initial, final, traces, id_by_name, ids_by_label, ctx):
    """Use pm4py's alignment engine; preserve a deterministic fallback.

    Some browser pm4py builds omit optional solver-like dependencies. A
    fallback still creates a transparent direct label replay rather than
    failing after minutes of package loading, and marks the method in stats.
    """
    events, quality = [], {"synchronous": 0, "deviations": 0, "fitness": 0.0, "fallbackCases": 0}
    for index, trace in enumerate(traces):
        if index % 4 == 0:
            ctx.progress(0.2 + 0.7 * index / max(1, len(traces)), f"aligning case {index + 1} / {len(traces)}")
        try:
            result = pm4py.conformance_diagnostics_alignments(EventLog([trace]), net, initial, final)[0]
            moves = result.get("alignment") or []
            quality["fitness"] += float(result.get("fitness", 0.0))
            events.extend(_events_from_alignment(str(trace.attributes["concept:name"]), trace, moves, id_by_name, ids_by_label, quality))
        except Exception as error:
            # The fallback does not pretend to be a conformance alignment.
            ctx.log(f"alignment fallback for case {trace.attributes['concept:name']}: {type(error).__name__}")
            quality["fallbackCases"] += 1
            events.extend(_fallback_events(str(trace.attributes["concept:name"]), trace, ids_by_label, quality))
    return events, quality


def _strings(value):
    if isinstance(value, str):
        return [value]
    if isinstance(value, (tuple, list)):
        found = []
        for child in value:
            found.extend(_strings(child))
        return found
    return []


def _events_from_alignment(case_id, trace, moves, id_by_name, ids_by_label, quality):
    out, cursor, last_time = [], 0, None
    for sequence, move in enumerate(moves):
        # pm4py returns (log move, model move).  Treating the flattened pair
        # as one list is subtly wrong: a visible model-only move would consume
        # the next log event, shifting the rest of the case by one.  Some
        # variants wrap each side in a (label, transition-name) tuple, hence
        # the recursive extraction after preserving the two sides.
        log_side = move[0] if isinstance(move, (tuple, list)) and len(move) >= 2 else None
        model_side = move[1] if isinstance(move, (tuple, list)) and len(move) >= 2 else None
        log_values, model_values = _strings(log_side), _strings(model_side)
        log_label = next((v for v in log_values if v not in {">>", "None", "null"}), None)
        transition_id = next((id_by_name[v] for v in model_values if v in id_by_name), None)
        model_label = next((v for v in model_values if v not in {">>", "None", "null"} and v not in id_by_name), None)
        consumes_log = log_label is not None
        source = trace[cursor] if consumes_log and cursor < len(trace) else None
        if consumes_log:
            cursor += 1
        if transition_id is None and model_label is not None and len(ids_by_label.get(model_label, [])) == 1:
            transition_id = ids_by_label[model_label][0]
        timestamp = source.get("__pm_time") if source else last_time
        last_time = timestamp if timestamp is not None else last_time
        if transition_id is None:
            if consumes_log:
                quality["deviations"] += 1
            continue
        silent = model_label is None and transition_id is not None
        # A model-only visible transition is a deviation too; a hidden move is
        # legitimate and is retained only when the backend supplied its ID.
        deviation = ((log_label is not None and (model_label is None or log_label != model_label))
                     or (log_label is None and model_label is not None))
        if deviation:
            quality["deviations"] += 1
        elif not silent:
            quality["synchronous"] += 1
        out.append({"caseId": case_id, "transitionId": transition_id, "timestamp": timestamp, "sequence": sequence, "silent": silent, "deviation": deviation})
    return out


def _fallback_events(case_id, trace, ids_by_label, quality):
    events = []
    for sequence, event in enumerate(trace):
        activity = str(event.get("concept:name"))
        candidates = ids_by_label.get(activity, [])
        transition_id = candidates[0] if candidates else None
        deviation = transition_id is None or len(candidates) != 1
        quality["synchronous"] += 0 if deviation else 1
        quality["deviations"] += 1 if deviation else 0
        if transition_id is not None:
            events.append({"caseId": case_id, "transitionId": transition_id, "timestamp": event.get("__pm_time"), "sequence": sequence, "silent": False, "deviation": deviation})
    return events


def _timeline(events):
    times = [e["timestamp"] for e in events if e.get("timestamp") is not None and not e.get("silent")]
    has_timing = bool(times) and max(times) > min(times)
    low, high = (min(times), max(times)) if has_timing else (0, max(1, len(events) - 1))
    span = max(1, high - low)
    # Retain timing proportions, but map wall-clock time to a comprehensible
    # 18–75 second looping visual timeline. Per traversal is later clamped by
    # the renderer to 250–5000 ms as documented in its help text.
    duration = max(18000, min(75000, span))
    return {"start": low, "end": high, "sourceSpanMs": span, "durationMs": duration, "hasTiming": has_timing}
