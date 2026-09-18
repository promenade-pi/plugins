"""Compare two object-centric event logs.

The report answers, in order:

1. **Strict equality** — is every relation (events, objects, E2O, O2O, event
   attributes, object attributes) byte-for-byte the same set of tuples?  This is
   the OCEL equivalence of Definition 1: identifiers, type names, timestamps,
   attribute values and both relations all identical.

2. **Structural equivalence** — Definition 2: does a bijection on event ids,
   object ids, event types and object types exist that preserves everything
   else?  Deciding graph isomorphism is hard in general, but the paper's φ must
   *preserve labels, timestamps and attribute values*, which pins the bijection
   down almost completely.  We compute a 1-dimensional Weisfeiler–Leman colour
   refinement seeded on those preserved features; equal colour-class histograms
   plus a consistency check decide equivalence, with a capped backtracking
   search for the residual automorphism case.  When the search budget is
   exhausted the verdict is reported as *undetermined*, never guessed.

3. **Coverage** — when they are not equivalent, how much overlaps: Jaccard and
   reciprocal coverage of event ids, object ids, event types and object types,
   plus per-type count deltas.

4. **Suspected renames** — for names present in one log but not the other, a
   normalisation pass (lower-case, strip non-alphanumerics) and a Jaro–Winkler
   score flag pairs that look like an automatic rename — the kind a SQLite
   export does when it sanitises a table name.

The heavy lifting is all in ``finalize`` because the two-stage cache key does
not include this action's parameters; ``prepare`` only checks the inputs are
usable.
"""

from collections import Counter, defaultdict

MAX_ITERATIONS = 30
SAMPLE_LIMIT = 25

# Physical logical-table names, as they reach a pyodide plugin (see
# app/src/host/relational/schemas.ts PHYSICAL_LOGICAL_NAME).
RELATIONS = [
    ("event", ["event_id", "activity", "ts"]),
    ("object", ["object_id", "object_type"]),
    ("e2o", ["event_id", "object_id", "qualifier"]),
    ("o2o", ["source_id", "target_id", "qualifier"]),
    ("event_attr", ["event_id", "name", "value"]),
    ("object_attr", ["object_id", "name", "value", "ts"]),
]


def _has(ctx, role, logical):
    return f"{role}__{logical}" in ctx.tables


async def prepare(ctx):
    for role in ("baseline", "candidate"):
        for logical in ("event", "object", "e2o"):
            if not _has(ctx, role, logical):
                raise ValueError(
                    f"the {role} log has no {logical} relation — both inputs must be OCEL 2.0 logs with objects"
                )
    return {"ok": True}


async def finalize(prepared, params, ctx):
    max_entities = max(1000, int(params.get("maxEntities", 200000)))
    max_search = max(0, int(params.get("maxSearchNodes", 50000)))
    rename_threshold = float(params.get("renameSimilarity", 0.9))
    type_names_opaque = bool(params.get("typeNamesOpaque", False))

    ctx.progress(0.1, "counting relations")
    counts = await _counts(ctx)

    ctx.progress(0.25, "checking strict equality")
    strict = await _strict_equality(ctx)

    ctx.progress(0.45, "measuring coverage")
    coverage = await _coverage(ctx)

    ctx.progress(0.6, "matching names")
    name_sets = await _name_sets(ctx)
    suspected = _suspected_renames(name_sets, rename_threshold)

    ctx.progress(0.75, "structural refinement")
    structural = await _structural(ctx, counts, max_entities, max_search, type_names_opaque)

    verdict = _verdict(strict, structural, suspected, type_names_opaque)

    return {
        "method": {
            "strictEquality": "set equality of every relation's tuples (Definition 1)",
            "structural": "1-WL colour refinement seeded on activity / object type / timestamp / attribute values, "
            "with a capped backtracking search for the automorphism case (Definition 2)",
            "exact": False,
            "bounds": {
                "maxEntities": max_entities,
                "maxSearchNodes": max_search,
                "iterations": MAX_ITERATIONS,
                "typeNamesOpaque": type_names_opaque,
            },
        },
        "verdict": verdict,
        "strict": strict,
        "structural": structural,
        "coverage": coverage,
        "suspectedRenames": suspected,
        "stats": {
            "baseline": counts["baseline"],
            "candidate": counts["candidate"],
        },
    }


