"""Promenade Log Quality.

The report shape and the stable check identifiers intentionally follow the
Ocelot Quality linter.  The data available to a Promenade plugin is the
normalised relational representation, so parser/schema-only checks are
excluded and timestamps are already valid DuckDB timestamp values.  Every
remaining check is deterministic and reports a bounded list of example IDs.
"""

import math
import re
from collections import Counter

import pandas as pd


CHECKS = {
    "SPEC-EVENT-MISSING-FIELD": ("error", "spec", "Event required fields"),
    "SPEC-OBJECT-MISSING-FIELD": ("error", "spec", "Object required fields"),
    "SPEC-DUP-EVENT-ID": ("error", "spec", "Duplicate event identifiers"),
    "SPEC-DUP-OBJECT-ID": ("error", "spec", "Duplicate object identifiers"),
    "INTEG-E2O-DANGLING": ("error", "integrity", "Dangling event-object references"),
    "INTEG-O2O-DANGLING": ("error", "integrity", "Dangling object-object references"),
    "INTEG-O2O-SELF-REF": ("error", "integrity", "Self-referencing object relations"),
    "INTEG-E2O-EXACT-DUPLICATE": ("error", "integrity", "Duplicate event-object relations"),
    "TEMPORAL-ATTR-CHANGE-OUT-OF-RANGE": ("error", "temporal", "Attribute changes outside lifecycle"),
    "TEMPORAL-OBJECT-USED-BEFORE-EXISTS": ("warning", "temporal", "Objects used before their attribute history begins"),
    "TEMPORAL-IMPLAUSIBLE-TIMESTAMP": ("warning", "temporal", "Implausible timestamps"),
    "TEMPORAL-PRECISION-LOSS": ("warning", "temporal", "Low timestamp precision"),
    "TEMPORAL-TIED-TIMESTAMPS": ("warning", "temporal", "Events sharing a timestamp"),
    "TEMPORAL-ASSERTED-ORDER": ("info", "temporal", "Event order is asserted, not recorded"),
    "TEMPORAL-BATCH-ARTEFACT": ("warning", "temporal", "Timestamp batching artefact"),
    "TEMPORAL-UNSORTED-EVENTS": ("info", "temporal", "Events are not ordered chronologically"),
    "SMELL-EVENT-NO-OBJECTS": ("warning", "structure", "Events without related objects"),
    "SMELL-OBJECT-NO-EVENTS": ("warning", "structure", "Objects without related events"),
    "SMELL-EMPTY-CASE": ("warning", "structure", "Empty cases"),
    "SMELL-SINGLETON-OBJECT-TYPE": ("warning", "structure", "Singleton object types"),
    "SMELL-UBIQUITOUS-OBJECT-TYPE": ("warning", "structure", "Ubiquitous object types"),
    "SMELL-ISOLATED-OBJECT-TYPE": ("warning", "structure", "Object types without object relations"),
    "SMELL-CONVERGENCE": ("warning", "structure", "Unusually convergent events"),
    "SMELL-DIVERGENCE": ("warning", "structure", "Unusually divergent objects"),
    "SMELL-SINGLE-OCCURRENCE-EVENT-TYPE": ("info", "structure", "Single-occurrence activities"),
    "QUAL-MATRIX-OUTLIER": ("warning", "qualifier", "Qualifier matrix outliers"),
    "QUAL-CASE-VARIANT": ("warning", "qualifier", "Qualifier case or whitespace variants"),
    "QUAL-PARTIALLY-QUALIFIED": ("warning", "qualifier", "Partially qualified relation groups"),
    "ATTR-ALWAYS-EMPTY": ("warning", "attribute", "Always-empty attributes"),
    "ATTR-HIGH-NULL-RATE": ("info", "attribute", "High attribute null rates"),
    "ATTR-IS-IDENTIFIER": ("info", "attribute", "Identifier-like attributes"),
    "ATTR-NUMERIC-AS-STRING": ("warning", "attribute", "Numbers stored as strings"),
    "ATTR-SENTINEL-VALUES": ("warning", "attribute", "Sentinel attribute values"),
    "ATTR-VALUE-CASE-VARIANT": ("warning", "attribute", "Attribute value case or whitespace variants"),
    "ATTR-STATIC-BUT-CHANGES": ("warning", "attribute", "Static attributes that change"),
    "ATTR-DYNAMIC-BUT-CONSTANT": ("info", "attribute", "Dynamic attributes that never change"),
    "ATTR-POSSIBLE-PII": ("warning", "attribute", "Potentially personal data"),
    "PORT-UNSAFE-TYPE-NAME": ("info", "portability", "Unsafe type names"),
    "PORT-NAME-COLLISION": ("info", "portability", "Names that collide after normalisation"),
}

IMPACTS = {
    "spec": "Downstream tools may reject the log or silently merge unrelated records.",
    "integrity": "Discovery and performance analyses can create phantom behaviour or omit real relationships.",
    "temporal": "Ordering, waiting-time and cycle-time analyses can be misleading.",
    "structure": "The log may model master data or extraction artefacts as process behaviour.",
    "qualifier": "Object roles become ambiguous, weakening object-centric models and comparisons.",
    "attribute": "Filters, data enrichment and privacy-sensitive analyses can be unreliable.",
    "portability": "Exporting to or querying from other OCEL tooling may need manual repairs.",
}

