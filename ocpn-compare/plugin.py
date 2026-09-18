"""OCPN Comparison.

The browser can compare two OCPNs without re-mining either one.  For every
object type we hide silent transitions (tau abstraction) and calculate the
visible direct-follow and reachability footprint induced by the net graph.
That gives a robust, explainable model comparison: adding the harmless
source/loop tau wrappers used by different converters does not become a
spurious activity difference.

This is intentionally *not* advertised as exact OCPN alignment.  Exact
identifier-aware object-centric conformance alignments require a token-game
semantics and an SMT solver; see the README for the relevant literature.
"""

from collections import defaultdict, deque


DISPLAY_LIMIT = 250


def prepare(ctx):
    """Read both inline OCPN payloads delivered by the multi-input API."""
    inputs = ctx.inputs
    baseline = (inputs.get("baseline") or [None])[0]
    candidate = (inputs.get("candidate") or [None])[0]
    if not isinstance(baseline, dict) or not isinstance(candidate, dict):
        raise ValueError("Compare OCPNs needs two inline ObjectCentricPetriNet payloads")
    _validate_net(baseline, "baseline")
    _validate_net(candidate, "candidate")
    return {"baseline": baseline, "candidate": candidate}


def finalize(prepared, params, ctx):
    max_length = max(1, min(16, int(params.get("maxVariantLength", 8))))
    max_variants = max(100, min(10000, int(params.get("maxVariants", 2000))))
    ctx.progress(0.15, "analysing baseline OCPN")
    baseline = _analyse_net(prepared["baseline"], max_length, max_variants)
    ctx.progress(0.5, "analysing candidate OCPN")
    candidate = _analyse_net(prepared["candidate"], max_length, max_variants)
    ctx.progress(0.75, "comparing object-type footprints")

    object_types = sorted(set(baseline["objectTypes"]) | set(candidate["objectTypes"]))
    per_type = []
    for object_type in object_types:
        left = baseline["byObjectType"].get(object_type, _empty_profile(object_type))
        right = candidate["byObjectType"].get(object_type, _empty_profile(object_type))
        per_type.append(_compare_type(object_type, left, right))

    visible_left = set(baseline["visibleActivities"])
    visible_right = set(candidate["visibleActivities"])
    variable_left = set(baseline["variableActivityTypes"])
    variable_right = set(candidate["variableActivityTypes"])
    shared_left = set(baseline["sharedActivities"])
    shared_right = set(candidate["sharedActivities"])
    aggregate = {
        "objectTypes": _set_comparison(set(baseline["objectTypes"]), set(candidate["objectTypes"])),
        "visibleActivities": _set_comparison(visible_left, visible_right),
        "sharedActivities": _set_comparison(shared_left, shared_right),
        "variableActivityTypes": _set_comparison(variable_left, variable_right),
        "structure": {
            "baseline": baseline["structure"],
            "candidate": candidate["structure"],
            "delta": {
                key: candidate["structure"][key] - baseline["structure"][key]
                for key in ("places", "transitions", "silentTransitions", "arcs", "variableArcs")
            },
        },
    }
    ctx.progress(0.95, "writing comparison report")
    return {
        "method": {
            "name": "τ-abstracted behavioural footprint + bounded reciprocal coverage",
            "exact": False,
            "explanation": "Silent transitions are abstracted from per-object-type net paths. Direct-follow and reachability relations are compared structurally; bounded visible graph walks estimate reciprocal coverage. This is not token-game or identifier-aware alignment conformance.",
            "variantBound": {"maxLength": max_length, "maxVariantsPerObjectType": max_variants},
        },
        "summary": aggregate,
        "perObjectType": per_type,
        "stats": {
            "objectTypes": len(object_types),
            "baselineVisibleActivities": len(visible_left),
            "candidateVisibleActivities": len(visible_right),
            "typesWithDifferences": sum(1 for row in per_type if not row["equivalent"]),
        },
    }


def _validate_net(net, role):
    required = ("objectTypes", "places", "transitions", "arcs")
    missing = [key for key in required if not isinstance(net.get(key), list)]
    if missing:
        raise ValueError(f"{role} is not an ObjectCentricPetriNet payload (missing {', '.join(missing)})")


def _analyse_net(net, max_length, max_variants):
    transitions = {str(t.get("id")): t for t in net.get("transitions", []) if t.get("id") is not None}
    object_types = sorted(str(t) for t in net.get("objectTypes", []))
    variable_pairs = set()
    for arc in net.get("arcs", []):
        if not arc.get("variable"):
            continue
        ref = arc.get("source") if (arc.get("source") or {}).get("kind") == "transition" else arc.get("target")
        transition = transitions.get(str((ref or {}).get("id")))
        if transition and transition.get("activity") is not None:
            variable_pairs.add(_pair(str(arc.get("objectType")), str(transition["activity"])))

    profiles = {}
    for object_type in object_types:
        profiles[object_type] = _type_profile(net, transitions, object_type, max_length, max_variants)

    activities = set()
    shared = set()
    for transition in transitions.values():
        activity = transition.get("activity")
        if activity is None:
            continue
        activities.add(str(activity))
        if len(transition.get("objectTypes") or []) > 1:
            shared.add(str(activity))

    return {
        "objectTypes": object_types,
        "byObjectType": profiles,
        "visibleActivities": sorted(activities),
        "sharedActivities": sorted(shared),
        "variableActivityTypes": sorted(variable_pairs),
        "structure": {
            "places": len(net.get("places", [])),
            "transitions": len(transitions),
            "silentTransitions": sum(1 for t in transitions.values() if t.get("activity") is None),
            "arcs": len(net.get("arcs", [])),
            "variableArcs": sum(1 for a in net.get("arcs", []) if a.get("variable")),
        },
    }