# --------------------------------------------------------------------------- #
# counts

async def _counts(ctx):
    out = {}
    for role in ("baseline", "candidate"):
        events = _one(await ctx.sql(f"SELECT count(*) AS n FROM {{{role}__event}}"))
        objects = _one(await ctx.sql(f"SELECT count(*) AS n FROM {{{role}__object}}"))
        event_types = _one(await ctx.sql(f"SELECT count(DISTINCT activity) AS n FROM {{{role}__event}}"))
        object_types = _one(await ctx.sql(f"SELECT count(DISTINCT object_type) AS n FROM {{{role}__object}}"))
        e2o = _one(await ctx.sql(f"SELECT count(*) AS n FROM {{{role}__e2o}}"))
        o2o = _one(await ctx.sql(f"SELECT count(*) AS n FROM {{{role}__o2o}}")) if _has(ctx, role, "o2o") else 0
        out[role] = {
            "events": events, "objects": objects,
            "eventTypes": event_types, "objectTypes": object_types,
            "e2o": e2o, "o2o": o2o,
        }
    return out


# --------------------------------------------------------------------------- #
# strict equality

async def _strict_equality(ctx):
    relations = []
    all_equal = True
    for logical, cols in RELATIONS:
        b = _has(ctx, "baseline", logical)
        c = _has(ctx, "candidate", logical)
        if not b and not c:
            continue
        projection = ", ".join(cols)
        if b and c:
            b_total = _one(await ctx.sql(f"SELECT count(*) AS n FROM {{baseline__{logical}}}"))
            c_total = _one(await ctx.sql(f"SELECT count(*) AS n FROM {{candidate__{logical}}}"))
            only_b = await ctx.sql(
                f"SELECT {projection} FROM {{baseline__{logical}}} "
                f"EXCEPT SELECT {projection} FROM {{candidate__{logical}}} LIMIT {SAMPLE_LIMIT + 1}"
            )
            only_c = await ctx.sql(
                f"SELECT {projection} FROM {{candidate__{logical}}} "
                f"EXCEPT SELECT {projection} FROM {{baseline__{logical}}} LIMIT {SAMPLE_LIMIT + 1}"
            )
            n_only_b = _one(await ctx.sql(
                f"SELECT count(*) AS n FROM (SELECT {projection} FROM {{baseline__{logical}}} "
                f"EXCEPT SELECT {projection} FROM {{candidate__{logical}}})"
            ))
            n_only_c = _one(await ctx.sql(
                f"SELECT count(*) AS n FROM (SELECT {projection} FROM {{candidate__{logical}}} "
                f"EXCEPT SELECT {projection} FROM {{baseline__{logical}}})"
            ))
            samples = {
                "baselineOnly": _rows(only_b, SAMPLE_LIMIT),
                "candidateOnly": _rows(only_c, SAMPLE_LIMIT),
            }
        else:
            present = "baseline" if b else "candidate"
            total = _one(await ctx.sql(f"SELECT count(*) AS n FROM {{{present}__{logical}}}"))
            b_total = total if b else 0
            c_total = total if c else 0
            n_only_b = total if b else 0
            n_only_c = total if c else 0
            samples = {"baselineOnly": [], "candidateOnly": []}
            samples["baselineOnly" if b else "candidateOnly"] = _rows(
                await ctx.sql(f"SELECT {projection} FROM {{{present}__{logical}}} LIMIT {SAMPLE_LIMIT}"),
                SAMPLE_LIMIT,
            )

        equal = n_only_b == 0 and n_only_c == 0
        all_equal = all_equal and equal
        relations.append({
            "relation": logical,
            "equal": equal,
            "present": {"baseline": b, "candidate": c},
            "baselineTotal": b_total,
            "candidateTotal": c_total,
            "baselineOnly": n_only_b,
            "candidateOnly": n_only_c,
            "samples": samples,
        })
    return {"equal": all_equal, "relations": relations}


# --------------------------------------------------------------------------- #
# coverage

