"""Object-Centric Variant Metro — stage 1: variants, then a variant-attributed OC-DFG.

This is the internal stage of `run.promenade.variant-metro.discover`. It reads
the OCEL, extracts process executions and groups them into variants exactly the
way the "Cases & Variants (OCEL)" plugin does (Adams, Schuster, Schmitz, Schuh &
van der Aalst, "Defining Cases and Variants for Object-Centric Event Data",
arXiv:2208.03235), and then — the part that is new here — folds every execution
back into one object-centric directly-follows graph in which *every node and
every arc records the most frequent variant it first appears in*.

That single extra number is what the metro map's slider rides on. At slider
position k the view shows exactly the nodes and arcs whose `minVariant` is at
most k, which is precisely the OC-DFG of the k most frequent variants: k = 1 is
the most frequent variant alone, k = max is the whole log. Because "appears in
variant r" is monotone in r, the filtered graph only ever grows as the slider
goes up — which is what lets the view keep the layout stable across the whole
slider range instead of reshuffling at every step.

Per-variant counts ride along too (`byVariant`), so the arc labels and station
numbers the view prints are the counts *of the variants currently shown*, not
of the whole log.

The algorithm is a direct port of `plugins/ocel-cases-variants/src/lib/`
(objectGraph.ts + isomorphism.ts) — deliberately, so the two plugins agree on
what a variant is. Only the hashing primitive differs (interned integers here,
a cyrb-style string hash there): both are just a way to bucket candidates
before exact verification, and neither is part of the result.
"""

from collections import defaultdict

# Above this many events in a hash bucket, exact pairwise verification is
# skipped and the Weisfeiler-Lehman bucket is trusted as one variant — the
# same scalability concession the paper (and the Cases & Variants plugin)
# makes. Kept identical to `VERIFY_NODE_CAP` there.
VERIFY_NODE_CAP = 40


# ---------------------------------------------------------------------------
# Stage A — raw data
# ---------------------------------------------------------------------------
async def prepare(ctx):
    """One pass over the three OCEL tables. Cached by the host per input+maxEvents."""
    ctx.progress(0.1, "reading objects")
    objects = await ctx.sql("SELECT object_id, object_type FROM {object}")
    ctx.progress(0.25, "reading events")
    events = await ctx.sql(
        "SELECT event_id, activity, epoch_ms(ts) AS ts_ms FROM {event}"
    )
    ctx.progress(0.45, "reading event-object relations")
    e2o = await ctx.sql("SELECT DISTINCT event_id, object_id FROM {e2o}")

    type_of = dict(zip(objects["object_id"].astype(str), objects["object_type"].astype(str)))

    activity_of = {}
    ts_of = {}
    for eid, act, ts in zip(
        events["event_id"].astype(str), events["activity"].astype(str), events["ts_ms"]
    ):
        activity_of[eid] = act
        ts_of[eid] = 0.0 if ts is None or ts != ts else float(ts)

    objects_by_event = defaultdict(list)
    events_by_object = defaultdict(list)
    for eid, oid in zip(e2o["event_id"].astype(str), e2o["object_id"].astype(str)):
        if eid not in activity_of or oid not in type_of:
            continue
        objects_by_event[eid].append(oid)
        events_by_object[oid].append(eid)
    for oid, evs in events_by_object.items():
        evs.sort(key=lambda e: (ts_of[e], e))

    ctx.log(
        f"{len(type_of)} objects, {len(activity_of)} events, "
        f"{sum(len(v) for v in objects_by_event.values())} relations"
    )
    return {
        "type_of": type_of,
        "activity_of": activity_of,
        "ts_of": ts_of,
        "objects_by_event": dict(objects_by_event),
        "events_by_object": dict(events_by_object),
    }


