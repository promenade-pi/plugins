# OCEL Builder

Writes a small OCEL 2.0 log by hand and publishes it as a top-level artifact —
the "hello world" log that teaching, testing a plugin, or filing a reproducible
bug report needs, without leaving Promenade to write JSON.

Two ways in:

- **New OCEL 2.0 log…** — from the **Artifacts** panel (the panel menu, or the
  buttons under the tree). Needs no artifact selected: it is the thing that
  makes one.
- **Edit log** — a view of an existing OCEL 2.0 log. It loads that log into the
  same editor and publishes the result as a **new** artifact that records the
  one it came from. Nothing is edited in place: artifacts here are immutable,
  and rewriting one would invalidate everything already derived from it.

## Schema first

The **Types** tab comes first because everything else follows from it. Declare
the log's *event types* (an event type is an activity) and *object types*, each
with its attributes and each attribute's value type — `string`, `integer`,
`float`, `boolean` or `time`, exactly the set OCEL 2.0 declares.

What that buys, immediately:

- the `activity` and `object_type` columns complete from the declared types;
- the Events and Objects sheets get one column per declared attribute, so
  attributes are never invented in a grid header;
- a row only has the attribute cells **its own type** declares — the rest are
  hatched and cannot be typed into, pasted over or filled;
- values are checked against their declared type as you type (`quantity` is an
  integer, `express` is true/false), and the **form** beside the grid renders
  the right control per type: a number field, a true/false choice, a date-time
  picker;
- the published artifact states its schema in `meta.semantics`, the way an
  imported OCEL 2.0 file does — rather than having it guessed back out of the
  rows.

Renaming a type or an attribute carries the rows that use it along, so a rename
is an edit and not a trap.

## Linking rows without leaving them

Every row on the Events and Objects sheets ends in a small ⛓ button. It opens
a dialog scoped to that one row: what it is already linked to (E2O for an
event, O2O for an object), with each relation's qualifier editable inline and
a remove button, and a form to add one more — pick an existing object by id,
or declare a new one on the spot (its type, an id pre-filled from
`o1`-style suggestion and still editable) and link it in the same step. The
new object lands on the Objects sheet exactly as if it had been typed there.

This is the fast path for "this event also touches that object" without
opening the E2O sheet and typing both ids by hand. The E2O/O2O sheets remain
the fast path for entering many relations at once — copy/paste, the fill
handle — the two are complementary, not a replacement for each other.

## The sheets

| Sheet | Columns | Notes |
| --- | --- | --- |
| Events | `event_id`, `activity`, `ts` + the event type's attributes | `ts` is ISO 8601 and optional. |
| Objects | `object_id`, `object_type` + the object type's attributes | Static values — one per object. |
| Changes | `object_id`, `attribute`, `ts`, `value` | Object attribute values that change over time. |
| E2O | `event_id`, `object_id`, `qualifier` | Which objects an event touches, and in which role. |
| O2O | `source_id`, `target_id`, `qualifier` | Relations between objects. |

### A tab per type

Under **Events** and **Objects** sits a tab per declared type — no "All" tab.
A type's own tab shows only that type's rows, only that type's attribute
columns, no type column (it would be one repeated value) and no unavailable
cells — a row typed there already belongs to that type. There is one more
tab, **Other**, which appears only when it is needed: rows whose type is
blank or not (yet) declared — the same rows `validate` calls "not a declared
type" — so a stray row always has somewhere to be seen and fixed, without a
table of every type at once to sift through to find it. Before any type is
declared, Other is the only tab there is; it disappears again as soon as the
last stray row is declared or removed.

### Attributes that change

An object attribute in OCEL 2.0 is not necessarily static — an order's
`status` has values, not a value. The **Changes** tab (under Objects) is where
those live: one row per value, with the moment it took effect. The `value` cell
is typed by whichever attribute the row names, so `quantity` still wants a
whole number there, and the attribute column completes to that object's own
type's attributes.

An attribute is either static or timed, never both: once an attribute of an
object has a Changes row, its static cell on the Objects sheet is locked (and
if one was already filled in, a warning offers to clear it). That is what the
published log carries — a static value has no timestamp, a timed one has the
timestamp it took effect.

## Editing