async def _coverage(ctx):
    events = await _id_coverage(ctx, "event", "event_id")
    objects = await _id_coverage(ctx, "object", "object_id")
    event_types = _set_coverage(
        await _distinct(ctx, "baseline", "event", "activity"),
        await _distinct(ctx, "candidate", "event", "activity"),
    )
    object_types = _set_coverage(
        await _distinct(ctx, "baseline", "object", "object_type"),
        await _distinct(ctx, "candidate", "object", "object_type"),
    )
    per_activity = _count_deltas(
        await _grouped_counts(ctx, "baseline", "event", "activity"),
        await _grouped_counts(ctx, "candidate", "event", "activity"),
    )
    per_object_type = _count_deltas(
        await _grouped_counts(ctx, "baseline", "object", "object_type"),
        await _grouped_counts(ctx, "candidate", "object", "object_type"),
    )
    return {
        "events": events,
        "objects": objects,
        "eventTypes": event_types,
        "objectTypes": object_types,
        "perActivity": per_activity,
        "perObjectType": per_object_type,
    }


async def _id_coverage(ctx, logical, col):
    b = _one(await ctx.sql(f"SELECT count(DISTINCT {col}) AS n FROM {{baseline__{logical}}}"))
    c = _one(await ctx.sql(f"SELECT count(DISTINCT {col}) AS n FROM {{candidate__{logical}}}"))
    shared = _one(await ctx.sql(
        f"SELECT count(*) AS n FROM (SELECT DISTINCT {col} FROM {{baseline__{logical}}} "
        f"INTERSECT SELECT DISTINCT {col} FROM {{candidate__{logical}}})"
    ))
    union = b + c - shared
    return {
        "baseline": b, "candidate": c, "shared": shared,
        "jaccard": (shared / union) if union else 1.0,
        "baselineInCandidate": (shared / b) if b else 1.0,
        "candidateInBaseline": (shared / c) if c else 1.0,
    }


def _set_coverage(base, cand):
    base, cand = set(base), set(cand)
    shared = base & cand
    union = base | cand
    return {
        "baseline": len(base), "candidate": len(cand), "shared": len(shared),
        "jaccard": (len(shared) / len(union)) if union else 1.0,
        "baselineInCandidate": (len(shared) / len(base)) if base else 1.0,
        "candidateInBaseline": (len(shared) / len(cand)) if cand else 1.0,
        "onlyBaseline": sorted(base - cand),
        "onlyCandidate": sorted(cand - base),
    }


def _count_deltas(base, cand):
    rows = []
    for key in sorted(set(base) | set(cand)):
        b = int(base.get(key, 0))
        c = int(cand.get(key, 0))
        rows.append({"name": key, "baseline": b, "candidate": c, "delta": c - b})
    return rows


async def _distinct(ctx, role, logical, col):
    df = await ctx.sql(f"SELECT DISTINCT {col} AS v FROM {{{role}__{logical}}} WHERE {col} IS NOT NULL")
    return [str(v) for v in df["v"].tolist()]


async def _grouped_counts(ctx, role, logical, col):
    df = await ctx.sql(f"SELECT {col} AS v, count(*) AS n FROM {{{role}__{logical}}} GROUP BY 1")
    return {str(v): int(n) for v, n in zip(df["v"].tolist(), df["n"].tolist())}


# --------------------------------------------------------------------------- #
# suspected renames

async def _name_sets(ctx):
    out = {}
    for role in ("baseline", "candidate"):
        out[role] = {
            "objectType": set(await _distinct(ctx, role, "object", "object_type")),
            "eventType": set(await _distinct(ctx, role, "event", "activity")),
            "eventAttr": set(await _distinct(ctx, role, "event_attr", "name")) if _has(ctx, role, "event_attr") else set(),
            "objectAttr": set(await _distinct(ctx, role, "object_attr", "name")) if _has(ctx, role, "object_attr") else set(),
        }
    return out


def _suspected_renames(name_sets, threshold):
    kinds = ["objectType", "eventType", "eventAttr", "objectAttr"]
    out = []
    for kind in kinds:
        only_b = sorted(name_sets["baseline"][kind] - name_sets["candidate"][kind])
        only_c = sorted(name_sets["candidate"][kind] - name_sets["baseline"][kind])
        used_c = set()
        for b in only_b:
            best = None
            for c in only_c:
                if c in used_c:
                    continue
                norm_eq = _normalize(b) == _normalize(c)
                jw = _jaro_winkler(b, c)
                if norm_eq or jw >= threshold:
                    score = (1.0 if norm_eq else 0.0, jw)
                    if best is None or score > best[0]:
                        best = (score, c, jw, norm_eq)
            if best is not None:
                _, c, jw, norm_eq = best
                used_c.add(c)
                out.append({
                    "kind": kind,
                    "baseline": b,
                    "candidate": c,
                    "jaroWinkler": round(jw, 4),
                    "levenshtein": _levenshtein(b, c),
                    "normalizedEqual": norm_eq,
                })
    return out


