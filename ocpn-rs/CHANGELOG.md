# Changelog

## 0.2.6

- Action renamed to "Discover OCPN (Rust)". With the pm4py discovery plugin
  installed there are two actions producing an Object-Centric Petri Net, and
  which algorithm ran is the difference that matters — it was previously
  legible only from the package name in the byline.

## 0.2.5

Changelog starts here; versions before 0.2.5 were not individually tracked.

Discovers an Object-Centric Petri Net from an OCEL 2.0 log: per selected
object type, project the log, mine a process tree with Inductive Miner,
convert it to a Petri net, then merge every object type's net by shared
activity. One action, selectable directly on the OCEL log — the
projection this needs runs transparently as its own internal stage.