# ---------------------------------------------------------------------------
# Stage B — the object graph (paper Def. 3)
# ---------------------------------------------------------------------------
def _object_graph(data):
    """Objects are nodes; two objects are adjacent when they co-occur in an event.

    Built here rather than by a SQL self-join (which is what the Cases &
    Variants view does) only because the relations are already in memory: the
    graph is the same one.
    """
    adjacency = defaultdict(set)
    for oid in data["events_by_object"]:
        adjacency[oid]
    for eid, oids in data["objects_by_event"].items():
        n = len(oids)
        if n < 2:
            continue
        for i in range(n):
            a = oids[i]
            for j in range(i + 1, n):
                b = oids[j]
                adjacency[a].add(b)
                adjacency[b].add(a)
    return adjacency


def _connected_components(adjacency):
    """Paper Def. 5 — every component's object set is one process execution."""
    seen = set()
    out = []
    for start in adjacency:
        if start in seen:
            continue
        seen.add(start)
        stack = [start]
        component = []
        while stack:
            cur = stack.pop()
            component.append(cur)
            for nb in adjacency[cur]:
                if nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
        out.append(component)
    return out


def _leading_type_execution(root, adjacency, type_of):
    """Paper Def. 6 — BFS from one root, keeping per type only the closest objects."""
    dist = {root: 0}
    queue = [root]
    head = 0
    while head < len(queue):
        cur = queue[head]
        head += 1
        d = dist[cur] + 1
        for nb in adjacency.get(cur, ()):
            if nb not in dist:
                dist[nb] = d
                queue.append(nb)
    min_by_type = {}
    for node, d in dist.items():
        t = type_of.get(node)
        if t is None:
            continue
        if d < min_by_type.get(t, 1 << 30):
            min_by_type[t] = d
    return sorted(node for node, d in dist.items() if d == min_by_type.get(type_of.get(node)))


def _nearest_type_distances(adjacency, type_of, type_names):
    """For every object type, the distance from each node to the *nearest*
    object of that type — one multi-source BFS per type, so `len(types)`
    passes over the graph in total rather than one pass per root.

    This is what makes leading-type extraction affordable. `D_t(r)` is by
    definition the distance at which root `r`'s closest type-`t` objects sit
    (paper Def. 6's per-type minimum), so knowing it up front turns the
    per-root search from "explore the whole graph, then take minima" into
    "explore only as deep as the furthest type actually needs" — see
    `_leading_type_executions`.
    """
    fields = {}
    for t in type_names:
        dist = {oid: 0 for oid in adjacency if type_of.get(oid) == t}
        frontier = list(dist)
        depth = 0
        while frontier:
            depth += 1
            nxt = []
            for u in frontier:
                for v in adjacency[u]:
                    if v not in dist:
                        dist[v] = depth
                        nxt.append(v)
            frontier = nxt
        fields[t] = dist
    return fields


def _adjacency_by_type(adjacency, type_of):
    """`node -> type -> neighbours of that type`.

    Lets the last (and usually only expensive) BFS level look up just the
    types it still needs instead of enumerating a hub object's entire
    neighbourhood — the difference between a few dozen lookups per root and a
    few hundred thousand.
    """
    split = {}
    for oid, neighbours in adjacency.items():
        by_type = {}
        for nb in neighbours:
            by_type.setdefault(type_of.get(nb, "?"), []).append(nb)
        split[oid] = by_type
    return split


