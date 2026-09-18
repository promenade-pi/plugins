#!/usr/bin/env python3
"""Offline invariant checks for `ablate.sql` and `plugin.py`.

Run by `package.sh` before anything is packaged, and standalone with
`python3 check.py`. The invariants here are what the evaluation *means* — a
gapped log that quietly emptied an event, or a metric that moves when the input
rows arrive in a different order, produces numbers that look fine and say
nothing — so they gate packaging rather than living in a document.

The SQL is checked by running it, in DuckDB, exactly as the host compiles it:
the same marker-comment program parsed the same way, the same bound parameters.
Type inference on a bound parameter and the `QUALIFY` over a joined window are
the two things most likely to behave differently from how they read, and
neither is visible without executing them.

What is asserted, on hand-built logs *and* on randomised ones:

Ablation (`ablate.sql`)
 1. The gapped log's relations are a subset of the reference's — a simulation
    never invents a link.
 2. No event is emptied, and every event selected for gapping loses at least
    one object: k = max(1, min(n-1, floor(n * d_f))) exactly.
 3. An event with a single object is never selected. Removing its only object
    would leave nothing to reconstruct from.
 4. Removing an object removes every row relating it to that event, including
    a second row under a different qualifier. A half-removed object is still
    visible and is not a gap.
 5. Events, objects and object-object relations pass through untouched.
 6. The same log, fractions and seed give the same gapped log; a different
    seed gives a different one of about the same size.

Learning graph (`plugin.py`, the GraphSAGE arm's hidden stage)
 a. Node indices are unique, sorted and in range, and every edge endpoint
    refers to a node that exists.
 b. No held-out link appears in the training graph. This is the no-leakage
    claim as an assertion rather than as a paragraph in a README.
 c. Indices round-trip: the gaps the kernel sees by number are the same pairs
    the co-occurrence arm sees by identifier.

Reconstruction (`plugin.py`)
 7. Every missing relation is evaluated exactly once, and the rank histogram
    and per-object-type breakdown each sum back to that count.
 8. Hits@1 <= Hits@5 <= Hits@10 <= 1, and Hits@1 <= MRR <= 1.
 9. The "all" candidate pool leaves nothing unranked and cannot score worse
    than "co-occurring" — it only adds ranks where the other had none.
10. Shuffling the order the relation rows arrive in changes no metric. This is
    the one that caught a real defect: summing log-probabilities over a Python
    set made the scores depend on the interpreter's string hash seed, and
    Hits@1 moved in the third decimal between runs of the same data.
11. On a log whose objects co-occur in fixed disjoint groups, the only
    candidate for any gap is the right one, so Hits@1 is exactly 1.0. This is
    the end-to-end correctness claim: not "the metric is self-consistent" but
    "the model recovers a link it has enough evidence to recover".
12. A gapped log paired with a log it was not derived from is reported as not
    a derived pair, instead of scoring their unrelated difference.
"""

import asyncio
import importlib.util
import math
import random
import re
import sys
from pathlib import Path

try:
    import duckdb
    import pandas  # noqa: F401  (plugin.py imports it; fail here, not there)
except ImportError:  # pragma: no cover
    sys.exit(
        "check.py needs duckdb and pandas:\n"
        "    python3 -m pip install duckdb pandas\n"
        "They are test-only — the plugin itself declares pandas through its "
        "manifest and gets it from Pyodide."
    )

HERE = Path(__file__).resolve().parent

LOGICAL_TO_PHYSICAL = {
    "events": "event", "objects": "object", "event_object": "e2o",
    "object_object": "o2o", "event_attributes": "event_attr",
    "object_attributes": "object_attr",
}

failures = []


def check(label, condition, detail=""):
    if not condition:
        failures.append(label + ((" — " + detail) if detail else ""))
    print(("  ok   " if condition else "  FAIL ") + label + ((" — " + detail) if detail else ""))


# --------------------------------------------------------------------------
# A minimal stand-in for the host's relational layer.
# --------------------------------------------------------------------------

