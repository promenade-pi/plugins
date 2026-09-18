"""Backbone-based OC-DFG layout by integer programming.

Implements the layout method of Lee, Song and van der Aalst for
Object-Centric Directly-Follows Graphs, combining the two papers:

  [1] D. Lee, M. Song, W.M.P. van der Aalst: "Layouting Object-Centric
      Directly Follows Graphs", BPM 2025, LNBIP 564, pp. 204-220.
  [2] D. Lee, M. Song, W.M.P. van der Aalst: "An optimized backbone-based
      process layout generation method using integer programming and
      heuristics to enhance user comprehension", Data & Knowledge
      Engineering 164 (2026) 102601.

[1] supplies the object-centric structure: one axis per object type, the
incremental axis merge, the layout cost function, axis-restricted crossing
minimisation. [2] supplies the refined single-graph core: the squared
precedence penalty, horizontal edges for mutually dependent activities,
virtual-node generation, integer-programming component balancing, and a
node-positioning step that keeps a backbone straight. Neither paper is a
superset of the other; README.md has the correspondence table and every
place this implementation had to decide something the papers leave open.

Both integer programs are solved by `scipy.optimize.milp`, i.e. by HiGHS,
which Pyodide's scipy ships as a compiled extension. The reference
implementation (github.com/deoksanglee/BackboneLayoutIP) uses Gurobi; these
are the same models transcribed to HiGHS' matrix form, with the squared
objective linearised exactly (see `_rank_ip`).
"""

import math
import time
from collections import defaultdict

import numpy as np

try:
    from scipy.optimize import Bounds, LinearConstraint, milp
    from scipy.sparse import csr_matrix

    _HAVE_MILP = True
except Exception:  # pragma: no cover - only where scipy lacks HiGHS
    _HAVE_MILP = False


# ---------------------------------------------------------------------------
# Geometry constants
#
# Node widths enter the layout itself: `packcut` ([2] Def. 19) separates
# neighbours by half their widths plus a gap, so a long activity label pushes
# its rank apart. The action therefore has to know the view's text metrics
# rather than emit width-free coordinates the view would have to re-space.
# ---------------------------------------------------------------------------

CHAR_W = 6.9
LABEL_PAD = 26.0
MIN_ACTIVITY_W = 108.0
MAX_ACTIVITY_W = 260.0
BOUNDARY_W = 30.0
VIRTUAL_W = 10.0

ACTIVITY_H = 40.0
BOUNDARY_H = 30.0


def _activity_width(label):
    raw = MIN_ACTIVITY_W if not label else len(str(label)) * CHAR_W + LABEL_PAD
    return float(min(MAX_ACTIVITY_W, max(MIN_ACTIVITY_W, raw)))


def _node_name(activity):
    return "a:" + activity


def _start_name(object_type):
    return "s:" + object_type


def _end_name(object_type):
    return "e:" + object_type


# ---------------------------------------------------------------------------
# 1. Data preparation ([1] Sect. 3.1)
# ---------------------------------------------------------------------------


class Graph:
    """The typed graph the layout runs on.

    One node per *activity*, shared by every object type that performs it —
    which is what makes an OC-DFG layout different from |OT| separate DFG
    layouts, and why rank assignment is a single global program rather than
    one program per type. Start and end nodes are per object type ([1]
    Sect. 3.1: `N_start = {start_ot | ot in OT}`).
    """

    def __init__(self):
        self.nodes = {}
        self.object_types = []
        self.typed_edges = []
        self.type_nodes = {}
        self.type_edges = {}
        self.backbone = {}     # ot -> {"nodes": [...], "edges": {...}, "virtual": [...]}
        self.pairs = []
        self.pair_index = {}

    def add_node(self, name, kind, label, object_type=None):
        node = self.nodes.get(name)
        if node is None:
            node = {
                "name": name,
                "kind": kind,               # activity | start | end | virtual
                "label": label,
                "objectTypes": set(),       # every type that uses this node
                "objectType": object_type,  # set for start/end/virtual only
                "rank": 0, "order": 0, "axis": 0,
                "x": 0.0, "y": 0.0,
                "width": (
                    _activity_width(label) if kind == "activity"
                    else BOUNDARY_W if kind in ("start", "end") else VIRTUAL_W
                ),
                "height": ACTIVITY_H if kind == "activity" else BOUNDARY_H,
                "count": 0,
            }
            self.nodes[name] = node
        if object_type is not None:
            node["objectTypes"].add(object_type)
        return node

    def activity_names(self, object_type=None):
        if object_type is None:
            return sorted(n for n, v in self.nodes.items() if v["kind"] == "activity")
        return sorted(
            n for n, v in self.nodes.items()
            if v["kind"] == "activity" and object_type in v["objectTypes"]
        )


def build_graph(payload):
    """Turns the host's OC-DFG payload into a `Graph`.

    The payload is what `core.discover.ocdfg` (or the pm4py plugin) stores
    inline: typed activity nodes with `count`/`starts`/`ends`, and typed
    directly-follows edges with `freq` (and `avgSecs` from 0.2.0 on).
    """
    graph = Graph()
    raw_nodes = payload.get("nodes") or []
    raw_edges = payload.get("edges") or []

    # Only types that actually carry a node take part: a declared type with no
    # timestamped events would otherwise contribute an isolated start/end pair
    # and a rank constraint about nothing.
    graph.object_types = sorted({str(n["objectType"]) for n in raw_nodes})
    known = set(graph.object_types)

    by_type_activity = {}
    for entry in raw_nodes:
        object_type = str(entry["objectType"])
        if object_type not in known:
            continue
        activity = str(entry["activity"])
        node = graph.add_node(_node_name(activity), "activity", activity, object_type)
        node["count"] += int(entry.get("count") or 0)
        by_type_activity[(object_type, activity)] = entry

    def push_edge(object_type, src, dst, freq, avg_secs=None, kind="df"):
        graph.typed_edges.append({
            "objectType": object_type, "src": src, "dst": dst,
            "freq": float(freq), "avgSecs": avg_secs, "kind": kind,
            "backbone": False, "chain": [src, dst],
        })

    activity_nodes = set(graph.nodes)
    for entry in raw_edges:
        object_type = str(entry["objectType"])
        if object_type not in known:
            continue
        src, dst = _node_name(str(entry["src"])), _node_name(str(entry["dst"]))
        if src not in activity_nodes or dst not in activity_nodes:
            continue
        avg = entry.get("avgSecs")
        push_edge(object_type, src, dst, entry.get("freq") or 0,
                  None if avg is None else float(avg))

    # Synthetic boundary nodes, created only where the type actually starts or
    # ends: an unattached one would still constrain every rank of its type
    # without drawing anything.
    for object_type in graph.object_types:
        starts = sorted((a, e) for (t, a), e in by_type_activity.items()
                        if t == object_type and int(e.get("starts") or 0) > 0)
        ends = sorted((a, e) for (t, a), e in by_type_activity.items()
                      if t == object_type and int(e.get("ends") or 0) > 0)
        if starts:
            name = _start_name(object_type)
            graph.add_node(name, "start", object_type, object_type)
            for activity, entry in starts:
                push_edge(object_type, name, _node_name(activity),
                          int(entry["starts"]), None, "start")
        if ends:
            name = _end_name(object_type)
            graph.add_node(name, "end", object_type, object_type)
            for activity, entry in ends:
                push_edge(object_type, _node_name(activity), name,
                          int(entry["ends"]), None, "end")

    graph.typed_edges.sort(key=lambda e: (e["objectType"], e["kind"], e["src"], e["dst"]))

    for object_type in graph.object_types:
        names = graph.activity_names(object_type)
        if _start_name(object_type) in graph.nodes:
            names.insert(0, _start_name(object_type))
        if _end_name(object_type) in graph.nodes:
            names.append(_end_name(object_type))
        graph.type_nodes[object_type] = names
        graph.type_edges[object_type] = [
            i for i, e in enumerate(graph.typed_edges) if e["objectType"] == object_type
        ]

    _build_pairs(graph)
    return graph


def _build_pairs(graph):
    """Collapses typed edges onto unique (src, dst) pairs.

    Rank assignment is about activity pairs, not about how many types make the
    trip — but *how many* types make it is exactly the object-centric analogue
    of edge importance, so it is retained as the pair weight. Summing the
    objective over typed edges instead gives the identical model with |OT|
    times the rows.
    """
    pairs = {}
    for edge in graph.typed_edges:
        key = (edge["src"], edge["dst"])
        entry = pairs.setdefault(key, {"src": key[0], "dst": key[1],
                                       "types": set(), "freq": 0.0})
        entry["types"].add(edge["objectType"])
        entry["freq"] += edge["freq"]
    graph.pairs = [pairs[k] for k in sorted(pairs)]
    graph.pair_index = {(p["src"], p["dst"]): i for i, p in enumerate(graph.pairs)}


# ---------------------------------------------------------------------------
# 2. Backbone determination ([1] Sect. 3.2, [2] Sect. 5.2 / Def. 11)
#
# Both papers take the backbone from the *most frequent variant* of the event
# log. An OC-DFG is an aggregate and its variants are not recoverable from it:
# directly-follows counts say nothing about which traces produced them. [2]
# Def. 5 explicitly allows other reference paths — "the most frequent sequence
# of activities, the longest path, or a user-selected reference path" — so the
# backbone is derived from the graph, and which derivation is used is a
# parameter rather than a hidden choice.
# ---------------------------------------------------------------------------


