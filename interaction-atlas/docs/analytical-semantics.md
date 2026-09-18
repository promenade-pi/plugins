# Interaction Atlas analytical semantics

## Object interaction field

For object types `A` and `B`, an interaction observation is an event `e` and
two objects of those types related to `e`. Different-type cells contain every
cross-type combination. A diagonal cell contains each unordered pair of
distinct same-type objects exactly once; an object is never paired with itself.

For a timestamped event `e` related to object `o`, the lifecycle coordinate is
`(t(e)-tmin(o)) / (tmax(o)-tmin(o))`. A single-timestamp lifecycle is placed at
0.5. The deterministic bin for phase `p` is `min(floor(p*n), n-1)`, so phase
1.0 enters the last bin. Repeated events at the same timestamp remain separate
observations. Event identifiers provide deterministic ordering when an order is
needed.

**Object-pair mass** assigns one unit to every observation. **Equal event
mass** divides an event's unit mass by `|Re,A| |Re,B|`, or by `choose(|Re,A|,2)`
on the diagonal. Thus every participating event contributes one unit per
object-type pair, independently of batch size.

Directional coverage is the fraction of active-population objects of one type
that co-occur with at least one object of the other type. It is deliberately
directional although the field itself is transposable: `muA,B(x,y) =
muB,A(y,x)`.

## Filters, quality, and limits

Activities and calendar ranges filter interaction events. With **fixed**
lifecycle bounds, bounds come from all timestamped source relations; with
**recomputed** bounds they come only from the active population. Invalid or
missing timestamps are reported and excluded rather than ordered or imputed.
Zero-duration objects can be excluded or included at phase 0.5.

Aggregation is a DuckDB query executed by Promenade's data worker, so the
frame receives binned summaries rather than constructing all pairs on the UI
thread. Identity-level contacts are fetched in deterministic 25-contact pages;
their count, activity context, lifetime summaries, and aggregate mass are
computed over the complete selected population and are never truncated.

The currently saved view configuration is the manifest parameter state plus a
small serialized field selection in the panel cache. A rectangular selection
stores `{ typeA, typeB, phase bounds }`; a lasso stores a grid resolution and
the exact indices of its selected bins. CSV exports contain identities only for
the selected observations; attributes are not exported. Pair JSON records
schema version, source artifact, parameters, bin field, selection, and
warnings. Display scale is visual-only and is not an analytical transformation.

## Field selection and remainder

A rectangular field selects observations whose two lifecycle phases lie in the
inclusive selected ranges. A lasso is evaluated against the centres of the
complete, deterministic lifecycle bins and selects the resulting discrete bin
mask. This makes a lasso stable across rendering, persistence, export, and
cohort materialization. Its inversion is the complement of that mask across
the complete `n × n` lifecycle grid.

The selection-versus-remainder comparison partitions the same active
type-pair population into `selected` and `not selected` before aggregation.
Both panes retain the normal weighting and phase semantics; they use separate
colour scales so sparse remainder structure remains visible. The displayed
mass and raw-contact totals are exact, disjoint complements under the active
filters.

## Extension points and constraints

The lifecycle provider has descriptor `{ kind: "lifecycle-phase", version: 1
}`. A later coordinate provider must map event/object identities through a
documented replay, alignment, or other semantic correspondence; screen
coordinates from unrelated model views are not valid coordinates. Model-aware
panels require the source-bound replay-evidence contract below.

## Experimental contextual analyses

Both experimental panels require an active selected field. Follow ripple
supports both rectangular and lasso-bin fields. Dark Matter requires a phase
rectangle because its opportunity surrogate is defined in terms of two phase
ranges; it is deliberately withheld for lassos rather than approximated by a
bounding box. Neither panel is a model residual, test of significance, or
causal explanation.

**Follow ripple** takes every selected interaction as an anchor. A neighbouring
event must touch either object of that anchor and occur within the configured
calendar-time window (default ±24 hours). The panel counts distinct
anchor-to-neighbour links grouped by before/after/same timestamp and activity.
It may describe temporal association in the same object's local context; it
does not establish that an interaction caused a neighbouring event.

