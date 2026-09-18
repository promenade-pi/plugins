# Interaction Atlas

An OCEL-native visual-analytics view of the **object interaction field**:
event-centred, lifecycle-normalized co-occurrence between object types.

Open it on an Object-Centric Event Log. The Atlas retains empty type pairs as
meaningful cells, while Pair detail provides a lifecycle-interaction tomogram,
rectangular field selection, contact coverage, multiplicity summaries,
paginated linked contact identities, deterministic representative examples, and
CSV/JSON export.

The tomogram itself is an aggregated interaction-mass field, not a scatter
plot. Its coloured activity dots are therefore placed on the lifecycle axes:
they are a stable, bounded representative activity sample with full names on
hover. A field selection changes the selected rectangle and contextual
evidence, but does not add marks to the field. **Clear field selection** stays
beside the chart status so it is available where the selection is made.

The field is also keyboard-accessible: focus the tomogram, use arrow keys to
inspect a bin, press Enter to select it, and Escape to remove the keyboard
focus bin. Native lifecycle-phase range controls below the field offer a
non-mouse way to select a rectangular phase range.

Pair detail also includes a short, data-derived reading guide and one phase
marginal for each axis. Both marginals are calculated from the complete
aggregated field, not from the bounded drill-down sample.

Absolute-lifetime median/range and the four-way multiplicity mix are likewise
exact aggregates of the active field selection. Identity-level contacts are
loaded 25 at a time and can be paged through without a hidden 500-row cap.
The four example contacts are deterministic: earliest, latest, highest event
multiplicity, and nearest to the selected field's phase centre.

**Create cohort** publishes the current pair and optional rectangular field as
an `ObjectCentricInteractionCohort` in Promenade's artifact graph. Its payload
records the source OCEL, coordinate-system version, pair, phase bounds, active
filters, and exact participating event/object identifiers. It contains no copy
of source OCEL rows.

Exports distinguish identity-level data from aggregates: **Export this page
CSV** writes the currently visible contact page, while **Export full field
CSV** writes every lifecycle-phase-bin cell of the complete aggregate,
including empty bins. **Export pair summary JSON** includes the same complete
field plus its analytical definition and pair metrics.

Within an open Atlas panel, exact detail results are retained in a bounded LRU
cache keyed by source, variant cohort, pair, field rectangle, and analytical
parameters. Returning to a field reuses the matching result; changing any of
those inputs cannot reuse a stale result. The header shows the number of
detail queries completed while a new field is calculated. **Cancel
calculation** interrupts the dedicated pending DuckDB query; it never cancels
the shared connection used by the rest of Promenade.

For large atlases, **Filter object types** reduces the visible matrix. Atlas
ordering can be alphabetical, by total interaction volume, or by a
deterministic greedy similarity order based on each type's interaction-mass
profile.

The comparison selector can use all executions after selecting a Cases &
Variants variant, a saved source-bound Interaction Cohort, or a second calendar
period. The resulting diverging field subtracts two independently normalized
interaction-mass distributions. Blue means relatively more concentrated in the
current population; red means more concentrated in the comparison population.
It is a population comparison, not a model-supported residual.
The selector receives only eligible cohort names initially; exact membership
is fetched only after one cohort is chosen.

## OCPN replay evidence

Atlas does not treat a bare OCPN as replay evidence. A source-bound
`ObjectCentricReplayEvidence` artifact must identify the source OCEL, OCPN,
replay engine and its deterministic ordering, and include event-level replay
support. Selecting it enables the **Model-supported** panel. A **Residual** is
shown only if the evidence also supplies expected interaction mass for the
current type pair and bin resolution; otherwise it remains explicitly
unavailable.

The lifetime distributions use exact raw-contact counts in logarithmic time
bins. This preserves the full selected population while keeping short and long
lifecycles readable together.

## Experimental context panels

After selecting a phase rectangle, **Follow ripple** summarizes nearby events
that touch either selected contact object within a configurable time window.
It is an object-local temporal association, never a causal statement.

**Dark Matter: opportunity gaps** explicitly counts type-pairs whose source
lifecycles overlap while both objects occur in the selected phase ranges, but
which have no observed contact in that field. These are gap candidates under
that narrow surrogate—not missing or expected events. The exact calculation is
withheld instead of sampled when either candidate side exceeds 2,000 objects.

## Lasso selections and the remainder

The normal drag gesture selects an axis-aligned phase rectangle. **Lasso bins**
instead selects every complete lifecycle-grid bin whose centre lies inside the
drawn polygon. The selection is therefore deterministic and is saved as an
exact bin mask, rather than as screen coordinates. **Invert selected bins**
uses the exact complement on the current grid.

For an active selection, the detail view shows **Selection versus remainder**:
two independently colour-scaled tomograms of the selected observations and
all remaining observations for the same type pair and active filters. Their
mass and raw-contact totals are exact complements. Follow ripple accepts both
selection forms; Dark Matter stays restricted to rectangular phase ranges,
because a lasso bounding box would silently change its opportunity definition.

Published lasso cohorts use the host-managed `interaction-cohort-v1` protocol.
Any compatible view receives only source-bound candidates and must state how
their exact event/object membership maps to its own visualization. The first
consumer, Performance Spectrum, uses selected events as the source side of
directly-follows segments; it does not reinterpret the lasso as screen space.

The analytical semantics and limitations are in
[docs/analytical-semantics.md](docs/analytical-semantics.md).

## Development

`npm test` verifies the DOM-free calculation kernel. `npm run package` builds
the single sandbox script and produces the `.pmplugin` archive.
