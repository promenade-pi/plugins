# Changelog

## 0.2.2

Fixed: hovering the Publish button made its label unreadable. The generic
`.ne button:hover` rule is one specificity point higher than
`.ne button.primary`, so hover repainted the primary button with the neutral
surface while its text stayed white — measured contrast 1.14. The hover rule
now restates the accent background instead of only brightening it (5.17, the
same as idle).

## 0.2.1

Publishes the net's counts (`places`, `transitions`, `totalEdges`) in the
artifact's metadata. The artifact tree builds a row's subtitle from a
provenance line plus a few known meta keys, and a net drawn from nothing has no
provenance to show — so an authored net was the one artifact in the list with
nothing under its name.

## 0.2.0

Opens an existing net. A second view, "Edit net", applies to `AcceptingPetriNet`
and `ObjectCentricPetriNet`, so a mined model can be corrected by hand instead
of redrawn.

Publishing from it makes a **new** artifact whose input is the one it was
edited from — an artifact is a node in the provenance DAG, not a file, and the
original is never touched. The button says so before you press it.

Two things the payload does not carry had to be reconstructed (`decompile.ts`):
node identity, since both compilers publish a node's *name* as its id, and
layout, since a published net has no coordinates by design. Reopened nets are
ranked by longest path and laid out in alternating columns; the panel's cached
document, now keyed by artifact, is what keeps a drawing across a close and
reopen.

## 0.1.1

Renamed to "Petri Net Editor".

Fixed: the object-type name field lost focus after every keystroke. The rows
were keyed by the type's name, so editing the name gave the row a new key and
React unmounted the input being typed into. Object types are now addressed by
position — which also makes a rename exact, where matching on the old name
merged two rows the moment a half-typed name collided with an existing one.

## 0.1.0

First release. A React Flow canvas for authoring a Petri net or an OCPN, with
object types, variable arcs, silent transitions and markings; PNML import and
export; and publishing straight into the catalog.

Needed one host change to exist at all: a package could publish only a type it
itself declared, and both net types are core, so an editor had no door. The
host now accepts a closed set of types it can validate structurally
(`HOST_VALIDATED_TYPES`), at both gates — install-time manifest validation and
the publish call — which prevents the forgery that rule guarded against
directly rather than by proxy.
