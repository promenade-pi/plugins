# OCPN Comparison

Select two `ObjectCentricPetriNet` artifacts and run **Compare OCPNs**. The
artifact opened afterwards is a report, not merely an image diff.

For each object type the plugin:

- abstracts silent (`τ`) transitions and compares the resulting visible
  directly-follows relations;
- compares the visible-activity reachability profile (precedes, cyclic, or
  unrelated for each activity pair);
- enumerates bounded visible variants in both directions, reporting baseline
  coverage in the candidate and candidate coverage in the baseline;
- reports object-type, shared-activity, variable-arc, and structural deltas.

This deliberately tolerates harmless converter differences such as additional
silent boundary transitions. It is a topology-based footprint comparison, not
an exact claim that two nets have the same firing language.

## Scientific basis and scope

Behavioural profiles are a well-established way to describe whether two tasks
can occur in order, in reverse order, or without an observable ordering. This
plugin applies that idea separately to each OCPN object-type projection after
τ-abstraction. It also adopts the reciprocal perspective of conformance:
reporting what the baseline exhibits that the candidate lacks *and* the other
direction, rather than reducing the result to one asymmetric score.

Exact Object-Centric Petri Net conformance is substantially harder. Gianola,
Montali and Winkler formulate identifier-aware OCPN alignments with
synchronisation as an SMT problem. That requires net firing semantics,
object identifiers, and a solver; it is intentionally not hidden behind this
browser report's percentage figures. The report labels its bounded graph-walk
coverage as an approximation and records its bounds.

References:

- Weidlich, Polyvyanyy, Mendling and Weske (2011), *Causal Behavioural
  Profiles – Efficient Computation, Applications, and Evaluation*,
  Fundamenta Informaticae, 113(3–4), 399–435.
- Gianola, Montali and Winkler (2023), *Object-Centric Conformance Alignments
  with Synchronization*, arXiv:2312.08537.
- van der Aalst and Basten (2001), *Identifying commonalities and differences
  in object life cycles using behavioral inheritance*, ICATPN.

## Building

```bash
./package.sh
```

The archive contains only the manifest, pure-Python comparison code and the
sandboxed report view. It has no third-party Python dependency.