**Dark Matter: opportunity gaps** uses one deliberately narrow, explicit
opportunity surrogate. A type-A/type-B object pair is eligible when both
objects occur in the selected phase ranges and their complete source lifecycle
intervals overlap in calendar time. A pair with no selected-field contact is a
gap candidate. It is not an unrecorded, omitted, or "missing" event, nor an
expected contact. To avoid a sampled result, the exact cross-product is only
calculated when each candidate side has at most 2,000 objects; otherwise the
panel reports that it is unavailable.

Peer-expected absence, opportunity thresholds, uncertainty estimates, and a
generative contact model remain intentionally outside this panel.

## OCEL executions and variants

Promenade's **Cases & Variants (OCEL)** view already implements the
process-execution and variant semantics introduced by Adams, Schuster,
Schmitz, Schuh, and van der Aalst. In particular, it extracts executions by a
chosen leading type or connected components, then groups their activity- and
object-count-labelled directly-follows graphs by isomorphism. Interaction
Atlas must use that established meaning when it later offers conditioning by
execution or variant; an arbitrary clustering of field shapes is instead an
**interaction regime** or an **OC-variant cohort**, not a Super Variant.

## Cohort conditioning through OCEL execution partitions

Interaction Atlas can also open a source-bound
`ObjectCentricExecutionPartition` published by Cases & Variants. The partition
records Adams-style extraction parameters and exact execution/variant event
memberships. Selecting a variant conditions the interaction-event population
to the union of those event ids; it does not rename that grouping, recompute a
different variant notion, or copy OCEL rows. Lifecycle bounds are still
calculated from the source OCEL under the existing fixed/filtered-bound rules.

With a selected variant, **Compare with all executions** calculates the same
pair field for both populations. Each cell is divided by that population's
total interaction mass before the all-executions field is subtracted from the
variant field. This prevents a larger population from looking different merely
because it has more observations. The resulting signed field is descriptive;
it is not a replay residual, significance test, or Super Variant.

The same selector accepts a stored `ObjectCentricInteractionCohort` with the
same canonical source OCEL, or a second calendar interval. Cohort membership
and comparison event ids remain source-bound. Calendar comparison applies the
same object/activity/lifecycle/multiplicity settings as the current field, but
replaces only its time interval. It is therefore a controlled descriptive
population comparison, not a causal or model-based claim.

The current contract is schema version 1. Payloads through 8 MiB are inline;
larger partitions are materialized as JSON in OPFS and the catalogue records
only the storage reference. Membership is exact in both cases.

## Published interaction cohorts

**Create cohort** publishes an `ObjectCentricInteractionCohort` directly under
its canonical source OCEL. Version 1 contains the selected type pair, optional
phase rectangle, coordinate-system version, active analytical filters, exact
event and object memberships, and raw contact count. It is membership and
provenance data—not a filtered copy of OCEL rows. Publication is host-validated
and uses inline storage through 8 MiB. Larger cohorts are materialized as JSON
in OPFS, retaining the exact membership while keeping the catalogue compact.

An exact lasso cohort additionally participates in the host-managed
`interaction-cohort-v1` selection protocol. A receiving view opts in through
its manifest, sees only cohorts bound to the canonical source OCEL, and reads
the payload through a host-validated bridge. The protocol transfers event and
object membership plus the discrete bin mask—not pixels or a coordinate
transform. Consumers must document their own mapping from membership to view
semantics; for example, Performance Spectrum selects outgoing segments whose
source event belongs to the cohort.

## OCEL/OCPN replay evidence

`ObjectCentricReplayEvidence` version 1 is the only model-aware input Atlas
accepts. It names the canonical source OCEL and OCPN model, records the replay
engine/version and timestamp-total-order policy, and provides one replay
support value plus log/model move counts per event. This enables a
model-supported summary, but not a residual.

An optional expected field has a concrete type pair, deterministic bin count,
and non-negative expected mass for every lifecycle bin. Only that explicit
expectation permits the observed-minus-expected residual display. Atlas
normalizes both masses before subtracting and labels the display as a mass
difference, not a significance score. A bare OCPN, an incomplete replay, a
foreign source, or support-only evidence can never activate the residual.
