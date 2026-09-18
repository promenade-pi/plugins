"""Invariants for the backbone OC-DFG layout.

Layout code is easy to break in ways a screenshot does not show, so every
property the two papers actually claim is asserted here as an executable
invariant, over handcrafted fixtures *and* 25 randomised OC-DFGs:

  * per-type backbone chains descend, strictly           [1] Eq. 7 / [2] Eq. 3
  * every activity sits strictly inside its type's
    start/end pair                                   [1] Eqs. 3-4 / [2] Eq. 6-7
  * a pair that may not be horizontal is not             [2] Eqs. 4-5
  * a mutually dependent pair *is* horizontal            [2] Sect. 3.2, Fig. 5
  * virtual-node chains occupy consecutive ranks         [2] Defs. 12-13
  * no two nodes on a rank overlap                       [2] Def. 19
  * a trunk is one straight vertical line                [2] Def. 20, Fig. 18
  * x is monotone in order within a rank
  * the IP never scores worse than the heuristic it replaces
  * component balancing attains the optimum the
    heuristic misses                                     [2] Fig. 7
  * the same input produces the same layout

Run with the repository venv (numpy + scipy):

    python -m unittest discover -s test
"""

import importlib.util
import json
import math
import pathlib
import random
import unittest
from collections import defaultdict

MODULE = pathlib.Path(__file__).resolve().parents[1] / "plugin.py"
SPEC = importlib.util.spec_from_file_location("ocdfg_backbone_layout", MODULE)
BL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BL)

FAST = {"timeLimitSecs": 10, "positioningIterations": 4, "crossMinIterations": 4}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def ocdfg(types_to_edges, starts=None, ends=None):
    """Builds an OC-DFG payload from `{object type: [(src, dst, freq)]}`."""
    nodes, edges = [], []
    starts = starts or {}
    ends = ends or {}
    for object_type, arcs in sorted(types_to_edges.items()):
        activities = sorted({a for arc in arcs for a in arc[:2]})
        first = starts.get(object_type, [activities[0]] if activities else [])
        last = ends.get(object_type, [activities[-1]] if activities else [])
        for activity in activities:
            nodes.append({
                "objectType": object_type, "activity": activity, "count": 10,
                "starts": 10 if activity in first else 0,
                "ends": 10 if activity in last else 0,
            })
        for src, dst, freq in arcs:
            edges.append({"objectType": object_type, "src": src, "dst": dst,
                          "freq": freq})
    return {
        "objectTypes": sorted(types_to_edges),
        "nodes": nodes, "edges": edges,
        "stats": {"objectTypes": len(types_to_edges),
                  "activities": len({n["activity"] for n in nodes}),
                  "edges": len(edges)},
    }


def toy_journal_figure_10():
    """[2] Table 4's toy variants, as a DFG for a single object type.

    <A,B,C,D,E> 210, <A,B,C,F,E> 90, <A,B,G,B,C,D,E> 80,
    <A,B,H,I,D,E> 70, <A,B,C,J,K,D,L,E> 55.
    """
    variants = [
        (["A", "B", "C", "D", "E"], 210),
        (["A", "B", "C", "F", "E"], 90),
        (["A", "B", "G", "B", "C", "D", "E"], 80),
        (["A", "B", "H", "I", "D", "E"], 70),
        (["A", "B", "C", "J", "K", "D", "L", "E"], 55),
    ]
    counts = {}
    for trace, freq in variants:
        for i in range(len(trace) - 1):
            counts[(trace[i], trace[i + 1])] = counts.get(
                (trace[i], trace[i + 1]), 0) + freq
    arcs = [(src, dst, freq) for (src, dst), freq in sorted(counts.items())]
    return ocdfg({"Case": arcs}, starts={"Case": ["A"]}, ends={"Case": ["E"]})


