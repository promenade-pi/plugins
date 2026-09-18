//! `LpmTree` -> small Petri net, plus the backloop augmentation that makes
//! "this pattern occurs 0, 1, 2, ... times inside one trace" replayable.
//!
//! The block-structured gadget-per-operator construction is the same idea as
//! `ocpn-rs/crates/ocpn-discovery/src/tree_to_net.rs`, adapted to this
//! crate's own 5-operator set (which is not object-centric and has no
//! per-object-type namespacing to worry about) rather than reused directly —
//! see `docs/algorithm.md` for why a shared crate wasn't a good fit here.
//!
//! ```text
//! Task(a):        in --a--> out
//! Seq(l, r):      in -> l -> mid -> r -> out
//! Xor(l, r):      both children wired directly between the same in/out
//! And(l, r):      in --tau(split)--> (li between fresh places) --tau(join)--> out
//! Or(l, r):       four-way Xor of independently-converted copies:
//!                 Seq(l,r), Seq(r,l), l alone, r alone — "do at least one of
//!                 l/r, any order, at most once each". Simpler than ProM's
//!                 n-ary OR gadget (ours is always binary; `useOrLoop`
//!                 defaults off anyway, matching ProM's own default).
//! XorLoop(body):  in -> body -> mid; mid --tau(exit)--> out; mid --tau(redo)--> in
//! ```

use crate::tree::LpmTree;

pub struct RawNet {
    pub place_count: usize,
    /// `None` = silent (tau).
    pub transitions: Vec<Option<u32>>,
    pub place_to_transition: Vec<(usize, usize)>,
    pub transition_to_place: Vec<(usize, usize)>,
    pub in_place: usize,
    pub out_place: usize,
}

struct Builder {
    place_count: usize,
    transitions: Vec<Option<u32>>,
    place_to_transition: Vec<(usize, usize)>,
    transition_to_place: Vec<(usize, usize)>,
}

impl Builder {
    fn fresh_place(&mut self) -> usize {
        let id = self.place_count;
        self.place_count += 1;
        id
    }

    fn fresh_transition(&mut self, activity: Option<u32>) -> usize {
        self.transitions.push(activity);
        self.transitions.len() - 1
    }

    fn arc_pt(&mut self, p: usize, t: usize) {
        self.place_to_transition.push((p, t));
    }

    fn arc_tp(&mut self, t: usize, p: usize) {
        self.transition_to_place.push((t, p));
    }
}

fn convert(tree: &LpmTree, in_place: usize, out_place: usize, b: &mut Builder) {
    match tree {
        LpmTree::Task(a) => {
            let t = b.fresh_transition(Some(*a));
            b.arc_pt(in_place, t);
            b.arc_tp(t, out_place);
        }
        LpmTree::Seq(l, r) => {
            let mid = b.fresh_place();
            convert(l, in_place, mid, b);
            convert(r, mid, out_place, b);
        }
        LpmTree::Xor(l, r) => {
            convert(l, in_place, out_place, b);
            convert(r, in_place, out_place, b);
        }
        LpmTree::And(l, r) => {
            let split = b.fresh_transition(None);
            let join = b.fresh_transition(None);
            b.arc_pt(in_place, split);
            b.arc_tp(join, out_place);
            for child in [l.as_ref(), r.as_ref()] {
                let p_start = b.fresh_place();
                let p_end = b.fresh_place();
                b.arc_tp(split, p_start);
                b.arc_pt(p_end, join);
                convert(child, p_start, p_end, b);
            }
        }
        LpmTree::Or(l, r) => {
            // Four independently-converted branches, each with its own fresh
            // places/transitions — see the module doc for why this is a
            // correct (if generous with fresh nodes) binary inclusive-or.
            let seq_lr = LpmTree::Seq(l.clone(), r.clone());
            let seq_rl = LpmTree::Seq(r.clone(), l.clone());
            for branch in [&seq_lr, &seq_rl, l.as_ref(), r.as_ref()] {
                convert(branch, in_place, out_place, b);
            }
        }
        LpmTree::XorLoop(body) => {
            let mid = b.fresh_place();
            convert(body, in_place, mid, b);
            let exit_t = b.fresh_transition(None);
            let redo_t = b.fresh_transition(None);
            b.arc_pt(mid, exit_t);
            b.arc_tp(exit_t, out_place);
            b.arc_pt(mid, redo_t);
            b.arc_tp(redo_t, in_place);
        }
    }
}

