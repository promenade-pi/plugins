"""Reconstruct missing event-object relations by pairwise object co-occurrence.

Implements §4.1 / §5.2 of Papp, "Object-Centric Event Log Repair Through Graph
Neural Networks": estimate P(o' | o) from observed co-occurrence, score every
candidate object for a partially observed event by summing log-probabilities
over its observed objects, and rank.

Two things here are not in the notebook this is ported from, and both exist
because a plugin makes a number reproducible — including a wrong one.

*The statistics come only from the gapped log.*  The notebook estimated its
co-occurrence table from the complete event log and then evaluated on holes
punched into that same data, so a pair it was asked to recover had already been
counted in the statistics used to recover it.  Here the reference log is opened
for exactly one purpose — reading the ground truth back out — and never
contributes a count.  `ablate.sql` is the other half of that arrangement: it
leaves the train partition intact so there is something honest to learn from.

*A candidate outside the pool is reported, not silently scored zero.*  The
co-occurrence model can only rank objects it has seen beside one of the
observed objects.  The notebook gave anything else a reciprocal rank of 0,
which reads as "ranked last" but is really "never considered" — a different
claim, and one that makes the number incomparable with any method that ranks
the whole object set.  Both readings are available here as `candidatePool`,
and whichever is chosen, `unreachable` counts how many gaps the pool could not
contain in the first place.
"""

import math
from collections import defaultdict

import pandas as pd

# The smoothing constant of §5.2, applied inside the logarithm so a candidate
# supported by one observed object but not another stays finite rather than
# collapsing the whole sum to negative infinity.
EPSILON = 1e-9

# Rank buckets for the distribution chart. A ranking model's failure mode is
# the shape of this distribution, not its mean: "usually first, occasionally
# hopeless" and "reliably third" can share an MRR.
BUCKETS = [
    ("1", 1, 1),
    ("2-5", 2, 5),
    ("6-10", 6, 10),
    ("11-50", 11, 50),
    ("51-100", 51, 100),
    ("101+", 101, None),
]


def _has(ctx, role, logical):
    return f"{role}__{logical}" in ctx.tables


async def prepare(ctx):
    for role in ("partial", "truth"):
        for logical in ("event", "object", "e2o"):
            if not _has(ctx, role, logical):
                raise ValueError(
                    f"the {role} log has no {logical} relation — both inputs must be "
                    "OCEL 2.0 logs with objects"
                )

    ctx.progress(0.08, "reading the gapped log")
    observed = await ctx.sql(
        "SELECT DISTINCT event_id, object_id FROM {partial__e2o} ORDER BY event_id, object_id"
    )

    ctx.progress(0.24, "locating the gaps")
    # The ground truth is the anti-join, never a stored side-channel: what is
    # missing *is* whatever the reference has and the gapped log does not, so
    # the two logs cannot drift out of agreement about it.
    gaps = await ctx.sql(
        "SELECT t.event_id, t.object_id "
        "FROM (SELECT DISTINCT event_id, object_id FROM {truth__e2o}) t "
        "LEFT JOIN (SELECT DISTINCT event_id, object_id FROM {partial__e2o}) p "
        "  ON p.event_id = t.event_id AND p.object_id = t.object_id "
        "WHERE p.event_id IS NULL "
        "ORDER BY t.event_id, t.object_id"
    )

    ctx.progress(0.38, "reading objects and activities")
    objects = await ctx.sql(
        "SELECT object_id, object_type FROM {truth__object} ORDER BY object_id"
    )
    activities = await ctx.sql("SELECT event_id, activity FROM {truth__event}")

    # Whether these two logs are actually a derived pair. A user can bind any
    # two OCEL logs to these slots, and the anti-join would then happily
    # describe their difference as "gaps" and score a meaningless number.
    ctx.progress(0.5, "checking the two logs agree")
    stray = await ctx.sql(
        "SELECT "
        "  (SELECT COUNT(*) FROM (SELECT event_id FROM {partial__event} "
        "     EXCEPT SELECT event_id FROM {truth__event})) AS events_only_in_partial, "
        "  (SELECT COUNT(*) FROM (SELECT object_id FROM {partial__object} "
        "     EXCEPT SELECT object_id FROM {truth__object})) AS objects_only_in_partial, "
        "  (SELECT COUNT(*) FROM (SELECT event_id, object_id FROM {partial__e2o} "
        "     EXCEPT SELECT event_id, object_id FROM {truth__e2o})) AS relations_only_in_partial"
    )

    ctx.progress(0.62, "counting co-occurrence")
    return {
        "observed": observed,
        "gaps": gaps,
        "objects": objects,
        "activities": activities,
        "stray": stray,
    }