def parse_program(source):
    """The same line-based marker scan as `host/relational/sqlProfile.ts`."""
    statements, current = [], None
    for line in source.splitlines():
        marker = re.match(r"^--\s*@(relation|output)\s+([A-Za-z_][A-Za-z0-9_]*)\s*$", line.strip())
        if marker:
            if current:
                statements.append(current)
            current = {"kind": marker.group(1), "name": marker.group(2), "lines": []}
            continue
        if current is not None:
            current["lines"].append(line)
    if current:
        statements.append(current)
    for statement in statements:
        statement["sql"] = "\n".join(statement["lines"]).strip()
    return statements


def run_ablation(con, prefix_table, params):
    """Compiles and runs `ablate.sql`, returning one DataFrame per output."""
    statements = parse_program((HERE / "ablate.sql").read_text())

    def bind(sql):
        for logical, physical in LOGICAL_TO_PHYSICAL.items():
            sql = sql.replace("{log." + logical + "}", f"{prefix_table}_{physical}")
        return re.sub(r":([A-Za-z_][A-Za-z0-9_]*)", r"$\1", sql)

    # A statement's text runs to the next marker, so it can end with the
    # comment introducing the following one; the closing paren and separating
    # comma therefore each need a line of their own.
    ctes = [s for s in statements if s["kind"] == "relation"]
    prefix = ""
    if ctes:
        prefix = "WITH " + ",\n".join(f'{c["name"]} AS (\n{bind(c["sql"])}\n)' for c in ctes) + "\n"

    return {
        s["name"]: con.execute(prefix + bind(s["sql"]) + "\n", params).df()
        for s in statements if s["kind"] == "output"
    }


class Ctx:
    """The two things `plugin.py` uses from its host context."""

    def __init__(self, con, roles):
        self.tables = {
            f"{role}__{logical}": f"{table}_{logical}"
            for role, table in roles.items()
            for logical in ("event", "object", "e2o", "o2o")
        }
        self._con = con
        self.params = {}

    async def sql(self, query):
        return self._con.execute(query.format(**self.tables)).df()

    def progress(self, *args, **kwargs):
        pass

    def log(self, message):
        print("   log:", message)