def _type_adjacency(graph, object_type):
    adjacency = defaultdict(list)
    for index in graph.type_edges[object_type]:
        edge = graph.typed_edges[index]
        adjacency[edge["src"]].append((edge["dst"], edge["freq"]))
    for key in adjacency:
        adjacency[key].sort(key=lambda t: (-t[1], t[0]))
    return adjacency


def _modal_path(adjacency, start, end):
    """Greedy walk always taking the most frequent unvisited successor.

    The aggregate analogue of "the most frequent variant": at every activity
    it follows the transition most objects of this type actually took. Nodes
    are never revisited, which `BN` requires anyway ([1] Sect. 3.2: the
    backbone node sequence holds *distinct* activities in first-appearance
    order).
    """
    path, seen, current = [start], {start}, start
    while current != end:
        nxt = next((d for d, _ in adjacency.get(current, ()) if d not in seen), None)
        if nxt is None:
            break
        path.append(nxt)
        seen.add(nxt)
        current = nxt
    return path


def _heaviest_path(adjacency, start, end, beam=48, max_depth=None):
    """Beam search for the heaviest simple path from `start`.

    Weight is the sum of `log(1 + freq)`, preferring a long path of busy
    transitions over a short one — [2]'s "longest path" backbone, made robust
    to the cycles a DFG has and an acyclic longest-path search does not.
    """
    if max_depth is None:
        max_depth = len(adjacency) + 2
    states = [(0.0, [start], frozenset([start]))]
    best = (0.0, [start])
    complete = None
    for _ in range(max_depth):
        nxt = []
        for score, path, seen in states:
            for destination, freq in adjacency.get(path[-1], ()):
                if destination in seen:
                    continue
                gain = score + math.log1p(max(0.0, freq))
                extended = path + [destination]
                if destination == end:
                    if complete is None or gain > complete[0]:
                        complete = (gain, extended)
                    continue
                nxt.append((gain, extended, seen | {destination}))
                if gain > best[0]:
                    best = (gain, extended)
        if not nxt:
            break
        nxt.sort(key=lambda s: (-s[0], s[1]))  # deterministic
        states = nxt[:beam]
    return complete[1] if complete is not None else best[1]


def determine_backbones(graph, strategy="modal"):
    """One backbone per object type ([1] Sect. 3.2)."""
    for object_type in graph.object_types:
        adjacency = _type_adjacency(graph, object_type)
        start, end = _start_name(object_type), _end_name(object_type)

        if start not in graph.nodes:
            candidates = graph.activity_names(object_type)
            if not candidates:
                graph.backbone[object_type] = {"nodes": [], "edges": set(), "virtual": []}
                continue
            # No recorded start: begin where the type least often arrives.
            incoming = defaultdict(int)
            for index in graph.type_edges[object_type]:
                incoming[graph.typed_edges[index]["dst"]] += 1
            start = min(candidates, key=lambda n: (incoming[n], n))
        if end not in graph.nodes:
            end = None

        path = (_heaviest_path(adjacency, start, end) if strategy == "heaviest"
                else _modal_path(adjacency, start, end))
        if end is not None and path[-1] != end:
            # Close the trunk on the type's end node when the walk stopped one
            # real transition short of it; otherwise leave it open.
            if any(d == end for d, _ in adjacency.get(path[-1], ())):
                path.append(end)

        edges = {(path[i], path[i + 1]) for i in range(len(path) - 1)
                 if (path[i], path[i + 1]) in graph.pair_index}
        graph.backbone[object_type] = {"nodes": path, "edges": edges, "virtual": []}

    for edge in graph.typed_edges:
        trunk = graph.backbone.get(edge["objectType"], {}).get("edges", set())
        edge["backbone"] = (edge["src"], edge["dst"]) in trunk


# ---------------------------------------------------------------------------
# 3. Rank assignment
# ---------------------------------------------------------------------------


def _mutual_pairs(graph):
    """Pairs (u, v) whose reverse (v, u) is also an edge.

    These are the activity pairs [2] Sect. 3.2 allows onto the same rank: a
    mutual directly-follows relation carries no precedence, so forcing one of
    the two above the other invents an ordering the log does not contain, and
    spends a back edge and a rank doing it.
    """
    keys = set(graph.pair_index)
    return {(u, v) for (u, v) in keys if (v, u) in keys}


def _pair_weights(graph, mode):
    freqs = [p["freq"] for p in graph.pairs] or [1.0]
    mean_freq = (sum(freqs) / len(freqs)) or 1.0
    weights = []
    for pair in graph.pairs:
        if mode == "frequency":
            weights.append(max(1e-6, pair["freq"] / mean_freq))
        elif mode == "uniform":
            weights.append(1.0)
        else:
            weights.append(float(len(pair["types"])))
    return weights


def _reaches(adjacency, source, target):
    """Whether `target` is reachable from `source`. Iterative, for wide DAGs."""
    if source == target:
        return True
    stack, seen = [source], {source}
    while stack:
        current = stack.pop()
        for neighbour in adjacency.get(current, ()):
            if neighbour == target:
                return True
            if neighbour not in seen:
                seen.add(neighbour)
                stack.append(neighbour)
    return False


def _rank_rows(graph, allow_horizontal):
    """The rank model's structural rows, shared by the IP and the heuristic.

    `chain`  ordered pairs that must descend by at least one rank: every
             type's backbone ([1] Eq. 7 / [2] Eq. 3).
    `bounds` per-type start/end enclosures ([1] Eqs. 3-4 / [2] Eqs. 6-7).
    `strict` pairs that may not share a rank at all ([2] Eqs. 4-5). With
             horizontal edges allowed this is the asymmetric pairs only, so a
             mutual pair may sit on one rank; without, it is every pair —
             the benchmark's "no horizontal edges" regime ([2] Sect. 3.2).
    `dropped` backbone chain constraints that had to be given up, see below.

    Neither paper mentions it, but in an OC-DFG the per-type chains of [1]
    Eq. 7 can *contradict* each other: two object types may traverse the same
    two shared activities in opposite orders, and no rank assignment satisfies
    both. Imposing all of them then makes the program infeasible rather than
    merely tight. Chains are therefore admitted greedily, biggest type first,
    and a constraint that would close a cycle with the ones already admitted
    is dropped and reported in the diagnostics rather than silently making the
    model unsolvable.
    """
    bounds = []
    for object_type in graph.object_types:
        start, end = _start_name(object_type), _end_name(object_type)
        for name in graph.type_nodes[object_type]:
            if name in (start, end):
                continue
            if start in graph.nodes:
                bounds.append((start, name))
            if end in graph.nodes:
                bounds.append((name, end))

    # Seeded with the enclosures, which cannot form a cycle among themselves:
    # a start node has no incoming and an end node no outgoing enclosure.
    adjacency = defaultdict(set)
    for u, v in bounds:
        adjacency[u].add(v)

    priority = sorted(graph.object_types,
                      key=lambda ot: (-len(graph.activity_names(ot)), ot))
    chain, dropped = [], []
    for object_type in priority:
        path = graph.backbone[object_type]["nodes"]
        for i in range(len(path) - 1):
            u, v = path[i], path[i + 1]
            if u == v:
                continue
            if _reaches(adjacency, v, u):
                dropped.append({"objectType": object_type, "src": u, "dst": v})
                continue
            adjacency[u].add(v)
            chain.append((u, v))

    mutual = _mutual_pairs(graph) if allow_horizontal else set()
    chained = set(chain)
    strict = []
    for pair in graph.pairs:
        key = (pair["src"], pair["dst"])
        if key[0] == key[1] or key in mutual:
            continue
        # A pair already ordered by a backbone chain needs no disjunction —
        # [2] Sect. 5.3 skips exactly those.
        if key in chained or (key[1], key[0]) in chained:
            continue
        strict.append(key)
    return chain, bounds, strict, dropped


def _compact_ranks(rank):
    """Removes rank gaps, keeping order — fewer ranks, fewer virtual nodes."""
    remap = {value: i + 1 for i, value in enumerate(sorted(set(rank.values())))}
    return {n: remap[r] for n, r in rank.items()}