def _leading_type_executions(roots, adjacency, type_of):
    """`_leading_type_execution` for every root, without the per-root full BFS.

    Identical definition, identical result (asserted against the reference
    implementation on randomised logs in `check.py`) — only the search is
    bounded. For a root `r`, an object `o` belongs to `r`'s execution exactly
    when `d(r, o) == D_type(o)(r)`, and every `D_t(r)` is already known from
    `_nearest_type_distances`. So the search only has to descend to
    `K = max_t D_t(r)` levels, and at that last level it only has to look at
    the types that actually still need it.

    On a log whose object graph a shared hub object makes fully connected
    (order-management: 7 659 roots over 11 872 objects), `K` is 1 or 2 and the
    whole extraction costs a few dozen lookups per root instead of a
    full-graph traversal — the reference implementation's own cost, which is
    what made the first version of this plugin take four minutes there.
    """
    type_names = sorted({type_of.get(oid, "?") for oid in adjacency})
    fields = _nearest_type_distances(adjacency, type_of, type_names)
    by_type = _adjacency_by_type(adjacency, type_of)

    out = []
    for root in roots:
        if root not in adjacency:
            out.append([root])
            continue
        # How deep each type sits, and therefore how deep to search at all.
        needed = defaultdict(list)
        depth_cap = 0
        for t in type_names:
            d = fields[t].get(root)
            if d is None:
                continue  # this root never reaches that type
            needed[d].append(t)
            if d > depth_cap:
                depth_cap = d

        kept = [root] if 0 in needed else []
        visited = {root}
        frontier = [root]
        for depth in range(1, depth_cap + 1):
            if depth == depth_cap:
                # Last level: only the types still outstanding, looked up
                # directly rather than by enumerating the whole frontier's
                # neighbourhood.
                wanted = needed.get(depth, ())
                for u in frontier:
                    lookup = by_type.get(u, {})
                    for t in wanted:
                        for v in lookup.get(t, ()):
                            if v not in visited:
                                visited.add(v)
                                kept.append(v)
                break
            nxt = []
            for u in frontier:
                for v in adjacency[u]:
                    if v not in visited:
                        visited.add(v)
                        nxt.append(v)
            wanted = set(needed.get(depth, ()))
            if wanted:
                kept.extend(v for v in nxt if type_of.get(v, "?") in wanted)
            frontier = nxt
        out.append(sorted(kept))
    return out


def _allowed_events_by_root(object_sets, data):
    """Scopes a shared ("hub") object to its closest execution.

    Identical rule to the Cases & Variants plugin's `computeAllowedEventsByRoot`:
    an event goes to the execution(s) containing its *least shared* touching
    object. See that plugin's README for why raw graph distance cannot do this
    job (a hub sits at distance 1 from everything it touches too).
    """
    members_of = defaultdict(set)
    for root, object_ids in object_sets:
        for oid in object_ids:
            members_of[oid].add(root)

    allowed = {root: set() for root, _ in object_sets}
    for eid, touching in data["objects_by_event"].items():
        best = min((len(members_of[o]) for o in touching if o in members_of), default=None)
        if best is None:
            continue
        for oid in touching:
            roots = members_of.get(oid)
            if roots is not None and len(roots) == best:
                for root in roots:
                    allowed[root].add(eid)
    return allowed


# ---------------------------------------------------------------------------
# Stage C — one process execution (paper Def. 4/7)
# ---------------------------------------------------------------------------
def _type_counts(object_ids, type_of):
    counts = defaultdict(int)
    for oid in object_ids:
        t = type_of.get(oid)
        if t is not None:
            counts[t] += 1
    return tuple(sorted(counts.items()))


def _build_execution(object_ids, data, max_events, allowed_events):
    """The labelled execution graph, plus the per-object event sequences it came from.

    Truncation (`max_events`) keeps the execution-wide chronologically *first*
    events, taken from each object's own chronologically first `max_events` —
    provably the exact same set, and comparable across executions, which is what
    keeps a truncated execution a real variant member instead of a forced
    singleton. Same reasoning as `buildExecution` in the Cases & Variants view.
    """
    type_of = data["type_of"]
    ts_of = data["ts_of"]
    object_set = set(object_ids)

    if allowed_events is not None:
        candidates = sorted(allowed_events, key=lambda e: (ts_of[e], e))
        kept = candidates[:max_events]
        truncated = len(candidates) > max_events
        touching = {
            eid: [o for o in data["objects_by_event"].get(eid, ()) if o in object_set]
            for eid in kept
        }
    else:
        union = {}
        for oid in object_ids:
            evs = data["events_by_object"].get(oid, ())
            for eid in evs[:max_events]:
                union.setdefault(eid, []).append(oid)
        ordered = sorted(union, key=lambda e: (ts_of[e], e))
        kept = ordered[:max_events]
        truncated = len(ordered) > max_events
        touching = {eid: union[eid] for eid in kept}

    per_object = defaultdict(list)
    for eid in kept:
        for oid in touching[eid]:
            per_object[oid].append(eid)
    # `kept` is already in (ts, id) order, so every per-object list is too.

    activity_of = data["activity_of"]
    nodes = {eid: (activity_of.get(eid, "?"), _type_counts(touching[eid], type_of)) for eid in kept}
    # D = each object's own consecutive-event pairs, restricted to this
    # execution (the practical reading of con_L ∩ (E'×E')); an arc's label is
    # the type counts of the objects touching *both* endpoints.
    pairs = set()
    for seq in per_object.values():
        for i in range(1, len(seq)):
            pairs.add((seq[i - 1], seq[i]))
    edges = {}
    for a, b in pairs:
        tb = set(touching[b])
        edges[(a, b)] = _type_counts([o for o in touching[a] if o in tb], type_of)

    return {
        "events": kept,
        "nodes": nodes,
        "edges": edges,
        "per_object": dict(per_object),
        "truncated": truncated,
    }


