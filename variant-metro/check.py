#!/usr/bin/env python3
"""Offline invariant checks for `variants.py`.

Run by `package.sh` before anything is packaged, and standalone with
`python3 check.py`. No test-runner dependency, same reasoning as the view's
own `check.js`: the invariants are what make the slider mean what it claims,
so they gate packaging rather than living in a document.

What is asserted, on hand-built logs *and* on randomised ones:

1. The two breadth-first-search paths (vectorised numpy, and the plain Python
   fallback for a runtime without numpy) extract the *same* executions. The
   fast path exists for speed only and must never change a result.
2. `minVariant` is monotone: an arc never appears in an earlier variant than
   the activity nodes at its ends. The view's filter relies on this — without
   it the slider could show an arc whose endpoints are hidden.
3. Per-variant counts (`byVariant`) sum exactly to the whole-model counts, so
   an arc label at the top of the slider matches the model it came from.
4. Variant ranks are dense (1..positions) and ordered by execution count
   descending, with the tail — if any — last.
5. Filtering at position 1 yields exactly the most frequent variant's own
   directly-follows graph, recomputed independently from that variant's
   executions. This is the end-to-end claim: "the bottom of the slider is the
   most frequent variant".
"""

import importlib.util
import json
import os
import random
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("variants", os.path.join(HERE, "variants.py"))
V = importlib.util.module_from_spec(spec)
spec.loader.exec_module(V)

failures = []


def check(name, condition, detail=""):
    if condition:
        print(f"  ok    {name}")
    else:
        print(f"  FAIL  {name}{(' — ' + detail) if detail else ''}")
        failures.append(name)


class Ctx:
    """The slice of the host's plugin context these checks need."""

    def log(self, message):
        pass

    def progress(self, fraction, message="", data=None):
        pass


# ---------------------------------------------------------------------------
# Synthetic logs
# ---------------------------------------------------------------------------
def make_data(events, type_of):
    """`events`: (event_id, activity, ts_ms, [object_ids])."""
    activity_of, ts_of, objects_by_event = {}, {}, {}
    events_by_object = defaultdict(list)
    for eid, activity, ts, oids in events:
        activity_of[eid] = activity
        ts_of[eid] = float(ts)
        oids = [o for o in oids if o in type_of]
        objects_by_event[eid] = oids
        for oid in oids:
            events_by_object[oid].append(eid)
    for oid in events_by_object:
        events_by_object[oid].sort(key=lambda e: (ts_of[e], e))
    return {
        "type_of": type_of,
        "activity_of": activity_of,
        "ts_of": ts_of,
        "objects_by_event": objects_by_event,
        "events_by_object": dict(events_by_object),
    }


def order_log():
    """Three deliberate variants at known frequencies, plus a shared employee.

    The employee is what makes this a real object-centric log rather than three
    independent traces: every order touches it, so the object graph is one
    connected component and extraction has to scope it back out again.
    """
    type_of = {"emp1": "employee"}
    events = []
    clock = 0
    kinds = ["plain"] * 6 + ["rush"] * 3 + ["cancel"] * 2
    for n, kind in enumerate(kinds):
        order = f"o{n}"
        type_of[order] = "order"
        items = [f"i{n}_{k}" for k in range(2)]
        for item in items:
            type_of[item] = "item"
        clock += 100000
        t = clock
        events.append((f"e{n}_0", "place order", t, [order, "emp1"]))
        for k, item in enumerate(items):
            t += 1000
            events.append((f"e{n}_p{k}", "pick item", t, [order, item]))
            t += 1000
            events.append((f"e{n}_k{k}", "pack item", t, [order, item]))
        t += 1000
        if kind == "cancel":
            events.append((f"e{n}_c", "cancel order", t, [order, "emp1"]))
        else:
            if kind == "rush":
                events.append((f"e{n}_x", "express check", t, [order]))
                t += 1000
            events.append((f"e{n}_s", "ship order", t, [order] + items))
    return make_data(events, type_of)