def _heuristic_ranks(graph, allow_horizontal):
    """Layering without the IP: orient every pair, then longest path.

    This is both the comparison baseline — the kind of heuristic rank
    assignment [2] Sect. 3.1 identifies as the source of unnecessary back
    edges — and the fallback when the IP is too large or times out.

    Every activity pair is oriented against the constraints already accepted:
    if the reverse direction is already implied, the pair becomes a back edge,
    otherwise it descends. The result is acyclic by construction, so a single
    topological longest-path pass satisfies every row of the rank model at
    once. That matters for two reasons: the layering is always feasible (no
    iteration cap to run out of), and it is always a feasible point of the
    *integer program*, which is what lets the test suite assert that the IP's
    objective never loses to it.

    Because every pair is oriented strictly, this baseline never produces a
    horizontal edge — which is precisely [2] Sect. 3.2's limitation #2, the
    behaviour the IP is there to improve on.
    """
    names = sorted(graph.nodes)
    chain, bounds, strict, _ = _rank_rows(graph, allow_horizontal)

    adjacency = defaultdict(set)
    for u, v in bounds:
        adjacency[u].add(v)
    for u, v in chain:
        adjacency[u].add(v)

    # Orient the remaining pairs, backbone-adjacent ones first so a trunk's
    # neighbourhood keeps its natural direction.
    accepted = {(u, v) for u, v in chain}
    ordered_pairs = sorted(
        ((p["src"], p["dst"]) for p in graph.pairs),
        key=lambda key: (0 if key in accepted or (key[1], key[0]) in accepted else 1,
                         key),
    )
    for u, v in ordered_pairs:
        if u == v or (u, v) in accepted or (v, u) in accepted:
            continue
        if _reaches(adjacency, v, u):
            adjacency[v].add(u)      # drawn as a back edge
            accepted.add((v, u))
        else:
            adjacency[u].add(v)
            accepted.add((u, v))

    incoming = defaultdict(list)
    outgoing = {name: sorted(adjacency.get(name, ())) for name in names}
    for name in names:
        for child in outgoing[name]:
            incoming[child].append(name)

    # Kahn topological order, then longest-path layering along it.
    remaining = {name: len(incoming[name]) for name in names}
    queue = sorted(name for name in names if remaining[name] == 0)
    topological = []
    while queue:
        name = queue.pop(0)
        topological.append(name)
        for child in outgoing[name]:
            remaining[child] -= 1
            if remaining[child] == 0:
                queue.append(child)
                queue.sort()
    # A cycle cannot survive the orientation pass, but never emit a partial
    # layering if one somehow did.
    topological.extend(name for name in names if name not in set(topological))

    rank = {name: 1 for name in names}
    for name in topological:
        for child in outgoing[name]:
            rank[child] = max(rank[child], rank[name] + 1)
    del strict
    return _compact_ranks(rank)


def _rank_objective(graph, rank, weights, squared):
    """Σ w_p · α_p^(2) + Σ_ot r_(end_ot) — [2] Eq. 1, per object type."""
    total = 0.0
    for i, pair in enumerate(graph.pairs):
        alpha = max(0, rank[pair["src"]] - rank[pair["dst"]] + 1)
        total += weights[i] * (alpha * alpha if squared else alpha)
    for object_type in graph.object_types:
        end = _end_name(object_type)
        if end in graph.nodes:
            total += rank[end]
    return total


def _rank_ip(graph, weights, squared, allow_horizontal, time_limit, log):
    """The rank-assignment integer program.

    Variables
      r_n    integer, one per node        the rank ([2] Def. 6)
      s_p,k  per pair, the penalty terms  see below
      y_p    binary, per strict pair      [2] Eqs. 4-5's upward indicator

    `alpha_p = max(0, r_u - r_v + 1)` is the precedence violation of pair p:
    0 downward, 1 horizontal, d+1 for a d-rank rise. [2] minimises its
    *square*, which is what pulls a mutually dependent pair onto one rank
    rather than merely somewhere adjacent. HiGHS takes no quadratic
    objective, so the square is linearised exactly rather than approximated:
    write `alpha_p = sum_k s_p,k` over K_p binary unit segments with segment
    cost `2k-1`. The sum of the cheapest k segments is then exactly k^2, and
    because the costs increase the solver always fills a prefix — no ordering
    constraints, no optimum lost.

    K_p also bounds alpha_p, hence how far pair p may rise. It starts at four
    segments and is quadrupled only for the pairs actually sitting at their
    bound, re-solving until none does. That keeps the binary count near 4|P|
    on graphs where nothing rises far, without capping the ones where
    something does. The linear objective needs no expansion at all: one
    integer variable per pair carries alpha_p directly.
    """
    if not _HAVE_MILP:
        raise RuntimeError("scipy.optimize.milp is unavailable")

    names = sorted(graph.nodes)
    node_index = {n: i for i, n in enumerate(names)}
    node_count = len(names)
    pair_count = len(graph.pairs)
    chain, bounds, strict, dropped = _rank_rows(graph, allow_horizontal)
    rank_max = float(node_count + 1)
    big_m = 3.0 * node_count + 1.0

    # segments[p] = how many variables carry alpha_p; segment_ub their bound.
    if squared:
        segments = [min(4, node_count + 1)] * pair_count
        segment_ub = 1.0
    else:
        segments = [1] * pair_count
        segment_ub = rank_max

    best = None
    for attempt in range(3 if squared else 1):
        offsets, cursor = [], node_count
        for count in segments:
            offsets.append(cursor)
            cursor += count
        y_offset = cursor
        total_vars = y_offset + len(strict)

        rows, cols, vals, ub = [], [], [], []

        def add_row(entries, upper):
            row = len(ub)
            for column, value in entries:
                rows.append(row)
                cols.append(column)
                vals.append(value)
            ub.append(upper)

        # [2] Eq. 2 — r_u - r_v - alpha_p <= -1
        for p, pair in enumerate(graph.pairs):
            add_row(
                [(node_index[pair["src"]], 1.0), (node_index[pair["dst"]], -1.0)]
                + [(offsets[p] + k, -1.0) for k in range(segments[p])],
                -1.0,
            )
        # [1] Eq. 7 / [2] Eq. 3 — backbone chains descend
        for u, v in chain:
            add_row([(node_index[u], 1.0), (node_index[v], -1.0)], -1.0)
        # [1] Eqs. 3-4 / [2] Eqs. 6-7 — per-type start/end enclosure
        for u, v in bounds:
            add_row([(node_index[u], 1.0), (node_index[v], -1.0)], -1.0)
        # [2] Eqs. 4-5 — this pair may not be horizontal
        for i, (u, v) in enumerate(strict):
            y = y_offset + i
            add_row([(node_index[u], 1.0), (node_index[v], -1.0), (y, -big_m)], -1.0)
            add_row([(node_index[u], -1.0), (node_index[v], 1.0), (y, big_m)], big_m - 1.0)

        matrix = csr_matrix((vals, (rows, cols)), shape=(len(ub), total_vars))
        cost = np.zeros(total_vars)
        for object_type in graph.object_types:
            end = _end_name(object_type)
            if end in graph.nodes:
                cost[node_index[end]] += 1.0
        for p in range(pair_count):
            for k in range(segments[p]):
                cost[offsets[p] + k] = weights[p] * ((2 * (k + 1) - 1) if squared else 1.0)

        upper = np.concatenate([
            np.full(node_count, rank_max),
            np.full(y_offset - node_count, segment_ub),
            np.ones(len(strict)),
        ])
        result = milp(
            c=cost,
            constraints=LinearConstraint(matrix, -np.inf, np.array(ub, dtype=float)),
            integrality=np.ones(total_vars),
            bounds=Bounds(np.zeros(total_vars), upper),
            options={"time_limit": float(time_limit), "presolve": True},
        )
        status = int(getattr(result, "status", 4))
        if result.x is None:
            log(f"rank IP round {attempt + 1}: no solution ({result.message})")
            if not squared or status == 2 and attempt + 1 == (3 if squared else 1):
                break
            segments = [min(node_count + 1, s * 4) for s in segments]
            continue

        rank = _compact_ranks({n: int(round(result.x[node_index[n]])) for n in names})
        objective = _rank_objective(graph, rank, weights, squared)
        if best is None or objective < best["objective"] - 1e-9:
            best = {"rank": rank, "objective": objective, "optimal": status == 0,
                    "message": str(result.message), "rounds": attempt + 1}
        if not squared:
            break

        at_bound = [
            p for p in range(pair_count)
            if segments[p] < node_count + 1
            and sum(int(round(result.x[offsets[p] + k])) for k in range(segments[p]))
            >= segments[p]
        ]
        if not at_bound:
            break
        for p in at_bound:
            segments[p] = min(node_count + 1, segments[p] * 4)
        log(f"rank IP round {attempt + 1}: widening {len(at_bound)} pair penalties")

    if best is None:
        raise RuntimeError("rank IP found no feasible layering")
    best["droppedChainConstraints"] = dropped
    return best


def assign_ranks(graph, params, log, progress):
    """Rank assignment: the IP where it fits, the heuristic where it does not."""
    squared = params["rankObjective"] == "squared"
    allow_horizontal = params["allowHorizontalEdges"]
    weights = _pair_weights(graph, params["rankEdgeWeight"])
    info = {
        "method": params["rankMethod"],
        "objective": params["rankObjective"],
        "edgeWeight": params["rankEdgeWeight"],
        "allowHorizontalEdges": allow_horizontal,
        "solver": None, "optimal": False, "fallback": None,
    }

    if params["rankMethod"] == "ip":
        if not _HAVE_MILP:
            info["fallback"] = "scipy.optimize.milp is unavailable in this runtime"
        elif len(graph.pairs) > params["maxPairsForIp"]:
            info["fallback"] = (
                f"{len(graph.pairs)} activity pairs exceed the "
                f"{params['maxPairsForIp']}-pair ceiling for the integer program"
            )
        if info["fallback"]:
            log("rank assignment: " + info["fallback"] + "; using the heuristic layering")

    if params["rankMethod"] == "ip" and not info["fallback"]:
        progress(0.25, "rank assignment (integer program)")
        started = time.time()
        try:
            solved = _rank_ip(graph, weights, squared, allow_horizontal,
                              params["timeLimitSecs"], log)
        except Exception as error:  # keep a layout rather than failing the run
            info["fallback"] = f"{type(error).__name__}: {error}"
            log("rank IP failed (" + info["fallback"] + "); using the heuristic layering")
        else:
            for name, value in solved["rank"].items():
                graph.nodes[name]["rank"] = value
            info.update({
                "solver": "HiGHS (scipy.optimize.milp)",
                "droppedChainConstraints": solved["droppedChainConstraints"],
                "optimal": solved["optimal"],
                "objectiveValue": round(solved["objective"], 4),
                "message": solved["message"],
                "rounds": solved["rounds"],
                "secs": round(time.time() - started, 3),
                "heuristicObjective": round(_rank_objective(
                    graph, _heuristic_ranks(graph, allow_horizontal), weights, squared), 4),
            })
            log(f"rank IP: objective {solved['objective']:.1f} over "
                f"{max(solved['rank'].values())} ranks "
                f"({'optimal' if solved['optimal'] else 'incumbent'})")
            return info

    progress(0.25, "rank assignment (heuristic)")
    ranks = _heuristic_ranks(graph, allow_horizontal)
    for name, value in ranks.items():
        graph.nodes[name]["rank"] = value
    info["solver"] = "heuristic (pair orientation + longest path)"
    info["droppedChainConstraints"] = _rank_rows(graph, allow_horizontal)[3]
    info["objectiveValue"] = round(_rank_objective(graph, ranks, weights, squared), 4)
    return info


