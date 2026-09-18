#!/usr/bin/env python3
"""Generates differential test cases as NDJSON.

Three sources, because they find different things:

  handwritten   one case per construct and per boundary condition. These are
                the cases a human can read, and the ones a regression should
                fail on first.
  random logs   small arbitrary logs over a tiny alphabet. Most are nonsense
                processes, which is the point: nonsense is what drives the
                recursion into fall-throughs, and the fall-throughs are where
                the undocumented behaviour lives.
  from trees    random sound process trees, simulated into logs, then
                rediscovered. These exercise deep nesting that random logs
                essentially never produce.

  tools/gencases.py --seed 1 --random 4000 --trees 4000 > cases.ndjson
"""
import argparse
import json
import random
import sys

ALPHABET = "abcdefghijklmnop"

# Two shapes of generated case. `small` finds fall-through behaviour, because
# tiny nonsense logs are what drive the recursion past every cut detector.
# `wide` finds the things small logs never reach: deep recursion, large
# alphabets, long traces, many variants.
PROFILES = {
    "small": dict(acts=5, traces=8, length=6, tree_acts=(2, 6), tree_depth=3,
                  tree_traces=(3, 20)),
    "wide": dict(acts=12, traces=40, length=25, tree_acts=(6, 16), tree_depth=5,
                 tree_traces=(10, 60)),
}


def case(cid, traces, variant="IMf", noise=0.0):
    return {"id": cid, "traces": traces, "variant": variant, "noiseThreshold": noise}


# ------------------------------------------------------------ handwritten

def handwritten():
    cases = []

    def add(name, traces):
        # Every hand-written log is run through both variants and across the
        # whole threshold range, since the threshold's boundaries are exactly
        # what the IMf reading has to get right.
        cases.append(case(f"hw.{name}.IM", traces, "IM", 0.0))
        for noise in (0.0, 0.01, 0.2, 0.5, 0.99, 1.0):
            cases.append(case(f"hw.{name}.IMf.{noise}", traces, "IMf", noise))

    # base cases
    add("empty-log", [])
    add("one-empty-trace", [[]])
    add("all-empty", [[], [], []])
    add("single-activity", [["a"]])
    add("single-activity-many", [["a"]] * 5)
    add("single-repeated", [["a", "a"]])
    add("single-repeated-long", [["a", "a", "a", "a", "a"]])
    add("single-mixed-lengths", [["a"], ["a", "a"], ["a", "a", "a"]])
    add("empty-and-nonempty", [[], ["a"]])
    add("empty-and-nonempty-skewed", [[]] + [["a", "b"]] * 9)
    add("mostly-empty", [[]] * 9 + [["a", "b"]])

    # sequence
    add("seq2", [["a", "b"]])
    add("seq3", [["a", "b", "c"]] * 3)
    add("seq-optional-middle", [["a", "b", "c"], ["a", "c"]])
    # the case the sequence pivot-merge exists for
    add("seq-pivot", [["a", "b", "c"], ["c"]])
    add("seq-long", [list("abcdefg")])

    # xor
    add("xor2", [["a"], ["b"]])
    add("xor3", [["a"], ["b"], ["c"]])
    add("xor-branches", [["a", "b"], ["c", "d"]])
    add("xor-skewed", [["a"]] * 20 + [["b"]])

    # parallel
    add("par2", [["a", "b"], ["b", "a"]])
    add("par3", [list(p) for p in ("abc", "acb", "bac", "bca", "cab", "cba")])
    add("par-partial", [["a", "b"], ["b", "a"], ["a", "b"]])
    add("par-nested", [["a", "b", "c"], ["a", "c", "b"]])

    # loops
    add("loop-simple", [["a"], ["a", "b", "a"]])
    add("loop-twice", [["a"], ["a", "b", "a"], ["a", "b", "a", "b", "a"]])
    add("loop-body-seq", [["a", "b"], ["a", "b", "c", "a", "b"]])
    add("loop-two-redos", [["a"], ["a", "b", "a"], ["a", "c", "a"]])
    add("loop-redo-seq", [["a"], ["a", "b", "c", "a"]])
    # a loop whose directly-follows graph looks exactly like concurrency —
    # this is what the minimum-self-distance detector exists to separate
    add("loop-vs-parallel", [["a", "b", "a"], ["b", "a", "b"]])
    add("self-loop-in-seq", [["a", "b", "b", "c"], ["a", "b", "c"]])

    # nesting
    add("nested-xor-in-seq", [["a", "b", "e"], ["a", "c", "e"]])
    add("nested-par-in-xor", [["a", "b"], ["b", "a"], ["c"]])
    add("nested-deep", [["a", "b", "e"], ["a", "c", "d", "e"], ["a", "d", "c", "e"]])
    add("nested-loop-in-seq", [["s", "a", "e"], ["s", "a", "b", "a", "e"]])

    # fall-throughs
    add("flower-ish", [list(p) for p in ("abc", "cba", "bac", "acb", "bca")])
    add("once-per-trace", [["x", "a", "b"], ["a", "x", "b"], ["a", "b", "x"]])
    add("tau-loop", [["a", "b"], ["a", "b", "a", "b"]])
    add("tau-loop-strict", [["a", "b", "a", "b"], ["a", "b"]])
    add("duplicate-heavy", [["a", "b", "a", "c", "a"], ["a", "c", "a", "b", "a"]])

    # noise-specific shapes: one rare deviation among many identical traces
    add("rare-reversal", [["a", "b"]] * 19 + [["b", "a"]])
    add("rare-extra", [["a", "b", "c"]] * 19 + [["a", "x", "b", "c"]])
    add("rare-skip", [["a", "b", "c"]] * 19 + [["a", "c"]])
    add("rare-empty", [["a", "b"]] * 19 + [[]])
    add("rare-start", [["a", "b", "c"]] * 19 + [["b", "c"]])
    add("rare-end", [["a", "b", "c"]] * 19 + [["a", "b"]])
    add("two-rare", [["a", "b", "c"]] * 18 + [["b", "a", "c"], ["a", "c", "b"]])

    # ordering / duplicates / short traces
    add("all-lengths", [[], ["a"], ["a", "b"], ["a", "b", "c"]])
    add("repeats-in-trace", [["a", "a", "b", "b"], ["a", "b"]])
    add("interleaved-repeat", [["a", "b", "a", "b", "a"]])
    add("wide-alphabet", [list(ALPHABET)])
    add("wide-shuffled", [list(ALPHABET), list(reversed(ALPHABET))])

    return cases


