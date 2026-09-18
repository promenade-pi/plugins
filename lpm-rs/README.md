# Local Process Models

Discovers **Local Process Models**: small, frequently-recurring Petri-net
fragments over a subset of a log's activities — a pattern that occurs
several times inside a bigger, possibly spaghetti-like process, rather than
a whole-process model.

## Actions

- **Discover Local Process Models** — Traditional Event Log in, a ranked
  `LocalProcessModelSet` out.
- **Local Process Model → Petri Net** — recompiles one ranked fragment into
  a plain Accepting Petri Net (set the "Fragment rank" param to the row you
  want; rank 0 is the top result), so any existing Accepting Petri Net
  viewer (e.g. the bundled Petri Net / React Flow renderer) can draw it.
- **Discover Local Process Models (object-centric)** — the same search for
  one object type of an Object-Centric Event Log at a time (it flattens the
  log by that type first). Run it once per object type.
- **Combine Local Process Models across object types** — merges two
  per-object-type results into object-centric fragments, flagging
  (activity, object type) pairs that often relate to more than one object as
  variable arcs.
- **Local Process Model → Object-Centric Petri Net** — recompiles one merged
  fragment into an Object-Centric Petri Net.

## View

The **Local Process Models** view is a sortable, filterable table: rank,
the fragment's operator notation and activities (coloured, click a row to
select those activities elsewhere in the app), and every score. It does not
draw its own Petri-net diagram — use the "→ Petri Net" / "→ Object-Centric
Petri Net" actions above and an existing net viewer for that, so this
plugin doesn't duplicate rendering work that already exists elsewhere in the
app.

See `docs/algorithm.md` for what's ported from ProM's
`LocalProcessModelDiscovery` / `ObjectCentricLPMs`, what's simplified, and
what's out of scope.