# ---------------------------------------------------------------------------
# 4. Virtual node generation ([2] Sect. 5.4, Defs. 12-13)
#
# Per *typed* edge, not per pair: each object type draws its own rail, so two
# types crossing the same rank gap need two chains to route and order
# independently. A chain inherits its edge's backbone flag, which keeps a
# trunk straight through the ranks it spans ([2] Def. 12).
# ---------------------------------------------------------------------------


def generate_virtual_nodes(graph, cap=40000):
    created = truncated = 0
    for edge in graph.typed_edges:
        rank_src = graph.nodes[edge["src"]]["rank"]
        rank_dst = graph.nodes[edge["dst"]]["rank"]
        distance = abs(rank_src - rank_dst)
        if distance <= 1:
            edge["chain"] = [edge["src"], edge["dst"]]
            continue
        if created + distance - 1 > cap:
            truncated += 1
            edge["chain"] = [edge["src"], edge["dst"]]
            continue
        step = 1 if rank_dst > rank_src else -1
        chain = [edge["src"]]
        for i in range(distance - 1):
            name = f"v:{created}"
            created += 1
            node = graph.add_node(name, "virtual", None, edge["objectType"])
            node["rank"] = rank_src + step * (i + 1)
            chain.append(name)
        chain.append(edge["dst"])
        edge["chain"] = chain
        if edge["backbone"]:
            graph.backbone[edge["objectType"]]["virtual"].extend(chain[1:-1])
    return {"virtualNodes": created, "unroutedEdges": truncated}


# ---------------------------------------------------------------------------
# 5. Per-type layout: components, balancing, initial order
# ---------------------------------------------------------------------------


def _type_layout_nodes(graph, object_type):
    """L_ot: this type's activities, boundary nodes and virtual nodes."""
    names = set(graph.type_nodes[object_type])
    for index in graph.type_edges[object_type]:
        names.update(graph.typed_edges[index]["chain"])
    return sorted(names)


def _type_trunk(graph, object_type, claimed):
    """BN_ot, made disjoint across types by merge order.

    [1] assigns each node exactly one object-type axis (Def. 3), so a node
    shared by two types belongs to the trunk of whichever type claimed it
    first. Without this, two trunks would each demand that a shared activity
    sit on their own straight line and the later one would silently win.
    """
    trunk = []
    backbone = graph.backbone[object_type]
    for name in list(backbone["nodes"]) + list(backbone["virtual"]):
        if name in graph.nodes and name not in claimed:
            trunk.append(name)
            claimed.add(name)
    return trunk


def _straight_trunk(graph, object_type, candidates):
    """The part of a trunk that can actually be one vertical line.

    Two conditions have to hold, and neither is automatic. A trunk may only
    hold nodes its own merge step introduced ([1] Sect. 3.5 step 3: a node
    already positioned keeps its position), and it may hold at most **one
    node per rank** — otherwise no single x exists, since two nodes on a rank
    must be separated. The second condition bites whenever a backbone chain
    constraint had to be dropped (see `_rank_rows`): the backbone is then no
    longer rank-monotone, its edges' rank spans overlap, and their virtual
    nodes collide.

    So: walk the backbone in order keeping only strictly descending nodes,
    then add the routed interior of each surviving backbone edge where its
    ranks are still free.
    """
    available = set(candidates)
    used = {}
    real = []
    last = -1
    for name in graph.backbone[object_type]["nodes"]:
        if name not in available or graph.nodes[name]["kind"] == "virtual":
            continue
        rank = graph.nodes[name]["rank"]
        if rank <= last or rank in used:
            continue
        used[rank] = name
        real.append(name)
        last = rank

    chains = {}
    for index in graph.type_edges[object_type]:
        edge = graph.typed_edges[index]
        if edge["backbone"]:
            chains[(edge["src"], edge["dst"])] = edge["chain"]

    trunk = list(real)
    for source, target in zip(real, real[1:]):
        interior = chains.get((source, target), [None])[1:-1]
        if not interior or any(name not in available for name in interior):
            continue
        ranks = [graph.nodes[name]["rank"] for name in interior]
        if any(rank in used for rank in ranks):
            continue
        for name, rank in zip(interior, ranks):
            used[rank] = name
            trunk.append(name)
    return trunk


def _components(graph, object_type, layout_nodes, trunk):
    """Weakly connected components of L_ot after removing the trunk ([2] Def. 8)."""
    inside = set(layout_nodes) - set(trunk)
    adjacency = defaultdict(set)
    for index in graph.type_edges[object_type]:
        chain = graph.typed_edges[index]["chain"]
        for i in range(len(chain) - 1):
            u, v = chain[i], chain[i + 1]
            if u in inside and v in inside:
                adjacency[u].add(v)
                adjacency[v].add(u)

    seen, components = set(), []
    for name in sorted(inside):
        if name in seen:
            continue
        stack, group = [name], []
        seen.add(name)
        while stack:
            current = stack.pop()
            group.append(current)
            for neighbour in sorted(adjacency.get(current, ())):
                if neighbour not in seen:
                    seen.add(neighbour)
                    stack.append(neighbour)
        components.append(sorted(group))
    # Big components first: the greedy baseline and the deterministic
    # within-rank ordering both want a stable, meaningful sequence.
    components.sort(key=lambda group: (-len(group), group[0]))
    return components


def _balance_ip(sizes, time_limit):
    """[2] Eqs. 8-10 — minimise |left - right| over component placements.

    Variables: d_c binary (1 = left) and the imbalance y. A partition problem,
    but on the handful of components a real type produces HiGHS settles it at
    once — and unlike the descending-size heuristic it actually attains the
    minimum ([2] Fig. 7).
    """
    count = len(sizes)
    total = float(sum(sizes))
    rows, cols, vals, ub = [], [], [], []

    def add_row(entries, upper):
        row = len(ub)
        for column, value in entries:
            rows.append(row)
            cols.append(column)
            vals.append(value)
        ub.append(upper)

    # diff = 2*Σ size_c·d_c - total ;  y >= diff ;  y >= -diff
    add_row([(c, 2.0 * sizes[c]) for c in range(count)] + [(count, -1.0)], total)
    add_row([(c, -2.0 * sizes[c]) for c in range(count)] + [(count, -1.0)], -total)

    result = milp(
        c=np.concatenate([np.zeros(count), np.ones(1)]),
        constraints=LinearConstraint(
            csr_matrix((vals, (rows, cols)), shape=(len(ub), count + 1)),
            -np.inf, np.array(ub, dtype=float)),
        integrality=np.concatenate([np.ones(count), np.zeros(1)]),
        bounds=Bounds(np.zeros(count + 1),
                      np.concatenate([np.ones(count), np.array([max(total, 1.0)])])),
        options={"time_limit": float(time_limit), "presolve": True},
    )
    if result.x is None:
        return None
    return [int(round(result.x[c])) == 1 for c in range(count)]


def _balance_greedy(sizes):
    """The benchmark's heuristic: everything right, then move components left
    in descending size while that shrinks the difference — [2] Sect. 3.4's
    limitation #4, kept as the comparison baseline."""
    left = [False] * len(sizes)
    on_left, on_right = 0.0, float(sum(sizes))
    for c in sorted(range(len(sizes)), key=lambda i: (-sizes[i], i)):
        if abs((on_left + sizes[c]) - (on_right - sizes[c])) < abs(on_left - on_right):
            left[c] = True
            on_left += sizes[c]
            on_right -= sizes[c]
    return left