PII_NAME = re.compile(r"(?:^|[_ .-])(email|e-mail|mail|phone|mobile|tel|name|first.?name|last.?name|address|iban|account|ssn|social.?security)(?:$|[_ .-])", re.I)
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
NUMERIC = re.compile(r"^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$")
SENTINELS = {"n/a", "na", "null", "none", "unknown", "-", "?", "9999", "99999"}


def _assertion_step(ctx, role="log"):
    """The step of an order assertion in the bound log's own plan, else 0.

    A derived log's transformation plan is part of what the log *is*, and this
    one operation changes what the timestamps mean. Reading it here is what
    stops the repair from quietly clearing the very finding that motivated it.
    """
    try:
        entries = (ctx.meta or {}).get(role) or []
    except Exception:
        return 0
    for entry in entries:
        for op in (entry or {}).get("transformOps") or []:
            if op.get("kind") == "disambiguateEventOrder":
                return int(op.get("stepMicroseconds") or 1000)
    return 0


def _exclude_activities_fix(activities):
    """Excluding one-off activities is a modelling choice, so it stays opt-in.

    A single occurrence is often a genuine rare path rather than noise, which
    is why this finding is informational and its repair carries a warning
    instead of joining any bulk action.
    """
    if not activities:
        return None
    return {
        "label": "Exclude those activities",
        "caution": "A one-off activity is often a real rare path, not noise.",
        "ops": [{
            "kind": "filterActivities",
            "values": sorted(_clean(a) for a in activities),
            "mode": "exclude", "minFrequency": 0, "maxFrequency": 100,
        }],
    }


def _safe_name(value):
    """A SQL-safe identifier for a type name, as `PORT-UNSAFE-TYPE-NAME` wants it."""
    cleaned = re.sub(r"[^A-Za-z0-9_]", "_", str(value)).strip("_")
    return cleaned if re.match(r"^[A-Za-z_]", cleaned or "") else f"t_{cleaned}"


def _missing(value):
    return value is None or (isinstance(value, str) and not value.strip()) or pd.isna(value)


def _clean(value):
    if _missing(value):
        return "(missing)"
    return str(value)


def _examples(values, maximum):
    return sorted({_clean(v) for v in values})[:maximum]


def _outlier_ids(series, ids):
    values = pd.to_numeric(series, errors="coerce").dropna()
    if len(values) < 4:
        return []
    q1, q3 = values.quantile(.25), values.quantile(.75)
    threshold = q3 + 1.5 * (q3 - q1)
    return ids[pd.to_numeric(series, errors="coerce") > threshold].tolist()


async def _optional_sql(ctx, logical, query, columns):
    """Read an optional imported relation without issuing a failing SQL query.

    Promenade intentionally does not materialise an attribute table when a
    source contains no such attributes. `ctx.tables` is the authoritative
    capability list for the bound artifact, so checking it first keeps an
    all-empty XES/OCEL report quiet and lets the associated checks pass.
    """
    if logical not in ctx.tables:
        return pd.DataFrame(columns=columns)
    return await ctx.sql(query)


class Report:
    def __init__(self, kind, meta, maximum):
        self.kind = kind
        self.meta = meta
        self.maximum = maximum
        self.results = []

    def add(self, check_id, affected, description, examples=None, fix=None):
        """Records one check's outcome, optionally with a repair the host can apply.

        A `fix` is `{label, ops, caution?}`. `ops` are Promenade transformation
        operations, verbatim — the host validates them, inserts each at its
        phase position in a derived log's plan and never touches the source.
        The plugin proposes; it does not decide where the repair lands, and it
        cannot name the artifact it lands on.
        """
        severity, category, name = CHECKS[check_id]
        examples = _examples(examples if examples is not None else affected, self.maximum)
        n = len(affected)
        finding = None
        if n:
            finding = {
                "title": f"{n:,} {description}",
                "description": description + ".",
                "impact": IMPACTS[category],
                "affectedCount": n,
                "examples": examples,
            }
            if fix and fix.get("ops"):
                finding["fix"] = fix
        self.results.append({
            "checkId": check_id, "severity": severity, "category": category,
            "name": name, "status": "failed" if finding else "passed",
            "findings": [finding] if finding else [],
        })

    def skip(self, check_id, note):
        """Records a check that cannot be evaluated, with the reason.

        Distinct from passing. A check that silently passes because the data it
        examines was rewritten reports good news it has not established, which
        is worse than saying nothing.
        """
        severity, category, name = CHECKS[check_id]
        self.results.append({
            "checkId": check_id, "severity": severity, "category": category,
            "name": name, "status": "skipped", "note": note, "findings": [],
        })

    def payload(self):
        counts = {"error": 0, "warning": 0, "info": 0}
        for result in self.results:
            if result["status"] == "failed":
                counts[result["severity"]] += len(result["findings"])
        return {
            "schemaVersion": "1", "engine": "Promenade Log Quality / Ocelot catalogue",
            "meta": self.meta, "counts": counts, "results": self.results,
        }


