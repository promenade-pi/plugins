# Changelog

## 0.1.0 — 2026-08-18

Initial release. Discovers an `ObjectCentricPetriNet` via
`pm4py.discover_oc_petri_net`, run in Pyodide — the same artifact type
`run.promenade.ocpn` (Rust) produces, so either of the installed OCPN
viewers renders it. One action, `ObjectCentricEventLog` in directly, no
internal projection stage (pm4py handles every object type itself).