def _normalize(s):
    return "".join(ch for ch in s.lower() if ch.isalnum())


def _levenshtein(a, b):
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _jaro(a, b):
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    window = max(len(a), len(b)) // 2 - 1
    a_flags = [False] * len(a)
    b_flags = [False] * len(b)
    matches = 0
    for i, ca in enumerate(a):
        lo = max(0, i - window)
        hi = min(i + window + 1, len(b))
        for j in range(lo, hi):
            if not b_flags[j] and b[j] == ca:
                a_flags[i] = b_flags[j] = True
                matches += 1
                break
    if matches == 0:
        return 0.0
    transpositions = 0
    k = 0
    for i in range(len(a)):
        if a_flags[i]:
            while not b_flags[k]:
                k += 1
            if a[i] != b[k]:
                transpositions += 1
            k += 1
    transpositions //= 2
    m = matches
    return (m / len(a) + m / len(b) + (m - transpositions) / m) / 3.0


def _jaro_winkler(a, b):
    j = _jaro(a, b)
    prefix = 0
    for ca, cb in zip(a, b):
        if ca == cb and prefix < 4:
            prefix += 1
        else:
            break
    return j + prefix * 0.1 * (1 - j)


# --------------------------------------------------------------------------- #
# structural equivalence (1-WL colour refinement)

async def _structural(ctx, counts, max_entities, max_search, type_names_opaque):
    for role in ("baseline", "candidate"):
        n = counts[role]["events"] + counts[role]["objects"]
        if n > max_entities:
            return {
                "equivalent": None,
                "reason": f"the {role} log has {n} events+objects, above the {max_entities} entity cap",
                "diverging": [],
            }

    base = await _load_graph(ctx, "baseline", type_names_opaque)
    cand = await _load_graph(ctx, "candidate", type_names_opaque)

    if len(base["events"]) != len(cand["events"]) or len(base["objects"]) != len(cand["objects"]):
        return {
            "equivalent": False,
            "reason": "event or object counts differ",
            "diverging": [],
        }

    col_b = _refine(base)
    col_c = _refine(cand)

    hist_b = _histogram(col_b, base)
    hist_c = _histogram(col_c, cand)
    if hist_b != hist_c:
        return {
            "equivalent": False,
            "reason": "colour-class histograms differ — no label-preserving bijection exists",
            "diverging": _diverging_classes(col_b, col_c, base, cand),
        }

    ok, phi, note = _try_bijection(base, cand, col_b, col_c, max_search)
    if ok is True:
        return {
            "equivalent": True,
            "reason": note,
            "phi": _phi_summary(base, cand, phi, type_names_opaque),
            "diverging": [],
        }
    if ok is None:
        return {
            "equivalent": None,
            "reason": "search budget reached before a consistent renaming was found or ruled out",
            "diverging": [],
        }
    return {
        "equivalent": False,
        "reason": note,
        "diverging": [],
    }


