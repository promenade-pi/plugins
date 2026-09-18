//! The timed token game: one case, played out against the net.
//!
//! The classical token game fires a transition atomically — inputs consumed
//! and outputs produced in the same instant — which is all a reachability
//! question needs, and exactly wrong for generating a log. A log records
//! *work*, and work takes time; two activities on the two branches of an
//! AND-split are not "interleaved in some order", they genuinely overlap.
//!
//! So a transition here is a *duration*: starting it consumes its input tokens
//! immediately, and its output tokens appear only when it completes.
//!
//! ```text
//!   while true:
//!     marking == final and nothing running  -> the case is complete
//!     some transition enabled               -> start one (consume, schedule)
//!     otherwise, something running          -> advance time to the earliest
//!                                              completion (produce)
//!     otherwise                             -> deadlock
//! ```
//!
//! Starting a transition does not advance the clock, so after an AND-split
//! *both* branches start at the same instant and then run concurrently, which
//! is what makes the emitted start/complete pairs overlap the way a real
//! log's do — and what a miner reading true concurrency (Split Miner 2.0) has
//! to see to find any. Two transitions in conflict cannot both start, because
//! the first to start has already taken the token.
//!
//! What this costs is nothing, formally. The transitions in *start* order are
//! a firing sequence of the ordinary net: at the moment one starts, its input
//! tokens are present in a marking that is pointwise no larger than the
//! classical one (the classical net has already produced what is still in
//! flight here), so whatever is enabled here is enabled there. And two
//! executions that overlap in time used disjoint tokens — the second started
//! while the first held its inputs — so they commute, which makes the
//! *completion* order a firing sequence too. That is the guarantee the log
//! rests on: every trace this produces can be replayed on the model it came
//! from, and `tests/invariants.rs` re-establishes it against an independent
//! replayer on every build rather than trusting the paragraph above.

use crate::rng::Rng;
use crate::Options;
use soundness_core::net::{Marking, Net};

/// One execution of one transition, with the interval it occupied.
#[derive(Clone, Debug, PartialEq)]
pub struct Execution {
    pub transition: usize,
    pub start_us: i64,
    pub complete_us: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Reached the final marking with nothing left running.
    Complete,
    /// Nothing enabled, nothing running, and not the final marking.
    Deadlock,
    /// Hit the per-case step limit — a loop the walk never left, usually.
    Truncated,
}

#[derive(Clone, Debug)]
pub struct Case {
    pub executions: Vec<Execution>,
    pub outcome: Outcome,
}

impl Case {
    /// The transitions in the order they *started*, which is the firing
    /// sequence this case corresponds to in the untimed net.
    ///
    /// Recorded order, not sorted order. Several transitions routinely start
    /// at the same instant — that is what an AND-split is, and a silent
    /// transition takes no time at all, so the one it enables starts at the
    /// same microsecond it did. Re-sorting on the timestamp would put those in
    /// some other order, and a transition placed before the one that enabled
    /// it is no longer a firing sequence.
    pub fn firing_sequence(&self) -> Vec<usize> {
        self.executions.iter().map(|e| e.transition).collect()
    }
}

/// How long one execution of `transition` takes, in microseconds.
///
/// A silent transition takes none: it is a routing step the model needed and
/// the business did not, so letting it consume service time would stretch
/// every duration in the log by however many taus the miner that produced the
/// net happened to insert.
pub(crate) fn duration_us(net: &Net, transition: usize, rng: &mut Rng, options: &Options) -> i64 {
    if net.labels[transition].is_none() {
        return 0;
    }
    let minutes = rng.exponential(options.duration_minutes);
    ((minutes * 60_000_000.0).round() as i64).max(1)
}

