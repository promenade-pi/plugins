//! Dijkstra alignment over the synchronous product, for scoring one small
//! LPM fragment against a (sub-)trace.
//!
//! Deliberately modeled on `plugins/alignment-rs/src/lib.rs`'s
//! `shortest_alignment` rather than depending on it: that plugin's `Model`
//! is a single whole-process net with no notion of "how many times did this
//! fire" or "what was enabled just before this step", while LPM scoring needs
//! exactly those two things (backloop-firing counts for support, per-marking
//! enabled-transition counts for determinism) on top of plain alignment cost.
//! Extracting a shared crate for two call sites with different result shapes
//! and a much smaller state space here (a handful of places, not an arbitrary
//! whole model) was judged not worth the cross-plugin coupling — see
//! `docs/algorithm.md`. The core technique (bitmask markings, uniform move
//! costs, a `MAX_STATES` safety bound) is unchanged.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

use crate::net::AugmentedNet;

/// 1-safe marking bitmask. An LPM fragment capped at a handful of
/// transitions never comes close to this many places.
pub const MAX_PLACES: usize = 128;

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct State {
    marking: u128,
    pos: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum MoveKind {
    Sync,
    Log,
    Model,
    Silent,
}

#[derive(Clone, Copy)]
pub struct Move {
    pub kind: MoveKind,
    /// The transition that fired — absent for a log move, which touches no
    /// transition at all.
    pub transition: Option<usize>,
    /// The marking reached once this move fires, unchanged for a log move.
    pub after: u128,
}

pub struct AlignedModel {
    /// `None` for silent transitions.
    activity_of: Vec<Option<u32>>,
    inputs: Vec<u128>,
    outputs: Vec<u128>,
    initial: u128,
    final_marking: u128,
}

impl AlignedModel {
    /// Builds the bitmask form of an augmented net for alignment. The
    /// augmented net's initial marking doubles as the final marking (see
    /// `net::augment_with_backloop`), so both are simply `1 << net.initial`.
    pub fn from_augmented(net: &AugmentedNet) -> Result<AlignedModel, String> {
        if net.place_count > MAX_PLACES {
            return Err(format!("fragment has {} places; alignment is bounded to {MAX_PLACES}", net.place_count));
        }
        let n = net.transitions.len();
        let mut inputs = vec![0u128; n];
        let mut outputs = vec![0u128; n];
        for &(p, t) in &net.place_to_transition {
            inputs[t] |= 1u128 << p;
        }
        for &(t, p) in &net.transition_to_place {
            outputs[t] |= 1u128 << p;
        }
        let marking = 1u128 << net.initial;
        Ok(AlignedModel { activity_of: net.transitions.clone(), inputs, outputs, initial: marking, final_marking: marking })
    }

    pub fn transition_count(&self) -> usize {
        self.activity_of.len()
    }

    pub fn activity_of(&self, t: usize) -> Option<u32> {
        self.activity_of[t]
    }

    /// The augmented net's shared initial/final marking (see
    /// `net::augment_with_backloop`).
    pub fn initial(&self) -> u128 {
        self.initial
    }

    pub fn fires(&self, t: usize, marking: u128) -> bool {
        self.inputs[t] & marking == self.inputs[t]
    }

    pub fn fire(&self, t: usize, marking: u128) -> u128 {
        (marking & !self.inputs[t]) | self.outputs[t]
    }
}

pub struct SearchResult {
    pub reached: bool,
    pub cost: u32,
    pub moves: Vec<Move>,
}

/// Dijkstra over the synchronous product of `model` and `trace`. Move costs:
/// sync 0, log 1, silent model move 0 (unchanged from `alignment-rs`'s
/// uniform regime) — but a **visible** model move costs `visible_model_cost`,
/// not 1. `alignment-rs` treats a model move on a real transition the same
/// as a log move because it is scoring a whole discovered process against a
/// log with no prior on which side is at fault. Scoring an LPM fragment is
/// different: `evaluator::evaluate` reads a transition's fire count off this
/// alignment as "how many real, observed occurrences of this activity does
/// the fragment explain" (the confidence metric's numerator) — a cheap model
/// move would let the search invent extra unobserved firings and inflate
/// that count past the activity's own true log-wide total. Ported from
/// ProM's `CostBasedCompleteParam` (comment: "select algorithm without ILP"),
/// which sets the visible-model-move cost to the trace length specifically
/// so no cheaper alternative to a log move is ever worth taking — the
/// caller passes the same bound (`trace.len() + 1`) here.
///
/// An empty `trace` finds the cheapest way to reach the final marking with no
/// log at all — used to normalise fitness, exactly as in `alignment-rs`.
pub fn shortest_alignment(model: &AlignedModel, trace: &[u32], max_states: usize, visible_model_cost: u32) -> SearchResult {
    let start = State { marking: model.initial, pos: 0 };
    let goal_pos = trace.len() as u32;

    let mut dist: HashMap<State, u32> = HashMap::new();
    let mut prev: HashMap<State, (State, Move)> = HashMap::new();
    let mut heap: BinaryHeap<Reverse<(u32, State)>> = BinaryHeap::new();

    dist.insert(start, 0);
    heap.push(Reverse((0, start)));

    while let Some(Reverse((d, s))) = heap.pop() {
        if dist.get(&s).copied().unwrap_or(u32::MAX) < d {
            continue; // stale entry
        }
        if s.marking == model.final_marking && s.pos == goal_pos {
            let mut moves = Vec::new();
            let mut cur = s;
            while let Some((p, mv)) = prev.get(&cur) {
                moves.push(*mv);
                cur = *p;
            }
            moves.reverse();
            return SearchResult { reached: true, cost: d, moves };
        }
        if dist.len() > max_states {
            break;
        }

        let relax = |ns: State, nd: u32, mv: Move,
                         dist: &mut HashMap<State, u32>, prev: &mut HashMap<State, (State, Move)>,
                         heap: &mut BinaryHeap<Reverse<(u32, State)>>| {
            if nd < dist.get(&ns).copied().unwrap_or(u32::MAX) {
                dist.insert(ns, nd);
                prev.insert(ns, (s, mv));
                heap.push(Reverse((nd, ns)));
            }
        };

        if s.pos < goal_pos {
            let ns = State { marking: s.marking, pos: s.pos + 1 };
            let mv = Move { kind: MoveKind::Log, transition: None, after: s.marking };
            relax(ns, d + 1, mv, &mut dist, &mut prev, &mut heap);
        }

        for t in 0..model.transition_count() {
            if model.inputs[t] & s.marking != model.inputs[t] {
                continue; // not enabled
            }
            let fired = (s.marking & !model.inputs[t]) | model.outputs[t];
            let act = model.activity_of(t);

            if s.pos < goal_pos && act == Some(trace[s.pos as usize]) {
                let ns = State { marking: fired, pos: s.pos + 1 };
                let mv = Move { kind: MoveKind::Sync, transition: Some(t), after: fired };
                relax(ns, d, mv, &mut dist, &mut prev, &mut heap);
            } else {
                let ns = State { marking: fired, pos: s.pos };
                let cost = if act.is_none() { 0 } else { visible_model_cost };
                let mv = Move {
                    kind: if act.is_none() { MoveKind::Silent } else { MoveKind::Model },
                    transition: Some(t),
                    after: fired,
                };
                relax(ns, d + cost, mv, &mut dist, &mut prev, &mut heap);
            }
        }
    }

    SearchResult { reached: false, cost: u32::MAX, moves: Vec::new() }
}

/// Activity ids of every *visible* transition enabled at `marking` — used by
/// the evaluator's determinism metric.
pub fn enabled_visible_count(model: &AlignedModel, marking: u128) -> usize {
    (0..model.transition_count())
        .filter(|&t| model.inputs[t] & marking == model.inputs[t] && model.activity_of(t).is_some())
        .count()
}

pub fn enabled_count(model: &AlignedModel, marking: u128) -> usize {
    (0..model.transition_count()).filter(|&t| model.inputs[t] & marking == model.inputs[t]).count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::{augment_with_backloop, compile};
    use crate::tree::LpmTree;

    #[test]
    fn a_trace_that_fires_the_fragment_twice_costs_nothing() {
        // Task(a), backloop-augmented: in --a--> out --backloop--> in.
        let raw = compile(&LpmTree::Task(0));
        let augmented = augment_with_backloop(&raw);
        let model = AlignedModel::from_augmented(&augmented).unwrap();
        let r = shortest_alignment(&model, &[0, 0], 10_000, 3);
        assert!(r.reached);
        assert_eq!(r.cost, 0);
        let backloop_fires = r.moves.iter().filter(|m| m.transition == Some(augmented.backloop_transition)).count();
        assert_eq!(backloop_fires, 2);
    }

    #[test]
    fn zero_occurrences_is_also_a_valid_alignment() {
        let raw = compile(&LpmTree::Task(0));
        let augmented = augment_with_backloop(&raw);
        let model = AlignedModel::from_augmented(&augmented).unwrap();
        let r = shortest_alignment(&model, &[], 10_000, 1);
        assert!(r.reached);
        assert_eq!(r.cost, 0);
    }

    #[test]
    fn an_unrelated_event_is_a_log_move() {
        let raw = compile(&LpmTree::Task(0));
        let augmented = augment_with_backloop(&raw);
        let model = AlignedModel::from_augmented(&augmented).unwrap();
        let r = shortest_alignment(&model, &[0, 99, 0], 10_000, 4);
        assert!(r.reached);
        assert_eq!(r.cost, 1);
    }
}