def toy_journal_figure_5():
    """[2] Fig. 5's example: B and E are mutually dependent.

    Variants A->B->C->D (100), A->E->B->C->D (80), A->E->F (60),
    A->B->E->F (40). B->E and E->B both occur, so no precedence holds between
    them and [2] Sect. 3.2 puts them on one rank.
    """
    variants = [
        (["A", "B", "C", "D"], 100),
        (["A", "E", "B", "C", "D"], 80),
        (["A", "E", "F"], 60),
        (["A", "B", "E", "F"], 40),
    ]
    counts = {}
    for trace, freq in variants:
        for i in range(len(trace) - 1):
            counts[(trace[i], trace[i + 1])] = counts.get(
                (trace[i], trace[i + 1]), 0) + freq
    arcs = [(src, dst, freq) for (src, dst), freq in sorted(counts.items())]
    return ocdfg({"Case": arcs}, starts={"Case": ["A"]},
                 ends={"Case": ["D", "F"]})


def order_to_cash():
    """A small multi-type OC-DFG with shared activities and a rework loop."""
    return ocdfg(
        {
            "Order": [
                ("place order", "check availability", 120),
                ("check availability", "confirm order", 100),
                ("confirm order", "ship", 95),
                ("ship", "invoice", 90),
                ("check availability", "clarify", 20),
                ("clarify", "check availability", 18),
            ],
            "Item": [
                ("check availability", "pick item", 300),
                ("pick item", "pack item", 290),
                ("pack item", "ship", 280),
                ("pick item", "repick item", 30),
                ("repick item", "pick item", 28),
            ],
            "Invoice": [
                ("invoice", "receive payment", 88),
                ("receive payment", "close case", 85),
                ("invoice", "dispute", 9),
                ("dispute", "invoice", 8),
            ],
        },
        starts={"Order": ["place order"], "Item": ["check availability"],
                "Invoice": ["invoice"]},
        ends={"Order": ["invoice"], "Item": ["ship"], "Invoice": ["close case"]},
    )


FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures"


def procure_to_pay():
    """The real OC-DFG that `core.discover.ocdfg` mines from Promenade's
    Procure-to-Pay sample log: 7 object types over 10 activities, heavily
    shared, with self-loops and mutual pairs throughout. Synthetic graphs do
    not reproduce that amount of sharing, and it is what stresses the axis
    merge and the disjoint-trunk rules."""
    return json.loads((FIXTURES / "procure-to-pay-ocdfg.json").read_text())


def random_ocdfg(rng):
    """A random but structurally plausible OC-DFG.

    Every type gets a spine so it has a start, an end and a reachable path,
    plus shortcuts, rework loops (which produce mutual pairs) and shared
    activities across types (which is what makes the layout object-centric).
    """
    type_count = rng.randint(1, 4)
    types = [f"T{i}" for i in range(type_count)]
    pool = [f"act {i}" for i in range(rng.randint(4, 14))]
    payload = {}
    starts, ends = {}, {}
    for object_type in types:
        size = rng.randint(3, min(len(pool), 9))
        spine = rng.sample(pool, size)
        arcs = {}
        for i in range(len(spine) - 1):
            arcs[(spine[i], spine[i + 1])] = rng.randint(20, 200)
        for _ in range(rng.randint(0, 4)):  # shortcuts and back edges
            a, b = rng.sample(spine, 2)
            arcs[(a, b)] = rng.randint(1, 40)
        for _ in range(rng.randint(0, 2)):  # rework: a mutual pair
            if len(spine) < 2:
                continue
            index = rng.randrange(len(spine) - 1)
            a, b = spine[index], spine[index + 1]
            arcs[(b, a)] = rng.randint(1, 30)
        for _ in range(rng.randint(0, 2)):  # self-loop; layout must survive it
            a = rng.choice(spine)
            arcs[(a, a)] = rng.randint(1, 20)
        payload[object_type] = [(s, d, f) for (s, d), f in sorted(arcs.items())]
        starts[object_type] = [spine[0]]
        ends[object_type] = [spine[-1]]
    return ocdfg(payload, starts=starts, ends=ends)


# ---------------------------------------------------------------------------
# Invariant checks
# ---------------------------------------------------------------------------