# ----------------------------------------------------------- random logs

def random_log(rng, max_acts, max_traces, max_len):
    acts = ALPHABET[: rng.randint(1, max_acts)]
    n = rng.randint(1, max_traces)
    return [
        [rng.choice(acts) for _ in range(rng.randint(0, max_len))]
        for _ in range(n)
    ]


def random_logs(rng, count, prof):
    cases = []
    for i in range(count):
        traces = random_log(rng, prof["acts"], prof["traces"], prof["length"])
        variant, noise = rng.choice(
            [("IM", 0.0), ("IMf", 0.0), ("IMf", 0.2), ("IMf", 0.5), ("IMf", 1.0)]
        )
        cases.append(case(f"rnd.{i}", traces, variant, noise))
    return cases


# ---------------------------------------------------- random sound trees

def random_tree(rng, acts, max_depth=3, depth=0):
    """A sound process tree over a partition of `acts`."""
    if len(acts) == 1 or depth >= max_depth or (depth > 0 and rng.random() < 0.25):
        return ("act", acts[0]) if acts else ("tau",)

    op = rng.choice(["seq", "xor", "and", "loop"])
    split = 2 if op == "loop" else rng.randint(2, min(3, len(acts)))
    split = min(split, len(acts))
    if split < 2:
        return ("act", acts[0])

    rng.shuffle(acts)
    cuts = sorted(rng.sample(range(1, len(acts)), split - 1))
    parts, prev = [], 0
    for c in cuts + [len(acts)]:
        parts.append(acts[prev:c])
        prev = c
    return (op, [random_tree(rng, p, max_depth, depth + 1) for p in parts])


def simulate(rng, tree, max_loop=2):
    """One trace from one traversal of the tree."""
    kind = tree[0]
    if kind == "tau":
        return []
    if kind == "act":
        return [tree[1]]
    children = tree[1]
    if kind == "seq":
        return [e for c in children for e in simulate(rng, c, max_loop)]
    if kind == "xor":
        return simulate(rng, rng.choice(children), max_loop)
    if kind == "and":
        # Any interleaving is valid; a random one keeps the log honest about
        # concurrency rather than always producing the same order.
        streams = [simulate(rng, c, max_loop) for c in children]
        out = []
        while any(streams):
            nonempty = [s for s in streams if s]
            out.append(rng.choice(nonempty).pop(0))
        return out
    if kind == "loop":
        body, redo = children[0], children[1]
        out = simulate(rng, body, max_loop)
        for _ in range(rng.randint(0, max_loop)):
            out += simulate(rng, redo, max_loop)
            out += simulate(rng, body, max_loop)
        return out
    raise ValueError(kind)


def tree_logs(rng, count, prof):
    cases = []
    lo, hi = prof["tree_acts"]
    tlo, thi = prof["tree_traces"]
    for i in range(count):
        n = rng.randint(lo, min(hi, len(ALPHABET)))
        tree = random_tree(rng, list(ALPHABET[:n]), prof["tree_depth"])
        traces = [simulate(rng, tree) for _ in range(rng.randint(tlo, thi))]
        variant, noise = rng.choice([("IM", 0.0), ("IMf", 0.0), ("IMf", 0.2)])
        cases.append(case(f"tree.{i}", traces, variant, noise))
    return cases


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--random", type=int, default=0)
    ap.add_argument("--trees", type=int, default=0)
    ap.add_argument("--no-handwritten", action="store_true")
    ap.add_argument("--profile", choices=sorted(PROFILES), default="small")
    args = ap.parse_args()

    prof = PROFILES[args.profile]
    rng = random.Random(args.seed)
    cases = []
    if not args.no_handwritten:
        cases += handwritten()
    cases += random_logs(rng, args.random, prof)
    cases += tree_logs(rng, args.trees, prof)

    # Ids must stay unique across seeds: the comparison is keyed by id, so a
    # collision silently drops cases instead of failing.
    for c in cases:
        c["id"] = f"{args.profile}.s{args.seed}.{c['id']}"
        print(json.dumps(c))
    print(f"{len(cases)} cases, seed {args.seed}", file=sys.stderr)


if __name__ == "__main__":
    main()