def _index(observed, fit_events=None):
    """event -> observed object set, and the co-occurrence tables it induces.

    Built from the gapped log alone. Support is counted over events, matching
    supp(X) = |{e : X ⊆ O(e)}| for the singleton and pair cases the model
    restricts itself to.

    `fit_events`, when given, restricts *fitting* to those events — the training
    partition. The returned context map still covers every event, because an
    event's surviving objects are what a prediction for it conditions on
    whether or not that event contributed to the statistics. The reference
    implementation draws the same line, and it matters: counting a gapped
    event's survivors into the model lets the test partition inform the
    parameters that are then scored on it.
    """
    event_objects = defaultdict(set)
    for event_id, object_id in zip(observed["event_id"], observed["object_id"]):
        event_objects[event_id].add(object_id)

    singleton = defaultdict(int)
    pair = defaultdict(int)
    fitted = (
        event_objects.values()
        if fit_events is None
        else [members for event, members in event_objects.items() if event in fit_events]
    )
    for members in fitted:
        ordered = sorted(members)
        for o in ordered:
            singleton[o] += 1
        for i, a in enumerate(ordered):
            for b in ordered[i + 1:]:
                pair[(a, b)] += 1
                pair[(b, a)] += 1

    conditional = defaultdict(dict)
    for (a, b), count in pair.items():
        support = singleton[a]
        if support:
            conditional[a][b] = count / support

    return event_objects, conditional


def _rank_candidates(observed_objects, conditional):
    """Candidates for one gapped event, best first.

    Ties are broken by object id so that two runs over the same log produce the
    same ranking — with 9,543 objects and a handful of distinct probabilities,
    ties are common enough that an unstable sort would move an object in and
    out of the top-1 between runs.
    """
    # The observed objects are summed over in sorted order, not set order.
    # Floating-point addition is not associative, so iterating a set — whose
    # order varies with the interpreter's string hash seed — gives scores that
    # differ in their last bits between runs. With as many near-ties as a
    # co-occurrence table produces, that is enough to move an object in and out
    # of the top-1 and to make Hits@1 wobble in the third decimal.
    ordered_observed = sorted(observed_objects)

    candidates = set()
    for o in ordered_observed:
        for other in conditional.get(o, ()):
            if other not in observed_objects:
                candidates.add(other)
    if not candidates:
        return []

    scored = []
    for candidate in sorted(candidates):
        total = 0.0
        for o in ordered_observed:
            total += math.log(conditional.get(o, {}).get(candidate, 0.0) + EPSILON)
        scored.append((total, candidate))
    scored.sort(key=lambda row: (-row[0], row[1]))
    return scored


def _bucket(rank):
    if rank is None:
        return "unranked"
    for label, low, high in BUCKETS:
        if rank >= low and (high is None or rank <= high):
            return label
    return "101+"


def _spread(items, limit):
    """A deterministic spread across the list, not its first `limit` entries.

    The gaps arrive sorted by event id, which on most extracts means sorted by
    time; taking a prefix would document one hour of the process and call it a
    walkthrough.
    """
    if limit <= 0 or not items:
        return []
    if len(items) <= limit:
        return list(items)
    step = len(items) / limit
    return [items[min(len(items) - 1, int(i * step))] for i in range(limit)]


