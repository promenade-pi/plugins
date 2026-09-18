//! The reduction rules.
//!
//! Every rule here preserves the net's **observable language**: the sequences
//! of visible activity labels it can produce, and which of them end in the
//! final marking. That is a stronger promise than the classical reduction
//! literature makes — Murata's six rules preserve liveness, safeness and
//! boundedness, and are stated for *unlabelled* nets, where fusing two
//! transitions costs nothing. In a labelled net it costs the label, so each
//! rule below carries the extra precondition that keeps the trace the same:
//! usually "one of the two transitions is silent".
//!
//! > Murata, T. (1989). *Petri nets: properties, analysis and applications.*
//! > Proceedings of the IEEE 77(4), 541–580, §5.
//!
//! > Berthelot, G. (1986). *Transformations and decompositions of nets.*
//! > Advances in Petri Nets, LNCS 254, 359–376.
//!
//! The one non-Murata rule is implicit places, whose general characterisation
//! is a linear program (Colom & Silva, 1990). What is implemented is the
//! dominance special case, which needs no solver — see `implicit_places`.

use crate::model::Model;

/// A rule is a function that changes the model and says how often it fired.
pub type Rule = fn(&mut Model) -> usize;

/// A silent transition whose input and output are the same multiset does
/// nothing at all: firing it leaves the marking exactly as it was, and it has
/// no label to record. It can only lengthen a firing sequence.
pub fn silent_no_ops(model: &mut Model) -> usize {
    let mut fired = 0;
    for t in model.live_transitions().collect::<Vec<_>>() {
        let transition = &model.transitions[t];
        if transition.label.is_none() && transition.pre == transition.post {
            model.transitions[t].alive = false;
            fired += 1;
        }
    }
    fired
}

/// **Fusion of series transitions** (Murata §5, FST).
///
/// A place `p` with exactly one producer `t1` and one consumer `t2`, where `p`
/// is `t1`'s only output and `t2`'s only input, and at least one of the two is
/// silent: the pair can only ever fire one after the other, so they become one
/// transition carrying whichever label there was.
///
/// `p` must be unmarked in both the initial and the final marking — a token
/// sitting there is a state the merged transition cannot represent, and a
/// final marking naming `p` is an acceptance condition that would vanish.
pub fn series_transitions(model: &mut Model) -> usize {
    let mut fired = 0;
    for p in model.live_places().collect::<Vec<_>>() {
        if !model.places[p].alive {
            continue;
        }
        if model.places[p].initial > 0 || model.places[p].final_marking > 0 {
            continue;
        }
        let producers = model.producers(p);
        let consumers = model.consumers(p);
        if producers.len() != 1 || consumers.len() != 1 {
            continue;
        }
        let (t1, t2) = (producers[0], consumers[0]);
        if t1 == t2 {
            continue; // a self-loop is not a series
        }
        if model.transitions[t1].post != vec![(p, 1)] || model.transitions[t2].pre != vec![(p, 1)] {
            continue;
        }
        if model.transitions[t1].label.is_some() && model.transitions[t2].label.is_some() {
            continue; // merging would lose one of the two labels
        }

        let label = model.transitions[t1]
            .label
            .clone()
            .or_else(|| model.transitions[t2].label.clone());
        let post = model.transitions[t2].post.clone();
        model.transitions[t1].label = label;
        model.transitions[t1].post = post;
        model.transitions[t2].alive = false;
        model.places[p].alive = false;
        fired += 1;
    }
    fired
}

