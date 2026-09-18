# Changelog

## 0.2.1

- Fixes the missing arrowhead on every arc that closes a loop. ELK returns a
  reversed edge — the back link of a cycle, laid out the other way round by
  cycle breaking and then restored — with its final bend point sitting
  exactly *on* its end point. Reading that point as the tangent gave a
  zero-length direction, so the arrowhead collapsed to a single point:
  present in the DOM, in the right place, and invisible. A two-activity
  loop therefore drew four lines and two arrows, reading as if the back
  links had no direction at all. Present in every version so far, and in
  both flow directions.

## 0.2.0

- Adds a **Flow direction** view parameter: the diagram can now run top to
  bottom as well as left to right. The layout preset is otherwise unchanged,
  so the two orientations are the same drawing, turned.
- Start/end markers carry their object-type label on whichever side the flow
  does not leave by — above a source and below a sink when running top to
  bottom — instead of always underneath, where a vertical source's outgoing
  arcs would have been drawn straight through their own label. Running top to
  bottom, a marker also reserves its label's width in the layout, so markers
  sharing a layer are spaced on what is actually drawn rather than on the
  29px circle alone.

## 0.1.11

- Drops "(React Flow)" from the view label and the package name. It was a
  disambiguator from when a second OC-DFG renderer existed; the other one is
  long disabled, so the qualifier only made the label longer than the panel.

## 0.1.10

Changelog starts here; versions before 0.1.10 were not individually tracked.

An interactive Object-Centric DFG renderer using React Flow and the same
tuned ELK layered preset as the OCPN React Flow view. Object types are
shown as coloured parallel flows and can be toggled in the in-canvas
legend.