# ---------------------------------------------------------------------------
# Stage D — variants (paper §V): WL bucketing, then exact verification
# ---------------------------------------------------------------------------
def _canonical_hash(execution):
    """Weisfeiler-Lehman canonical hash of the labelled execution graph.

    Colors are interned as integers rather than concatenated strings, so a
    round costs O(edges) instead of growing the label without bound; refinement
    stops as soon as the number of distinct colors stops growing.
    """
    out_edges = defaultdict(list)
    in_edges = defaultdict(list)
    for (a, b), label in execution["edges"].items():
        out_edges[a].append((b, label))
        in_edges[b].append((a, label))

    intern = {}

    def color_of(key):
        c = intern.get(key)
        if c is None:
            c = len(intern)
            intern[key] = c
        return c

    colors = {eid: color_of(execution["nodes"][eid]) for eid in execution["events"]}
    rounds = min(len(execution["events"]) + 1, 16)
    for r in range(rounds):
        nxt = {}
        for eid in execution["events"]:
            outs = tuple(sorted((lab, colors[to]) for to, lab in out_edges.get(eid, ())))
            ins = tuple(sorted((lab, colors[fr]) for fr, lab in in_edges.get(eid, ())))
            nxt[eid] = color_of((colors[eid], outs, ins))
        before = len(set(colors.values()))
        after = len(set(nxt.values()))
        colors = nxt
        if after <= before and r > 0:
            break
    return (len(execution["events"]), len(execution["edges"]), tuple(sorted(colors.values())))


def _isomorphic(a, b):
    """Backtracking exact isomorphism check, pruned by node label groups."""
    if len(a["events"]) != len(b["events"]) or len(a["edges"]) != len(b["edges"]):
        return False
    a_by_label = defaultdict(list)
    for eid in a["events"]:
        a_by_label[a["nodes"][eid]].append(eid)
    b_by_label = defaultdict(list)
    for eid in b["events"]:
        b_by_label[b["nodes"][eid]].append(eid)
    if len(a_by_label) != len(b_by_label):
        return False
    for label, group in a_by_label.items():
        if len(b_by_label.get(label, ())) != len(group):
            return False

    order = sorted(a["events"], key=lambda e: len(a_by_label[a["nodes"][e]]))
    mapping = {}
    used = set()
    a_edges = a["edges"]
    b_edges = b["edges"]

    def consistent(av, bv):
        for aid, bid in mapping.items():
            if a_edges.get((aid, av)) != b_edges.get((bid, bv)):
                return False
            if a_edges.get((av, aid)) != b_edges.get((bv, bid)):
                return False
        return True

    def backtrack(i):
        if i == len(order):
            return True
        av = order[i]
        for bv in b_by_label[a["nodes"][av]]:
            if bv in used or not consistent(av, bv):
                continue
            mapping[av] = bv
            used.add(bv)
            if backtrack(i + 1):
                return True
            del mapping[av]
            used.discard(bv)
        return False

    return backtrack(0)