/// **Fusion of series places** (Murata §5, FSP).
///
/// A silent transition `t` that is the only consumer of `p` and the only
/// producer of `q`, moving one token from one to the other: a token in `p` can
/// go nowhere except `q`, and nothing observable happens on the way, so the
/// two places are the same place.
///
/// Their markings add, which is what keeps a net whose source and sink collapse
/// into one place accepting the empty trace — as it should.
///
/// `p`, the upstream place, must not be in the final marking. Tokens flow one
/// way: a token in `p` can always reach `q` (through a silent step, so at no
/// cost to the trace), but a token in `q` can never go back. Merging the two
/// would let `q`'s tokens satisfy a final-marking condition stated about `p`,
/// which is acceptance the original net does not have — a net that deadlocks
/// with its token one place short of the finish would come back accepting.
pub fn series_places(model: &mut Model) -> usize {
    let mut fired = 0;
    for t in model.live_transitions().collect::<Vec<_>>() {
        if !model.transitions[t].alive || model.transitions[t].label.is_some() {
            continue;
        }
        let (pre, post) = (model.transitions[t].pre.clone(), model.transitions[t].post.clone());
        if pre.len() != 1 || post.len() != 1 || pre[0].1 != 1 || post[0].1 != 1 {
            continue;
        }
        let (p, q) = (pre[0].0, post[0].0);
        if p == q {
            continue;
        }
        if model.places[p].final_marking > 0 {
            continue; // see the note above: the flow is one-way
        }
        if model.consumers(p) != vec![t] || model.producers(q) != vec![t] {
            continue;
        }

        model.transitions[t].alive = false;
        model.rename_place(q, p);
        model.places[p].initial += model.places[q].initial;
        model.places[p].final_marking += model.places[q].final_marking;
        model.places[q].alive = false;
        fired += 1;
    }
    fired
}

/// **Fusion of parallel transitions** (Murata §5, FPT).
///
/// Two transitions with the same label, the same inputs and the same outputs
/// are the same transition: whatever one can do, the other can, and the trace
/// cannot tell which fired.
pub fn parallel_transitions(model: &mut Model) -> usize {
    let mut fired = 0;
    let live: Vec<usize> = model.live_transitions().collect();
    for (i, &t) in live.iter().enumerate() {
        if !model.transitions[t].alive {
            continue;
        }
        for &u in &live[i + 1..] {
            if !model.transitions[u].alive {
                continue;
            }
            let (a, b) = (&model.transitions[t], &model.transitions[u]);
            if a.label == b.label && a.pre == b.pre && a.post == b.post {
                model.transitions[u].alive = false;
                fired += 1;
            }
        }
    }
    fired
}

/// **Fusion of parallel places** (Murata §5, FPP).
///
/// Two places connected to exactly the same transitions with exactly the same
/// weights hold, from the initial marking onwards, token counts that differ by
/// a constant. Merging them adds their markings and their arc weights, so the
/// merged place carries the sum — and the constraint on every transition is
/// unchanged.
///
/// Acceptance is the catch. The merged place is accepting when it holds
/// `F(p) + F(q)` tokens, and the two places separately when each holds its
/// own. Since their counts move together, both conditions are "the same
/// number of firings has happened" — but only if they are the *same* number:
/// `F(p) − M₀(p)` must equal `F(q) − M₀(q)`. Without that, a net whose token
/// sits in the wrong one of two identically wired places comes back
/// accepting, which is how a deadlocked net turns into one that finishes with
/// no work at all.
pub fn parallel_places(model: &mut Model) -> usize {
    let mut fired = 0;
    let live: Vec<usize> = model.live_places().collect();
    for (i, &p) in live.iter().enumerate() {
        if !model.places[p].alive {
            continue;
        }
        for &q in &live[i + 1..] {
            if !model.places[q].alive {
                continue;
            }
            let distance = |x: usize| {
                model.places[x].final_marking as i64 - model.places[x].initial as i64
            };
            if distance(p) != distance(q) {
                continue; // see the note above: acceptance would change
            }
            let same = model.live_transitions().all(|t| {
                model.weight_in(t, p) == model.weight_in(t, q)
                    && model.weight_out(t, p) == model.weight_out(t, q)
            });
            if !same {
                continue;
            }
            model.rename_place(q, p);
            model.places[p].initial += model.places[q].initial;
            model.places[p].final_marking += model.places[q].final_marking;
            model.places[q].alive = false;
            fired += 1;
        }
    }
    fired
}