def _temporal_checks(report, events, id_col, order_cols, partition_col=None, assertion_step=0):
    """Temporal checks, scoped to a case where a case exists.

    `assertion_step` is the step, in microseconds, of a `disambiguateEventOrder`
    operation in the log's own transformation plan, or 0 when there is none.
    The host reports it through `ctx.meta`; it is not recoverable from the
    timestamps, because a repair's offsets are indistinguishable from data the
    source recorded at the same resolution.

    `partition_col` is the trace column on a traditional log and None on OCEL,
    where there is no case notion and the timeline is global. It matters twice:
    chronological order is a property *within* a case (comparing the first
    event of one case against the last event of the previous one reports every
    log whose cases overlap in time, which is nearly all of them), and a
    timestamp tie only makes an order ambiguous between events that are
    actually ordered relative to each other.
    """
    if events.empty or "ts" not in events:
        report.add("TEMPORAL-IMPLAUSIBLE-TIMESTAMP", [], "events use implausible timestamps")
        report.add("TEMPORAL-PRECISION-LOSS", [], "timestamps have low precision")
        report.add("TEMPORAL-ASSERTED-ORDER", [], "events carry an asserted rather than a recorded order")
        report.add("TEMPORAL-TIED-TIMESTAMPS", [], "events share a timestamp with another event")
        report.add("TEMPORAL-BATCH-ARTEFACT", [], "events share an unusually large timestamp batch")
        report.add("TEMPORAL-UNSORTED-EVENTS", [], "events are not ordered chronologically")
        return
    ts = pd.to_datetime(events["ts"], errors="coerce", utc=True)
    implausible = events.loc[(ts.dt.year <= 1971) | (ts.dt.year >= 2100), id_col].tolist()
    report.add(
        "TEMPORAL-IMPLAUSIBLE-TIMESTAMP", implausible, "events use likely sentinel or far-future timestamps",
        fix={
            "label": "Clear those timestamps",
            "caution": (
                "Clearing keeps the event in the control flow and removes it from every "
                "duration. Dropping the event instead is the other reasonable choice."
            ),
            "ops": [{
                "kind": "dropImplausibleTimestamps",
                "mode": "clear", "minYear": 1972, "maxYear": 2099,
            }],
        },
    )
    valid = ts.dropna()
    if assertion_step:
        # Not measurable on this log, and passing would be a false all-clear.
        #
        # A `disambiguateEventOrder` repair spreads tied events by offsets that
        # are not recoverable afterwards — the group each event belonged to is
        # gone once its timestamp moved. Running the ratio anyway reports the
        # log as well-timed, because the offsets are exactly what the check
        # looks for the absence of. The source's precision is unchanged by the
        # repair; this log simply can no longer show it.
        report.skip(
            "TEMPORAL-PRECISION-LOSS",
            "Not measurable: an order assertion in this log's transformation plan has "
            "moved tied timestamps, so the source's own precision cannot be read off "
            "them. Run this check on the source log instead.",
        )
    else:
        low_precision = []
        if len(valid):
            seconds_only = ((valid.dt.microsecond == 0) & (valid.dt.nanosecond == 0)).mean() >= .98
            midnight = ((valid.dt.hour == 0) & (valid.dt.minute == 0) & (valid.dt.second == 0)).mean() >= .8
            if seconds_only or midnight:
                low_precision = events.loc[ts.notna(), id_col].tolist()
        report.add("TEMPORAL-PRECISION-LOSS", low_precision, "timestamps are almost entirely rounded to seconds or midnight")
    report.add(
        "TEMPORAL-ASSERTED-ORDER",
        events.loc[ts.notna(), id_col].tolist() if assertion_step else [],
        "events carry an order asserted by a repair in this log's transformation plan, "
        "not one recorded by the source — every duration and directly-follows relation "
        "computed here inherits that assumption",
    )
    _tied_timestamps(report, events, ts, id_col, partition_col, bool(assertion_step))
    batch = ts.value_counts(dropna=True)
    batch_ids = []
    if len(events) >= 20 and len(batch) and batch.iloc[0] >= max(10, math.ceil(len(events) * .2)):
        batch_ids = events.loc[ts == batch.index[0], id_col].tolist()
    report.add("TEMPORAL-BATCH-ARTEFACT", batch_ids, "events share an unusually large identical timestamp")
    ordered = events.sort_values(order_cols, kind="stable")
    sorted_ts = pd.to_datetime(ordered["ts"], errors="coerce", utc=True)
    # Within a case, never across the boundary between two of them: the diff
    # from one case's last event to the next case's first is not a violation,
    # it is what overlapping cases look like.
    if partition_col:
        deltas = sorted_ts.groupby(ordered[partition_col].values).diff()
    else:
        deltas = sorted_ts.diff()
    unsorted = ordered.loc[(deltas.dt.total_seconds() < 0).fillna(False), id_col].tolist()
    report.add("TEMPORAL-UNSORTED-EVENTS", unsorted, "events are not ordered chronologically in their recorded sequence")