def local_layouts(graph, params, log):
    """Per-type trunk, component sides and initial node orders ([2] Def. 14)."""
    layouts, claimed = {}, set()
    balancing = params["componentBalancing"]
    stats = {"balancing": balancing, "imbalance": {}}

    for object_type in graph.object_types:
        layout_nodes = _type_layout_nodes(graph, object_type)
        trunk = _type_trunk(graph, object_type, claimed)
        components = _components(graph, object_type, layout_nodes, trunk)
        sizes = [float(len(group)) for group in components]

        if not components:
            left_flags = []
        elif balancing == "off":
            left_flags = [False] * len(components)
        elif balancing == "ip" and _HAVE_MILP:
            left_flags = _balance_ip(sizes, params["timeLimitSecs"])
            if left_flags is None:
                log(f"component balancing IP failed for {object_type}; using the heuristic")
                left_flags = _balance_greedy(sizes)
        else:
            left_flags = _balance_greedy(sizes)

        on_left = sum(sizes[c] for c in range(len(components)) if left_flags[c])
        stats["imbalance"][object_type] = abs(on_left - (sum(sizes) - on_left))

        # [2] Def. 14: trunk order 0, left nodes -1, -2, ..., right +1, +2, ...
        order = {name: 0 for name in trunk}
        left_by_rank, right_by_rank = defaultdict(list), defaultdict(list)
        for c, group in enumerate(components):
            for name in group:
                rank = graph.nodes[name]["rank"]
                (left_by_rank if left_flags[c] else right_by_rank)[rank].append(name)
        for group in left_by_rank.values():
            for i, name in enumerate(group):
                order[name] = -(i + 1)
        for group in right_by_rank.values():
            for i, name in enumerate(group):
                order[name] = i + 1
        # A node an earlier type already claimed for its trunk still needs a
        # local order to be positioned against.
        for name in layout_nodes:
            order.setdefault(name, 0)

        layouts[object_type] = {
            "nodes": layout_nodes, "trunk": trunk, "trunkSet": set(trunk),
            "components": components, "left": left_flags, "order": order,
        }
    return layouts, stats


# ---------------------------------------------------------------------------
# 6. Crossings
# ---------------------------------------------------------------------------


def _segments(graph):
    """Rank-adjacent drawn segments, taken from the virtual-node chains."""
    out = []
    for edge in graph.typed_edges:
        chain = edge["chain"]
        out.extend((chain[i], chain[i + 1]) for i in range(len(chain) - 1))
    return out


def _count_inversions(values):
    """Merge-sort inversion count — the crossings across one rank boundary."""
    if len(values) < 2:
        return 0
    middle = len(values) // 2
    left, right = values[:middle], values[middle:]
    count = _count_inversions(left) + _count_inversions(right)
    merged, i, j = [], 0, 0
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:
            merged.append(left[i])
            i += 1
        else:
            merged.append(right[j])
            count += len(left) - i
            j += 1
    merged.extend(left[i:])
    merged.extend(right[j:])
    values[:] = merged
    return count


class Crossings:
    """Crossing counts over an order assignment, indexed by rank boundary.

    Crossings depend only on the node orders of two adjacent ranks — plus, for
    horizontal edges, the order intervals inside one rank. A swap inside rank
    r can therefore only change the (r-1, r) and (r, r+1) boundaries and rank
    r's own horizontal overlaps, which is what makes the local delta used by
    crossing minimisation exact rather than an approximation.
    """

    def __init__(self, graph):
        self.graph = graph
        self.by_boundary = defaultdict(list)
        self.horizontal = defaultdict(list)
        for u, v in _segments(graph):
            rank_u, rank_v = graph.nodes[u]["rank"], graph.nodes[v]["rank"]
            if rank_u == rank_v:
                self.horizontal[rank_u].append((u, v))
            else:
                self.by_boundary[min(rank_u, rank_v)].append(
                    (u, v) if rank_u < rank_v else (v, u))
        self.ranks = sorted({node["rank"] for node in graph.nodes.values()})

    def boundary(self, rank, order):
        pairs = self.by_boundary.get(rank)
        if not pairs:
            return 0
        rows = sorted((order[u], order[v]) for u, v in pairs
                      if u in order and v in order)
        return _count_inversions([b for _, b in rows])

    def within(self, rank, order):
        pairs = self.horizontal.get(rank)
        if not pairs:
            return 0
        spans = [(min(order[u], order[v]), max(order[u], order[v]))
                 for u, v in pairs if u in order and v in order]
        count = 0
        for i in range(len(spans)):
            a1, b1 = spans[i]
            for j in range(i + 1, len(spans)):
                a2, b2 = spans[j]
                # Properly interleaved intervals cross; nested ones do not.
                if a1 < a2 < b1 < b2 or a2 < a1 < b2 < b1:
                    count += 1
        return count

    def around(self, rank, order):
        return (self.boundary(rank - 1, order) + self.boundary(rank, order)
                + self.within(rank, order))

    def total(self, order):
        return sum(self.boundary(rank, order) + self.within(rank, order)
                   for rank in self.ranks)


# ---------------------------------------------------------------------------
# 7. OC-DFG layout generation: object type axes ([1] Sect. 3.5)
# ---------------------------------------------------------------------------


def _set_distance(a, b):
    """[1] Def. 5 — 1 - 2|A ∩ B| / (|A| + |B|); 0 identical, 1 disjoint."""
    if not a and not b:
        return 0.0
    return 1.0 - (2.0 * len(a & b)) / float(len(a) + len(b))


def _distance_ranks(values):
    """[1] Def. 7 — the rank of each pair's distance among all pairs."""
    keys = sorted(values)
    return {key: sum(1 for other in keys if values[other] < values[key]) for key in keys}


def _densify(order):
    """Collapses unused order columns, so the axis arithmetic cannot collide.

    [1] Sect. 3.5 step 3 shifts existing nodes right by the inserted layout's
    width; the stated width (max - min) is one short of the column count it is
    illustrated with (Fig. 3), which would overlap the inserted block with the
    one it displaced. Shifting by the full column count and then dropping the
    columns nobody occupies reproduces Fig. 3 — a shared node consumes no new
    column — without depending on which reading of the width was meant.
    """
    remap = {value: i for i, value in enumerate(sorted(set(order.values())))}
    return {name: remap[value] for name, value in order.items()}


def _type_positions(graph, order, object_type):
    return [order[n] for n in graph.activity_names(object_type) if n in order]


def _layout_cost(graph, order, crossings, lambda1, lambda2, ocel_rank):
    """[1] Def. 8 — axis-distance fidelity plus a crossing penalty."""
    types = graph.object_types
    structural = 0.0
    if len(types) >= 2 and ocel_rank:
        layout_distance = {}
        positions = {ot: _type_positions(graph, order, ot) for ot in types}
        for i in range(len(types)):
            for j in range(i + 1, len(types)):
                a, b = types[i], types[j]
                xa, xb = positions[a], positions[b]
                layout_distance[(a, b)] = (
                    0.0 if not xa or not xb
                    else abs(sum(xa) / len(xa) - sum(xb) / len(xb))
                )
        layout_rank = _distance_ranks(layout_distance)
        numerator = sum((ocel_rank[k] - layout_rank.get(k, 0)) ** 2 for k in ocel_rank)
        denominator = sum(ocel_rank[k] ** 2 for k in ocel_rank)
        structural = math.sqrt(numerator / denominator) if denominator > 0 else 0.0

    edge_count = max(1, len(graph.typed_edges))
    penalty = crossings.total(order) / float(edge_count * edge_count)
    return lambda1 * structural + lambda2 * penalty


def merge_axes(graph, layouts, params, crossings, log, progress):
    """Incrementally merges the per-type layouts onto object type axes.

    [1] Sect. 3.5: start from the main object type, then repeatedly take the
    type whose node set is closest to what is already placed and try it at
    every axis position, keeping the candidate with the lowest cost.
    """
    types = graph.object_types
    activity_sets = {ot: set(graph.activity_names(ot)) for ot in types}
    if not types:
        return {"order": {}, "axisOfType": {}, "main": None, "mergeOrder": []}

    ocel_distance = {}
    for i in range(len(types)):
        for j in range(i + 1, len(types)):
            a, b = types[i], types[j]
            ocel_distance[(a, b)] = _set_distance(activity_sets[a], activity_sets[b])
    ocel_rank = _distance_ranks(ocel_distance)

    # [1] Sect. 3.5 step 1 — the main type performs the most activities that
    # more than one type performs.
    shared = {n for n, node in graph.nodes.items()
              if node["kind"] == "activity" and len(node["objectTypes"]) > 1}
    requested = str(params.get("mainObjectType") or "")
    if requested in types:
        main = requested
    else:
        def key(ot):
            return (len(activity_sets[ot] & shared), len(activity_sets[ot]))
        best_key = max(key(ot) for ot in types)
        main = min(ot for ot in types if key(ot) == best_key)

    local = layouts[main]["order"]
    members = layouts[main]["nodes"]
    shift = -min((local[n] for n in members), default=0)
    order = {name: local[name] + shift for name in members}
    axis_of_node = {name: 0 for name in order}
    axis_of_type = {main: 0}
    merge_order = [main]
    # A trunk is straight over the nodes its own merge step introduced. [1]
    # Sect. 3.5 step 3 is explicit that a node already positioned keeps its
    # position, so a backbone activity an earlier type already placed is
    # still drawn as this type's backbone but is not forced onto its column —
    # two straight lines cannot both pass through one shared node.
    layouts[main]["straightTrunk"] = _straight_trunk(
        graph, main, layouts[main]["trunk"])

    remaining = [ot for ot in types if ot != main]
    step = 0
    while remaining:
        step += 1
        progress(0.45 + 0.15 * step / max(1, len(types)),
                 f"merging object type axes ({step}/{len(types) - 1})")

        placed = {n for n in order if graph.nodes[n]["kind"] == "activity"}
        target = min(remaining, key=lambda ot: (_set_distance(placed, activity_sets[ot]), ot))
        members = layouts[target]["nodes"]
        local = layouts[target]["order"]
        if not members:
            remaining.remove(target)
            axis_of_type[target] = max(axis_of_type.values()) + 1
            merge_order.append(target)
            layouts[target]["straightTrunk"] = []
            continue

        new_members = [n for n in members if n not in order]
        introduced = set(new_members)
        layouts[target]["straightTrunk"] = _straight_trunk(
            graph, target, [n for n in layouts[target]["trunk"] if n in introduced])
        local_min = min(local[n] for n in members)
        width = max(local[n] for n in members) - local_min + 1
        axes_used = len(set(axis_of_type.values()))

        best = None
        for target_axis in range(axes_used + 1):
            candidate = {
                name: value + (width if axis_of_node[name] >= target_axis else 0)
                for name, value in order.items()
            }
            left = [v for n, v in candidate.items() if axis_of_node[n] < target_axis]
            left_margin = (max(left) + 1) if left else 0
            for name in new_members:
                candidate[name] = left_margin + local[name] - local_min
            candidate = _densify(candidate)
            cost = _layout_cost(graph, candidate, crossings, params["axisWeight"],
                                params["crossingWeight"], ocel_rank)
            if best is None or cost < best[0] - 1e-12:
                best = (cost, target_axis, candidate)

        cost, target_axis, order = best
        # Inserting an axis renumbers every axis at or beyond it; the nodes
        # this step introduces are the ones that belong to the new axis.
        axis_of_node = {
            name: (axis + 1 if axis >= target_axis else axis)
            for name, axis in axis_of_node.items()
        }
        axis_of_type = {
            ot: (axis + 1 if axis >= target_axis else axis)
            for ot, axis in axis_of_type.items()
        }
        axis_of_type[target] = target_axis
        for name in new_members:
            axis_of_node[name] = target_axis

        remaining.remove(target)
        merge_order.append(target)
        log(f"axis merge: {target} at axis {target_axis} (cost {cost:.4f})")

    order = _densify(order)
    for name, node in graph.nodes.items():
        node["order"] = order.get(name, 0)
        node["axis"] = axis_of_node.get(
            name, axis_of_type.get(node.get("objectType"), 0))

    return {"order": order, "axisOfType": axis_of_type, "main": main,
            "mergeOrder": merge_order, "axisOfNode": axis_of_node}


