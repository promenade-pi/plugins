"""Inductive Miner (pm4py) — example packaged Python plugin.

Two actions from one module:

    discover      TraditionalEventLog -> ProcessTree
    toPetriNet    ProcessTree         -> AcceptingPetriNet

The split is not cosmetic. The inductive miner *computes* a process tree; the
Petri net is a translation of it. Producing only the net threw away the
intermediate result the algorithm actually derives, and made the tree — the
thing you look at to understand what the miner decided — unavailable.

Each action names an `entryPoint` in the manifest, which selects the
`prepare_<x>` / `finalize_<x>` pair below. The two-stage contract is the
host's, not this plugin's invention:

    prepare(ctx)                  expensive, parameter-independent; cached
    finalize(prepared, params, c) cheap, re-run on every parameter change

Data reaches Python only through `ctx.sql()` — except for an artifact another
action produced, which arrives as `ctx.input` in exactly the shape its
producer returned. There is no file access and no artifact deserialisation.

This plugin does not know that a process tree viewer exists. It declares what
it produces; the host matches that against what is installed, and against what
the registry offers.
"""

import pm4py
import pm_plugin


# --------------------------------------------------------------- discovery


async def prepare_discover(ctx):
    """Fetches the log once and puts it in the shape pm4py expects.

    `{event}` expands to the artifact's event view; `{maxEvents}` comes from
    the action's parameters. Ordering belongs in SQL, where the data is.
    """
    ctx.progress(0.1, "querying the log")
    df = await ctx.sql(
        """
        SELECT trace_idx, activity, ts
        FROM {event}
        WHERE ts IS NOT NULL
        ORDER BY trace_idx, ts, event_idx
        LIMIT {maxEvents}
        """
    )
    fetched = len(df)
    ctx.log(f"fetched {fetched} events")

    # A second, cheap aggregate — not a bigger fetch reshaped into rows — so a
    # run truncated by {maxEvents} can be told apart from a log that is
    # genuinely that small. Without it, a truncated run looks identical to a
    # complete one downstream: same fields, same shape, just quietly missing
    # whatever behaviour lived past the cutoff (an infrequent activity, most
    # visibly — noise filtering is computed against whatever slice of the log
    # it is given, and a slice's frequencies are not the full log's).
    total = int((await ctx.sql(
        "SELECT COUNT(*) AS n FROM {event} WHERE ts IS NOT NULL"
    ))["n"].iloc[0])

    df = df.rename(
        columns={
            "trace_idx": "case:concept:name",
            "activity": "concept:name",
            "ts": "time:timestamp",
        }
    )
    df["case:concept:name"] = df["case:concept:name"].astype(str)

    ctx.progress(0.5, "formatting for pm4py")
    return {"log": pm4py.format_dataframe(df), "fetched": fetched, "total": total}


def finalize_discover(prepared, params, ctx):
    """Discovers a process tree.

    Returns structure, not a picture: the host draws it, or a viewer plugin
    does. pm4py's graphviz rendering is unavailable in the browser anyway —
    the `dot` binary cannot exist there — and a plugin that produced images
    could not be re-styled, re-coloured or made selectable by the host.
    """
    noise = float(params.get("noiseThreshold", 0.0))
    ctx.progress(0.7, f"inductive miner (noise {noise})")

    tree = pm4py.discover_process_tree_inductive(prepared["log"], noise_threshold=noise)
    result = pm_plugin.process_tree(
        tree,
        stats={
            "noiseThreshold": noise,
            "events": prepared["fetched"],
            "totalEvents": prepared["total"],
            "truncated": prepared["fetched"] < prepared["total"],
        },
    )
    ctx.log(
        f"discovered {result['stats']['nodes']} nodes "
        f"({result['stats']['operators']} operators, {result['stats']['leaves']} leaves)"
    )
    return result


# ------------------------------------------------------------- conversion


def prepare_to_petri_net(ctx):
    """Reads the input tree.

    Cheap, but it is still the expensive stage of this action's two-stage
    contract — and it is what gets cached when the (currently empty) parameter
    set changes.
    """
    payload = ctx.input
    if payload is None:
        raise ValueError("no process tree on the input")
    ctx.progress(0.4, "reading the process tree")
    return pm_plugin.parse_process_tree(payload)


def finalize_to_petri_net(prepared, params, ctx):
    """Converts the tree into an accepting Petri net.

    `pm4py.convert_to_petri_net` returns net, initial and final marking; the
    host models those as one `AcceptingPetriNet` artifact, because three
    provenance nodes for one result is noise and the markings mean nothing
    without the net.
    """
    ctx.progress(0.7, "converting to a Petri net")
    net, im, fm = pm4py.convert_to_petri_net(prepared)
    result = pm_plugin.petri_net(net, im, fm)
    ctx.log(f"{len(net.places)} places / {len(net.transitions)} transitions")
    return result
