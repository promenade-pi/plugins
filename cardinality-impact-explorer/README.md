# Cardinality Impact Explorer

Run **Explore Cardinality Impact** on an `ObjectCentricEventLog`, then open
the report. Pick a primary object, a related object and a downstream target
object. The report visualises their relation and lets analysts test `1:1`,
`1:5`, `1:10`, `1:25`, or an exact value.

The action measures event-local type co-occurrence (how many related objects
occur with one primary object in an event) and profiles target-object lifecycle
variants, elapsed time and repeated activities. The interactive deltas are
scenario estimates anchored in those observed baselines; they are not causal
claims. Optional operational breakdowns appear when matching OCEL attributes
such as picker, warehouse/location, or customer segment exist.

This is intended for exploratory what-if discussion. Validate consequential
decisions with a controlled comparison or domain knowledge of the operational
change being modelled.