def _tied_timestamps(report, events, ts, id_col, partition_col, already_asserted=False):
    """Events whose order the log does not determine.

    Distinct from `TEMPORAL-PRECISION-LOSS`, which reports the *cause* (a
    rounded timestamp column) without saying how much order was actually lost,
    and from `TEMPORAL-BATCH-ARTEFACT`, which only fires when a single
    timestamp value dominates the whole log. Neither notices the ordinary case:
    thousands of small ties spread across cases, each one an event pair whose
    order every downstream model will silently invent.
    """
    frame = events.loc[ts.notna()].assign(_ts=ts.loc[ts.notna()])
    if frame.empty:
        report.add("TEMPORAL-TIED-TIMESTAMPS", [], "events share a timestamp with another event")
        return
    keys = ([partition_col] if partition_col else []) + ["_ts"]
    sizes = frame.groupby(keys, dropna=False)[id_col].transform("size")
    tied = frame.loc[sizes > 1]
    scope = "in the same case" if partition_col else "in the log"
    affected = tied[id_col].tolist()
    detail = f"events share their timestamp with another event {scope}"
    if partition_col and not tied.empty:
        ambiguous = tied[partition_col].nunique()
        detail += f", leaving {ambiguous:,} case{'' if ambiguous == 1 else 's'} with an undetermined event order"
    report.add(
        "TEMPORAL-TIED-TIMESTAMPS", affected, detail,
        fix=None if already_asserted else {
            "label": "Assert an order",
            "caution": (
                "This does not recover the real order — it asserts one. Every "
                "duration and directly-follows relation derived afterwards "
                "inherits the assumption."
            ),
            "ops": [{
                "kind": "disambiguateEventOrder",
                "tieBreak": "identifier",
                "stepMicroseconds": 1000,
            }],
        },
    )


def _scoped_ops(attrs, names, kind, **extra):
    """One operation per scope the flagged attributes actually appear in.

    An OCEL report profiles event and object attributes together, so a name
    alone does not say which relation to rewrite — and rewriting the wrong one
    is a silent no-op. Grouping by the recorded scope keeps the proposed repair
    addressed at what the finding was actually about.
    """
    if not names:
        return []
    wanted = set(names)
    hits = attrs.loc[attrs["_name"].isin(wanted)]
    ops = []
    for scope, frame in hits.groupby("_scope", sort=True):
        ops.append({"kind": kind, "scope": scope, "names": sorted(set(frame["_name"])), **extra})
    return ops


def _attribute_checks(report, attrs, owner_col, name_col, value_col):
    if attrs.empty:
        for check in ["ATTR-ALWAYS-EMPTY", "ATTR-HIGH-NULL-RATE", "ATTR-IS-IDENTIFIER", "ATTR-NUMERIC-AS-STRING", "ATTR-SENTINEL-VALUES", "ATTR-VALUE-CASE-VARIANT", "ATTR-POSSIBLE-PII"]:
            report.add(check, [], "attributes match this quality pattern")
        return
    attrs = attrs.copy()
    attrs["_name"] = attrs[name_col].map(_clean)
    attrs["_value"] = attrs[value_col].map(_clean)
    if "_scope" not in attrs:
        attrs["_scope"] = "eventAttribute"
    groups = list(attrs.groupby("_name", dropna=False, sort=True))
    always_empty = [name for name, frame in groups if frame["_value"].eq("(missing)").all()]
    high_null = [name for name, frame in groups if len(frame) >= 5 and frame["_value"].eq("(missing)").mean() >= .5 and not frame["_value"].eq("(missing)").all()]
    identifier = []
    numeric = []
    sentinel = []
    variants = []
    pii = []
    for name, frame in groups:
        values = [v for v in frame["_value"].tolist() if v != "(missing)"]
        unique = set(values)
        if len(values) >= 10 and len(unique) / len(values) >= .95:
            identifier.append(name)
        if len(values) >= 5 and sum(bool(NUMERIC.match(v)) for v in values) / len(values) >= .95:
            numeric.append(name)
        if any(v.strip().lower() in SENTINELS for v in values):
            sentinel.append(name)
        normalised = {}
        for v in unique:
            normalised.setdefault(v.strip().casefold(), set()).add(v)
        if any(len(vs) > 1 for vs in normalised.values()):
            variants.append(name)
        if PII_NAME.search(name) or any(EMAIL.match(v) for v in values[:1000]):
            pii.append(name)
    report.add(
        "ATTR-ALWAYS-EMPTY", always_empty, "attribute definitions contain no populated value",
        fix={"label": "Remove them", "ops": _scoped_ops(attrs, always_empty, "removeAttributes")},
    )
    report.add("ATTR-HIGH-NULL-RATE", high_null, "attributes have a high missing-value rate")
    report.add("ATTR-IS-IDENTIFIER", identifier, "attributes are almost unique per record and look identifier-like")
    # Deliberately no repair: the relational layer stores every attribute value
    # as text by construction, so there is no column type to cast to and a
    # "fix" here would rewrite the representation while changing nothing.
    report.add("ATTR-NUMERIC-AS-STRING", numeric, "attributes contain numeric values stored as text")
    report.add(
        "ATTR-SENTINEL-VALUES", sentinel, "attributes use placeholder or sentinel values",
        fix={
            "label": "Clear to missing",
            "caution": "Check the list first — in some domains \u201cunknown\u201d is a real answer.",
            "ops": _scoped_ops(attrs, sentinel, "mapSentinelValues", values=sorted(SENTINELS)),
        },
    )
    report.add(
        "ATTR-VALUE-CASE-VARIANT", variants, "attribute values differ only in case or surrounding whitespace",
        fix={"label": "Canonicalise", "ops": _scoped_ops(attrs, variants, "canonicaliseValues")},
    )
    report.add(
        "ATTR-POSSIBLE-PII", pii, "attribute names or value patterns suggest potentially personal data",
        fix={
            "label": "Pseudonymise",
            "caution": (
                "A salted digest, not anonymisation: the same value always maps to "
                "the same digest, so the log stays joinable and stays guessable."
            ),
            "ops": _scoped_ops(attrs, pii, "pseudonymiseAttributes", mode="hash", salt="promenade"),
        },
    )


