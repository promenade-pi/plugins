# Changelog

## 0.4.0

- **No more "All" tab.** Events and Objects now show one tab per declared
  type plus, only when needed, an **Other** tab for rows with no declared
  type. A table holding every type at once was the thing that made the
  sheet confusing; there is no view that mixes them any more.
- **Every validation issue now names the rows it's about** (`Issue.rows`).
  "Go" jumps to the exact tab an offending row lives on instead of a generic
  section, and each type tab gets its own error dot.
- **A "+ relation" button on every Events/Objects row** opens a small dialog:
  what that row is already linked to, with qualifiers editable inline and a
  remove button, and a form to link an existing object or create one on the
  spot (type + a suggested, editable id) — without leaving the row for the
  E2O/O2O sheet.

## 0.3.0

- **A tab per type.** Under Events and Objects, each declared type gets its own
  tab beside *All*: only its rows, only its own attribute columns, no type
  column, no unavailable cells — and a row typed there is already of that type.
- **Object attributes that change over time.** A new Changes tab records the
  values an object attribute took and when, the way OCEL 2.0 allows. The
  `value` cell is typed by the attribute the row names; an attribute is either
  static or timed, so a timed one locks (and offers to clear) the static cell
  it replaces. The host learned to write these as `object_attr` rows carrying
  their `ts`.
- **Edit log.** A second view, bound to an existing OCEL 2.0 log: it loads the
  log into the same editor and publishes the result as a new artifact whose
  provenance records the log it came from. Loading is lossless — undeclared
  attributes are declared with an inferred value type — and capped at 25,000
  events or objects, past which the panel explains why hand-editing is the
  wrong tool.
- **Search and paging** per sheet, composing with the per-type tabs.

## 0.2.1

Header layout: at panel width the *Create OCEL log* button wrapped onto three
lines. The buttons now stay on one line and the name field shrinks first.

## 0.2.0

Schema first. A new **Types** tab declares the log's event types and object
types with their typed attributes (`string` / `integer` / `float` / `boolean` /
`time`), and everything else follows from it:

- the Events and Objects sheets derive their attribute columns from the
  declarations, replacing the old "+ add an attribute column" header control
  (which also opened an overwide text field and lost the keystrokes that
  followed it to the grid);
- a row only has the attribute cells its own type declares; the rest are
  hatched and reject typing, pasting and filling;
- values are validated against their declared type, and a new typed **form**
  beside the grid edits the active row with a control per value type;
- renaming a type or attribute carries the rows and values that use it along;
- the published log states its schema in `meta.semantics`, as an OCEL 2.0
  import does, instead of having it inferred from the rows;
- the fill handle respects declarations: a boolean attribute repeats rather
  than counting, a `time` attribute continues like a timestamp column.

The workspace entry is now called *New OCEL 2.0 log…*.

## 0.1.0

First release. A four-sheet spreadsheet (Events / Objects / E2O / O2O) for
writing an OCEL 2.0 log by hand, with keyboard navigation, range selection, a
pattern-continuing fill handle, TSV copy/paste, per-column autocomplete over
the ids and vocabulary the log already contains, live referential validation
with one-click repairs, and publishing as a top-level `ObjectCentricEventLog`
artifact through the host's `promenade.publishLog()` capability.
