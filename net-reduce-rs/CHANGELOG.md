# Changelog

## 0.1.0

First release.

- **Reduce net** — an `AcceptingPetriNet` in, a smaller one out, with the same
  language. Six rules, applied to a fixpoint: silent no-ops, fusion of series
  transitions and series places, fusion of duplicate transitions and places,
  self-loop places, and redundant (implicit) places.
- Every rule carries the precondition that keeps the *trace* the same, not just
  the classical liveness/boundedness properties: Murata's rules are stated for
  unlabelled nets, where fusing two transitions costs nothing, and in a
  labelled net it costs a label.
- The report says what each rule removed, before and after counts, and how much
  of the net went away — all of it on the artifact's statistics.
- **Executable invariants** gating the package. Both nets' languages are
  enumerated with `playout-core`'s extensive play-out and compared trace for
  trace; soundness is compared with `soundness-core`. Two other plugins' crates
  act as the oracle, and neither knows this one exists.

### Four defects the invariants caught before release

Each was a precondition one case too weak, and each produced a *smaller* net —
which is what was asked for, and looks like success:

- fusing two identically wired places could conflate the initial and final
  markings, turning a deadlocked net into one that accepts the empty trace;
- fusing a place into its successor across a silent step did the same when the
  upstream place carried the final marking, because tokens only flow one way;
- removing a marked place could leave the payload with an empty initial
  marking, which the next reader treats as "markings were lost" and guesses at;
- removing a self-loop place dropped the final marking's condition on it, so a
  net whose token pool can never be empty — and which therefore can never
  finish — came back finishing immediately.

A fifth finding is a limit rather than a bug: the classical implicit-place test is
about *firing*, and an accepting net also asks whether the marking reached is
the final one. Dropping a place drops its share of that question, so this
implements the acceptance-preserving subset — see `docs/rules.md`.