/// **Elimination of self-loop places** (Murata §5, ESP).
///
/// A place whose only connection is to one transition, in both directions and
/// with the same weight, holds a token count that never changes. If it starts
/// with enough tokens it can never block that transition, so it constrains
/// nothing about firing.
///
/// It may still constrain *finishing*, and that is the extra condition here:
/// its count is constant at `M₀(p)`, so a final marking asking for anything
/// else is a condition the net can never satisfy. Removing such a place turns
/// a net that can never finish into one that finishes immediately — which is
/// what the invariants found. `M₀(p) = F(p)` is therefore required, and the
/// usual case (a token pool that no final marking mentions, `M₀(p) = F(p) = 0`)
/// is excluded anyway by needing tokens to start with.
pub fn self_loop_places(model: &mut Model) -> usize {
    let mut fired = 0;
    for p in model.live_places().collect::<Vec<_>>() {
        if model.places[p].final_marking != model.places[p].initial {
            continue; // see the note above: the count is constant, so this is unsatisfiable
        }
        if model.places[p].final_marking > 0 && !model.another_final_place(p) {
            continue; // the payload's final marking must not become empty
        }
        let producers = model.producers(p);
        let consumers = model.consumers(p);
        if producers.len() != 1 || consumers != producers {
            continue;
        }
        let t = producers[0];
        let weight = model.weight_in(t, p);
        if weight == 0 || model.weight_out(t, p) != weight || model.places[p].initial < weight {
            continue;
        }
        if !model.another_marked_place(p) {
            continue; // the payload's initial marking must not become empty
        }
        for u in model.live_transitions().collect::<Vec<_>>() {
            model.transitions[u].pre.retain(|&(q, _)| q != p);
            model.transitions[u].post.retain(|&(q, _)| q != p);
        }
        model.places[p].alive = false;
        fired += 1;
    }
    fired
}

/// **Implicit places**, in the form an *accepting* net allows.
///
/// A place is *implicit* when removing it removes no firing sequence: it is
/// never the reason a transition cannot fire. The general characterisation is
/// a linear program over the marking equation (Colom & Silva, 1990; Silva,
/// Teruel & Colom, 1998).
///
/// That classical definition is about firing, and an accepting net asks a
/// second question the definition does not: whether the marking reached *is*
/// the final marking. Dropping a place drops its condition — "and this place
/// is empty" — from that test, so a net that deadlocked one place short of the
/// finish can come back accepting the empty trace. The invariants caught
/// exactly that, which is why this rule is narrower than the literature's:
///
/// > `p` goes when some other place `q` constrains at least as much *and*
/// > carries the same count at a fixed offset — `Pre(p, t) ≤ Pre(q, t)` and
/// > the same effect on every firing, with `M₀(p) − M₀(q) = F(p) − F(q) ≥ 0`.
///
/// Then `M(p) = M(q) + offset` in every reachable marking, so `p` never blocks
/// anything `q` allows (`M(p) ≥ M(q) ≥ Pre(q, t) ≥ Pre(p, t)`), and
/// `M(p) = F(p)` holds exactly when `M(q) = F(q)` does — firing *and*
/// acceptance are both preserved, with no solver and no state space.
///
/// One consequence worth stating: a transition can never lose its last input
/// place. If `Pre(p, t) > 0` then `Pre(q, t) ≥ Pre(p, t) > 0`, so `q` is an
/// input of `t` too.
pub fn implicit_places(model: &mut Model) -> usize {
    let mut fired = 0;
    for p in model.live_places().collect::<Vec<_>>() {
        if !model.places[p].alive {
            continue;
        }
        let dominated = model.live_places().any(|q| {
            if q == p {
                return false;
            }
            let offset = model.places[p].initial as i64 - model.places[q].initial as i64;
            let final_offset =
                model.places[p].final_marking as i64 - model.places[q].final_marking as i64;
            if offset < 0 || offset != final_offset {
                return false;
            }
            model.live_transitions().all(|t| {
                let (pre_p, pre_q) = (model.weight_in(t, p), model.weight_in(t, q));
                let effect_p = model.weight_out(t, p) as i64 - pre_p as i64;
                let effect_q = model.weight_out(t, q) as i64 - pre_q as i64;
                pre_p <= pre_q && effect_p == effect_q
            })
        });
        if !dominated {
            continue;
        }
        if model.places[p].initial > 0 && !model.another_marked_place(p) {
            continue; // the payload's initial marking must not become empty
        }
        if model.places[p].final_marking > 0 && !model.another_final_place(p) {
            continue; // nor the final one — see `another_marked_place`
        }
        for u in model.live_transitions().collect::<Vec<_>>() {
            model.transitions[u].pre.retain(|&(q, _)| q != p);
            model.transitions[u].post.retain(|&(q, _)| q != p);
        }
        model.places[p].alive = false;
        fired += 1;
    }
    fired
}