async def prepare_xes(ctx):
    ctx.progress(.08, "querying events")
    events = await ctx.sql("SELECT event_idx, trace_idx, activity, ts, lifecycle, resource FROM {event} ORDER BY trace_idx, event_idx")
    ctx.progress(.28, "querying cases")
    cases = await ctx.sql("SELECT trace_idx, case_id FROM {trace}")
    attrs = await _optional_sql(ctx, "event_attr", "SELECT event_idx, key, value FROM {event_attr}", ["event_idx", "key", "value"])
    ctx.progress(.5, "loaded XES data")
    return {"events": events, "cases": cases, "attrs": attrs, "assertionStep": _assertion_step(ctx)}


def finalize_xes(prepared, params, ctx):
    events, cases, attrs = prepared["events"], prepared["cases"], prepared["attrs"]
    max_examples = int(params.get("maxExamples", 10))
    report = Report("TraditionalEventLog", {"logType": "TraditionalEventLog", "eventCount": int(len(events)), "caseCount": int(len(cases))}, max_examples)
    ctx.progress(.58, "checking event and temporal quality")
    missing_activity = events.loc[events["activity"].map(_missing), "event_idx"].tolist()
    report.add("SPEC-EVENT-MISSING-FIELD", missing_activity, "events have no activity under the selected classifier")
    _temporal_checks(report, events, "event_idx", ["trace_idx", "event_idx"],
                     partition_col="trace_idx", assertion_step=prepared["assertionStep"])
    empty_cases = cases.loc[~cases["trace_idx"].isin(events["trace_idx"]), "trace_idx"].tolist()
    report.add(
        "SMELL-EMPTY-CASE", empty_cases, "cases have no events",
        fix={"label": "Drop them", "ops": [{"kind": "dropEmptyCases"}]},
    )
    counts = events["activity"].fillna("(missing)").value_counts()
    singles = counts[counts == 1].index.tolist()
    report.add("SMELL-SINGLE-OCCURRENCE-EVENT-TYPE", singles, "activities occur only once in the log",
               fix=_exclude_activities_fix(singles))
    if params.get("includeAttributes", True):
        ctx.progress(.78, "profiling attributes")
        _attribute_checks(report, attrs, "event_idx", "key", "value")
    else:
        for check in ["ATTR-ALWAYS-EMPTY", "ATTR-HIGH-NULL-RATE", "ATTR-IS-IDENTIFIER", "ATTR-NUMERIC-AS-STRING", "ATTR-SENTINEL-VALUES", "ATTR-VALUE-CASE-VARIANT", "ATTR-POSSIBLE-PII"]:
            severity, category, name = CHECKS[check]
            report.results.append({"checkId": check, "severity": severity, "category": category, "name": name, "status": "skipped", "note": "Attribute profiling disabled", "findings": []})
    ctx.progress(.96, "assembling report")
    return report.payload()


async def prepare_ocel(ctx):
    ctx.progress(.06, "querying events and objects")
    events = await ctx.sql("SELECT event_id, activity, ts FROM {event} ORDER BY event_id")
    objects = await ctx.sql("SELECT object_id, object_type FROM {object} ORDER BY object_id")
    ctx.progress(.25, "querying relations")
    e2o = await ctx.sql("SELECT event_id, object_id, qualifier FROM {e2o}")
    o2o = await ctx.sql("SELECT source_id, target_id, qualifier FROM {o2o}")
    event_attrs = await _optional_sql(ctx, "event_attr", "SELECT event_id, name, value FROM {event_attr}", ["event_id", "name", "value"])
    object_attrs = await _optional_sql(ctx, "object_attr", "SELECT object_id, name, value, ts FROM {object_attr}", ["object_id", "name", "value", "ts"])
    ctx.progress(.5, "loaded OCEL data")
    return {"events": events, "objects": objects, "e2o": e2o, "o2o": o2o,
            "event_attrs": event_attrs, "object_attrs": object_attrs,
            "assertionStep": _assertion_step(ctx)}