def random_log(seed):
    """A randomised object-centric log: variable case shapes, optional hubs."""
    rng = random.Random(seed)
    activities = ["A", "B", "C", "D", "E", "F"]
    hubs = [f"h{i}" for i in range(rng.randint(0, 2))]
    type_of = {h: "resource" for h in hubs}
    events = []
    clock = 0
    for n in range(rng.randint(3, 25)):
        root = f"r{n}"
        type_of[root] = "root"
        children = [f"c{n}_{k}" for k in range(rng.randint(0, 3))]
        for c in children:
            type_of[c] = "child"
        # A case's shape is drawn from a small pool, so several cases really do
        # share a variant instead of every case being unique.
        shape = rng.choice([
            ["A", "B", "C"], ["A", "C"], ["A", "B", "B", "C"],
            ["A", "D", "E"], ["A", "B", "C", "F"],
        ])
        clock += 10_000
        t = clock
        for i, activity in enumerate(shape):
            t += rng.randint(1, 5) * 1000
            touching = [root]
            if children and rng.random() < 0.6:
                touching.append(rng.choice(children))
            if hubs and rng.random() < 0.3:
                touching.append(rng.choice(hubs))
            events.append((f"e{n}_{i}", activity, t, touching))
    return make_data(events, type_of)


PARAMS = {
    "extraction": "leadingType",
    "maxEvents": 300,
    "maxVariants": 25,
    "maxObjectTypes": 12,
    "scopeSharedObjects": True,
}


# ---------------------------------------------------------------------------
# 1. The vectorised BFS must not change a result
# ---------------------------------------------------------------------------
def check_bfs_paths_agree(name, data, leading_type):
    adjacency = V._object_graph(data)
    roots = sorted(o for o in data["events_by_object"] if data["type_of"].get(o) == leading_type)
    fast = V._leading_type_executions(roots, adjacency, data["type_of"])
    plain = [V._leading_type_execution(root, adjacency, data["type_of"]) for root in roots]
    check(f"both BFS paths agree ({name}, {len(roots)} roots)", fast == plain,
          f"first divergence at {next((i for i, (a, b) in enumerate(zip(fast, plain)) if a != b), None)}")


# ---------------------------------------------------------------------------
# 2-5. Properties of the folded, variant-attributed OC-DFG
# ---------------------------------------------------------------------------
def check_payload(name, data, params):
    out = V.finalize(data, params, Ctx())
    nodes, edges, variants = out["nodes"], out["edges"], out["variants"]
    if not nodes:
        check(f"{name}: non-empty result", False, "no nodes at all")
        return out

    node_min = {(n["objectType"], n["activity"]): n["minVariant"] for n in nodes}
    monotone = all(
        edge["minVariant"] >= max(
            node_min.get((edge["objectType"], edge["src"]), 1),
            node_min.get((edge["objectType"], edge["dst"]), 1),
        )
        for edge in edges
    )
    check(f"{name}: minVariant monotone along every arc", monotone)

    sums_match = all(
        abs(sum(row[1] for row in n["byVariant"]) - n["count"]) < 1e-9
        and abs(sum(row[2] for row in n["byVariant"]) - n["starts"]) < 1e-9
        and abs(sum(row[3] for row in n["byVariant"]) - n["ends"]) < 1e-9
        for n in nodes
    ) and all(
        abs(sum(row[1] for row in e["byVariant"]) - e["freq"]) < 1e-9 for e in edges
    )
    check(f"{name}: per-variant counts sum to the whole model", sums_match)

    ranks = [v["rank"] for v in variants]
    counts = [v["executions"] for v in variants]
    dense = ranks == list(range(1, len(variants) + 1)) == list(range(1, out["stats"]["sliderPositions"] + 1))
    # The tail position pools several variants, so only the individually-ranked
    # ones have to descend; the tail can be any size and is always last.
    individual = [c for c, v in zip(counts, variants) if not v.get("tail")]
    tail_last = all(not v.get("tail") for v in variants[:-1])
    check(f"{name}: variant ranks dense and frequency-ordered",
          dense and individual == sorted(individual, reverse=True) and tail_last,
          f"ranks={ranks[:6]} counts={counts[:6]}")

    check(f"{name}: every node and arc is attributed",
          all(n["byVariant"] for n in nodes) and all(e["byVariant"] for e in edges))
    return out