class Checker:
    """Re-derives the constraints from the payload and checks the result."""

    def __init__(self, case, payload, result, params):
        self.case = case
        self.payload = payload
        self.result = result
        self.params = params
        self.nodes = {node["id"]: node for node in result["nodes"]}
        self.rank = {node["id"]: node["rank"] for node in result["nodes"]}
        self.graph = BL.build_graph(payload)
        BL.determine_backbones(self.graph, params.get("backbone", "modal"))
        self.pairs = set(self.graph.pair_index)
        self.ip_solved = str(
            result["diagnostics"]["rank"].get("solver") or "").startswith("HiGHS")
        allow = params.get("allowHorizontalEdges", True)
        self.chain, self.bounds, self.strict, self.dropped = BL._rank_rows(
            self.graph, allow)

    # -- rank invariants ---------------------------------------------------

    def backbone_chains_descend(self):
        """Every admitted chain constraint holds.

        Only the admitted ones: an OC-DFG can have two types traversing the
        same activities in opposite orders, and the model reports which chain
        constraints it had to give up (see `_rank_rows`).
        """
        self.case.assertEqual(
            self.dropped,
            self.result["diagnostics"]["rank"].get("droppedChainConstraints", []),
            "the reported dropped chain constraints disagree with the model")
        for u, v in self.chain:
            self.case.assertLess(
                self.rank[u], self.rank[v],
                f"backbone constraint {u} -> {v} does not descend")

    def boundaries_enclose(self):
        for u, v in self.bounds:
            self.case.assertLess(self.rank[u], self.rank[v],
                                 f"enclosure {u} -> {v} is violated")
        for object_type in self.result["objectTypes"]:
            start, end = BL._start_name(object_type), BL._end_name(object_type)
            for name in self.graph.activity_names(object_type):
                if start in self.rank:
                    self.case.assertLess(self.rank[start], self.rank[name],
                                         f"{name} is not below {start}")
                if end in self.rank:
                    self.case.assertLess(self.rank[name], self.rank[end],
                                         f"{name} is not above {end}")

    def horizontal_edges_are_legal(self):
        """Only a pair the model allowed may share a rank.

        Holds for the heuristic too: it orients every pair strictly, so it
        produces no horizontal edges at all ([2] Sect. 3.2's limitation #2).
        """
        allow = self.params.get("allowHorizontalEdges", True)
        for u, v in self.strict:
            if u == v:
                continue  # a self-loop is trivially horizontal
            self.case.assertNotEqual(
                self.rank[u], self.rank[v],
                f"pair {u} -> {v} must not be horizontal (allow={allow})")

    # -- structural invariants ---------------------------------------------

    def chains_are_consecutive(self):
        for edge in self.result["edges"]:
            names = [edge["src"], *edge["via"], edge["dst"]]
            if len(names) == 2:
                continue  # unrouted: adjacent ranks, or over the virtual cap
            ranks = [self.rank[n] for n in names]
            for i in range(len(ranks) - 1):
                self.case.assertEqual(
                    abs(ranks[i + 1] - ranks[i]), 1,
                    f"edge {edge['id']} jumps from rank {ranks[i]} to {ranks[i + 1]}")
            self.case.assertEqual(
                len(names), abs(ranks[0] - ranks[-1]) + 1,
                f"edge {edge['id']} has the wrong number of virtual nodes")

    def every_node_is_placed(self):
        for entry in self.payload["nodes"]:
            name = BL._node_name(str(entry["activity"]))
            self.case.assertIn(name, self.nodes, f"{name} is missing from the layout")
        for edge in self.result["edges"]:
            self.case.assertGreaterEqual(len(edge["waypoints"]), 2)

    # -- geometry invariants -----------------------------------------------

    def rows(self):
        rows = {}
        for node in self.result["nodes"]:
            rows.setdefault(node["rank"], []).append(node)
        for rank in rows:
            rows[rank].sort(key=lambda n: (n["order"], n["id"]))
        return rows

    def no_overlap(self):
        gap = self.params.get("minGap", BL.DEFAULTS["minGap"])
        for rank, row in self.rows().items():
            for i in range(1, len(row)):
                left, right = row[i - 1], row[i]
                required = (left["width"] + right["width"]) / 2.0 + gap
                self.case.assertGreaterEqual(
                    right["x"] - left["x"], required - 0.05,
                    f"rank {rank}: {left['id']} and {right['id']} overlap "
                    f"({right['x'] - left['x']:.2f} < {required:.2f})")

    def x_is_monotone_in_order(self):
        for rank, row in self.rows().items():
            for i in range(1, len(row)):
                self.case.assertGreater(
                    row[i]["x"], row[i - 1]["x"],
                    f"rank {rank}: order and x disagree for {row[i]['id']}")

    def trunks_are_straight(self):
        """Every straight trunk really is one vertical line ([2] Def. 20).

        A type's straight trunk is the part of its backbone its own merge step
        introduced; a backbone activity an earlier type already placed keeps
        that position instead ([1] Sect. 3.5 step 3), so it is deliberately
        not part of this set.
        """
        if not self.result["diagnostics"]["positioning"]["separationConverged"]:
            return  # needed the unconditional final separation sweep
        straight = 0
        for axis in self.result["axes"]:
            trunk = [n for n in axis["straightTrunk"] if n in self.nodes]
            if not trunk:
                continue
            straight += 1
            xs = {round(self.nodes[n]["x"], 2) for n in trunk}
            self.case.assertEqual(
                len(xs), 1,
                f"{axis['objectType']}: trunk is not a straight line ({sorted(xs)})")
        self.case.assertEqual(
            straight, self.result["diagnostics"]["positioning"]["straightTrunks"],
            "the reported straight-trunk count disagrees with the geometry")

    # -- optimality --------------------------------------------------------

    def ip_beats_the_heuristic(self):
        info = self.result["diagnostics"]["rank"]
        if not (self.ip_solved and info.get("optimal")):
            return
        self.case.assertLessEqual(
            info["objectiveValue"], info["heuristicObjective"] + 1e-6,
            "the IP scored worse than the heuristic layering it replaces")

    def metrics_agree(self):
        metrics = self.result["metrics"]
        back = sum(1 for e in self.result["edges"] if e["back"])
        horizontal = sum(1 for e in self.result["edges"] if e["horizontal"])
        self.case.assertEqual(metrics["backEdges"], back)
        self.case.assertEqual(metrics["horizontalEdges"], horizontal)
        for key in ("edgeOrthogonality", "nodeOrthogonality", "balance"):
            self.case.assertGreaterEqual(metrics[key], -1e-9, key)
            self.case.assertLessEqual(metrics[key], 1.0 + 1e-9, key)

    def all(self):
        self.every_node_is_placed()
        self.backbone_chains_descend()
        self.boundaries_enclose()
        self.horizontal_edges_are_legal()
        self.chains_are_consecutive()
        self.no_overlap()
        self.x_is_monotone_in_order()
        self.trunks_are_straight()
        self.ip_beats_the_heuristic()
        self.metrics_agree()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestFixtures(unittest.TestCase):
    def check(self, payload, **params):
        merged = dict(FAST)
        merged.update(params)
        result = BL.layout_ocdfg(payload, merged)
        Checker(self, payload, result, BL._resolved_params(merged)).all()
        return result

    def test_single_type_journal_toy(self):
        result = self.check(toy_journal_figure_10())
        self.assertEqual(result["stats"]["objectTypes"], 1)
        self.assertEqual(result["mainObjectType"], "Case")
        # [2] Fig. 10 lays this toy out over ten ranks including Start/End.
        self.assertGreaterEqual(result["metrics"]["ranks"], 8)

    def test_real_procure_to_pay(self):
        result = self.check(procure_to_pay())
        self.assertEqual(result["stats"]["objectTypes"], 7)
        self.assertEqual(result["stats"]["activities"], 10)
        rank = result["diagnostics"]["rank"]
        self.assertTrue(rank["optimal"], "P2P should solve to optimality")
        self.assertEqual(rank["droppedChainConstraints"], [])
        positioning = result["diagnostics"]["positioning"]
        self.assertEqual(positioning["straightTrunks"], positioning["trunks"])
        # Every horizontal edge on this log is a self-loop, and that is the
        # correct outcome rather than a missed opportunity: the log's five
        # mutual pairs all lie on some type's backbone, whose chain orders
        # them, so none of them may share a rank ([1] Eq. 7 wins over [2]
        # Sect. 3.2 where the two disagree).
        horizontal = [e for e in result["edges"] if e["horizontal"]]
        self.assertTrue(horizontal, "the self-loops should be horizontal")
        self.assertEqual([e for e in horizontal if e["src"] != e["dst"]], [])
        graph = BL.build_graph(procure_to_pay())
        BL.determine_backbones(graph, "modal")
        chain, bounds, _, _ = BL._rank_rows(graph, True)
        implied = defaultdict(set)
        for u, v in list(chain) + list(bounds):
            implied[u].add(v)
        for u, v in BL._mutual_pairs(graph):
            if u == v:
                continue
            self.assertTrue(
                BL._reaches(implied, u, v) or BL._reaches(implied, v, u),
                f"{u} and {v} are mutual but nothing orders them, so one of "
                "them should have been placed horizontally")

    def test_real_procure_to_pay_baseline(self):
        self.check(procure_to_pay(), rankMethod="heuristic",
                   componentBalancing="greedy", allowHorizontalEdges=False)

    def test_multi_type(self):
        result = self.check(order_to_cash())
        self.assertEqual(result["stats"]["objectTypes"], 3)
        # Each type gets its own axis, and the axes are consecutive from 0.
        axes = sorted(entry["axis"] for entry in result["axes"])
        self.assertEqual(axes, list(range(len(axes))))
        # "check availability" and "ship" are shared; each is placed once.
        shared = [n for n in result["nodes"]
                  if n["kind"] == "activity" and len(n["objectTypes"]) > 1]
        self.assertTrue(shared, "the fixture should have shared activities")

    def test_empty_payload(self):
        result = BL.layout_ocdfg({"objectTypes": [], "nodes": [], "edges": []})
        self.assertEqual(result["nodes"], [])
        self.assertIn("reason", result["diagnostics"])

    def test_heuristic_and_greedy_baseline(self):
        """The benchmark regime: heuristic ranks, greedy balancing, no
        horizontal edges — [2]'s comparison target, reachable as parameters."""
        result = self.check(order_to_cash(), rankMethod="heuristic",
                            componentBalancing="greedy",
                            allowHorizontalEdges=False)
        self.assertEqual(result["metrics"]["horizontalEdges"],
                         sum(1 for e in result["edges"]
                             if e["src"] == e["dst"]))

    def test_linear_objective(self):
        self.check(order_to_cash(), rankObjective="linear")

    def test_heaviest_backbone(self):
        self.check(order_to_cash(), backbone="heaviest")

    def test_edge_weight_modes(self):
        for mode in ("objectTypes", "frequency", "uniform"):
            with self.subTest(mode=mode):
                self.check(order_to_cash(), rankEdgeWeight=mode)

    def test_requested_main_object_type(self):
        """The chosen type initialises the layout and is merged first.

        It does not necessarily end up on axis 0: [1] Sect. 3.5 step 3 may
        insert a later type to its left, which renumbers every axis.
        """
        result = self.check(order_to_cash(), mainObjectType="Invoice")
        self.assertEqual(result["mainObjectType"], "Invoice")
        self.assertEqual(result["diagnostics"]["merge"]["mergeOrder"][0], "Invoice")

    def test_determinism(self):
        payload = order_to_cash()
        first = BL.layout_ocdfg(payload, dict(FAST))
        second = BL.layout_ocdfg(payload, dict(FAST))
        for result in (first, second):
            result["diagnostics"].pop("secs", None)
            result["diagnostics"]["rank"].pop("secs", None)
        self.assertEqual(json.dumps(first, sort_keys=True),
                         json.dumps(second, sort_keys=True))