- **Keyboard** — arrows move, `Tab`/`Shift+Tab` across, `Enter` edits and moves
  down, typing replaces a cell, `Esc` cancels, `Delete` clears the selection,
  `Cmd/Ctrl+Z` undoes.
- **Fill handle** — drag the small square at the corner of the selection to
  continue a pattern: `o1` → `o2, o3…`, `order-08` → `order-09`, two seed cells
  set the step (`e1, e3` → `e5, e7`), timestamps continue by their own interval
  (or an hour from a single cell) in the format you typed them. Anything else
  repeats, so a two-cell `Order / Item` seed fills a type column in one drag.
- **Autocomplete** — every id, type and qualifier column completes from what
  exists: an E2O row can only complete to an object you have actually created,
  the `activity` and `object_type` columns to a type you have declared, a
  boolean attribute to `true`/`false`. Qualifiers complete from what you have
  typed anywhere, since OCEL declares no qualifier vocabulary. `↓`/`↑` pick,
  `Enter`/`Tab` accept.
- **Paste** — paste TSV straight from Excel, Numbers or Sheets; rows are added
  as needed. Copy works the same way, so a selection round-trips.
- **Form** — the panel beside the grid edits the active row through typed
  controls, showing only the fields its type declares. The grid is the fast way
  to enter many rows; the form is the precise way to enter one. It hides itself
  when the panel is too narrow to earn the width.
- **Search and paging** — a sheet past 200 rows gets a search box (matching any
  cell) and a pager. Both compose with the per-type tabs, and a new row can
  only be typed where the sheet actually ends.

The footer validates as you type: duplicate ids and duplicate declarations,
missing required cells, unparseable timestamps, values that contradict their
declared type, rows naming an undeclared type, and relations pointing at events
or objects that do not exist — the last two with one-click *Declare N types* /
*Add N objects* repairs. Warnings (an event relating to no object, an object
appearing in no event, a declared type nothing uses) are legal OCEL but usually
a slip, so they never block publishing. Errors do.

A half-written log survives closing its tab: the editor keeps its document in
the host's per-panel plugin state — and for **Edit log** that cached edit wins
over reloading the log, so an interrupted edit is not lost.

## Editing an existing log, and its limit

*Edit log* loads the whole log into the panel: undo, validation, referential
repair and publishing all reason about the log as one value. That is what makes
hand-editing feel like a document rather than a database, and it is why there
is a cap — 25,000 events or objects. Past it the panel says so and names the
counts instead of loading, because the honest answer for a log that size is not
a slow editor: a transformation that *describes* the change is both faster and
reproducible, which hand-editing is not.

Loading is lossless by design. An attribute present in the rows but missing
from the log's declared schema is declared on load, with its value type
inferred from the values (a column of whole numbers becomes `integer`, mixed
text stays `string`), so nothing is silently dropped on the way back out — a
log loaded and published unchanged is the same log, with the source recorded in
its provenance.

## What it publishes

`Create OCEL log` hands the rows to the host's `promenade.publishLog()`, which
validates them again, writes real Parquet and registers the result as an
`ObjectCentricEventLog`. A log written from scratch is a root of the provenance
DAG, exactly like an imported one; a log from *Edit log* is a child of the log
it was edited from, so the DAG says which came first. Every OCEL-consuming
action and view (OCPN discovery, the metro map, notebooks, OCEL export) then
works against either unchanged, because there is nothing about them that says
they were typed rather than imported.

## Plugin API this relies on

Two generic host capabilities, neither specific to this plugin:

- `views[].standalone` — a panel that is not a view *of* an artifact, opened
  from the workspace's "New" affordance. Nothing is selected when you start
  writing a log, so nothing can be applied to.
- `views[].publishes: ["ObjectCentricEventLog"]` — the manifest declaration
  that entitles a view to call `promenade.publishLog()`, whether it is
  standalone or bound to an artifact. The host validates every row, the
  declared schema and the claimed provenance before anything is written;
  declaring the capability buys the right to ask, not to be believed.

The publish request itself grew two fields for this release, both host-side:
`objectChanges` (timed object attribute values) and `source` (the log an edit
came from — checked against the artifact the frame is actually bound to, so a
plugin cannot claim provenance it was never given).