async def _load_graph(ctx, role, type_names_opaque):
    events = {}
    df = await ctx.sql(f"SELECT event_id, activity, CAST(ts AS VARCHAR) AS ts FROM {{{role}__event}}")
    for eid, act, ts in zip(df["event_id"].tolist(), df["activity"].tolist(), df["ts"].tolist()):
        events[str(eid)] = {"activity": None if act is None else str(act), "ts": None if ts is None else str(ts), "attrs": []}

    objects = {}
    df = await ctx.sql(f"SELECT object_id, object_type FROM {{{role}__object}}")
    for oid, ot in zip(df["object_id"].tolist(), df["object_type"].tolist()):
        objects[str(oid)] = {"objectType": None if ot is None else str(ot), "attrs": []}

    if _has(ctx, role, "event_attr"):
        df = await ctx.sql(f"SELECT event_id, name, value FROM {{{role}__event_attr}}")
        for eid, name, value in zip(df["event_id"].tolist(), df["name"].tolist(), df["value"].tolist()):
            e = events.get(str(eid))
            if e is not None:
                e["attrs"].append((str(name), _s(value)))

    if _has(ctx, role, "object_attr"):
        df = await ctx.sql(f"SELECT object_id, name, value, CAST(ts AS VARCHAR) AS ts FROM {{{role}__object_attr}}")
        for oid, name, value, ts in zip(df["object_id"].tolist(), df["name"].tolist(), df["value"].tolist(), df["ts"].tolist()):
            o = objects.get(str(oid))
            if o is not None:
                o["attrs"].append((str(name), _s(ts), _s(value)))

    e2o_by_e = defaultdict(list)
    e2o_by_o = defaultdict(list)
    df = await ctx.sql(f"SELECT event_id, object_id, qualifier FROM {{{role}__e2o}}")
    for eid, oid, q in zip(df["event_id"].tolist(), df["object_id"].tolist(), df["qualifier"].tolist()):
        eid, oid, q = str(eid), str(oid), _s(q)
        e2o_by_e[eid].append((q, oid))
        e2o_by_o[oid].append((q, eid))

    o2o_out = defaultdict(list)
    o2o_in = defaultdict(list)
    if _has(ctx, role, "o2o"):
        df = await ctx.sql(f"SELECT source_id, target_id, qualifier FROM {{{role}__o2o}}")
        for sid, tid, q in zip(df["source_id"].tolist(), df["target_id"].tolist(), df["qualifier"].tolist()):
            sid, tid, q = str(sid), str(tid), _s(q)
            o2o_out[sid].append((q, tid))
            o2o_in[tid].append((q, sid))

    for e in events.values():
        e["attrs"] = tuple(sorted(e["attrs"]))
    for o in objects.values():
        o["attrs"] = tuple(sorted(o["attrs"]))

    return {
        "events": events, "objects": objects,
        "e2o_by_e": e2o_by_e, "e2o_by_o": e2o_by_o,
        "o2o_out": o2o_out, "o2o_in": o2o_in,
        "typeNamesOpaque": type_names_opaque,
    }


def _seed(graph):
    opaque = graph["typeNamesOpaque"]
    col_e = {}
    for eid, e in graph["events"].items():
        key = ("E", e["ts"], e["attrs"]) if opaque else ("E", e["activity"], e["ts"], e["attrs"])
        col_e[eid] = hash(key)
    col_o = {}
    for oid, o in graph["objects"].items():
        key = ("O", o["attrs"]) if opaque else ("O", o["objectType"], o["attrs"])
        col_o[oid] = hash(key)
    return col_e, col_o


def _refine(graph):
    col_e, col_o = _seed(graph)
    for _ in range(MAX_ITERATIONS):
        new_e = {}
        for eid in col_e:
            nbr = tuple(sorted((q, col_o.get(oid, 0)) for q, oid in graph["e2o_by_e"].get(eid, ())))
            new_e[eid] = hash((col_e[eid], nbr))
        new_o = {}
        for oid in col_o:
            e_nbr = tuple(sorted((q, "e", col_e.get(eid, 0)) for q, eid in graph["e2o_by_o"].get(oid, ())))
            out_nbr = tuple(sorted((q, ">", col_o.get(t, 0)) for q, t in graph["o2o_out"].get(oid, ())))
            in_nbr = tuple(sorted((q, "<", col_o.get(s, 0)) for q, s in graph["o2o_in"].get(oid, ())))
            new_o[oid] = hash((col_o[oid], e_nbr, out_nbr, in_nbr))
        if _classes(new_e) == _classes(col_e) and _classes(new_o) == _classes(col_o):
            return {"e": new_e, "o": new_o}
        col_e, col_o = new_e, new_o
    return {"e": col_e, "o": col_o}


def _classes(colouring):
    return len(set(colouring.values()))


def _histogram(col, graph):
    return (
        tuple(sorted(Counter(col["e"].values()).values())),
        tuple(sorted(Counter(col["o"].values()).values())),
        tuple(sorted(Counter(col["e"].values()).items())),
        tuple(sorted(Counter(col["o"].values()).items())),
    )