def _type_profile(net, transitions, object_type, max_length, max_variants):
    places = {str(p.get("id")): p for p in net.get("places", []) if str(p.get("objectType")) == object_type}
    outgoing, incoming = defaultdict(list), defaultdict(list)
    nodes = set()
    for arc in net.get("arcs", []):
        if str(arc.get("objectType")) != object_type:
            continue
        source, target = _node_id(arc.get("source")), _node_id(arc.get("target"))
        if source and target:
            outgoing[source].append(target)
            incoming[target].append(source)
            nodes.add(source)
            nodes.add(target)

    visible = {
        tid: str(t["activity"])
        for tid, t in transitions.items()
        if t.get("activity") is not None and object_type in (t.get("objectTypes") or []) and tid in nodes
    }
    silent = {
        tid for tid, t in transitions.items()
        if t.get("activity") is None and object_type in (t.get("objectTypes") or [])
    }
    source_places = {pid for pid, p in places.items() if p.get("kind") == "source"}
    sink_places = {pid for pid, p in places.items() if p.get("kind") == "sink"}

    def first_visible(seeds, reverse=False, stop_at_sink=False):
        links = incoming if reverse else outgoing
        queue, seen, found, hit_sink = deque(seeds), set(seeds), set(), False
        while queue:
            node = queue.popleft()
            if stop_at_sink and node in sink_places:
                hit_sink = True
                continue
            if node in visible:
                found.add(node)
                continue
            # Only places and silent transitions may be traversed after a
            # seed.  A malformed foreign node cannot turn into a visible flow.
            if node not in places and node not in silent and node not in source_places and node not in sink_places:
                continue
            for nxt in links.get(node, []):
                if nxt not in seen:
                    seen.add(nxt)
                    queue.append(nxt)
        return found, hit_sink

    successors_by_id = {}
    ends = set()
    for tid in visible:
        next_ids, reaches_sink = first_visible(outgoing.get(tid, []), stop_at_sink=True)
        successors_by_id[tid] = next_ids
        if reaches_sink:
            ends.add(tid)
    start_ids, _ = first_visible(source_places)
    # A net missing boundary tags is still comparable: infer visible roots and
    # leaves from the tau-abstracted graph rather than returning no variants.
    if not start_ids:
        has_visible_predecessor = {target for targets in successors_by_id.values() for target in targets}
        start_ids = set(visible) - has_visible_predecessor or set(visible)
    if not ends:
        ends = {tid for tid, targets in successors_by_id.items() if not targets} or set(visible)

    direct = set()
    labelled_successors = defaultdict(set)
    for source, targets in successors_by_id.items():
        for target in targets:
            relation = _pair(visible[source], visible[target])
            direct.add(relation)
            labelled_successors[visible[source]].add(visible[target])
    activities = set(visible.values())
    starts = {visible[tid] for tid in start_ids if tid in visible}
    end_labels = {visible[tid] for tid in ends if tid in visible}
    reachable = {activity: _reachable(activity, labelled_successors) for activity in activities}
    profile = _reachability_profile(activities, reachable)
    variants, truncated = _bounded_variants(starts, end_labels, labelled_successors, max_length, max_variants)

    return {
        "objectType": object_type,
        "present": bool(nodes or visible),
        "activities": sorted(activities),
        "starts": sorted(starts),
        "ends": sorted(end_labels),
        "direct": sorted(direct),
        "profile": profile,
        "variants": sorted(variants),
        "variantsTruncated": truncated,
        "structure": {
            "places": len(places),
            "visibleTransitions": len(visible),
            "silentTransitions": len(silent),
            "arcs": sum(1 for a in net.get("arcs", []) if str(a.get("objectType")) == object_type),
        },
    }