pub fn simulate_case(net: &Net, arrival_us: i64, rng: &mut Rng, options: &Options) -> Case {
    let mut marking: Marking = net.initial.clone();
    let mut now = arrival_us;
    let mut running: Vec<(usize, i64)> = Vec::new();
    let mut executions: Vec<Execution> = Vec::new();

    loop {
        if running.is_empty() && marking == net.final_marking {
            return Case { executions, outcome: Outcome::Complete };
        }

        let enabled: Vec<usize> =
            (0..net.transition_count()).filter(|&t| net.enabled(&marking, t)).collect();

        if !enabled.is_empty() {
            if executions.len() >= options.max_length {
                return Case { executions, outcome: Outcome::Truncated };
            }
            let transition = enabled[rng.below(enabled.len())];
            for &(place, weight) in &net.pre[transition] {
                marking[place] -= weight;
            }
            let complete_us = now + duration_us(net, transition, rng, options);
            running.push((transition, complete_us));
            executions.push(Execution { transition, start_us: now, complete_us });
            continue;
        }

        // Nothing can start, so the clock moves to the next completion. A
        // linear scan for the earliest: a case has a handful of concurrent
        // executions, not the thousands a heap would earn its keep on.
        match running.iter().enumerate().min_by_key(|(_, &(t, at))| (at, t)) {
            Some((index, _)) => {
                let (transition, at) = running.remove(index);
                now = now.max(at);
                for &(place, weight) in &net.post[transition] {
                    marking[place] = marking[place].saturating_add(weight);
                }
            }
            None => {
                return Case { executions, outcome: Outcome::Deadlock };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soundness_core::testing::{build, fixtures};

    fn options() -> Options {
        Options { duration_minutes: 10.0, ..Options::default() }
    }

    fn labels(net: &Net, case: &Case) -> Vec<String> {
        let mut order: Vec<&Execution> = case.executions.iter().collect();
        order.sort_by_key(|e| (e.complete_us, e.transition));
        order.iter().filter(|e| net.labels[e.transition].is_some()).map(|e| net.name_of(e.transition)).collect()
    }

    #[test]
    fn a_sequence_plays_out_in_order() {
        let net = fixtures::sequence();
        let case = simulate_case(&net, 0, &mut Rng::new(1), &options());
        assert_eq!(case.outcome, Outcome::Complete);
        assert_eq!(labels(&net, &case), vec!["A", "B"]);
        assert!(case.executions[0].complete_us <= case.executions[1].start_us);
    }

    #[test]
    fn concurrent_branches_actually_overlap() {
        let net = fixtures::parallel();
        let case = simulate_case(&net, 0, &mut Rng::new(2), &options());
        assert_eq!(case.outcome, Outcome::Complete);
        let a = case.executions.iter().find(|e| net.name_of(e.transition) == "A").unwrap();
        let b = case.executions.iter().find(|e| net.name_of(e.transition) == "B").unwrap();
        // The AND-split makes both enabled at the same instant, and starting
        // one does not move the clock, so their intervals intersect.
        assert!(a.start_us < b.complete_us && b.start_us < a.complete_us, "{a:?} vs {b:?}");
    }

    #[test]
    fn a_silent_transition_takes_no_time_and_makes_no_event() {
        // i -> tau -> p -> A -> o
        let net = build(3, &[("", &[0], &[1]), ("A", &[1], &[2])], &[0], &[2]);
        let case = simulate_case(&net, 1_000, &mut Rng::new(3), &options());
        assert_eq!(case.outcome, Outcome::Complete);
        let tau = &case.executions[0];
        assert_eq!(tau.start_us, tau.complete_us);
        assert_eq!(labels(&net, &case), vec!["A"]);
    }

    #[test]
    fn a_choice_is_taken_both_ways_across_cases() {
        // i -> {A, B} -> o
        let net = build(2, &[("A", &[0], &[1]), ("B", &[0], &[1])], &[0], &[1]);
        let mut rng = Rng::new(5);
        let taken: std::collections::HashSet<String> = (0..40)
            .map(|_| labels(&net, &simulate_case(&net, 0, &mut rng, &options())).join(""))
            .collect();
        assert_eq!(taken.len(), 2, "both branches must be reachable: {taken:?}");
    }

    #[test]
    fn a_net_that_deadlocks_says_so_rather_than_spinning() {
        let net = fixtures::xor_split_and_join();
        let case = simulate_case(&net, 0, &mut Rng::new(7), &options());
        assert_eq!(case.outcome, Outcome::Deadlock);
        assert!(!case.executions.is_empty(), "the prefix it did manage is kept");
    }

    #[test]
    fn a_case_that_never_finishes_is_truncated_at_the_limit() {
        // A loop with no way out: L gives its own token back.
        let net = build(2, &[("L", &[0], &[0]), ("X", &[0], &[1])], &[0], &[1]);
        let options = Options { max_length: 12, ..options() };
        // A seed whose walk keeps choosing the loop; whichever it chooses, the
        // outcome is one of the two and never an infinite loop.
        let case = simulate_case(&net, 0, &mut Rng::new(11), &options);
        assert!(case.executions.len() <= 12);
        assert!(matches!(case.outcome, Outcome::Complete | Outcome::Truncated));
    }

    #[test]
    fn the_start_order_is_a_firing_sequence() {
        let net = fixtures::parallel();
        let case = simulate_case(&net, 0, &mut Rng::new(13), &options());
        let mut marking = net.initial.clone();
        for transition in case.firing_sequence() {
            assert!(net.enabled(&marking, transition), "not enabled: {transition}");
            marking = net.fire(&marking, transition);
        }
        assert_eq!(marking, net.final_marking);
    }
}
