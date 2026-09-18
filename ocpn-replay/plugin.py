"""Deterministic, object-bound OCEL/OCPN replay.

This producer deliberately implements an auditable replay, not an optimal
alignment. Each event-object relation for a modelled object type is one
binding with its own marking. Silent transitions may be inserted via bounded
breadth-first search before a labelled firing. The output follows the Atlas
ObjectCentricReplayEvidence contract exactly.
"""

from collections import Counter, defaultdict, deque

ENGINE_ID = "run.promenade.ocpn-replay.greedy-token-game"
ENGINE_VERSION = "1.0.0"


async def prepare(ctx):
    inputs, input_ids = ctx.inputs, ctx.input_ids
    model = (inputs.get("model") or [None])[0]
    source_id, model_id = _one_id(input_ids, "log"), _one_id(input_ids, "model")
    if not isinstance(model, dict):
        raise ValueError("Replay needs an inline ObjectCentricPetriNet model")
    _validate_model(model)

    max_events = int(ctx.params.get("maxEvents", 500000))
    total = int((await ctx.sql("SELECT COUNT(*) AS n FROM {event}"))["n"].iloc[0])
    timed = int((await ctx.sql("SELECT COUNT(*) AS n FROM {event} WHERE ts IS NOT NULL"))["n"].iloc[0])
    if timed != total:
        raise ValueError(
            "Replay requires a timestamp for every source event so its timestamp-total order and lifecycle phase are defined. "
            f"{total - timed} event(s) have no timestamp."
        )
    if total > max_events:
        raise ValueError(
            f"Replay stopped before execution: source has {total:,} events, above the safety ceiling of {max_events:,}. "
            "Raise Maximum events; incomplete prefixes never produce completed evidence."
        )

    ctx.progress(0.12, "reading timestamp-ordered OCEL events")
    events = await ctx.sql("""
        SELECT event_id, COALESCE(activity, '(none)') AS activity, epoch_ms(ts) AS ts_ms
        FROM {event} ORDER BY ts, event_id
    """)
    ctx.progress(0.28, "reading object bindings")
    bindings = await ctx.sql("""
        SELECT DISTINCT r.event_id, r.object_id, o.object_type
        FROM {e2o} r JOIN {object} o ON o.object_id = r.object_id
        ORDER BY r.event_id, o.object_type, r.object_id
    """)
    return {
        "sourceId": source_id, "modelId": model_id, "model": model,
        "events": events.to_dict("records"), "bindings": bindings.to_dict("records"),
    }


