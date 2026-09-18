#!/usr/bin/env python3
"""Compares canonical trees from the ProM oracle and the Rust implementation.

Reports every mismatch with the log that produced it, because a mismatch is
only useful if it can be reduced to a case small enough to reason about.
Exits non-zero when anything differs, so it can gate a build.
"""
import json
import sys
from collections import Counter


def load(path):
    out = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                r = json.loads(line)
                out[r.get("id", "?")] = r
    return out


def main():
    cases_path, prom_path, rust_path = sys.argv[1:4]
    cases = load(cases_path)
    prom = load(prom_path)
    rust = load(rust_path)

    mismatches = []
    errors = []
    violations = []
    ok = 0

    for cid in cases:
        p, r = prom.get(cid), rust.get(cid)
        if p is None or r is None:
            errors.append((cid, "missing result", str(p), str(r)))
            continue
        if p.get("violations"):
            violations.append((cid, p["violations"]))
        if "error" in p or "error" in r:
            errors.append((cid, "error", p.get("error", ""), r.get("error", "")))
            continue
        if p["canonical"] == r["canonical"]:
            ok += 1
        else:
            mismatches.append((cid, p["canonical"], r["canonical"]))

    total = len(cases)
    print(f"cases       {total}")
    print(f"agree       {ok}")
    print(f"mismatch    {len(mismatches)}")
    print(f"errors      {len(errors)}")
    print(f"violations  {len(violations)}")

    if violations:
        print("\n-- loop-shape violations in the reference (exit child not tau)")
        for cid, v in violations[:10]:
            print(f"  {cid}: {v}")

    if errors:
        print("\n-- errors")
        for cid, kind, a, b in errors[:20]:
            print(f"  {cid} [{kind}]\n     prom: {a}\n     rust: {b}")

    if mismatches:
        print("\n-- mismatches")
        shapes = Counter()
        for cid, a, b in mismatches:
            shapes[(a.split("(")[0], b.split("(")[0])] += 1
        print("   root-operator pairs:", dict(shapes))
        # Smallest logs first: the shortest counterexample is the one worth
        # reading.
        mismatches.sort(key=lambda m: len(json.dumps(cases[m[0]].get("traces", []))))
        for cid, a, b in mismatches[:25]:
            c = cases[cid]
            print(f"\n  {cid}  variant={c.get('variant','IMf')} "
                  f"noise={c.get('noiseThreshold',0)}")
            print(f"    log:  {json.dumps(c.get('traces'))}")
            print(f"    prom: {a}")
            print(f"    rust: {b}")

    return 1 if (mismatches or errors) else 0


if __name__ == "__main__":
    sys.exit(main())