def finalize(prepared, params, ctx):
    top_k = max(1, int(params.get("topK", 10)))
    pool_mode = str(params.get("candidatePool", "eventObjects"))
    fit_on = str(params.get("fitOn", "trainEvents"))
    max_examples = max(0, int(params.get("maxExamples", 25)))

    observed = prepared["observed"]
    gaps = prepared["gaps"]
    objects = prepared["objects"]
    stray = prepared["stray"]

    object_type = dict(zip(objects["object_id"], objects["object_type"]))
    # The universe a candidate may come from. The reference implementation uses
    # every object that participates in at least one event, which excludes
    # objects the log records but never relates — they cannot be the answer to
    # "which object was dropped from this event".
    participating = sorted(set(observed["object_id"]) | set(gaps["object_id"]))
    activity_of = dict(zip(prepared["activities"]["event_id"], prepared["activities"]["activity"]))
    total_objects = len(object_type)

    # A gapped log is a strict subset of its reference. Anything the gapped log
    # has that the reference does not means these two artifacts are not a
    # derived pair, and every number below would be measuring their unrelated
    # difference instead of a reconstruction.
    pairing = _pairing(stray)

    ctx.progress(0.68, "estimating co-occurrence probabilities")
    gapped_events = set(gaps["event_id"])
    fit_events = None if fit_on == "allObserved" else {
        event for event in set(observed["event_id"]) if event not in gapped_events
    }
    event_objects, conditional = _index(observed, fit_events)

    missing_by_event = defaultdict(list)
    for event_id, object_id in zip(gaps["event_id"], gaps["object_id"]):
        missing_by_event[event_id].append(object_id)

    ctx.progress(0.78, "ranking candidates")
    hits = {1: 0, 3: 0, 5: 0, 10: 0}
    reciprocal = 0.0
    evaluated = 0
    unreachable = 0
    set_correct = 0
    set_predicted = 0
    histogram = defaultdict(int)
    per_type = defaultdict(lambda: {"evaluated": 0, "hits1": 0, "reciprocal": 0.0, "unreachable": 0})
    walkthrough_pool = []

    for event_id in sorted(missing_by_event):
        missing = sorted(missing_by_event[event_id])
        observed_objects = event_objects.get(event_id, set())
        if not observed_objects:
            # Every object of this event is gone. The model has no context to
            # condition on, so this is not a gap it can be asked about.
            for m in missing:
                unreachable += 1
                histogram["unranked"] += 1
                bucket = per_type[object_type.get(m, "unknown")]
                bucket["evaluated"] += 1
                bucket["unreachable"] += 1
                evaluated += 1
            continue

        missing_set = set(missing)
        scored = _rank_candidates(observed_objects, conditional)
        rank_of = {candidate: index + 1 for index, (_, candidate) in enumerate(scored)}
        # Under `eventObjects`, candidates with no co-occurrence evidence are
        # not excluded — they all score |O(e)|·log(ε), which is strictly below
        # any candidate with real evidence, and tie. Their ranks follow the same
        # identifier order the scored list is tie-broken by, so the block is
        # computed rather than enumerated: 40 million scores would otherwise be
        # evaluated to learn that they are all equal.
        tail = None
        if pool_mode == "eventObjects":
            tail = [
                candidate
                for candidate in participating
                if candidate not in rank_of and candidate not in observed_objects
            ]
        predicted = [candidate for _, candidate in scored[:top_k]]
        set_predicted += len(predicted)
        predicted_set = set(predicted)

        # Objects the pool never considered: everything that is neither
        # observed nor scored. Under "all" they share the position directly
        # after the scored candidates, so a true object among them takes that
        # group's expected rank under random tie-breaking rather than a rank
        # that pretends the model ordered them.
        if tail is not None:
            tail_rank = {candidate: len(scored) + i + 1 for i, candidate in enumerate(tail)}
            tied_rank = None
        else:
            tail_rank = {}
            unscored_count = max(0, total_objects - len(observed_objects) - len(scored))
            tied_rank = len(scored) + (unscored_count + 1) / 2 if unscored_count else None

        for m in missing:
            evaluated += 1
            type_bucket = per_type[object_type.get(m, "unknown")]
            type_bucket["evaluated"] += 1

            rank = rank_of.get(m)
            if rank is None:
                unreachable += 1
                type_bucket["unreachable"] += 1
                if m in tail_rank:
                    rank = tail_rank[m]
                elif pool_mode == "all" and tied_rank is not None:
                    rank = tied_rank

            if rank is None:
                histogram["unranked"] += 1
            else:
                histogram[_bucket(int(math.ceil(rank)))] += 1
                reciprocal += 1.0 / rank
                type_bucket["reciprocal"] += 1.0 / rank
                for k in hits:
                    if rank <= k:
                        hits[k] += 1
                if rank <= 1:
                    type_bucket["hits1"] += 1

            if m in predicted_set:
                set_correct += 1

        if max_examples:
            walkthrough_pool.append({
                "eventId": str(event_id),
                "activity": str(activity_of.get(event_id, "")),
                "observed": [
                    {"objectId": str(o), "objectType": str(object_type.get(o, "unknown"))}
                    for o in sorted(observed_objects)
                ],
                "missing": [
                    {
                        "objectId": str(m),
                        "objectType": str(object_type.get(m, "unknown")),
                        "rank": rank_of.get(m, tail_rank.get(m, tied_rank if pool_mode == "all" else None)),
                        "inPool": m in rank_of,
                    }
                    for m in missing
                ],
                "predictions": [
                    {
                        "objectId": str(candidate),
                        "objectType": str(object_type.get(candidate, "unknown")),
                        "score": round(score, 4),
                        "correct": candidate in missing_set,
                    }
                    for score, candidate in scored[:top_k]
                ],
                "correct": bool(predicted and predicted[0] in missing_set),
            })

    ctx.progress(0.94, "assembling the evaluation")
    denominator = evaluated or 1
    metrics = {
        "evaluated": evaluated,
        "gappedEvents": len(missing_by_event),
        "unreachable": unreachable,
        "hitsAt": {str(k): hits[k] / denominator for k in sorted(hits)},
        "mrr": reciprocal / denominator,
        "precisionAtK": set_correct / set_predicted if set_predicted else 0.0,
        "recallAtK": set_correct / denominator,
    }
    precision, recall = metrics["precisionAtK"], metrics["recallAtK"]
    metrics["f1AtK"] = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0

    by_type = []
    for name in sorted(per_type):
        row = per_type[name]
        count = row["evaluated"] or 1
        by_type.append({
            "objectType": name,
            "evaluated": row["evaluated"],
            "unreachable": row["unreachable"],
            "hitsAt1": row["hits1"] / count,
            "mrr": row["reciprocal"] / count,
        })
    by_type.sort(key=lambda r: (-r["evaluated"], r["objectType"]))

    order = [label for label, _, _ in BUCKETS] + ["unranked"]
    distribution = [{"bucket": label, "n": int(histogram.get(label, 0))} for label in order]

    return {
        "method": {
            "model": "pairwise object co-occurrence",
            "reference": "Papp, Object-Centric Event Log Repair Through Graph Neural Networks, §4.1 / §5.2",
            "score": "s(o') = Σ_{o ∈ O(e)} log( P̂(o' | o) + ε ),  ε = 1e-9",
            "estimatedFrom": (
                "events with no held-out link, in the gapped log only"
                if fit_on == "trainEvents"
                else "every observed relation in the gapped log"
            ),
            "candidatePool": pool_mode,
            "fitOn": fit_on,
            "topK": top_k,
        },
        "pairing": pairing,
        "meta": {
            "objectCount": total_objects,
            "observedRelations": int(len(observed)),
            "missingRelations": int(len(gaps)),
            "observedEvents": len(event_objects),
        },
        "metrics": metrics,
        "rankDistribution": distribution,
        "byObjectType": by_type,
        "examples": _spread(walkthrough_pool, max_examples),
    }