def _compare_type(object_type, left, right):
    direct = _set_comparison(set(left["direct"]), set(right["direct"]), _relation_rows)
    activities = _set_comparison(set(left["activities"]), set(right["activities"]))
    starts = _set_comparison(set(left["starts"]), set(right["starts"]))
    ends = _set_comparison(set(left["ends"]), set(right["ends"]))
    profile = _profile_comparison(left["profile"], right["profile"])
    variants = _set_comparison(set(left["variants"]), set(right["variants"]), _variant_rows)
    bounded = {
        **variants,
        "baselineCoverageInCandidate": _ratio(variants["sharedCount"], variants["baselineCount"]),
        "candidateCoverageInBaseline": _ratio(variants["sharedCount"], variants["candidateCount"]),
        "baselineTruncated": left["variantsTruncated"],
        "candidateTruncated": right["variantsTruncated"],
    }
    structural_delta = {
        key: right["structure"].get(key, 0) - left["structure"].get(key, 0)
        for key in ("places", "visibleTransitions", "silentTransitions", "arcs")
    }
    equivalent = all((
        activities["jaccard"] == 1,
        starts["jaccard"] == 1,
        ends["jaccard"] == 1,
        direct["jaccard"] == 1,
        profile["agreement"] == 1,
        bounded["baselineCoverageInCandidate"] == 1,
        bounded["candidateCoverageInBaseline"] == 1,
    ))
    return {
        "objectType": object_type,
        "baselinePresent": left["present"],
        "candidatePresent": right["present"],
        "equivalent": equivalent,
        "activities": activities,
        "starts": starts,
        "ends": ends,
        "directFollows": direct,
        "reachabilityProfile": profile,
        "boundedCoverage": bounded,
        "structure": {"baseline": left["structure"], "candidate": right["structure"], "delta": structural_delta},
    }


def _empty_profile(object_type):
    return {
        "objectType": object_type, "present": False, "activities": [], "starts": [], "ends": [],
        "direct": [], "profile": {}, "variants": [], "variantsTruncated": False,
        "structure": {"places": 0, "visibleTransitions": 0, "silentTransitions": 0, "arcs": 0},
    }


def _node_id(ref):
    if not isinstance(ref, dict) or ref.get("id") is None:
        return None
    return str(ref["id"])


def _pair(first, second):
    return f"{first}\u241f{second}"


def _split_pair(value):
    first, second = value.split("\u241f", 1)
    return {"from": first, "to": second}


def _relation_rows(values):
    return [_split_pair(value) for value in values]


def _variant_rows(values):
    return [{"activities": value.split("\u241f") if value else []} for value in values]


def _display(values, render=None):
    ordered = sorted(values)
    return (render or (lambda x: x))(ordered[:DISPLAY_LIMIT]) if render else ordered[:DISPLAY_LIMIT]


def _set_comparison(left, right, render=None):
    shared = left & right
    union = left | right
    return {
        "baselineCount": len(left),
        "candidateCount": len(right),
        "sharedCount": len(shared),
        "jaccard": _ratio(len(shared), len(union)),
        "onlyBaseline": _display(left - right, render),
        "onlyCandidate": _display(right - left, render),
        "onlyBaselineOmitted": max(0, len(left - right) - DISPLAY_LIMIT),
        "onlyCandidateOmitted": max(0, len(right - left) - DISPLAY_LIMIT),
    }


def _ratio(numerator, denominator):
    return 1 if denominator == 0 else round(numerator / denominator, 6)


def _reachable(start, adjacency):
    found, queue = set(), deque(adjacency.get(start, set()))
    while queue:
        activity = queue.popleft()
        if activity in found:
            continue
        found.add(activity)
        queue.extend(adjacency.get(activity, set()) - found)
    return found


def _reachability_profile(activities, reachable):
    result = {}
    ordered = sorted(activities)
    for index, first in enumerate(ordered):
        for second in ordered[index + 1:]:
            forward = second in reachable.get(first, set())
            backward = first in reachable.get(second, set())
            if forward and backward:
                relation = "cyclic"
            elif forward:
                relation = "first-precedes-second"
            elif backward:
                relation = "second-precedes-first"
            else:
                relation = "unrelated"
            result[_pair(first, second)] = relation
    return result


def _profile_comparison(left, right):
    keys = set(left) | set(right)
    differences = []
    agreed = 0
    for key in sorted(keys):
        baseline = left.get(key, "not-present")
        candidate = right.get(key, "not-present")
        if baseline == candidate:
            agreed += 1
        elif len(differences) < DISPLAY_LIMIT:
            row = _split_pair(key)
            row.update({"baseline": baseline, "candidate": candidate})
            differences.append(row)
    return {
        "pairs": len(keys),
        "agreedPairs": agreed,
        "agreement": _ratio(agreed, len(keys)),
        "differences": differences,
        "differencesOmitted": max(0, len(keys) - agreed - DISPLAY_LIMIT),
    }


def _bounded_variants(starts, ends, adjacency, max_length, max_variants):
    if not starts:
        return set(), False
    variants, stack, truncated = set(), [(start, (start,)) for start in sorted(starts)], False
    while stack:
        current, trace = stack.pop()
        if current in ends:
            variants.add("\u241f".join(trace))
        if len(trace) >= max_length:
            if adjacency.get(current):
                truncated = True
            continue
        for next_activity in sorted(adjacency.get(current, set()), reverse=True):
            if len(variants) + len(stack) >= max_variants:
                truncated = True
                break
            stack.append((next_activity, trace + (next_activity,)))
    return variants, truncated