def _qualifier_checks(report, events, objects, e2o):
    if e2o.empty:
        for check in ["QUAL-MATRIX-OUTLIER", "QUAL-CASE-VARIANT", "QUAL-PARTIALLY-QUALIFIED"]:
            report.add(check, [], "qualifiers match this quality pattern")
        return
    rel = e2o.merge(events[["event_id", "activity"]], on="event_id", how="left").merge(objects[["object_id", "object_type"]], on="object_id", how="left")
    rel["_qual"] = rel["qualifier"].map(lambda v: "" if _missing(v) else str(v))
    variants = []
    for q in sorted(set(q for q in rel["_qual"].tolist() if q)):
        pass
    groups = {}
    for q in sorted(set(q for q in rel["_qual"].tolist() if q)):
        groups.setdefault(q.strip().casefold(), set()).add(q)
    variants = [" / ".join(sorted(values)) for values in groups.values() if len(values) > 1]
    partial = []
    outliers = []
    for (activity, object_type), frame in rel.groupby(["activity", "object_type"], dropna=False, sort=True):
        qs = frame["_qual"].value_counts()
        if len(qs) > 1 and "" in qs.index:
            partial.append(f"{_clean(activity)} × {_clean(object_type)}")
        if len(frame) >= 10 and len(qs) > 1 and qs.iloc[0] / len(frame) >= .9:
            outliers.append(f"{_clean(activity)} × {_clean(object_type)}")
    report.add("QUAL-MATRIX-OUTLIER", outliers, "event type/object type relation groups have rare qualifier outliers")
    report.add(
        "QUAL-CASE-VARIANT", variants, "qualifiers differ only in case or surrounding whitespace",
        fix={
            "label": "Canonicalise",
            "ops": [{"kind": "canonicaliseValues", "scope": "qualifier", "names": []}],
        },
    )
    report.add("QUAL-PARTIALLY-QUALIFIED", partial, "otherwise similar relation groups mix qualified and unqualified links")


def _ocel_structure(report, events, objects, e2o, o2o):
    related_events = set(e2o["event_id"].dropna().astype(str).tolist()) if not e2o.empty else set()
    related_objects = set(e2o["object_id"].dropna().astype(str).tolist()) if not e2o.empty else set()
    report.add(
        "SMELL-EVENT-NO-OBJECTS",
        [x for x in events["event_id"].astype(str) if x not in related_events],
        "events have no related object",
        fix={"label": "Drop those events", "ops": [{"kind": "dropEventsWithoutObjects"}]},
    )
    report.add(
        "SMELL-OBJECT-NO-EVENTS",
        [x for x in objects["object_id"].astype(str) if x not in related_objects],
        "objects are never referenced by an event",
        fix={"label": "Drop those objects", "ops": [{"kind": "dropOrphanObjects"}]},
    )
    by_type = objects.groupby("object_type", dropna=False)["object_id"].count()
    singletons = by_type[by_type == 1].index.tolist()
    report.add(
        "SMELL-SINGLETON-OBJECT-TYPE", singletons, "object types have exactly one object",
        fix={
            "label": "Exclude those types",
            "caution": "A singleton can be a genuine one-off, not an extraction artefact.",
            "ops": [{
                "kind": "filterObjectTypes",
                "values": sorted(_clean(v) for v in singletons),
                "mode": "exclude", "minFrequency": 0, "maxFrequency": 100,
            }] if singletons else [],
        },
    )
    event_count = max(1, len(events))
    type_event = e2o.merge(objects[["object_id", "object_type"]], on="object_id", how="inner").groupby("object_type")["event_id"].nunique() if not e2o.empty else pd.Series(dtype="int64")
    report.add("SMELL-UBIQUITOUS-OBJECT-TYPE", type_event[type_event / event_count >= .95].index.tolist(), "object types occur in almost every event")
    o2o_objects = set()
    if not o2o.empty:
        o2o_objects = set(o2o["source_id"].dropna().astype(str)) | set(o2o["target_id"].dropna().astype(str))
    isolated_types = []
    for typ, frame in objects.groupby("object_type", dropna=False):
        if not any(str(oid) in o2o_objects for oid in frame["object_id"]):
            isolated_types.append(_clean(typ))
    report.add("SMELL-ISOLATED-OBJECT-TYPE", isolated_types, "object types have no object-to-object relation")
    if not e2o.empty:
        typed = e2o.merge(objects[["object_id", "object_type"]], on="object_id", how="left").merge(
            events[["event_id", "activity"]], on="event_id", how="left"
        )
        per_event = typed.groupby(["event_id", "object_type"], dropna=False).size().reset_index(name="n")
        report.add("SMELL-CONVERGENCE", _outlier_ids(per_event["n"], per_event["event_id"]), "events relate to an unusually high number of objects of one type")
        per_object = typed.groupby(["object_id", "activity"], dropna=False).size().reset_index(name="n")
        report.add("SMELL-DIVERGENCE", _outlier_ids(per_object["n"], per_object["object_id"]), "objects relate to an unusually high number of events of one type")
    else:
        report.add("SMELL-CONVERGENCE", [], "events relate to an unusually high number of objects of one type")
        report.add("SMELL-DIVERGENCE", [], "objects relate to an unusually high number of events of one type")
    activities = events["activity"].fillna("(missing)").value_counts()
    once = activities[activities == 1].index.tolist()
    report.add("SMELL-SINGLE-OCCURRENCE-EVENT-TYPE", once, "activities occur only once in the log",
               fix=_exclude_activities_fix(once))