# ---------------------------------------------------------------------------
# Graph stage for the GraphSAGE arm (`entryPoint: "graph"`).
#
# The Rust kernel that trains the network cannot reach DuckDB — a
# `value-finalize/1` wasm action receives one JSON payload and no data
# capability, which is the whole reason this stage exists. It turns two logs
# into the integer-indexed heterogeneous graph of §4.2: event and object nodes,
# the `has` / `in` / `related` relations between them, and the held-out links
# the network is scored on.
#
# Everything the kernel needs is dense-packed into parallel arrays rather than
# objects-per-edge. It crosses the worker boundary as JSON, and 55,000 edges as
# `[{"src":…,"dst":…}]` is several times the size of two flat integer lists
# that say the same thing.
# ---------------------------------------------------------------------------


async def prepare_graph(ctx):
    prepared = await prepare(ctx)
    # The `related` channel of §4.2, which the co-occurrence arm has no use for
    # and therefore does not read. Taken from the gapped log: an object-object
    # relation the simulator never touched is still observed data, and this is
    # the channel that lets an object two hops away reach an event at all.
    prepared["o2o"] = await ctx.sql(
        "SELECT source_id, target_id FROM {partial__o2o}"
        if "partial__o2o" in ctx.tables else
        "SELECT NULL AS source_id, NULL AS target_id WHERE FALSE"
    )
    return prepared


