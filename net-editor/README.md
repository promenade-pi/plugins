# Petri Net Editor

Draw a Petri net or an object-centric Petri net by hand — or open one that
already exists and edit it — and publish it as an artifact.

One canvas covers both, because a Petri net *is* the object-centric net with no
object types. Declare none and the editor publishes an `AcceptingPetriNet`;
declare one and places and arcs gain a type, arcs can be marked variable, and
it publishes an `ObjectCentricPetriNet`.

## What it enforces before you publish

The host validates every published payload — a plugin frame is untrusted — but
its errors are about the payload, and by then you have lost the connection
between "arc a7's object type does not match place p3's" and the arc you just
drew. So the same rules are checked here, said about the thing on screen:

- every arc runs between a place and a transition;
- an arc and the place it touches carry the same object type (drawing an arc
  takes the place's type, and retyping a place retypes its arcs, so this is
  hard to break on purpose);
- a silent transition belongs to **exactly one** object type — a τ in an OCPN
  is per-type routing, and one shared across types has no meaning;
- a transition's object types come from its arcs and are shown, never edited.

## Editing an existing net

"Edit net" applies to `AcceptingPetriNet` and `ObjectCentricPetriNet`, so a
mined model can be corrected rather than redrawn.

Publishing from it makes a **new** artifact whose input is the one it was
edited from. That is not a limitation to work around: an artifact is a node in
a provenance DAG, and a model that silently changed under everything derived
from it would make those derivations lies. The button says so before you press
it.

Two things the payload does not carry are reconstructed on the way in:

- **Identity.** Both compilers publish a node's *name* as its id, so reading
  one back mints fresh internal ids and keeps the published id as the name. The
  id a node arrived with is then kept when it is published again — a miner's
  transition id is routinely not its activity (`t:Collect Goods` against
  `Collect Goods`), and `ocpn.ts` makes that id the mechanism by which two
  object types share a transition. Republishing under freshly derived ids would
  quietly turn an edited net into a different net. Renaming a node does release
  its id, because the id named the thing that was renamed.
- **Layout.** A published net has no coordinates, on purpose. A reopened net is
  ranked by longest path and laid out in alternating columns; the panel's own
  cached document, keyed by artifact, is what keeps your arrangement across a
  close and reopen.

## PNML

Reads and writes PNML. Our own files round-trip exactly, positions included.

PNML has no object-centric grammar, so the object types travel in a
`<toolspecific>` block — the same thing OCPN Studio does with its colour sets.
Reading someone else's file keeps the structure, names and positions, and
adopts each place's `<colorSet>` as an object type **verbatim**: a product
colour set such as `AircraftxGate` arrives as a type of that name for you to
split or rename, because guessing at the decomposition would invent a model the
file does not contain. Guards, code segments, priorities and extra pages are
reported as import notes rather than silently dropped.

Unlike Promenade's own OCPN export, this one writes `<graphics>` positions: an
authored net has a layout its author chose and will expect back.

## Layout

The canvas arrangement is kept in the panel's own cached state, not in the
artifact. A published net carries no coordinates by design — layout is view
state, recomputed by whichever viewer opens it — so reopening the editor
restores your arrangement while the artifact still lays out automatically
elsewhere.