def _portability_checks(report, objects):
    names = sorted({_clean(x) for x in objects["object_type"].tolist() if not _missing(x)})
    unsafe = [name for name in names if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name)]
    buckets = {}
    for name in names:
        buckets.setdefault(re.sub(r"[^a-z0-9]", "", name.casefold()), []).append(name)
    collisions = [" / ".join(v) for _, v in sorted(buckets.items()) if len(v) > 1]
    report.add(
        "PORT-UNSAFE-TYPE-NAME", unsafe, "type names require quoting or escaping in common SQL tools",
        fix={
            "label": "Rename to safe names",
            "caution": "Renaming changes what downstream models and saved views refer to.",
            "ops": [
                {"kind": "renameObjectType", "from": name, "to": _safe_name(name), "allowMerge": False}
                for name in unsafe if _safe_name(name) not in names
            ],
        },
    )
    report.add("PORT-NAME-COLLISION", collisions, "type names collide after case and punctuation normalisation")


def _object_attribute_temporal_checks(report, events, e2o, object_attrs):
    """Checks OCEL dynamic attribute timestamps against the observed object lifecycle.

    An object can legitimately have no related event, so it is excluded rather
    than treated as an out-of-range violation.  This mirrors Ocelot's rule:
    compare a value only when the object's observed event-time span exists.
    """
    if object_attrs.empty or e2o.empty or events.empty:
        report.add("TEMPORAL-ATTR-CHANGE-OUT-OF-RANGE", [], "attribute changes occur outside an object's observed event span")
        report.add("TEMPORAL-OBJECT-USED-BEFORE-EXISTS", [], "objects are used before their attribute history begins")
        return
    event_times = e2o.merge(events[["event_id", "ts"]], on="event_id", how="inner")
    spans = event_times.groupby("object_id")["ts"].agg(first_event="min", last_event="max").reset_index()
    attrs = object_attrs.copy()
    attrs["_attr_row"] = attrs.index
    attrs = attrs.merge(spans, on="object_id", how="inner")
    change_ts = pd.to_datetime(attrs["ts"], errors="coerce", utc=True)
    first_event = pd.to_datetime(attrs["first_event"], errors="coerce", utc=True)
    last_event = pd.to_datetime(attrs["last_event"], errors="coerce", utc=True)
    out_of_range = attrs.loc[change_ts.notna() & ((change_ts < first_event) | (change_ts > last_event)), "_attr_row"].tolist()
    report.add("TEMPORAL-ATTR-CHANGE-OUT-OF-RANGE", out_of_range, "attribute changes occur outside an object's observed event span")
    first_attribute = object_attrs.loc[object_attrs["ts"].notna()].groupby("object_id")["ts"].min().reset_index(name="first_attribute")
    existence = spans.merge(first_attribute, on="object_id", how="inner")
    before_exists = existence.loc[pd.to_datetime(existence["first_event"], utc=True) < pd.to_datetime(existence["first_attribute"], utc=True), "object_id"].tolist()
    report.add("TEMPORAL-OBJECT-USED-BEFORE-EXISTS", before_exists, "objects are used before their attribute history begins")