def _diverging_classes(col_b, col_c, base, cand, limit=8):
    def label_e(graph, eid):
        e = graph["events"][eid]
        return {"activity": e["activity"], "ts": e["ts"]}

    out = []
    hist_b = Counter(col_b["e"].values())
    hist_c = Counter(col_c["e"].values())
    for colour in set(hist_b) | set(hist_c):
        if hist_b.get(colour, 0) == hist_c.get(colour, 0):
            continue
        example_id = next((eid for eid, cc in col_b["e"].items() if cc == colour), None)
        if example_id is None:
            example_id = next((eid for eid, cc in col_c["e"].items() if cc == colour), None)
            example = label_e(cand, example_id)
        else:
            example = label_e(base, example_id)
        out.append({
            "kind": "event",
            "baselineCount": hist_b.get(colour, 0),
            "candidateCount": hist_c.get(colour, 0),
            "example": example,
        })
        if len(out) >= limit:
            break
    return out


def _try_bijection(base, cand, col_b, col_c, max_search):
    """Returns (result, phi, note): result is True / False / None (budget hit)."""
    e_classes_b = defaultdict(list)
    for eid, c in col_b["e"].items():
        e_classes_b[c].append(eid)
    e_classes_c = defaultdict(list)
    for eid, c in col_c["e"].items():
        e_classes_c[c].append(eid)
    o_classes_b = defaultdict(list)
    for oid, c in col_b["o"].items():
        o_classes_b[c].append(oid)
    o_classes_c = defaultdict(list)
    for oid, c in col_c["o"].items():
        o_classes_c[c].append(oid)

    # Every colour present on one side must be present on the other with the
    # same multiplicity (the histogram check already guarantees this shape).
    for classes_b, classes_c in ((e_classes_b, e_classes_c), (o_classes_b, o_classes_c)):
        if set(classes_b) != set(classes_c):
            return (False, None, "colour classes are not shared between the logs")

    singletons = all(len(v) == 1 for v in e_classes_b.values()) and all(len(v) == 1 for v in o_classes_b.values())

    phi_e = {}
    phi_o = {}
    if singletons:
        for c, ids in e_classes_b.items():
            phi_e[ids[0]] = e_classes_c[c][0]
        for c, ids in o_classes_b.items():
            phi_o[ids[0]] = o_classes_c[c][0]
        if _consistent(base, cand, phi_e, phi_o):
            return (True, {"e": phi_e, "o": phi_o}, "colour refinement determined a unique label-preserving bijection")
        return (False, None, "the colour-determined mapping does not preserve every relation tuple")

    if max_search == 0:
        return (None, None, "search disabled")

    # Backtracking within colour classes.  Objects first (E2O consistency then
    # constrains events), most-constrained class first.
    budget = [max_search]
    o_class_items = sorted(o_classes_b.items(), key=lambda kv: len(kv[1]))

    def assign_objects(idx):
        if budget[0] <= 0:
            return None
        if idx == len(o_class_items):
            return _extend_to_events(base, cand, phi_o, e_classes_b, e_classes_c, budget)
        colour, b_ids = o_class_items[idx]
        c_ids = list(o_classes_c[colour])
        for perm in _permutations(c_ids):
            budget[0] -= 1
            if budget[0] <= 0:
                return None
            for b_id, c_id in zip(b_ids, perm):
                phi_o[b_id] = c_id
            if _o2o_consistent_partial(base, cand, phi_o):
                res = assign_objects(idx + 1)
                if res is not None:
                    return res
            for b_id in b_ids:
                phi_o.pop(b_id, None)
        return None

    result = assign_objects(0)
    if budget[0] <= 0 and result is None:
        return (None, None, "search budget reached")
    if result is None:
        return (False, None, "no consistent label-preserving bijection exists within the colour classes")
    return (True, result, "a consistent label-preserving bijection exists (the logs have non-trivial automorphisms)")


def _permutations(items):
    if len(items) <= 1:
        yield list(items)
        return
    for i in range(len(items)):
        rest = items[:i] + items[i + 1:]
        for p in _permutations(rest):
            yield [items[i]] + p


def _o2o_consistent_partial(base, cand, phi_o):
    cand_o2o = set()
    for s, lst in cand["o2o_out"].items():
        for q, t in lst:
            cand_o2o.add((s, q, t))
    for s, lst in base["o2o_out"].items():
        if s not in phi_o:
            continue
        for q, t in lst:
            if t in phi_o and (phi_o[s], q, phi_o[t]) not in cand_o2o:
                return False
    return True


