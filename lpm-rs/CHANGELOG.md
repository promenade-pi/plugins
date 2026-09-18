# Changelog

## 0.1.3

- The 0.1.2 fix was incomplete: `defaultFromOptions` only resolves once an
  `optionsFrom` control actually mounts (a view, or a param panel opened
  *before* running) — clicking the action straight from "Available actions"
  runs it immediately with only the schema's static `default` values
  (`host/actions/registry.ts`'s `defaultParams`), so `objectType` was still
  unbound on that path. Reproduced the exact reported error this way.
  Fixed properly: `objectType` now has a static `"default": ""`, and
  `project-oc.sql` treats an empty value as "use the single most frequent
  object type" via a small fallback CTE, so a first, unconfigured run always
  binds `:objectType` to something.

## 0.1.2

- Fixed `run.promenade.lpm.discover-oc` / `project-oc`: the `objectType`
  param (data-bound via `optionsFrom`, no static default) had no
  `defaultFromOptions`, so a user who ran the action without first touching
  the dropdown got `missing value for parameter ":objectType"` — the
  internal projection's SQL bind failing before it ever ran. Added
  `"defaultFromOptions": "first"` to both declarations, matching the pattern
  already used elsewhere in the app (`dotted-chart`, `ocel-cases-variants`)
  for exactly this situation.

## 0.1.1

- Fixed `run.promenade.lpm.to-net`/`to-ocpn`: the `AcceptingPetriNet`/
  `ObjectCentricPetriNet` wire shape uses snake_case field names
  (`place_to_transition`, `initial_marking`, ...) and a required
  `activities` (transition index list) field — this crate's own camelCase
  convention had leaked into it, so `petrinet-layered` rendered places with
  no transitions or arcs at all. Found by actually opening the rendered
  diagram, not just validating the JSON's own internal consistency.

## 0.1.0

Initial release.

- `run.promenade.lpm.discover` — Local Process Model discovery over a
  Traditional Event Log: recursive process-tree search (sequence, exclusive
  choice, parallel, inclusive choice, loop), scored by alignment-based
  support, confidence, determinism, language fit and coverage.
- `run.promenade.lpm.to-net` — recompiles one ranked fragment into a plain
  Accepting Petri Net, viewable with any existing Accepting Petri Net
  renderer.
- `run.promenade.lpm.project-oc` / `discover-oc` — the same search against an
  Object-Centric Event Log, flattened by one selected object type.
- `run.promenade.lpm.combine-oc` — merges two per-object-type results into
  object-centric fragments, flagging variable arcs.
- `run.promenade.lpm.to-ocpn` — recompiles one merged fragment into an
  Object-Centric Petri Net.
- `run.promenade.lpm.ranking` view — a sortable, filterable, colour-coded
  table over the discovered fragments.

Ports Tax, Sidorova, Haakma & van der Aalst's `LocalProcessModelDiscovery`
(the process-tree search, not the newer SPECpp/place-combination approach)
and the object-centric layer from `ObjectCentricLPMs` (simplified to
per-object-type flattening rather than the full case-notion machinery). See
`docs/algorithm.md` for exactly what is and isn't a literal port.