def finalize(prepared, params, ctx):
    game = _compile_game(prepared["model"])
    max_silent = max(0, min(128, int(params.get("maxSilentMoves", 32))))
    bins = max(8, min(80, int(params.get("binCount", 24))))
    trace_limit = max(0, min(50000, int(params.get("traceLimit", 3000))))
    events = [
        {"event_id": str(row["event_id"]), "activity": str(row["activity"]), "ts_ms": int(row["ts_ms"])}
        for row in prepared["events"]
    ]
    bindings_by_event = defaultdict(list)
    for row in prepared["bindings"]:
        bindings_by_event[str(row["event_id"])].append((str(row["object_id"]), str(row["object_type"])))

    # Fixed lifecycle bounds match Interaction Atlas's default exactly.
    event_time = {row["event_id"]: row["ts_ms"] for row in events}
    lifetimes = {}
    for event_id, pairs in bindings_by_event.items():
        timestamp = event_time[event_id]
        for object_id, _ in pairs:
            first, last = lifetimes.get(object_id, (timestamp, timestamp))
            lifetimes[object_id] = min(first, timestamp), max(last, timestamp)

    markings, accepted, evidence_events = {}, defaultdict(set), []
    # The animation trace: one frame per event, each step a single token move.
    # Markings are never snapshotted — the view replays these steps against the
    # net to reconstruct them — so a frame costs a handful of small dicts.
    trace_frames = []
    # Frames accumulated since the last progress tick, streamed to a live-preview
    # view of the evidence so the token game animates while the replay runs.
    stream_batch = []
    total_events = max(1, len(events))
    # ~60 streamed updates over the run, whatever its length (min every 8 events).
    stream_every = max(8, total_events // 60)
    for index, event in enumerate(events):
        if index % stream_every == 0:
            payload = None
            if stream_batch:
                payload = {"kind": "replay-delta", "upTo": index, "total": len(events), "frames": stream_batch}
                stream_batch = []
            ctx.progress(0.30 + 0.55 * index / total_events, f"replaying {index:,} / {len(events):,} events", payload)
        event_id, activity = event["event_id"], event["activity"]
        collect_trace = trace_limit > 0 and index < trace_limit
        frame_steps = []
        relevant = [
            (object_id, object_type) for object_id, object_type in bindings_by_event.get(event_id, [])
            if object_type in game["types"]
        ]
        supported = log_moves = model_moves = 0
        for object_id, object_type in relevant:
            marking = markings.get(object_id, _initial_marking(game, object_type))
            result = _replay_binding(game, object_type, activity, marking, max_silent)
            if result is None:
                log_moves += 1
                markings[object_id] = marking
                if collect_trace:
                    frame_steps.append({"o": object_id, "ot": object_type, "k": "logmove"})
            else:
                new_marking, silent_ids, visible_id = result
                markings[object_id] = new_marking
                accepted[event_id].add(object_id)
                supported += 1
                model_moves += len(silent_ids)
                if collect_trace:
                    for silent_id in silent_ids:
                        frame_steps.append({"o": object_id, "ot": object_type, "tr": silent_id, "k": "silent"})
                    frame_steps.append({"o": object_id, "ot": object_type, "tr": visible_id, "k": "fire"})
        if not relevant:
            log_moves = 1
        evidence_events.append({
            "eventId": event_id,
            "tsMs": event["ts_ms"],
            "support": supported / len(relevant) if relevant else 0.0,
            "logMoves": log_moves,
            "modelMoves": model_moves,
        })
        if collect_trace and frame_steps:
            frame = {"e": event_id, "t": event["ts_ms"], "a": activity, "steps": frame_steps}
            trace_frames.append(frame)
            stream_batch.append(frame)

    if stream_batch:
        ctx.progress(0.87, f"replaying {len(events):,} events",
                     {"kind": "replay-delta", "upTo": len(events), "total": len(events), "frames": stream_batch})
    ctx.progress(0.88, "building replayed-event interaction fields")
    expected_fields = _expected_fields(events, bindings_by_event, accepted, lifetimes, game["types"], bins)
    log_total = sum(row["logMoves"] for row in evidence_events)
    model_total = sum(row["modelMoves"] for row in evidence_events)
    supported_bindings = sum(len(values) for values in accepted.values())
    ctx.log(f"replayed {len(events):,} events; {supported_bindings:,} supported bindings; {log_total:,} log moves; {model_total:,} silent model moves")
    ctx.progress(1, "completed replay evidence")

    model = prepared["model"]
    # The net travels with the evidence so a view can draw it without a second
    # artifact input (the host only forwards a source artifact to single-input
    # views). This is OcpnPayload minus the discovery-time `metadata`.
    net = {
        "objectTypes": list(model.get("objectTypes") or []),
        "places": list(model.get("places") or []),
        "transitions": list(model.get("transitions") or []),
        "arcs": list(model.get("arcs") or []),
    }
    trace = None
    if trace_limit > 0:
        trace = {
            "limit": trace_limit,
            "truncated": len(events) > trace_limit,
            "objectTypes": sorted(game["types"]),
            "frames": trace_frames,
        }

    return {
        "schemaVersion": 1,
        "sourceArtifactId": prepared["sourceId"], "modelArtifactId": prepared["modelId"],
        "coordinateSystem": "lifecycle-phase-v1",
        "replay": {"engineId": ENGINE_ID, "engineVersion": ENGINE_VERSION,
                   "ordering": "timestamp-total-order-v1", "completed": True},
        "events": evidence_events, "expectedFields": expected_fields,
        "net": net, "trace": trace,
        "stats": {"events": len(events), "supportedBindings": supported_bindings,
                  "logMoves": log_total, "silentModelMoves": model_total,
                  "tracedEvents": len(trace_frames),
                  "method": "deterministic object-bound greedy token replay"},
    }


def _one_id(ids, role):
    values = (ids or {}).get(role) or []
    if len(values) != 1 or not isinstance(values[0], str) or not values[0]:
        raise ValueError(f"Replay needs exactly one {role} artifact id")
    return values[0]


def _validate_model(model):
    missing = [key for key in ("objectTypes", "places", "transitions", "arcs") if not isinstance(model.get(key), list)]
    if missing:
        raise ValueError("OCPN model is missing " + ", ".join(missing))


def _compile_game(model):
    types = set(map(str, model["objectTypes"]))
    transitions = {str(row.get("id")): row for row in model["transitions"] if row.get("id") is not None}
    places = {str(row.get("id")): row for row in model["places"] if row.get("id") is not None}
    inputs, outputs = defaultdict(lambda: defaultdict(Counter)), defaultdict(lambda: defaultdict(Counter))
    for arc in model["arcs"]:
        object_type = str(arc.get("objectType"))
        if object_type not in types:
            continue
        source, target = arc.get("source") or {}, arc.get("target") or {}
        source_id, target_id = str(source.get("id")), str(target.get("id"))
        if source.get("kind") == "place" and target.get("kind") == "transition":
            inputs[object_type][target_id][source_id] += 1
        elif source.get("kind") == "transition" and target.get("kind") == "place":
            outputs[object_type][source_id][target_id] += 1

    visible, silent, sources = defaultdict(lambda: defaultdict(list)), defaultdict(list), defaultdict(list)
    for object_type in types:
        for place_id, place in places.items():
            if str(place.get("objectType")) == object_type and place.get("kind") == "source":
                sources[object_type].append(place_id)
        for transition_id, transition in transitions.items():
            if object_type not in set(map(str, transition.get("objectTypes") or [])):
                continue
            if transition.get("activity") is None:
                silent[object_type].append(transition_id)
            else:
                visible[object_type][str(transition["activity"])].append(transition_id)
    for rows in list(silent.values()) + list(sources.values()):
        rows.sort()
    for by_activity in visible.values():
        for rows in by_activity.values():
            rows.sort()
    return {"types": types, "inputs": inputs, "outputs": outputs,
            "visible": visible, "silent": silent, "sources": sources}


def _initial_marking(game, object_type):
    return {place_id: 1 for place_id in game["sources"][object_type]}


def _enabled(marking, required):
    return all(marking.get(place_id, 0) >= count for place_id, count in required.items())


def _fire(game, object_type, transition_id, marking):
    next_marking = dict(marking)
    for place_id, count in game["inputs"][object_type][transition_id].items():
        remaining = next_marking.get(place_id, 0) - count
        if remaining:
            next_marking[place_id] = remaining
        else:
            next_marking.pop(place_id, None)
    for place_id, count in game["outputs"][object_type][transition_id].items():
        next_marking[place_id] = next_marking.get(place_id, 0) + count
    return next_marking


def _marking_key(marking):
    return tuple(sorted((place_id, count) for place_id, count in marking.items() if count))


def _replay_binding(game, object_type, activity, marking, max_silent):
    """Returns (next_marking, [silent_transition_ids...], visible_transition_id)
    for the shortest bounded silent prefix that enables `activity`, or None for
    a log move. The silent path is returned (not just its length) so the
    animation trace can name every transition that fired."""
    targets = game["visible"][object_type].get(activity) or []
    if not targets:
        return None
    queue, seen = deque([(marking, ())]), {_marking_key(marking)}
    while queue:
        state, path = queue.popleft()
        for transition_id in targets:
            if _enabled(state, game["inputs"][object_type][transition_id]):
                return _fire(game, object_type, transition_id, state), list(path), transition_id
        if len(path) >= max_silent:
            continue
        for transition_id in game["silent"][object_type]:
            if not _enabled(state, game["inputs"][object_type][transition_id]):
                continue
            next_state = _fire(game, object_type, transition_id, state)
            key = _marking_key(next_state)
            if key not in seen:
                seen.add(key)
                queue.append((next_state, path + (transition_id,)))
    return None


def _phase(object_id, timestamp, lifetimes):
    first, last = lifetimes[object_id]
    return 0.5 if first == last else (timestamp - first) / (last - first)


def _expected_fields(events, bindings_by_event, accepted, lifetimes, model_types, bins):
    fields = {}
    for event in events:
        event_id, timestamp = event["event_id"], event["ts_ms"]
        by_type = defaultdict(list)
        for object_id, object_type in bindings_by_event.get(event_id, []):
            if object_id in accepted[event_id] and object_type in model_types:
                by_type[object_type].append(object_id)
        types = sorted(by_type)
        for left_index, left_type in enumerate(types):
            for right_type in types[left_index:]:
                pairs = []
                for left in sorted(set(by_type[left_type])):
                    for right in sorted(set(by_type[right_type])):
                        if left_type != right_type or left < right:
                            pairs.append((left, right))
                if not pairs:
                    continue
                mass = fields.setdefault((left_type, right_type), [0.0] * (bins * bins))
                weight = 1.0 / len(pairs)
                for left, right in pairs:
                    bin_a = min(bins - 1, max(0, int(_phase(left, timestamp, lifetimes) * bins)))
                    bin_b = min(bins - 1, max(0, int(_phase(right, timestamp, lifetimes) * bins)))
                    mass[bin_b * bins + bin_a] += weight
    return [
        {"pair": {"a": left, "b": right}, "binCount": bins, "mass": mass, "population": "replayed-events"}
        for (left, right), mass in sorted(fields.items())
    ]
