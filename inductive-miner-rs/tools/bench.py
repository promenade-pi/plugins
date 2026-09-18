#!/usr/bin/env python3
"""Benchmarks the miner on shapes that stress different parts of it.

Correctness first: this is only worth reading once the differential suite is
clean. What it is looking for is pathological behaviour — a shape where the
recursion or a cut detector blows up — not a win over ProM.

  tools/bench.py [--prom] [--wasm]
"""
import argparse
import json
import os
import random
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ORACLE = os.environ.get("ORACLE_DIR", os.path.expanduser("~/.cache/promenade-im-oracle"))


def seq_tree_log(rng, n_traces, acts):
    """Many traces, very few variants — the common real-log shape."""
    base = list(acts)
    out = []
    for _ in range(n_traces):
        t = list(base)
        if rng.random() < 0.3:
            t = t[:-1]          # a skipped last step
        if rng.random() < 0.2:
            t = t + [base[-1]]  # a repeat
        out.append(t)
    return out


def many_variants(rng, n_traces, acts):
    return [
        [rng.choice(acts) for _ in range(rng.randint(3, 12))]
        for _ in range(n_traces)
    ]


def wide_alphabet(rng, n_traces, n_acts):
    acts = [f"a{i}" for i in range(n_acts)]
    out = []
    for _ in range(n_traces):
        k = rng.randint(5, 20)
        start = rng.randint(0, n_acts - k)
        out.append(acts[start:start + k])
    return out


def deep_sequence(n_traces, depth):
    """Forces the recursion `depth` levels down: each cut peels one activity."""
    acts = [f"a{i}" for i in range(depth)]
    return [list(acts) for _ in range(n_traces)]


def noisy(rng, n_traces, acts, rate):
    out = []
    for _ in range(n_traces):
        t = list(acts)
        if rng.random() < rate:
            i, j = rng.randrange(len(t)), rng.randrange(len(t))
            t[i], t[j] = t[j], t[i]
        out.append(t)
    return out


def build_cases(rng):
    A8 = list("abcdefgh")
    return [
        ("many traces, few variants", seq_tree_log(rng, 200_000, A8), "IMf", 0.2),
        ("many variants", many_variants(rng, 20_000, A8), "IMf", 0.2),
        ("many activities (200)", wide_alphabet(rng, 20_000, 200), "IMf", 0.2),
        ("deep recursion (60)", deep_sequence(5_000, 60), "IM", 0.0),
        ("noisy (5%)", noisy(rng, 50_000, A8, 0.05), "IMf", 0.2),
        ("noisy (5%), IM", noisy(rng, 50_000, A8, 0.05), "IM", 0.0),
    ]


def run(cmd, stdin_path, repeats=1):
    with open(stdin_path) as f:
        data = f.read()
    payload = data * repeats
    t0 = time.perf_counter()
    p = subprocess.run(cmd, input=payload, capture_output=True, text=True)
    dt = (time.perf_counter() - t0) / repeats
    return dt, p.stdout.strip().split("\n")[0] if p.stdout else p.stderr[-200:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prom", action="store_true", help="also time the ProM reference")
    args = ap.parse_args()

    rng = random.Random(42)
    subprocess.run(["cargo", "build", "--release", "-p", "inductive-miner-cli"],
                   cwd=ROOT, capture_output=True)
    rust = os.path.join(ROOT, "target/release/im")

    prom_cmd = None
    if args.prom:
        with open(os.path.join(ORACLE, "cp.txt")) as f:
            cp = f.read().strip()
        prom_cmd = ["java", "-Xmx6g", "-cp", f"{ORACLE}/classes:{cp}", "OracleMain"]

    header = f"{'shape':<28}{'traces':>9}{'events':>10}{'variants':>10}{'rust':>10}"
    if prom_cmd:
        header += f"{'ProM':>10}"
    print(header)
    print("-" * len(header))

    for name, traces, variant, noise in build_cases(rng):
        case = {"id": "b", "traces": traces, "variant": variant,
                "noiseThreshold": noise}
        path = f"/tmp/bench-{abs(hash(name))}.ndjson"
        with open(path, "w") as f:
            f.write(json.dumps(case) + "\n")

        events = sum(len(t) for t in traces)
        variants = len({tuple(t) for t in traces})

        # The JVM needs a couple of runs before its numbers mean anything; the
        # Rust binary does not, but is measured the same way for fairness.
        run([rust], path)
        rt, _ = run([rust], path, repeats=3)

        row = (f"{name:<28}{len(traces):>9,}{events:>10,}{variants:>10,}"
               f"{rt * 1000:>9.0f}ms")
        if prom_cmd:
            run(prom_cmd, path)
            pt, _ = run(prom_cmd, path, repeats=3)
            row += f"{pt * 1000:>9.0f}ms"
        print(row)
        os.remove(path)


if __name__ == "__main__":
    main()