def finalize_graph(prepared, params, ctx):
    observed = prepared["observed"]
    gaps = prepared["gaps"]
    objects = prepared["objects"]
    activities = prepared["activities"]

    ctx.progress(0.7, "indexing nodes")
    # Object and event ids are assigned in sorted order, not first-seen order.
    # The kernel's own tie-breaks (hard-negative sampling, equal-score ranking)
    # resolve by index, so a stable index is part of what makes two runs over
    # the same log produce the same answer.
    object_ids = sorted(objects["object_id"].astype(str))
    object_index = {o: i for i, o in enumerate(object_ids)}
    object_type_of = dict(zip(objects["object_id"].astype(str), objects["object_type"].astype(str)))
    object_type_names = sorted({str(t) for t in object_type_of.values()})
    object_type_index = {t: i for i, t in enumerate(object_type_names)}

    event_ids = sorted({str(e) for e in activities["event_id"]})
    event_index = {e: i for i, e in enumerate(event_ids)}
    activity_of = dict(zip(activities["event_id"].astype(str), activities["activity"].astype(str)))
    activity_names = sorted({str(a) for a in activity_of.values()})
    activity_index = {a: i for i, a in enumerate(activity_names)}

    ctx.progress(0.8, "building edges")
    e2o_src, e2o_dst = [], []
    for event_id, object_id in zip(observed["event_id"].astype(str), observed["object_id"].astype(str)):
        e = event_index.get(event_id)
        o = object_index.get(object_id)
        if e is not None and o is not None:
            e2o_src.append(e)
            e2o_dst.append(o)

    o2o_src, o2o_dst = [], []
    for source_id, target_id in zip(prepared["o2o"]["source_id"].astype(str),
                                    prepared["o2o"]["target_id"].astype(str)):
        a = object_index.get(source_id)
        b = object_index.get(target_id)
        # A self-relation carries no information for message passing and would
        # double-count the node's own state, which the self-transform already
        # holds. Dangling ends are dropped for the same reason `_index` never
        # sees them: they are not links, they are damage.
        if a is not None and b is not None and a != b:
            o2o_src.append(a)
            o2o_dst.append(b)

    gap_event, gap_object = [], []
    for event_id, object_id in zip(gaps["event_id"].astype(str), gaps["object_id"].astype(str)):
        e = event_index.get(event_id)
        o = object_index.get(object_id)
        if e is not None and o is not None:
            gap_event.append(e)
            gap_object.append(o)

    ctx.progress(0.92, "packing the graph")
    return {
        "schemaVersion": 1,
        "objectIds": object_ids,
        "objectTypes": [object_type_index[object_type_of[o]] for o in object_ids],
        "objectTypeNames": object_type_names,
        "eventIds": event_ids,
        "eventActivities": [activity_index[activity_of[e]] for e in event_ids],
        "activityNames": activity_names,
        "e2oSrc": e2o_src,
        "e2oDst": e2o_dst,
        "o2oSrc": o2o_src,
        "o2oDst": o2o_dst,
        "gapEvent": gap_event,
        "gapObject": gap_object,
        "pairing": _pairing(prepared["stray"]),
    }


def _pairing(stray):
    """Whether the two bound logs really are a derived pair.

    `derivedPair` is computed here and carried in the payload rather than being
    left for a consumer to infer from the three counts. The kernel that reads
    this deserialises into a struct where a missing field takes its type's
    default — and the default for a bool is `false`, so an omitted verdict
    reads as "not a derived pair" and the view shows a contradiction: a warning
    that the logs disagree, over three counts that are all zero.
    """
    row = stray.iloc[0]
    counts = {
        "eventsOnlyInPartial": int(row["events_only_in_partial"]),
        "objectsOnlyInPartial": int(row["objects_only_in_partial"]),
        "relationsOnlyInPartial": int(row["relations_only_in_partial"]),
    }
    return {**counts, "derivedPair": all(v == 0 for v in counts.values())}