class TestPaperClaims(unittest.TestCase):
    """The specific mechanisms the two papers claim, on their own examples."""

    def test_mutual_pair_shares_a_rank(self):
        """[2] Sect. 3.2 / Fig. 5.

        B and E are mutually dependent, so the squared penalty must place them
        on one rank (cost 1 + 1) rather than one above the other (cost 4 + 0).
        Forbidding horizontal edges must then separate them again.
        """
        payload = toy_journal_figure_5()
        allowed = BL.layout_ocdfg(payload, dict(FAST, allowHorizontalEdges=True))
        rank = {n["id"]: n["rank"] for n in allowed["nodes"]}
        self.assertTrue(
            allowed["diagnostics"]["rank"].get("optimal"),
            "this toy example should solve to optimality")
        self.assertEqual(rank["a:B"], rank["a:E"],
                         "a mutually dependent pair should share a rank")
        self.assertGreater(allowed["metrics"]["horizontalEdges"], 0)

        forbidden = BL.layout_ocdfg(payload, dict(FAST, allowHorizontalEdges=False))
        rank = {n["id"]: n["rank"] for n in forbidden["nodes"]}
        self.assertNotEqual(rank["a:B"], rank["a:E"],
                            "with horizontal edges off the pair must separate")

    def test_squared_penalty_differs_from_linear(self):
        """The squared objective is what pulls the pair together; the linear
        objective of [1] Eq. 1 is indifferent between the two placements."""
        payload = toy_journal_figure_5()
        squared = BL.layout_ocdfg(payload, dict(FAST, rankObjective="squared"))
        linear = BL.layout_ocdfg(payload, dict(FAST, rankObjective="linear"))
        rank = {n["id"]: n["rank"] for n in squared["nodes"]}
        self.assertEqual(rank["a:B"], rank["a:E"])
        # The linear model is free to do either; it must still be feasible.
        self.assertTrue(linear["diagnostics"]["rank"].get("optimal"))

    def test_component_balancing_attains_the_optimum(self):
        """[2] Fig. 7 exactly: sizes 11, 5, 4, 3, 3, 2.

        The descending-size heuristic splits them 16/12 (difference 4); an
        optimal split is 14/14 (difference 0). This is the whole argument for
        formulating balancing as an integer program.
        """
        sizes = [11.0, 5.0, 4.0, 3.0, 3.0, 2.0]

        def difference(flags):
            left = sum(size for size, flag in zip(sizes, flags) if flag)
            return abs(left - (sum(sizes) - left))

        self.assertEqual(difference(BL._balance_greedy(sizes)), 4.0)
        optimal = BL._balance_ip(sizes, 10)
        self.assertIsNotNone(optimal, "the balancing IP should solve")
        self.assertEqual(difference(optimal), 0.0)

    def test_backbone_is_the_modal_path(self):
        """The backbone follows the most frequent transition at each step."""
        payload = toy_journal_figure_10()
        graph = BL.build_graph(payload)
        BL.determine_backbones(graph, "modal")
        trunk = [n[2:] for n in graph.backbone["Case"]["nodes"]
                 if n.startswith("a:")]
        self.assertEqual(trunk[:4], ["A", "B", "C", "D"])
        self.assertEqual(trunk[-1], "E")


class TestRandomised(unittest.TestCase):
    """The same invariants over 25 randomised graphs, plus the two regimes."""

    def test_random_graphs(self):
        rng = random.Random(20260910)
        for index in range(25):
            payload = random_ocdfg(rng)
            regime = ({} if index % 3 else
                      {"rankMethod": "heuristic", "componentBalancing": "greedy"})
            if index % 5 == 4:
                regime["allowHorizontalEdges"] = False
            params = dict(FAST)
            params.update(regime)
            with self.subTest(index=index, regime=regime,
                              types=payload["stats"]["objectTypes"],
                              activities=payload["stats"]["activities"]):
                result = BL.layout_ocdfg(payload, params)
                Checker(self, payload, result, BL._resolved_params(params)).all()
                self.assertTrue(all(math.isfinite(n["x"]) and math.isfinite(n["y"])
                                    for n in result["nodes"]))


if __name__ == "__main__":
    unittest.main()
