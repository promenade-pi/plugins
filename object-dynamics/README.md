# Object Dynamics

A family of independent, object-centric exploration views over an OCEL 2.0
log. Each view below is its own Promenade View — its own manifest entry, its
own Dockview panel, its own SavedView state — not a tab inside a shared
container. Open any combination of them side by side.

See [`docs/object-dynamics.md`](../../docs/object-dynamics.md) at the repo
root for the full product concept, semantics, and architecture writeup.

## Views

| View | What it answers |
|---|---|
| Overview | Quick orientation numbers and one-click launches into the other six views. Optional — nothing else depends on it. |
| Multiplicity | How many unique objects of a type participate in each event — a matrix overview plus a per-activity/type distribution. |
| Type Signatures | Which exact sets of object types co-occur in the same events, multiplicity ignored. |
| Lifecycle Repetition | How many times an individual object repeats each activity across its own lifecycle. |
| Activity Timing | Elapsed time from one activity to a matching activity on the same object, under an explicit pairing strategy. |
| Attribute Distribution | Value distribution of an event attribute, or a dynamic object attribute resolved as of each qualifying event. |
| Attribute History | How one object's attributes evolved over time, aligned with its own events on a shared time axis. |

## Shared code (`src/lib`)

Every view is bundled independently (see `build.js`), but all of them draw
from one shared library: SQL helpers (`sql.ts`), the dynamic object-state
service (`objectState.ts` — the one place "what was this attribute's value
at time T" is implemented), attribute-type detection (`attributeKind.ts`),
chart primitives (`charts/`), selectors, summary metrics, empty states,
semantic help, and export (PNG/SVG/CSV). This is what makes the family look
and behave consistently without coupling the views to each other at
runtime.

## Isolation

Same sandboxed-view contract as `ocelot`: no host DOM, no storage, no
credentialed network. The only door to data is `promenade.sql()` — every
aggregation is computed in SQL and returned already-grouped; nothing here
fetches a raw per-event or per-object table into the browser.