/// A place nothing produces into, nothing consumes from, and no marking
/// mentions: left behind by the rules above, and describing nothing.
pub fn isolated_places(model: &mut Model) -> usize {
    let mut fired = 0;
    for p in model.live_places().collect::<Vec<_>>() {
        if model.places[p].initial > 0 || model.places[p].final_marking > 0 {
            continue;
        }
        if model.producers(p).is_empty() && model.consumers(p).is_empty() {
            model.places[p].alive = false;
            fired += 1;
        }
    }
    fired
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Model;
    use soundness_core::testing::build;

    fn model(
        places: usize,
        transitions: &[(&str, &[usize], &[usize])],
        initial: &[usize],
        final_marking: &[usize],
    ) -> Model {
        Model::from_net(&build(places, transitions, initial, final_marking))
    }

    #[test]
    fn a_silent_transition_that_changes_nothing_goes() {
        let mut m = model(2, &[("A", &[0], &[1]), ("", &[0], &[0])], &[0], &[1]);
        assert_eq!(silent_no_ops(&mut m), 1);
        assert_eq!(m.transition_count(), 1);
        assert_eq!(m.transitions[0].label.as_deref(), Some("A"));
    }

    #[test]
    fn a_visible_transition_that_changes_nothing_stays() {
        // It produces an event, which is the whole point of it.
        let mut m = model(2, &[("A", &[0], &[1]), ("ping", &[0], &[0])], &[0], &[1]);
        assert_eq!(silent_no_ops(&mut m), 0);
    }

    #[test]
    fn a_silent_step_between_two_transitions_is_absorbed() {
        // i -A-> p -tau-> q -B-> o  becomes  i -A-> q -B-> o
        let mut m = model(
            4,
            &[("A", &[0], &[1]), ("", &[1], &[2]), ("B", &[2], &[3])],
            &[0],
            &[3],
        );
        assert_eq!(series_transitions(&mut m), 1);
        assert_eq!(m.transition_count(), 2);
        let labels: Vec<Option<String>> =
            m.live_transitions().map(|t| m.transitions[t].label.clone()).collect();
        assert_eq!(labels, vec![Some("A".into()), Some("B".into())]);
    }

    #[test]
    fn two_visible_transitions_in_series_are_left_alone() {
        let mut m = model(3, &[("A", &[0], &[1]), ("B", &[1], &[2])], &[0], &[2]);
        assert_eq!(series_transitions(&mut m), 0);
        assert_eq!(m.transition_count(), 2);
    }

    #[test]
    fn a_marked_place_between_two_transitions_is_left_alone() {
        let mut m = model(3, &[("", &[0], &[1]), ("B", &[1], &[2])], &[0, 1], &[2]);
        assert_eq!(series_transitions(&mut m), 0);
    }

    #[test]
    fn a_silent_hop_between_two_places_merges_them() {
        // p -tau-> q, with nothing else touching either end of the hop.
        let mut m = model(
            3,
            &[("A", &[0], &[1]), ("", &[1], &[2])],
            &[0],
            &[2],
        );
        assert_eq!(series_places(&mut m), 1);
        assert_eq!(m.place_count(), 2);
        assert_eq!(m.transition_count(), 1);
        // The merged place carries the final marking the second one had.
        let merged = m.live_places().find(|&p| m.places[p].final_marking > 0).unwrap();
        assert_eq!(m.transitions[0].post, vec![(merged, 1)]);
    }

    #[test]
    fn identical_transitions_collapse_into_one() {
        let mut m = model(2, &[("A", &[0], &[1]), ("A", &[0], &[1]), ("B", &[0], &[1])], &[0], &[1]);
        assert_eq!(parallel_transitions(&mut m), 1);
        assert_eq!(m.transition_count(), 2);
    }

    #[test]
    fn transitions_differing_only_in_label_are_kept_apart() {
        let mut m = model(2, &[("A", &[0], &[1]), ("", &[0], &[1])], &[0], &[1]);
        assert_eq!(parallel_transitions(&mut m), 0);
    }

    #[test]
    fn places_wired_identically_merge_and_add_their_markings() {
        // Two places both filled by A and both drained by B.
        let mut m = model(4, &[("A", &[0], &[1, 2]), ("B", &[1, 2], &[3])], &[0], &[3]);
        assert_eq!(parallel_places(&mut m), 1);
        assert_eq!(m.place_count(), 3);
        let merged = m.live_places().find(|&p| m.weight_out(0, p) == 2).unwrap();
        assert_eq!(m.weight_in(1, merged), 2, "the weights add, so B still waits for both");
    }

    #[test]
    fn a_marked_self_loop_place_constrains_nothing() {
        // p is a token pool A borrows and returns; it starts with a token and
        // the final marking expects it to still be there, which it always is.
        let mut m = model(3, &[("A", &[0, 2], &[1, 2])], &[0, 2], &[1, 2]);
        assert_eq!(self_loop_places(&mut m), 1);
        assert_eq!(m.place_count(), 2);
        assert_eq!(m.transitions[0].pre, vec![(0, 1)]);
        assert_eq!(m.transitions[0].post, vec![(1, 1)]);
    }

    #[test]
    fn a_self_loop_place_the_final_marking_wants_empty_is_kept() {
        // Its token never goes away, so this net can never finish — and a
        // reduction that removed the place would say it finishes at once.
        let mut m = model(3, &[("A", &[0, 2], &[1, 2])], &[0, 2], &[1]);
        assert_eq!(self_loop_places(&mut m), 0);
    }

    #[test]
    fn an_unmarked_self_loop_place_is_a_real_constraint() {
        // With no token, A can never fire: removing the place would invent
        // behaviour rather than preserve it.
        let mut m = model(3, &[("A", &[0, 2], &[1, 2])], &[0], &[1]);
        assert_eq!(self_loop_places(&mut m), 0);
    }

    #[test]
    fn a_place_another_place_already_constrains_is_implicit() {
        // q is the real constraint on B; p starts with a token and is filled
        // at least as often, so it never blocks anything q does not.
        let mut m = model(
            4,
            &[("A", &[0], &[1, 3]), ("B", &[1, 3], &[2])],
            &[0],
            &[2],
        );
        // Both are filled by A and drained by B with the same weights, so this
        // is the parallel-places case; implicitness must find it too.
        assert!(implicit_places(&mut m) >= 1);
        assert!(m.place_count() < 4);
    }

    #[test]
    fn a_place_that_is_the_only_constraint_is_not_implicit() {
        let mut m = model(3, &[("A", &[0], &[1]), ("B", &[1], &[2])], &[0], &[2]);
        assert_eq!(implicit_places(&mut m), 0);
    }

    #[test]
    fn one_of_two_identical_sink_places_goes_and_the_other_stays() {
        // Both are filled by A and both are in the final marking, so their
        // counts are equal at every moment: "both hold a token" and "this one
        // holds a token" are the same condition. One of them is therefore
        // redundant — and the last one is not, because a net with no final
        // marking at all is read as a net whose marking was lost.
        let mut m = model(3, &[("A", &[0], &[1, 2])], &[0], &[1, 2]);
        assert_eq!(implicit_places(&mut m), 1);
        assert_eq!(m.place_count(), 2);
        assert_eq!(m.live_places().filter(|&p| m.places[p].final_marking > 0).count(), 1);
    }

    #[test]
    fn the_only_final_place_is_never_removed() {
        // p2 is dominated by p1 — same effect, same offset — but it is the
        // only thing that says what "finished" means.
        let mut m = model(3, &[("A", &[0], &[1, 2])], &[0], &[2]);
        let before = m.place_count();
        implicit_places(&mut m);
        assert!(m.live_places().any(|p| m.places[p].final_marking > 0), "the final marking survived");
        assert!(m.place_count() <= before);
    }
}