def check_position_one_is_the_top_variant(name, data, params):
    """Position 1 must equal the most frequent variant's own DFG, recomputed."""
    adjacency = V._object_graph(data)
    type_of = data["type_of"]
    leading = params.get("leadingType")
    if not leading:
        by_count = defaultdict(int)
        for oid in data["events_by_object"]:
            by_count[type_of.get(oid, "?")] += 1
        leading = max(by_count.items(), key=lambda kv: (kv[1], kv[0]))[0]
    roots = sorted(o for o in data["events_by_object"] if type_of.get(o) == leading)
    object_sets = list(zip(roots, V._leading_type_executions(roots, adjacency, type_of)))
    allowed = V._allowed_events_by_root(object_sets, data) if params["scopeSharedObjects"] else None
    executions = [
        ex for root, oids in object_sets
        if (ex := V._build_execution(oids, data, params["maxEvents"],
                                     allowed.get(root) if allowed else None))["events"]
    ]
    groups = V._group_variants(executions)
    groups.sort(key=lambda g: (-len(g), -sum(len(ex["events"]) for ex in g) / len(g)))

    # The most frequent variant's own OC-DFG, built here from nothing but that
    # variant's executions — deliberately not reusing `finalize`'s fold.
    expected_nodes, expected_edges = set(), set()
    for ex in groups[0]:
        for oid, seq in ex["per_object"].items():
            ot = type_of.get(oid)
            if ot is None or not seq:
                continue
            for eid in seq:
                expected_nodes.add((ot, data["activity_of"][eid]))
            for i in range(1, len(seq)):
                expected_edges.add((ot, data["activity_of"][seq[i - 1]], data["activity_of"][seq[i]]))

    out = V.finalize(data, params, Ctx())
    kept_types = set(out["objectTypes"])
    got_nodes = {(n["objectType"], n["activity"]) for n in out["nodes"] if n["minVariant"] == 1}
    got_edges = {(e["objectType"], e["src"], e["dst"]) for e in out["edges"] if e["minVariant"] == 1}
    expected_nodes = {k for k in expected_nodes if k[0] in kept_types}
    expected_edges = {k for k in expected_edges if k[0] in kept_types}
    check(f"{name}: slider position 1 is exactly the most frequent variant",
          got_nodes == expected_nodes and got_edges == expected_edges,
          f"nodes +{len(got_nodes - expected_nodes)}/-{len(expected_nodes - got_nodes)} "
          f"arcs +{len(got_edges - expected_edges)}/-{len(expected_edges - got_edges)}")


def main():
    """Runs every check. Kept behind a function so this module can also be
    imported — `view-src/harness/make-payload.py` reuses `order_log()` to build
    the fixture the view harness renders, and importing a script that runs
    itself on import is a trap.
    """
    print("variant-metro: variant extraction checks\n")

    order = order_log()
    check_bfs_paths_agree("order log", order, "order")
    out = check_payload("order log", order, {**PARAMS, "leadingType": "order"})
    check("order log: three variants, most frequent first",
          out["stats"]["variantCount"] == 3 and [v["executions"] for v in out["variants"]] == [6, 3, 2],
          json.dumps([v["executions"] for v in out["variants"]]))
    check("order log: 'express check' only appears in variant 2",
          all(n["minVariant"] == 2 for n in out["nodes"] if n["activity"] == "express check"))
    check("order log: 'cancel order' only appears in variant 3",
          all(n["minVariant"] == 3 for n in out["nodes"] if n["activity"] == "cancel order"))
    check_position_one_is_the_top_variant("order log", order, {**PARAMS, "leadingType": "order"})

    # The tail bucket: two individual positions, everything else pooled onto one.
    tail = check_payload("order log (maxVariants 2)", order, {**PARAMS, "leadingType": "order", "maxVariants": 2})
    check("order log: the tail shares the last slider position",
          tail["stats"]["sliderPositions"] == 3 and tail["variants"][-1]["tail"] is True
          and tail["variants"][-1]["cumulativeVariants"] == tail["stats"]["variantCount"],
          json.dumps(tail["variants"][-1]))

    cc = check_payload("order log (connected components)", order, {**PARAMS, "extraction": "connectedComponents"})
    check("order log: the shared employee makes one component",
          cc["stats"]["executionCount"] == 1, json.dumps(cc["stats"]))

    unscoped = check_payload("order log (unscoped)", order, {**PARAMS, "leadingType": "order", "scopeSharedObjects": False})
    check("order log: unscoped extraction still produces variants",
          unscoped["stats"]["variantCount"] >= 1)

    print()
    for seed in range(1, 13):
        data = random_log(seed)
        params = {**PARAMS, "leadingType": "root"}
        check_bfs_paths_agree(f"randomised log #{seed}", data, "root")
        check_payload(f"randomised log #{seed}", data, params)
        check_position_one_is_the_top_variant(f"randomised log #{seed}", data, params)

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: {', '.join(failures[:6])}")
        sys.exit(1)
    print("All variant extraction checks passed.")


if __name__ == "__main__":
    main()
