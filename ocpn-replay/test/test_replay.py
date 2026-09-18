import importlib.util
import pathlib
import unittest


MODULE = pathlib.Path(__file__).resolve().parents[1] / "plugin.py"
SPEC = importlib.util.spec_from_file_location("ocpn_replay", MODULE)
REPLAY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REPLAY)


def model():
    types = ["Item", "Order"]
    places, arcs = [], []
    transitions = [
        {"id": "t:A", "activity": "A", "objectTypes": types},
        {"id": "t:B", "activity": "B", "objectTypes": types},
    ]
    for object_type in types:
        source, middle, after, sink = (
            f"p:{object_type}:src", f"p:{object_type}:middle",
            f"p:{object_type}:after", f"p:{object_type}:sink",
        )
        tau = f"t:silent:{object_type}:0"
        places.extend([
            {"id": source, "objectType": object_type, "kind": "source"},
            {"id": middle, "objectType": object_type, "kind": "normal"},
            {"id": after, "objectType": object_type, "kind": "normal"},
            {"id": sink, "objectType": object_type, "kind": "sink"},
        ])
        transitions.append({"id": tau, "activity": None, "objectTypes": [object_type]})
        for left, right in [(source, "t:A"), ("t:A", middle), (middle, tau), (tau, after), (after, "t:B"), ("t:B", sink)]:
            arcs.append({
                "id": f"a:{object_type}:{len(arcs)}",
                "source": {"kind": "place" if left.startswith("p:") else "transition", "id": left},
                "target": {"kind": "place" if right.startswith("p:") else "transition", "id": right},
                "objectType": object_type, "variable": False,
            })
    return {"objectTypes": types, "places": places, "transitions": transitions, "arcs": arcs}


class Ctx:
    def progress(self, *_args):
        pass

    def log(self, *_args):
        pass


class ReplayTests(unittest.TestCase):
    def test_replays_bindings_through_silent_moves_and_builds_pair_field(self):
        prepared = {
            "sourceId": "log_1", "modelId": "model_1", "model": model(),
            "events": [
                {"event_id": "e1", "activity": "A", "ts_ms": 0},
                {"event_id": "e2", "activity": "B", "ts_ms": 100},
            ],
            "bindings": [
                {"event_id": event, "object_id": object_id, "object_type": object_type}
                for event in ("e1", "e2")
                for object_id, object_type in (("i1", "Item"), ("o1", "Order"))
            ],
        }
        evidence = REPLAY.finalize(prepared, {"binCount": 8, "maxSilentMoves": 4}, Ctx())
        self.assertEqual("log_1", evidence["sourceArtifactId"])
        self.assertEqual("model_1", evidence["modelArtifactId"])
        self.assertTrue(evidence["replay"]["completed"])
        self.assertEqual([1.0, 1.0], [row["support"] for row in evidence["events"]])
        self.assertEqual(2, sum(row["modelMoves"] for row in evidence["events"]))
        self.assertEqual([0, 100], [row["tsMs"] for row in evidence["events"]])
        field = evidence["expectedFields"][0]
        self.assertEqual({"a": "Item", "b": "Order"}, field["pair"])
        self.assertEqual(2.0, sum(field["mass"]))

        # The net travels with the evidence, self-contained for a view.
        self.assertEqual(["Item", "Order"], evidence["net"]["objectTypes"])
        self.assertEqual(8, len(evidence["net"]["places"]))

        # The animation trace: e1 fires A for both objects, e2 crosses the
        # silent transition then fires B for both.
        trace = evidence["trace"]
        self.assertFalse(trace["truncated"])
        self.assertEqual(["Item", "Order"], trace["objectTypes"])
        self.assertEqual(["e1", "e2"], [frame["e"] for frame in trace["frames"]])
        e1_kinds = [step["k"] for step in trace["frames"][0]["steps"]]
        self.assertEqual(["fire", "fire"], e1_kinds)
        e2_kinds = [step["k"] for step in trace["frames"][1]["steps"]]
        self.assertEqual(["silent", "fire", "silent", "fire"], e2_kinds)
        for step in trace["frames"][1]["steps"]:
            self.assertTrue(step["tr"])  # every model step names its transition

    def test_trace_limit_zero_omits_trace_and_truncates(self):
        prepared = {
            "sourceId": "log_1", "modelId": "model_1", "model": model(),
            "events": [
                {"event_id": "e1", "activity": "A", "ts_ms": 0},
                {"event_id": "e2", "activity": "B", "ts_ms": 100},
            ],
            "bindings": [
                {"event_id": event, "object_id": "i1", "object_type": "Item"}
                for event in ("e1", "e2")
            ],
        }
        self.assertIsNone(
            REPLAY.finalize(prepared, {"binCount": 8, "traceLimit": 0}, Ctx())["trace"]
        )
        capped = REPLAY.finalize(prepared, {"binCount": 8, "traceLimit": 500}, Ctx())["trace"]
        # traceLimit 500 > 2 events, so nothing is truncated; frames still land.
        self.assertFalse(capped["truncated"])
        self.assertEqual(2, len(capped["frames"]))

    def test_unknown_activity_is_explicit_log_move(self):
        prepared = {
            "sourceId": "log_1", "modelId": "model_1", "model": model(),
            "events": [{"event_id": "e1", "activity": "Unknown", "ts_ms": 0}],
            "bindings": [{"event_id": "e1", "object_id": "i1", "object_type": "Item"}],
        }
        evidence = REPLAY.finalize(prepared, {"binCount": 8, "maxSilentMoves": 4}, Ctx())
        self.assertEqual(0.0, evidence["events"][0]["support"])
        self.assertEqual(1, evidence["events"][0]["logMoves"])
        self.assertEqual([], evidence["expectedFields"])


if __name__ == "__main__":
    unittest.main()