def load_plugin():
    spec = importlib.util.spec_from_file_location("relation_gap_plugin", HERE / "plugin.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --------------------------------------------------------------------------
# Log generators.
# --------------------------------------------------------------------------

def create_log(con, name, events, objects, e2o, o2o=()):
    con.execute(f"CREATE OR REPLACE TABLE {name}_event (event_id VARCHAR, activity VARCHAR, ts TIMESTAMP)")
    con.execute(f"CREATE OR REPLACE TABLE {name}_object (object_id VARCHAR, object_type VARCHAR)")
    con.execute(f"CREATE OR REPLACE TABLE {name}_e2o (event_id VARCHAR, object_id VARCHAR, qualifier VARCHAR)")
    con.execute(f"CREATE OR REPLACE TABLE {name}_o2o (source_id VARCHAR, target_id VARCHAR, qualifier VARCHAR)")
    con.execute(f"CREATE OR REPLACE TABLE {name}_event_attr (event_id VARCHAR, name VARCHAR, value VARCHAR)")
    con.execute(f"CREATE OR REPLACE TABLE {name}_object_attr (object_id VARCHAR, name VARCHAR, value VARCHAR, ts TIMESTAMP)")
    con.executemany(f"INSERT INTO {name}_event VALUES (?,?,?)", events)
    con.executemany(f"INSERT INTO {name}_object VALUES (?,?)", objects)
    con.executemany(f"INSERT INTO {name}_e2o VALUES (?,?,?)", e2o)
    if o2o:
        con.executemany(f"INSERT INTO {name}_o2o VALUES (?,?,?)", o2o)


def random_log(rng):
    """A log with the shapes that matter: singletons, duplicate qualifiers, orphans."""
    types = [f"type{i}" for i in range(rng.randint(2, 5))]
    objects, by_type = [], {t: [] for t in types}
    for t in types:
        for i in range(rng.randint(4, 30)):
            oid = f"{t}:{i}"
            objects.append((oid, t))
            by_type[t].append(oid)
    # Orphans: objects no event ever relates to.
    for i in range(rng.randint(0, 5)):
        objects.append((f"orphan:{i}", types[0]))

    events, e2o = [], []
    for e in range(rng.randint(20, 200)):
        eid = f"e{e}"
        events.append((eid, f"act{rng.randint(0, 4)}", None))
        size = rng.choice([1, 1, 2, 2, 2, 3, 4, 5, 8])
        chosen = set()
        for _ in range(size):
            chosen.add(rng.choice(by_type[rng.choice(types)]))
        for oid in sorted(chosen):
            e2o.append((eid, oid, "primary"))
            # A second row for the same pair, under another qualifier.
            if rng.random() < 0.15:
                e2o.append((eid, oid, "secondary"))
    o2o = [
        (rng.choice(objects)[0], rng.choice(objects)[0], "rel")
        for _ in range(rng.randint(0, 40))
    ]
    return events, objects, e2o, o2o


def grouped_log(groups=40, per_group=4, repeats=3):
    """Objects co-occur in fixed disjoint groups and nowhere else.

    Every event is one whole group, so the only object ever seen beside a
    group's members is another member: a gap has exactly one candidate.
    """
    events, objects, e2o = [], [], []
    for g in range(groups):
        members = [f"g{g}:o{i}" for i in range(per_group)]
        objects.extend((m, f"type{g % 3}") for m in members)
        for r in range(repeats):
            eid = f"g{g}e{r}"
            events.append((eid, "act", None))
            e2o.extend((eid, m, "primary") for m in members)
    return events, objects, e2o, []


# --------------------------------------------------------------------------
# The checks.
# --------------------------------------------------------------------------

def distinct_pairs(frame):
    return set(zip(frame["event_id"], frame["object_id"]))


def ablation_checks(con, label, events, objects, e2o, o2o, params):
    params = {"protocol": "dropFraction", **params}
    create_log(con, "src", events, objects, e2o, o2o)
    out = run_ablation(con, "src", params)

    truth_rows = {(a, b, c) for a, b, c in e2o}
    gapped_rows = set(out["event_object"].itertuples(index=False, name=None))
    truth = distinct_pairs(con.execute(
        "SELECT DISTINCT event_id, object_id FROM src_e2o").df())
    gapped = distinct_pairs(out["event_object"])

    sizes, kept = {}, {}
    for event_id, _ in truth:
        sizes[event_id] = sizes.get(event_id, 0) + 1
    for event_id, _ in gapped:
        kept[event_id] = kept.get(event_id, 0) + 1
    touched = {e for e in sizes if kept.get(e, 0) < sizes[e]}

    drop = params["dropFraction"]
    expected_k = {e: max(1, min(sizes[e] - 1, math.floor(sizes[e] * drop))) for e in touched}

    check(f"[{label}] gapped relations are a subset of the reference",
          gapped_rows <= truth_rows)
    check(f"[{label}] no event is emptied",
          all(kept.get(e, 0) >= 1 for e in sizes),
          f"{sum(1 for e in sizes if kept.get(e, 0) < 1)} emptied")
    check(f"[{label}] single-object events are never gapped",
          not any(sizes[e] == 1 for e in touched))
    check(f"[{label}] dropped count is max(1, min(n-1, floor(n*d)))",
          all(sizes[e] - kept[e] == expected_k[e] for e in touched),
          f"{sum(1 for e in touched if sizes[e] - kept[e] != expected_k[e])} disagree")
    # Every row of a dropped pair is gone, not just the first qualifier.
    dropped_pairs = truth - gapped
    check(f"[{label}] a dropped object leaves no row behind",
          not any((e, o) in dropped_pairs for e, o, _ in gapped_rows))
    check(f"[{label}] events, objects and o2o pass through unchanged",
          len(out["events"]) == len(events)
          and len(out["objects"]) == len(objects)
          and len(out["object_object"]) == len(o2o))
    check(f"[{label}] the same seed reproduces the same log",
          distinct_pairs(run_ablation(con, "src", params)["event_object"]) == gapped)
    if touched:
        other = run_ablation(con, "src", {**params, "seed": params["seed"] + 1})
        other_pairs = distinct_pairs(other["event_object"])
        check(f"[{label}] a different seed selects differently",
              other_pairs != gapped)
    return out


def reconstruction_checks(con, label, module, gapped_frame, expect_perfect=False):
    con.execute("CREATE OR REPLACE TABLE gap_e2o (event_id VARCHAR, object_id VARCHAR, qualifier VARCHAR)")
    con.executemany("INSERT INTO gap_e2o VALUES (?,?,?)",
                    list(gapped_frame.itertuples(index=False, name=None)))
    con.execute("CREATE OR REPLACE VIEW gap_event AS SELECT * FROM src_event")
    con.execute("CREATE OR REPLACE VIEW gap_object AS SELECT * FROM src_object")
    # The simulator never touches object-object relations, so the gapped log's
    # `related` channel is the reference's. Binding it here is what makes the
    # graph stage's o2o path actually run instead of taking its empty fallback.
    con.execute("CREATE OR REPLACE VIEW gap_o2o AS SELECT * FROM src_o2o")

    ctx = Ctx(con, {"partial": "gap", "truth": "src"})
    prepared = asyncio.run(module.prepare(ctx))
    settings = {"topK": 10, "candidatePool": "cooccurring", "fitOn": "trainEvents",
                "maxExamples": 12}
    result = module.finalize(prepared, settings, ctx)
    wide = module.finalize(prepared, {**settings, "candidatePool": "all"}, ctx)

    metrics, meta = result["metrics"], result["meta"]
    hits = metrics["hitsAt"]
    check(f"[{label}] every missing relation is evaluated once",
          metrics["evaluated"] == meta["missingRelations"],
          f'{metrics["evaluated"]} vs {meta["missingRelations"]}')
    check(f"[{label}] Hits@1 <= Hits@5 <= Hits@10 <= 1",
          hits["1"] <= hits["5"] <= hits["10"] <= 1.0)
    check(f"[{label}] Hits@1 <= MRR <= 1", hits["1"] <= metrics["mrr"] <= 1.0)
    check(f"[{label}] the rank histogram sums to the evaluated count",
          sum(b["n"] for b in result["rankDistribution"]) == metrics["evaluated"])
    check(f"[{label}] the per-type breakdown sums to the evaluated count",
          sum(r["evaluated"] for r in result["byObjectType"]) == metrics["evaluated"])
    check(f"[{label}] the walkthrough respects its limit",
          len(result["examples"]) <= 12)
    check(f"[{label}] each example's verdict matches its own top prediction",
          all(ex["correct"] == bool(ex["predictions"] and ex["predictions"][0]["correct"])
              for ex in result["examples"]))
    check(f"[{label}] the wide pool leaves nothing unranked",
          next(b["n"] for b in wide["rankDistribution"] if b["bucket"] == "unranked") == 0)
    check(f"[{label}] the wide pool never scores worse",
          wide["metrics"]["mrr"] >= metrics["mrr"] - 1e-12)
    check(f"[{label}] the two logs are recognised as a derived pair",
          result["pairing"]["derivedPair"])

    # Row order must not reach the numbers.
    rows = list(gapped_frame.itertuples(index=False, name=None))
    random.Random(99).shuffle(rows)
    con.execute("CREATE OR REPLACE TABLE gap_e2o (event_id VARCHAR, object_id VARCHAR, qualifier VARCHAR)")
    con.executemany("INSERT INTO gap_e2o VALUES (?,?,?)", rows)
    shuffled = module.finalize(asyncio.run(module.prepare(ctx)), settings, ctx)
    check(f"[{label}] shuffling the input rows changes no metric",
          shuffled["metrics"] == metrics)

    if expect_perfect:
        # Fitting on the whole gapped log, every group is in the statistics and
        # the determined answer is always first.
        whole = module.finalize(prepared, {**settings, "fitOn": "allObserved"}, ctx)
        check(f"[{label}] fitted on everything, a determined answer is always first",
              whole["metrics"]["hitsAt"]["1"] == 1.0 and whole["metrics"]["mrr"] == 1.0,
              f'Hits@1={whole["metrics"]["hitsAt"]["1"]:.4f}')

        # Fitting on the training partition alone, a gap is recoverable exactly
        # when its answer co-occurs with something the event still shows, in an
        # event the model was allowed to fit. Anything else is not a model
        # failure — the evidence is not there. The share is computed from the
        # data rather than assumed, so this asserts the fitting rule does what
        # it says rather than that the number happens to be high.
        reachable = expected_reachable_share(prepared)
        check(f"[{label}] fitted on the training split, every reachable gap is found",
              abs(hits["1"] - reachable) < 1e-9,
              f'Hits@1={hits["1"]:.4f} reachable={reachable:.4f}')
        check(f"[{label}] the training split really does cost something here",
              reachable < 1.0, f"reachable={reachable:.4f}")
    return result


def expected_reachable_share(prepared):
    """Share of gaps whose answer the fitted statistics could possibly rank.

    A candidate is reachable when it co-occurred with one of the event's
    surviving objects inside an event the model was allowed to fit — which is
    the definition of the co-occurrence model's candidate set, applied to the
    training partition.
    """
    observed, gaps = prepared["observed"], prepared["gaps"]
    by_event = {}
    for event_id, object_id in zip(observed["event_id"], observed["object_id"]):
        by_event.setdefault(event_id, set()).add(object_id)
    gapped = set(gaps["event_id"])
    neighbours = {}
    for event_id, members in by_event.items():
        if event_id in gapped:
            continue
        for a in members:
            neighbours.setdefault(a, set()).update(m for m in members if m != a)
    total = hit = 0
    for event_id, object_id in zip(gaps["event_id"], gaps["object_id"]):
        total += 1
        context = by_event.get(event_id, set())
        if any(object_id in neighbours.get(o, ()) for o in context):
            hit += 1
    return hit / total if total else 0.0


def graph_stage_checks(con, label, module):
    """The graph the wasm kernel is handed must describe the same two logs.

    Everything downstream is integer indices, so an off-by-one in the node
    numbering does not fail — it trains happily on a graph that is not the log,
    and reports a plausible number for it. These are the claims that make the
    indices mean what the kernel assumes.
    """
    ctx = Ctx(con, {"partial": "gap", "truth": "src"})
    prepared = asyncio.run(module.prepare_graph(ctx))
    g = module.finalize_graph(prepared, {}, ctx)

    n_obj, n_evt = len(g["objectIds"]), len(g["eventIds"])
    check(f"[{label}] node ids are unique and sorted",
          g["objectIds"] == sorted(set(g["objectIds"]))
          and g["eventIds"] == sorted(set(g["eventIds"])))
    check(f"[{label}] every node carries a type", len(g["objectTypes"]) == n_obj
          and len(g["eventActivities"]) == n_evt)
    check(f"[{label}] every type index is in range",
          all(0 <= t < len(g["objectTypeNames"]) for t in g["objectTypes"])
          and all(0 <= a < len(g["activityNames"]) for a in g["eventActivities"]))
    check(f"[{label}] every edge endpoint is in range",
          all(0 <= e < n_evt for e in g["e2oSrc"]) and all(0 <= o < n_obj for o in g["e2oDst"])
          and all(0 <= o < n_obj for o in g["o2oSrc"] + g["o2oDst"])
          and all(0 <= e < n_evt for e in g["gapEvent"])
          and all(0 <= o < n_obj for o in g["gapObject"]))
    check(f"[{label}] edge lists are paired",
          len(g["e2oSrc"]) == len(g["e2oDst"])
          and len(g["o2oSrc"]) == len(g["o2oDst"])
          and len(g["gapEvent"]) == len(g["gapObject"]))

    observed = set(zip(g["e2oSrc"], g["e2oDst"]))
    held = set(zip(g["gapEvent"], g["gapObject"]))
    # The whole no-leakage argument in one assertion: a link the network is
    # asked to recover must not also be a link it can see.
    check(f"[{label}] no held-out link is present in the training graph",
          not (observed & held), f"{len(observed & held)} leaked")
    check(f"[{label}] the observed edges are exactly the gapped log's",
          len(observed) == len(distinct_pairs(con.execute(
              "SELECT DISTINCT event_id, object_id FROM gap_e2o").df())))
    check(f"[{label}] no self-relation survives into the related channel",
          not any(a == b for a, b in zip(g["o2oSrc"], g["o2oDst"])))
    check(f"[{label}] the pairing verdict is present and true",
          g["pairing"].get("derivedPair") is True,
          f'derivedPair={g["pairing"].get("derivedPair")!r}')

    # Index round-trip: a gap named by index must be the same pair the
    # co-occurrence arm found by identifier.
    by_id = {(g["eventIds"][e], g["objectIds"][o]) for e, o in held}
    truth_gaps = set(zip(prepared["gaps"]["event_id"].astype(str),
                         prepared["gaps"]["object_id"].astype(str)))
    check(f"[{label}] indices round-trip to the same gaps the identifiers name",
          by_id == truth_gaps, f"{len(by_id ^ truth_gaps)} differ")


def pairing_check(con, module):
    con.execute("INSERT INTO gap_e2o VALUES ('e0', 'invented:object', 'nonsense')")
    ctx = Ctx(con, {"partial": "gap", "truth": "src"})
    pairing = module.finalize(
        asyncio.run(module.prepare(ctx)),
        {"topK": 10, "candidatePool": "cooccurring", "maxExamples": 0},
        ctx,
    )["pairing"]
    check("[pairing] a relation the reference lacks is counted",
          pairing["relationsOnlyInPartial"] >= 1)
    check("[pairing] such a pair is not called derived", pairing["derivedPair"] is False)


def main():
    con = duckdb.connect()
    module = load_plugin()

    print("grouped log — one possible answer per gap")
    events, objects, e2o, o2o = grouped_log()
    out = ablation_checks(con, "grouped", events, objects, e2o, o2o,
                          {"testFraction": 0.5, "dropFraction": 0.3, "seed": 42})
    reconstruction_checks(con, "grouped", module, out["event_object"], expect_perfect=True)
    graph_stage_checks(con, "grouped", module)
    pairing_check(con, module)

    print("\nsingle-target protocol")
    events, objects, e2o, o2o = random_log(random.Random(5))
    create_log(con, "src", events, objects, e2o, o2o)
    out = run_ablation(con, "src", {"protocol": "singleTarget", "testFraction": 0.4,
                                    "dropFraction": 0.9, "seed": 3})
    truth = distinct_pairs(con.execute("SELECT DISTINCT event_id, object_id FROM src_e2o").df())
    gapped = distinct_pairs(out["event_object"])
    per_event = {}
    for e, _ in truth - gapped:
        per_event[e] = per_event.get(e, 0) + 1
    check("[single-target] exactly one object is hidden per gapped event",
          per_event and all(n == 1 for n in per_event.values()),
          f"{sum(1 for n in per_event.values() if n != 1)} events lost more than one")
    check("[single-target] the drop rate is ignored",
          len(truth - gapped) == len(per_event))

    print("\nparameter extremes")
    events, objects, e2o, o2o = random_log(random.Random(1))
    for test_fraction, drop_fraction in ((0.9, 0.9), (0.01, 0.01), (0.5, 0.9), (0.5, 0.01)):
        ablation_checks(con, f"t={test_fraction},d={drop_fraction}", events, objects, e2o, o2o,
                        {"testFraction": test_fraction, "dropFraction": drop_fraction, "seed": 7})

    print("\nrandomised logs")
    for trial in range(12):
        rng = random.Random(1000 + trial)
        events, objects, e2o, o2o = random_log(rng)
        params = {
            "testFraction": round(rng.uniform(0.05, 0.85), 3),
            "dropFraction": round(rng.uniform(0.05, 0.85), 3),
            "seed": rng.randint(0, 999999),
        }
        out = ablation_checks(con, f"rnd{trial}", events, objects, e2o, o2o, params)
        reconstruction_checks(con, f"rnd{trial}", module, out["event_object"])
        graph_stage_checks(con, f"rnd{trial}", module)

    print()
    if failures:
        print(f"{len(failures)} check(s) failed:")
        for f in failures:
            print("  - " + f)
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