# ---------------------------------------------------------------------------
# 8. Cross-minimisation ([1] Sect. 3.6, Alg. 1)
# ---------------------------------------------------------------------------


def minimize_crossings(graph, crossings, trunk_nodes, max_iterations, log):
    """Swaps adjacent same-axis nodes while that reduces crossings.

    [1] restricts swaps to nodes on the same object type axis, keeping each
    type's band intact at the price of some crossings an unrestricted sweep
    would have removed ([1] Sect. 4.4 reports exactly that trade). Trunk nodes
    are held in place so the backbones stay straight.
    """
    order = {name: node["order"] for name, node in graph.nodes.items()}
    by_rank = defaultdict(list)
    for name, node in graph.nodes.items():
        by_rank[node["rank"]].append(name)
    for rank in by_rank:
        by_rank[rank].sort(key=lambda n: (order[n], n))

    before = crossings.total(order)
    swaps = 0
    for _ in range(max(0, int(max_iterations))):
        improved = False
        for rank in sorted(by_rank):
            row = by_rank[rank]
            for i in range(len(row) - 1):
                a, b = row[i], row[i + 1]
                if a in trunk_nodes or b in trunk_nodes:
                    continue
                if graph.nodes[a]["axis"] != graph.nodes[b]["axis"]:
                    continue
                current = crossings.around(rank, order)
                order[a], order[b] = order[b], order[a]
                if crossings.around(rank, order) < current:
                    row[i], row[i + 1] = b, a
                    improved = True
                    swaps += 1
                else:
                    order[a], order[b] = order[b], order[a]
        if not improved:
            break

    after = crossings.total(order)
    for name, value in order.items():
        graph.nodes[name]["order"] = value
    log(f"cross-minimisation: {before} -> {after} crossings in {swaps} swaps")
    return {"before": before, "after": after, "swaps": swaps}


# ---------------------------------------------------------------------------
# 9. Node positioning ([1] Alg. 2, [2] Sect. 5.7 / Defs. 16-21)
# ---------------------------------------------------------------------------


class Positioner:
    """x/y coordinates from ranks and orders.

    [2] Def. 21 splits a single-backbone layout into left / backbone / right
    and packs each; [1] Alg. 2 runs the same three moves once per object type,
    so every type's trunk ends up straight on its own axis. This does the
    latter, with the former's split applied inside each type.
    """

    def __init__(self, graph, order_spacing, rank_spacing, gap):
        self.graph = graph
        self.order_spacing = float(order_spacing)
        self.rank_spacing = float(rank_spacing)
        self.gap = float(gap)
        self.by_rank = defaultdict(list)
        for name, node in graph.nodes.items():
            self.by_rank[node["rank"]].append(name)
        self.rows = {}
        self.neighbours_down = defaultdict(list)
        self.neighbours_up = defaultdict(list)
        for u, v in _segments(graph):
            rank_u, rank_v = graph.nodes[u]["rank"], graph.nodes[v]["rank"]
            if rank_v == rank_u + 1:
                self.neighbours_down[u].append(v)
                self.neighbours_up[v].append(u)
            elif rank_u == rank_v + 1:
                self.neighbours_down[v].append(u)
                self.neighbours_up[u].append(v)
        self.refresh_rows()

    def refresh_rows(self):
        """Caches each rank's left-to-right node sequence and every node's
        index in it. Orders do not change during positioning, so this is
        computed once instead of re-sorting inside `packcut`'s inner loop."""
        self.rows = {}
        self.position_in_row = {}
        for rank, names in self.by_rank.items():
            row = sorted(names, key=lambda n: (self.graph.nodes[n]["order"], n))
            self.rows[rank] = row
            for index, name in enumerate(row):
                self.position_in_row[name] = index

    # -- helpers ------------------------------------------------------------

    def initial(self):
        """[2] Def. 16 — x = w · order, y = h · rank."""
        return {name: self.order_spacing * node["order"]
                for name, node in self.graph.nodes.items()}

    def _separation(self, left, name):
        return ((self.graph.nodes[left]["width"] + self.graph.nodes[name]["width"]) / 2.0
                + self.gap)

    def _left_neighbour(self, name):
        """[2] Def. 18, relaxed to the nearest node to the left.

        The definition asks for the node whose order is exactly one less;
        after the axis merge a rank frequently has no node at order - 1, and
        reading it literally would leave that node unconstrained and free to
        slide past a nearer neighbour.
        """
        row = self.rows[self.graph.nodes[name]["rank"]]
        index = self.position_in_row[name]
        return row[index - 1] if index > 0 else None

    def _right_neighbour(self, name):
        row = self.rows[self.graph.nodes[name]["rank"]]
        index = self.position_in_row[name]
        return row[index + 1] if index + 1 < len(row) else None

    def _clamped(self, x, name, wanted):
        """The reference's `get_node_x_median`: honour both same-rank margins."""
        low, high = -math.inf, math.inf
        left = self._left_neighbour(name)
        if left is not None:
            low = x[left] + self._separation(left, name)
        right = self._right_neighbour(name)
        if right is not None:
            high = x[right] - self._separation(right, name)
        if low > high:
            return low
        return min(max(wanted, low), high)

    # -- the three moves ----------------------------------------------------

    def medianpos(self, x, movable):
        """[2] Def. 10 — place a node at the median of its neighbours' x."""
        ordered = sorted(movable, key=lambda n: (self.graph.nodes[n]["rank"], n))
        for neighbours, names in ((self.neighbours_up, ordered),
                                  (self.neighbours_down, list(reversed(ordered)))):
            for name in names:
                positions = [x[m] for m in neighbours.get(name, ())]
                if positions:
                    x[name] = self._clamped(x, name, float(np.median(positions)))

    def packcut(self, x, movable):
        """[2] Def. 19 — pull nodes left, never past a same-rank neighbour."""
        if not movable:
            return
        movable = set(movable)
        names = sorted(self.graph.nodes, key=lambda n: (x[n], n))
        for i in range(len(names) - 1):
            distance = x[names[i + 1]] - x[names[i]]
            if distance <= 0:
                continue
            for name in names[i + 1:]:
                if name not in movable:
                    continue
                left = self._left_neighbour(name)
                floor = (-math.inf if left is None
                         else x[left] + self._separation(left, name))
                x[name] = max(x[name] - distance, floor)

    def packcut_trunk(self, x, trunk):
        """[2] Def. 20 — one x for the whole trunk, at its tightest margin."""
        if not trunk:
            return
        trunk_set = set(trunk)
        margin = -math.inf
        for name in trunk:
            left = self._left_neighbour(name)
            if left is not None and left not in trunk_set:
                margin = max(margin, x[left] + self._separation(left, name))
        if margin == -math.inf:
            margin = max(x[name] for name in trunk)
        for name in trunk:
            x[name] = margin

    # -- separation ---------------------------------------------------------

    def settle(self, x, trunks, rounds=12):
        """Removes the overlaps the three packing moves can leave behind.

        `packcut` only enforces a node's left margin when it finds a gap to
        close, and `packcut_trunk` moves a whole trunk right, which can push
        into whatever sits to its right. This sweeps every rank left to right
        and moves nodes right until the required separation holds, moving each
        trunk as one rigid group so trunk linearity survives. Moves are only
        ever rightward, so it converges; the last round is an unconditional
        sweep, which guarantees no overlap even if a pathological graph has
        not converged by then.
        """
        trunk_of = {}
        for index, trunk in enumerate(trunks):
            for name in trunk:
                trunk_of[name] = index

        for round_index in range(rounds):
            rigid = round_index + 1 < rounds
            moved = False
            for rank in sorted(self.rows):
                row = self.rows[rank]
                for i in range(1, len(row)):
                    left, name = row[i - 1], row[i]
                    floor = x[left] + self._separation(left, name)
                    if x[name] >= floor - 1e-9:
                        continue
                    delta = floor - x[name]
                    group = trunk_of.get(name)
                    if rigid and group is not None:
                        for member in trunks[group]:
                            x[member] += delta
                    else:
                        x[name] += delta
                    moved = True
            if not moved:
                return True
        return False

    # -- the loop -----------------------------------------------------------

    def xlength(self, x):
        """Weighted horizontal edge length; the reference's own objective.

        Virtual-to-virtual segments weigh heaviest, so a long routed edge is
        straightened before a short real one is nudged.
        """
        total = 0.0
        for edge in self.graph.typed_edges:
            chain = edge["chain"]
            for i in range(len(chain) - 1):
                u, v = chain[i], chain[i + 1]
                real_u = self.graph.nodes[u]["kind"] != "virtual"
                real_v = self.graph.nodes[v]["kind"] != "virtual"
                weight = 1.0 if (real_u and real_v) else (2.0 if (real_u or real_v) else 8.0)
                total += weight * max(1.0, edge["freq"]) * abs(x[u] - x[v])
        return total

    def run(self, layouts, iterations, log):
        trunks = [
            [n for n in layouts[ot].get("straightTrunk", ()) if n in self.graph.nodes]
            for ot in self.graph.object_types
        ]
        trunks = [trunk for trunk in trunks if trunk]

        all_trunk = {name for trunk in trunks for name in trunk}
        x = self.initial()
        self.settle(x, trunks)
        best, best_length = dict(x), self.xlength(x)

        for _ in range(max(1, int(iterations))):
            for object_type in self.graph.object_types:
                layout = layouts[object_type]
                trunk = [n for n in layout.get("straightTrunk", ())
                         if n in self.graph.nodes]
                members = [n for n in layout["nodes"] if n in self.graph.nodes]
                # `nonBN_ot` of [1] Alg. 2, minus *every* type's trunk: a
                # shared activity can be on another type's trunk, and moving
                # it here would bend that line after its own pass straightened
                # it.
                non_trunk = [n for n in members if n not in all_trunk]
                if not members:
                    continue
                self.medianpos(x, non_trunk)
                if trunk:
                    spine = sum(self.graph.nodes[n]["order"] for n in trunk) / len(trunk)
                    self.packcut(x, [n for n in non_trunk
                                     if self.graph.nodes[n]["order"] < spine])
                    self.packcut_trunk(x, trunk)
                    self.packcut(x, [n for n in non_trunk
                                     if self.graph.nodes[n]["order"] >= spine])
                else:
                    self.packcut(x, non_trunk)
            converged = self.settle(x, trunks)
            length = self.xlength(x)
            if length < best_length:
                best_length, best = length, dict(x)
            del converged

        straight = self.settle(best, trunks)
        offset = min((best[n] - self.graph.nodes[n]["width"] / 2.0 for n in best),
                     default=0.0)
        for name, node in self.graph.nodes.items():
            node["x"] = round(best[name] - offset, 3)
            node["y"] = round(self.rank_spacing * node["rank"], 3)
        bent = [
            trunk for trunk in trunks
            if len({round(best[n], 2) for n in trunk}) > 1
        ]
        log(f"node positioning: weighted horizontal edge length {best_length:.0f}, "
            f"{len(trunks) - len(bent)}/{len(trunks)} trunks straight")
        return {
            "xlength": round(best_length, 2),
            "separationConverged": bool(straight),
            "trunks": len(trunks),
            "straightTrunks": len(trunks) - len(bent),
        }