def _extend_to_events(base, cand, phi_o, e_classes_b, e_classes_c, budget):
    phi_e = {}
    cand_e2o = defaultdict(set)
    for oid, lst in cand["e2o_by_o"].items():
        for q, eid in lst:
            cand_e2o[eid].add((q, oid))
    # Each baseline event's required candidate E2O signature under phi_o.
    for colour, b_ids in e_classes_b.items():
        c_ids = list(e_classes_c[colour])
        used = set()
        for b_id in b_ids:
            want = frozenset((q, phi_o[oid]) for q, oid in base["e2o_by_e"].get(b_id, ()) if oid in phi_o)
            match = None
            for c_id in c_ids:
                if c_id in used:
                    continue
                have = frozenset(cand_e2o.get(c_id, set()))
                if want == have:
                    match = c_id
                    break
            if match is None:
                return None
            used.add(match)
            phi_e[b_id] = match
            budget[0] -= 1
            if budget[0] <= 0:
                return None
    if _consistent(base, cand, phi_e, phi_o):
        return {"e": phi_e, "o": phi_o}
    return None


def _consistent(base, cand, phi_e, phi_o):
    if len(set(phi_e.values())) != len(phi_e) or len(set(phi_o.values())) != len(phi_o):
        return False
    cand_e2o = set()
    for eid, lst in cand["e2o_by_e"].items():
        for q, oid in lst:
            cand_e2o.add((eid, q, oid))
    base_e2o = set()
    for eid, lst in base["e2o_by_e"].items():
        for q, oid in lst:
            base_e2o.add((eid, q, oid))
    if len(base_e2o) != len(cand_e2o):
        return False
    for eid, q, oid in base_e2o:
        if eid not in phi_e or oid not in phi_o:
            return False
        if (phi_e[eid], q, phi_o[oid]) not in cand_e2o:
            return False
    cand_o2o = set()
    for sid, lst in cand["o2o_out"].items():
        for q, tid in lst:
            cand_o2o.add((sid, q, tid))
    base_o2o = set()
    for sid, lst in base["o2o_out"].items():
        for q, tid in lst:
            base_o2o.add((sid, q, tid))
    if len(base_o2o) != len(cand_o2o):
        return False
    for sid, q, tid in base_o2o:
        if sid not in phi_o or tid not in phi_o:
            return False
        if (phi_o[sid], q, phi_o[tid]) not in cand_o2o:
            return False
    return True


def _phi_summary(base, cand, phi, type_names_opaque):
    et = {}
    for b_id, c_id in phi["e"].items():
        a = base["events"][b_id]["activity"]
        b = cand["events"][c_id]["activity"]
        if a is not None and b is not None:
            et.setdefault(a, set()).add(b)
    ot = {}
    for b_id, c_id in phi["o"].items():
        a = base["objects"][b_id]["objectType"]
        b = cand["objects"][c_id]["objectType"]
        if a is not None and b is not None:
            ot.setdefault(a, set()).add(b)
    return {
        "eventTypeMap": _one_to_one(et),
        "objectTypeMap": _one_to_one(ot),
        "eventTypesRenamed": [k for k, v in _one_to_one(et).items() if k != v],
        "objectTypesRenamed": [k for k, v in _one_to_one(ot).items() if k != v],
    }


def _one_to_one(multi):
    return {k: (sorted(v)[0] if len(v) == 1 else "|".join(sorted(v))) for k, v in multi.items()}


# --------------------------------------------------------------------------- #
# verdict

def _verdict(strict, structural, suspected, type_names_opaque):
    if strict["equal"]:
        return "strict-equal"
    eq = structural["equivalent"]
    if eq is True:
        renamed = bool(structural.get("phi", {}).get("eventTypesRenamed") or structural.get("phi", {}).get("objectTypesRenamed"))
        type_renames = any(r["kind"] in ("objectType", "eventType") for r in suspected)
        if renamed or type_renames or type_names_opaque:
            return "equivalent-up-to-rename"
        return "structurally-equivalent"
    if eq is False:
        return "different"
    return "undetermined"


# --------------------------------------------------------------------------- #
# helpers

def _one(df):
    return int(df.iloc[0]["n"])


def _rows(df, limit):
    records = df.head(limit).to_dict(orient="records")
    return [{k: _s(v) for k, v in row.items()} for row in records]


def _s(v):
    try:
        import pandas as pd
        if v is None or (not isinstance(v, (list, dict)) and pd.isna(v)):
            return None
    except Exception:
        if v is None:
            return None
    return str(v)