def _group_variants(executions):
    """Buckets by canonical hash, then splits each bucket into true isomorphism classes."""
    buckets = defaultdict(list)
    for ex in executions:
        buckets[_canonical_hash(ex)].append(ex)

    groups = []
    for bucket in buckets.values():
        if len(bucket) == 1 or any(len(ex["events"]) > VERIFY_NODE_CAP for ex in bucket):
            groups.append(bucket)
            continue
        classes = []
        for ex in bucket:
            for cls in classes:
                if _isomorphic(cls[0], ex):
                    cls.append(ex)
                    break
            else:
                classes.append([ex])
        groups.extend(classes)
    return groups


# ---------------------------------------------------------------------------
# Stage E — fold the variants back into one variant-attributed OC-DFG
# ---------------------------------------------------------------------------
def finalize(prepared, params, ctx):
    data = prepared
    extraction = str(params.get("extraction") or "leadingType")
    max_events = int(params.get("maxEvents") or 300)
    max_variants = max(2, int(params.get("maxVariants") or 25))
    max_object_types = max(1, int(params.get("maxObjectTypes") or 12))
    scope_shared = bool(params.get("scopeSharedObjects", True))

    type_of = data["type_of"]
    if not data["events_by_object"]:
        return _empty(ctx, "the log has no event-to-object relations to build executions from")

    ctx.progress(0.05, "building the object graph")
    adjacency = _object_graph(data)

    # ---- executions -------------------------------------------------------
    if extraction == "connectedComponents":
        object_sets = [(sorted(c)[0], c) for c in _connected_components(adjacency)]
        allowed = None
    else:
        leading_type = str(params.get("leadingType") or "")
        by_count = defaultdict(int)
        for oid in data["events_by_object"]:
            by_count[type_of.get(oid, "?")] += 1
        if leading_type not in by_count:
            leading_type = max(by_count.items(), key=lambda kv: (kv[1], kv[0]))[0]
        roots = sorted(o for o in data["events_by_object"] if type_of.get(o) == leading_type)
        ctx.progress(0.15, f"extracting {len(roots)} executions led by {leading_type}")
        object_sets = list(zip(roots, _leading_type_executions(roots, adjacency, type_of)))
        allowed = _allowed_events_by_root(object_sets, data) if scope_shared else None

    if not object_sets:
        return _empty(ctx, "no process executions could be extracted from this log")

    ctx.progress(0.35, f"building {len(object_sets)} process executions")
    executions = []
    for root, object_ids in object_sets:
        ex = _build_execution(
            object_ids, data, max_events, allowed.get(root) if allowed is not None else None
        )
        if ex["events"]:
            executions.append(ex)
    if not executions:
        return _empty(ctx, "every extracted process execution turned out to be empty")

    ctx.progress(0.55, f"grouping {len(executions)} executions into variants")
    groups = _group_variants(executions)
    # Most frequent variant first — this ordering *is* the slider's own scale.
    groups.sort(key=lambda g: (-len(g), -sum(len(ex["events"]) for ex in g) / len(g)))
    variant_count = len(groups)

    # Each of the `maxVariants` most frequent variants gets its own slider
    # position; everything past that shares one final position, so the top of
    # the slider is always the complete log rather than a truncated model.
    individual = min(variant_count, max_variants)
    has_tail = variant_count > individual
    positions = individual + (1 if has_tail else 0)

    ctx.progress(0.75, "folding variants into a directly-follows graph")
    node_acc = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0, 0.0]))  # (ot,act) -> rank -> [count,starts,ends]
    edge_acc = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))       # (ot,src,dst) -> rank -> [freq,secs]
    activity_of = data["activity_of"]
    ts_of = data["ts_of"]
    truncated = 0

    for index, group in enumerate(groups):
        rank = min(index, individual) + 1
        for ex in group:
            if ex["truncated"]:
                truncated += 1
            for oid, seq in ex["per_object"].items():
                ot = type_of.get(oid)
                if ot is None or not seq:
                    continue
                seen_here = set()
                for eid in seq:
                    act = activity_of.get(eid, "?")
                    if act not in seen_here:
                        seen_here.add(act)
                        node_acc[(ot, act)][rank][0] += 1
                node_acc[(ot, activity_of.get(seq[0], "?"))][rank][1] += 1
                node_acc[(ot, activity_of.get(seq[-1], "?"))][rank][2] += 1
                for i in range(1, len(seq)):
                    a, b = seq[i - 1], seq[i]
                    slot = edge_acc[(ot, activity_of.get(a, "?"), activity_of.get(b, "?"))][rank]
                    slot[0] += 1
                    slot[1] += max(0.0, (ts_of[b] - ts_of[a]) / 1000.0)

    # ---- object-type limit (drawing only; variants always used every type) --
    type_weight = defaultdict(float)
    for (ot, _act), by_rank in node_acc.items():
        type_weight[ot] += sum(v[0] for v in by_rank.values())
    kept_types = sorted(type_weight, key=lambda t: (-type_weight[t], t))[:max_object_types]
    kept = set(kept_types)

    nodes = []
    for (ot, act), by_rank in sorted(node_acc.items()):
        if ot not in kept:
            continue
        ranks = sorted(by_rank)
        nodes.append({
            "objectType": ot,
            "activity": act,
            "count": sum(by_rank[r][0] for r in ranks),
            "starts": sum(by_rank[r][1] for r in ranks),
            "ends": sum(by_rank[r][2] for r in ranks),
            "minVariant": ranks[0],
            "byVariant": [[r, by_rank[r][0], by_rank[r][1], by_rank[r][2]] for r in ranks],
        })

    edges = []
    for (ot, src, dst), by_rank in sorted(edge_acc.items()):
        if ot not in kept:
            continue
        ranks = sorted(by_rank)
        freq = sum(by_rank[r][0] for r in ranks)
        secs = sum(by_rank[r][1] for r in ranks)
        edges.append({
            "objectType": ot,
            "src": src,
            "dst": dst,
            "freq": freq,
            "avgSecs": (secs / freq) if freq > 0 else None,
            "minVariant": ranks[0],
            "byVariant": [[r, by_rank[r][0], by_rank[r][1]] for r in ranks],
        })

    execution_total = len(executions)
    variants = []
    for index, group in enumerate(groups[:individual]):
        variants.append({
            "rank": index + 1,
            "executions": len(group),
            "avgEvents": sum(len(ex["events"]) for ex in group) / len(group),
            "tail": False,
            "variants": 1,
        })
    if has_tail:
        tail_groups = groups[individual:]
        tail_executions = sum(len(g) for g in tail_groups)
        variants.append({
            "rank": positions,
            "executions": tail_executions,
            "avgEvents": sum(len(ex["events"]) for g in tail_groups for ex in g) / max(1, tail_executions),
            "tail": True,
            "variants": len(tail_groups),
        })
    # Cumulative share of all process executions covered up to and including
    # each slider position — the honest "how much of the log am I looking at".
    running_executions = 0
    running_variants = 0
    for entry in variants:
        running_executions += entry["executions"]
        running_variants += entry["variants"]
        entry["cumulative"] = running_executions
        entry["cumulativeVariants"] = running_variants
        entry["share"] = running_executions / execution_total if execution_total else 0.0

    ctx.log(
        f"{execution_total} executions, {variant_count} variants, "
        f"{len(nodes)} activity/type nodes, {len(edges)} arcs"
    )
    return {
        "objectTypes": kept_types,
        "nodes": nodes,
        "edges": edges,
        "variants": variants,
        "activities": sorted({n["activity"] for n in nodes}),
        "stats": {
            "variantCount": variant_count,
            "executionCount": execution_total,
            "sliderPositions": positions,
            "tailPosition": positions if has_tail else 0,
            "truncatedExecutions": truncated,
            "extractionMethod": extraction,
            "objectTypeCount": len(kept_types),
        },
    }


def _empty(ctx, reason):
    ctx.log(reason)
    return {
        "objectTypes": [],
        "nodes": [],
        "edges": [],
        "variants": [],
        "activities": [],
        "stats": {
            "variantCount": 0,
            "executionCount": 0,
            "sliderPositions": 0,
            "truncatedExecutions": 0,
            "objectTypeCount": 0,
            "note": reason,
        },
    }
