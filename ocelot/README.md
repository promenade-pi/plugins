# OCEL 2.0 Inspector

Object-centric log exploration, ported from [Ocelot](https://github.com/rwth-pads/ocelot)
(rwth-pads) into five views. Every table here pages real SQL — nothing is
loaded into the browser wholesale, unlike Ocelot's own in-memory arrays.

Ships installed by default and its Overview is `primary` for
`ObjectCentricEventLog` (see `ViewDef.primary` in `host/views/registry.ts`):
it is the view an OCEL artifact opens to by default, standing in for the
core Overview (still the default for XES logs, untouched), and it does not
appear as a separate row in the Inspector's Views list — there is nothing
to choose, it is just what the artifact opens to.

## Views

| View | What it shows |
|---|---|
| Overview (`primary`) | Object/event type and instance counts, time range, timing profile, structural stats, object-type and event-type breakdowns, an event-type × object-type relation matrix, and a per-object-type process-behaviour table (variants, spread, most common path). |
| Object Types | A React Flow graph of declared object types — draggable nodes, colored by declared attribute type. Two independently toggleable edge kinds: object-to-object relation counts, and how often two types co-occur on the same event. A type filter and a graph/list toggle live in the toolbar. |
| Objects | A table per object type — declared attributes (with a full change-history dialog for time-varying ones), relationship chips, and a row action that opens a side panel with an object preview, or the full lifecycle view: current attributes, a merged event/attribute-change timeline, and a multi-hop relationship graph that includes both objects and events. |
| Event Types | The same graph, for event types — filterable by which object types to relate against. |
| Events | A table per event type — declared attributes and the event's object relationships. |

## Isolation

Runs behind an opaque origin: no host DOM, no storage, no credentialed
network, no panel handle. The only door to data is `promenade.sql()` — every
table page is a `LIMIT`/`OFFSET` query plus a separate count query, and every
per-row extra (an attribute's full history, a side panel's recent events, an
object's own timeline/relations) is fetched only when actually opened.

Written in React, bundled per view with esbuild into one classic-script IIFE
each (same toolchain as `ocpn-flow-view`) — the plugin boundary otherwise
presumes no framework, but two of these five views need React Flow either
way, and the other three (routing, pagination, side-panel state) are far
more naturally React state than hand-rolled DOM diffing.