/// Compiles a tree fragment into a net with one designated entry and exit
/// place (no backloop yet — see `augment_with_backloop`).
pub fn compile(tree: &LpmTree) -> RawNet {
    let mut b = Builder { place_count: 0, transitions: Vec::new(), place_to_transition: Vec::new(), transition_to_place: Vec::new() };
    let in_place = b.fresh_place();
    let out_place = b.fresh_place();
    convert(tree, in_place, out_place, &mut b);
    RawNet {
        place_count: b.place_count,
        transitions: b.transitions,
        place_to_transition: b.place_to_transition,
        transition_to_place: b.transition_to_place,
        in_place,
        out_place,
    }
}

pub struct AugmentedNet {
    pub place_count: usize,
    pub transitions: Vec<Option<u32>>,
    pub place_to_transition: Vec<(usize, usize)>,
    pub transition_to_place: Vec<(usize, usize)>,
    /// Shared initial *and* final marking — see the doc comment below.
    pub initial: usize,
    pub backloop_transition: usize,
}

/// Adds a silent `backloop` transition from the fragment's exit place back to
/// its entry place, and marks *that entry place* as both the initial and the
/// final marking. This is exactly `LocalProcessModelEvaluator.evaluateNetOnLog`'s
/// trick (`LocalProcessModelDiscovery/src/.../LocalProcessModelEvaluator.java:102-116`):
/// an alignment against this augmented net can complete zero, one or several
/// full loops before the trace runs out — each backloop firing is one
/// occurrence of the fragment — while any given alignment still has to reach
/// a *reproduced* state (back at the entry place) exactly when the trace is
/// exhausted, which is what makes "did this pattern occur, how many times"
/// well-defined instead of "is the model merely compatible with a prefix".
pub fn augment_with_backloop(raw: &RawNet) -> AugmentedNet {
    let mut transitions = raw.transitions.clone();
    transitions.push(None); // the backloop itself is silent
    let backloop_transition = transitions.len() - 1;

    let mut place_to_transition = raw.place_to_transition.clone();
    let mut transition_to_place = raw.transition_to_place.clone();
    place_to_transition.push((raw.out_place, backloop_transition));
    transition_to_place.push((backloop_transition, raw.in_place));

    AugmentedNet {
        place_count: raw.place_count,
        transitions,
        place_to_transition,
        transition_to_place,
        initial: raw.in_place,
        backloop_transition,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::LpmTree;

    fn count_visible(net: &RawNet) -> usize {
        net.transitions.iter().filter(|t| t.is_some()).count()
    }

    #[test]
    fn single_task_has_one_visible_transition() {
        let net = compile(&LpmTree::Task(0));
        assert_eq!(count_visible(&net), 1);
        assert_eq!(net.place_count, 2);
    }

    #[test]
    fn seq_chains_through_one_shared_place() {
        let net = compile(&LpmTree::Seq(Box::new(LpmTree::Task(0)), Box::new(LpmTree::Task(1))));
        assert_eq!(count_visible(&net), 2);
        assert_eq!(net.place_count, 3); // in, mid, out
    }

    #[test]
    fn xor_shares_in_and_out_across_both_children() {
        let net = compile(&LpmTree::Xor(Box::new(LpmTree::Task(0)), Box::new(LpmTree::Task(1))));
        assert_eq!(count_visible(&net), 2);
        assert_eq!(net.place_count, 2); // just in/out, no extra places
    }

    #[test]
    fn and_adds_split_join_and_four_places() {
        let net = compile(&LpmTree::And(Box::new(LpmTree::Task(0)), Box::new(LpmTree::Task(1))));
        assert_eq!(count_visible(&net), 2);
        // in, out, plus p_start/p_end per child (2 children * 2 = 4)
        assert_eq!(net.place_count, 6);
        let silent = net.transitions.iter().filter(|t| t.is_none()).count();
        assert_eq!(silent, 2); // split, join
    }

    #[test]
    fn xorloop_wraps_a_single_activity_with_two_silent_transitions() {
        let net = compile(&LpmTree::XorLoop(Box::new(LpmTree::Task(0))));
        assert_eq!(count_visible(&net), 1);
        let silent = net.transitions.iter().filter(|t| t.is_none()).count();
        assert_eq!(silent, 2); // exit, redo
    }

    #[test]
    fn backloop_augmentation_shares_initial_and_final_marking() {
        let raw = compile(&LpmTree::Task(0));
        let augmented = augment_with_backloop(&raw);
        assert_eq!(augmented.initial, raw.in_place);
        // The backloop is one extra silent transition wiring out_place -> in_place.
        assert!(augmented.transitions[augmented.backloop_transition].is_none());
        assert!(augmented.place_to_transition.contains(&(raw.out_place, augmented.backloop_transition)));
        assert!(augmented.transition_to_place.contains(&(augmented.backloop_transition, raw.in_place)));
    }
}