# ---------------------------------------------------------------------------
# 10. Metrics ([1] Sect. 4.3, [2] Def. 23)
# ---------------------------------------------------------------------------


def _positions_by_type(graph):
    by_type = defaultdict(list)
    for node in graph.nodes.values():
        if node["kind"] != "activity":
            continue
        for object_type in node["objectTypes"]:
            by_type[object_type].append(node["x"])
    return by_type


def _object_type_compactness(graph):
    """[1]'s QM_OTC — how tightly one type's activities cluster in x.

    The silhouette score of [1] Sect. 4.3, over one-dimensional x positions.
    Ranges -1..1; higher means better-separated object type bands.
    """
    by_type = _positions_by_type(graph)
    types = sorted(by_type)
    if len(types) < 2:
        return None
    scores = []
    for object_type in types:
        own = by_type[object_type]
        if len(own) < 2:
            continue
        for index, value in enumerate(own):
            a = sum(abs(value - own[other]) for other in range(len(own)) if other != index)
            a /= float(len(own) - 1)
            b = math.inf
            for other_type in types:
                if other_type == object_type or not by_type[other_type]:
                    continue
                group = by_type[other_type]
                b = min(b, sum(abs(value - other) for other in group) / len(group))
            if b is math.inf:
                continue
            denominator = max(a, b)
            scores.append(0.0 if denominator == 0 else (b - a) / denominator)
    return (sum(scores) / len(scores)) if scores else None


def _interaction_preservation(graph):
    """[1]'s QM_OTIP — do layout distances rank like OC-DFG distances?

    Reported as 1 - deviation so that, like every other score here, higher is
    better; the paper reports the deviation itself.
    """
    types = graph.object_types
    if len(types) < 2:
        return None
    activity_sets = {ot: set(graph.activity_names(ot)) for ot in types}
    positions = _positions_by_type(graph)

    ocel, layout = {}, {}
    for i in range(len(types)):
        for j in range(i + 1, len(types)):
            a, b = types[i], types[j]
            ocel[(a, b)] = _set_distance(activity_sets[a], activity_sets[b])
            xa, xb = positions[a], positions[b]
            layout[(a, b)] = (0.0 if not xa or not xb
                              else abs(sum(xa) / len(xa) - sum(xb) / len(xb)))
    ocel_rank = _distance_ranks(ocel)
    layout_rank = _distance_ranks(layout)
    denominator = sum(ocel_rank[k] ** 2 for k in ocel_rank)
    if denominator == 0:
        return None
    numerator = sum((ocel_rank[k] - layout_rank[k]) ** 2 for k in ocel_rank)
    return 1.0 - math.sqrt(numerator / denominator)


def _balance_about(graph, trunk):
    """Left/right node counts about one trunk, and the normalised balance."""
    trunk = [n for n in trunk if n in graph.nodes]
    if not trunk:
        return None
    spine = sum(graph.nodes[n]["order"] for n in trunk) / len(trunk)
    inside = set(trunk)
    left = right = 0
    for name, node in graph.nodes.items():
        if node["kind"] == "virtual" or name in inside:
            continue
        if node["order"] < spine:
            left += 1
        elif node["order"] > spine:
            right += 1
    total = left + right
    balance = 1.0 if total == 0 else 1.0 - abs(left - right) / float(total)
    return {"left": left, "right": right, "balance": balance,
            "difference": abs(left - right)}


def compute_metrics(graph, crossings, layouts, main_type):
    """The layout-quality metrics both papers evaluate against.

    Two of the paper's printed formulas are ambiguous and are resolved here
    rather than silently: QM_bal is printed as a raw left/right node-count
    difference while the tables report a 0..1 score, so a normalised
    `balance` is reported alongside the raw `balanceDifference`; and the
    orthogonality denominators are printed as |N| where the summation is over
    E, so |E| is used.
    """
    order = {name: node["order"] for name, node in graph.nodes.items()}

    back_edges = horizontal = 0
    for edge in graph.typed_edges:
        rank_src = graph.nodes[edge["src"]]["rank"]
        rank_dst = graph.nodes[edge["dst"]]["rank"]
        if rank_src > rank_dst:
            back_edges += 1
        elif rank_src == rank_dst:
            horizontal += 1

    # [2]'s QM_bal is about the one backbone of a single-log layout. In an
    # OC-DFG every type has a trunk, so the headline figure is the main
    # type's — the layout's central spine — and the per-type split is
    # reported beside it.
    by_type = {}
    for object_type in graph.object_types:
        about = _balance_about(graph, layouts[object_type].get("straightTrunk", ()))
        if about is not None:
            by_type[object_type] = round(about["balance"], 4)
    main = _balance_about(
        graph, layouts.get(main_type, {}).get("straightTrunk", ())
        if main_type else ())
    if main is None:
        main = {"left": 0, "right": 0, "balance": 1.0, "difference": 0}
    left, right, balance = main["left"], main["right"], main["balance"]

    length = deviation = 0.0
    counted = 0
    for u, v in _segments(graph):
        a, b = graph.nodes[u], graph.nodes[v]
        dx, dy = a["x"] - b["x"], a["y"] - b["y"]
        length += math.hypot(dx, dy)
        theta = math.degrees(math.atan2(abs(dy), abs(dx)))  # 0 = horizontal
        deviation += min(theta, abs(90.0 - theta)) / 45.0
        counted += 1
    orthogonality = 1.0 - (deviation / counted) if counted else 1.0

    real = [node for node in graph.nodes.values() if node["kind"] != "virtual"]
    rank_span = max((node["rank"] for node in graph.nodes.values()), default=0)
    order_span = max((node["order"] for node in graph.nodes.values()), default=0)
    cells = max(1, rank_span) * max(1, order_span + 1)

    compactness = _object_type_compactness(graph)
    preservation = _interaction_preservation(graph)
    return {
        "backEdges": back_edges,
        "horizontalEdges": horizontal,
        "backEdgeRate": round(
            back_edges / len(graph.typed_edges), 4) if graph.typed_edges else 0.0,
        "crossings": crossings.total(order),
        "edgeLength": round(length, 2),
        "edgeOrthogonality": round(orthogonality, 4),
        "nodeOrthogonality": round(min(1.0, len(real) / float(cells)), 4),
        "balance": round(balance, 4),
        "balanceDifference": main["difference"],
        "balanceByObjectType": by_type,
        "leftNodes": left,
        "rightNodes": right,
        "ranks": rank_span,
        "orderColumns": order_span + 1,
        "objectTypeCompactness": None if compactness is None else round(compactness, 4),
        "objectTypeInteractionPreservation": (
            None if preservation is None else round(preservation, 4)),
    }