def finalize_ocel(prepared, params, ctx):
    events, objects, e2o, o2o = prepared["events"], prepared["objects"], prepared["e2o"], prepared["o2o"]
    maximum = int(params.get("maxExamples", 10))
    report = Report("ObjectCentricEventLog", {
        "logType": "ObjectCentricEventLog", "eventCount": int(len(events)), "objectCount": int(len(objects)),
        "eventObjectRelationCount": int(len(e2o)), "objectObjectRelationCount": int(len(o2o)),
    }, maximum)
    ctx.progress(.58, "checking specification and integrity")
    event_missing = events.loc[events["event_id"].map(_missing) | events["activity"].map(_missing) | events["ts"].map(_missing), "event_id"].tolist()
    object_missing = objects.loc[objects["object_id"].map(_missing) | objects["object_type"].map(_missing), "object_id"].tolist()
    report.add("SPEC-EVENT-MISSING-FIELD", event_missing, "events lack an identifier, activity or timestamp")
    report.add("SPEC-OBJECT-MISSING-FIELD", object_missing, "objects lack an identifier or object type")
    report.add("SPEC-DUP-EVENT-ID", events.loc[events["event_id"].duplicated(False), "event_id"].tolist(), "event identifiers are duplicated")
    report.add("SPEC-DUP-OBJECT-ID", objects.loc[objects["object_id"].duplicated(False), "object_id"].tolist(), "object identifiers are duplicated")
    event_ids, object_ids = set(events["event_id"].dropna().astype(str)), set(objects["object_id"].dropna().astype(str))
    dangling_e2o = e2o.loc[~e2o["event_id"].astype(str).isin(event_ids) | ~e2o["object_id"].astype(str).isin(object_ids)] if not e2o.empty else e2o
    report.add(
        "INTEG-E2O-DANGLING", dangling_e2o.index.tolist(),
        "event-object relations reference an unknown event or object",
        fix={
            "label": "Drop them",
            "caution": "This deletes the evidence of a broken extract; the extract itself is still broken.",
            "ops": [{"kind": "dropDanglingRelations"}],
        },
    )
    dangling_o2o = o2o.loc[~o2o["source_id"].astype(str).isin(object_ids) | ~o2o["target_id"].astype(str).isin(object_ids)] if not o2o.empty else o2o
    report.add(
        "INTEG-O2O-DANGLING", dangling_o2o.index.tolist(),
        "object-object relations reference an unknown object",
        fix={
            "label": "Drop them",
            "caution": "This deletes the evidence of a broken extract; the extract itself is still broken.",
            "ops": [{"kind": "dropDanglingRelations"}],
        },
    )
    report.add(
        "INTEG-O2O-SELF-REF",
        o2o.loc[o2o["source_id"] == o2o["target_id"], "source_id"].tolist() if not o2o.empty else [],
        "object-object relations point from an object to itself",
        fix={"label": "Drop them", "ops": [{"kind": "dropSelfRelations"}]},
    )
    duplicate_e2o = e2o.loc[e2o.fillna("").duplicated(["event_id", "object_id", "qualifier"], keep=False)].index.tolist() if not e2o.empty else []
    report.add(
        "INTEG-E2O-EXACT-DUPLICATE", duplicate_e2o,
        "identical event-object relation tuples appear more than once",
        fix={"label": "Deduplicate", "ops": [{"kind": "deduplicateRelations", "scope": "both"}]},
    )
    _temporal_checks(report, events, "event_id", ["event_id"], assertion_step=prepared["assertionStep"])
    _object_attribute_temporal_checks(report, events, e2o, prepared["object_attrs"])
    ctx.progress(.72, "checking structural and qualifier quality")
    _ocel_structure(report, events, objects, e2o, o2o)
    _qualifier_checks(report, events, objects, e2o)
    if params.get("includeAttributes", True):
        ctx.progress(.83, "profiling attributes")
        # `_scope` travels with the rows so a proposed repair can address the
        # relation the finding actually came from; the checks themselves still
        # group by attribute name, as an OCEL attribute name is log-wide.
        all_attrs = pd.concat([
            prepared["event_attrs"][["event_id", "name", "value"]]
                .rename(columns={"event_id": "owner"}).assign(_scope="eventAttribute"),
            prepared["object_attrs"][["object_id", "name", "value"]]
                .rename(columns={"object_id": "owner"}).assign(_scope="objectAttribute"),
        ], ignore_index=True)
        _attribute_checks(report, all_attrs, "owner", "name", "value")
        changing = []
        oa = prepared["object_attrs"]
        if not oa.empty:
            for name, frame in oa.groupby("name", dropna=False, sort=True):
                values_per_object = frame.groupby("object_id")["value"].nunique(dropna=True)
                if (values_per_object > 1).any() and frame["ts"].isna().all():
                    changing.append(_clean(name))
        report.add("ATTR-STATIC-BUT-CHANGES", changing, "object attributes have several values but no change timestamps")
        dynamic_constant = []
        if not oa.empty:
            dated = oa.loc[oa["ts"].notna()]
            for name, frame in dated.groupby("name", dropna=False, sort=True):
                if len(frame) > 1 and frame["value"].nunique(dropna=True) <= 1:
                    dynamic_constant.append(_clean(name))
        report.add("ATTR-DYNAMIC-BUT-CONSTANT", dynamic_constant, "time-stamped object attributes never change value")
    else:
        for check in ["ATTR-ALWAYS-EMPTY", "ATTR-HIGH-NULL-RATE", "ATTR-IS-IDENTIFIER", "ATTR-NUMERIC-AS-STRING", "ATTR-SENTINEL-VALUES", "ATTR-VALUE-CASE-VARIANT", "ATTR-POSSIBLE-PII", "ATTR-STATIC-BUT-CHANGES", "ATTR-DYNAMIC-BUT-CONSTANT"]:
            severity, category, name = CHECKS[check]
            report.results.append({"checkId": check, "severity": severity, "category": category, "name": name, "status": "skipped", "note": "Attribute profiling disabled", "findings": []})
    _portability_checks(report, objects)
    ctx.progress(.96, "assembling report")
    return report.payload()