# ---------------------------------------------------------------------------
# 11. The pipeline
# ---------------------------------------------------------------------------

DEFAULTS = {
    "backbone": "modal",
    "mainObjectType": "",
    "rankMethod": "ip",
    "rankObjective": "squared",
    "rankEdgeWeight": "objectTypes",
    "allowHorizontalEdges": True,
    "componentBalancing": "ip",
    "crossMinIterations": 8,
    "positioningIterations": 8,
    "axisWeight": 0.5,
    "crossingWeight": 0.5,
    "orderSpacing": 170,
    "rankSpacing": 110,
    "minGap": 26,
    "timeLimitSecs": 20,
    "maxPairsForIp": 1200,
}

_INT_PARAMS = ("crossMinIterations", "positioningIterations", "maxPairsForIp")
_FLOAT_PARAMS = ("axisWeight", "crossingWeight", "orderSpacing", "rankSpacing",
                 "minGap", "timeLimitSecs")


def _resolved_params(params):
    out = dict(DEFAULTS)
    for key, value in (params or {}).items():
        if key in out and value is not None and value != "":
            out[key] = value
    for key in _INT_PARAMS:
        out[key] = int(out[key])
    for key in _FLOAT_PARAMS:
        out[key] = float(out[key])
    out["allowHorizontalEdges"] = bool(out["allowHorizontalEdges"])
    return out


def layout_ocdfg(payload, params=None, log=None, progress=None):
    """Runs the whole pipeline and returns the layout payload.

    Importable on its own — the test suite drives this directly, with no
    Pyodide and no host.
    """
    log = log or (lambda message: None)
    progress = progress or (lambda fraction, message="", data=None: None)
    resolved = _resolved_params(params)
    started = time.time()

    progress(0.05, "preparing the typed graph")
    graph = build_graph(payload)
    if not graph.object_types or not graph.nodes:
        return _empty_layout(resolved, "the OC-DFG has no typed activities")

    progress(0.15, "determining backbones")
    determine_backbones(graph, resolved["backbone"])

    rank_info = assign_ranks(graph, resolved, log, progress)

    progress(0.35, "generating virtual nodes")
    virtual_info = generate_virtual_nodes(graph)

    progress(0.4, "per-type layout and component balancing")
    layouts, balance_info = local_layouts(graph, resolved, log)

    crossings = Crossings(graph)
    merge_info = merge_axes(graph, layouts, resolved, crossings, log, progress)

    progress(0.65, "cross-minimisation")
    trunk_nodes = set()
    for layout in layouts.values():
        trunk_nodes.update(layout["trunk"])
    crossing_info = minimize_crossings(
        graph, crossings, trunk_nodes, resolved["crossMinIterations"], log)

    progress(0.8, "node positioning")
    positioner = Positioner(graph, resolved["orderSpacing"], resolved["rankSpacing"],
                            resolved["minGap"])
    position_info = positioner.run(layouts, resolved["positioningIterations"], log)

    progress(0.92, "metrics")
    metrics = compute_metrics(graph, crossings, layouts, merge_info["main"])

    return _emit(graph, layouts, resolved, metrics, {
        "rank": rank_info,
        "virtual": virtual_info,
        "balancing": balance_info,
        "merge": {k: v for k, v in merge_info.items() if k not in ("order", "axisOfNode")},
        "crossings": crossing_info,
        "positioning": position_info,
        "secs": round(time.time() - started, 3),
    })


def _emit(graph, layouts, params, metrics, diagnostics):
    """The `OCDFGBackboneLayout` payload."""
    trunk_of = {}
    for object_type in graph.object_types:
        for name in layouts[object_type]["trunk"]:
            trunk_of[name] = object_type

    nodes = []
    for name in sorted(graph.nodes):
        node = graph.nodes[name]
        nodes.append({
            "id": name,
            "kind": node["kind"],
            "label": node["label"],
            "activity": node["label"] if node["kind"] == "activity" else None,
            "objectType": node["objectType"],
            "objectTypes": sorted(node["objectTypes"]),
            "axis": node["axis"], "rank": node["rank"], "order": node["order"],
            "x": node["x"], "y": node["y"],
            "width": round(node["width"], 2), "height": round(node["height"], 2),
            "count": node["count"] or None,
            "backboneOf": trunk_of.get(name),
        })

    edges = []
    for index, edge in enumerate(graph.typed_edges):
        chain = edge["chain"]
        edges.append({
            "id": f"{index}|{edge['objectType']}|{edge['src']}|{edge['dst']}",
            "objectType": edge["objectType"],
            "src": edge["src"], "dst": edge["dst"], "kind": edge["kind"],
            "freq": edge["freq"], "avgSecs": edge["avgSecs"],
            "backbone": bool(edge["backbone"]),
            "waypoints": [{"x": graph.nodes[n]["x"], "y": graph.nodes[n]["y"]}
                          for n in chain],
            "via": chain[1:-1],
            "back": graph.nodes[edge["src"]]["rank"] > graph.nodes[edge["dst"]]["rank"],
            "horizontal": graph.nodes[edge["src"]]["rank"] == graph.nodes[edge["dst"]]["rank"],
        })

    axes = []
    axis_of_type = diagnostics["merge"].get("axisOfType", {})
    for object_type in graph.object_types:
        trunk = [n for n in layouts[object_type]["trunk"] if n in graph.nodes]
        axes.append({
            "objectType": object_type,
            "axis": axis_of_type.get(object_type, 0),
            "backbone": [n for n in graph.backbone[object_type]["nodes"]
                         if graph.nodes[n]["kind"] != "virtual"],
            "trunk": trunk,
            "straightTrunk": [n for n in layouts[object_type].get("straightTrunk", ())
                              if n in graph.nodes],
            "trunkX": (round(sum(graph.nodes[n]["x"] for n in trunk) / len(trunk), 2)
                       if trunk else None),
            "activities": len(graph.activity_names(object_type)),
            "components": len(layouts[object_type]["components"]),
            "componentsLeft": int(sum(1 for flag in layouts[object_type]["left"] if flag)),
        })
    axes.sort(key=lambda entry: (entry["axis"], entry["objectType"]))

    width = max((node["x"] + node["width"] / 2.0 for node in graph.nodes.values()),
                default=0.0)
    height = max((node["y"] + node["height"] / 2.0 for node in graph.nodes.values()),
                 default=0.0)

    return {
        "objectTypes": graph.object_types,
        "mainObjectType": diagnostics["merge"].get("main"),
        "nodes": nodes, "edges": edges, "axes": axes,
        "extent": {"width": round(width + 48, 1), "height": round(height + 48, 1)},
        "metrics": metrics, "params": params, "diagnostics": diagnostics,
        "stats": {
            "objectTypes": len(graph.object_types),
            "activities": len(graph.activity_names()),
            "edges": len(graph.typed_edges),
            "ranks": metrics["ranks"],
            "backEdges": metrics["backEdges"],
            "crossings": metrics["crossings"],
            "virtualNodes": diagnostics["virtual"]["virtualNodes"],
        },
    }


def _empty_layout(params, reason):
    return {
        "objectTypes": [], "mainObjectType": None, "nodes": [], "edges": [], "axes": [],
        "extent": {"width": 0, "height": 0}, "metrics": {}, "params": params,
        "diagnostics": {"reason": reason},
        "stats": {"objectTypes": 0, "activities": 0, "edges": 0, "ranks": 0,
                  "backEdges": 0, "crossings": 0, "virtualNodes": 0},
    }


# ---------------------------------------------------------------------------
# Host entry points
# ---------------------------------------------------------------------------


async def prepare(ctx):
    """The OC-DFG arrives as an inline payload, so there is nothing to query."""
    payload = ctx.input
    if not isinstance(payload, dict):
        raise ValueError("this action needs an OC-DFG artifact as its input")
    return payload


def finalize(prepared, params, ctx):
    return layout_ocdfg(prepared, params, log=ctx.log, progress=ctx.progress)
