//! Extensive play-out: every distinct trace the net can produce, not a sample
//! of them.
//!
//! The stochastic walk answers "what does this process look like in operation";
//! this answers "what is this model's language", which is the question a
//! differential test asks. Two miners disagreeing on a model is easiest to see
//! as a trace one admits and the other does not, and that comparison needs the
//! set, not a sample that happens to be missing the rare branch.
//!
//! Depth-first, in transition-index order, so the result is deterministic and
//! carries no seed. Three budgets bound it, because a model's language is
//! routinely infinite (a loop) or astronomically large (n concurrent branches
//! have n! interleavings): the longest firing sequence, how many distinct
//! traces to keep, and how many markings to expand in total. Whether all three
//! held is reported rather than assumed — a truncated enumeration is still a
//! set of real traces, it is just no longer the *whole* language, and a caller
//! comparing two models has to know which it got.

use crate::Options;
use soundness_core::net::{Marking, Net};
use std::collections::HashSet;

pub struct Enumeration {
    /// One firing sequence per distinct visible trace, in discovery order.
    pub sequences: Vec<Vec<usize>>,
    /// False when a budget stopped the search before the language was closed.
    pub exhausted: bool,
}

/// The visible label sequence of a firing sequence — what the log will show,
/// and therefore what "distinct trace" means. Silent transitions leave no
/// trace, and two transitions carrying the same label are the same activity.
fn visible(net: &Net, sequence: &[usize]) -> Vec<String> {
    sequence
        .iter()
        .filter_map(|&t| net.labels[t].clone())
        .collect()
}

struct Search<'a> {
    net: &'a Net,
    options: &'a Options,
    seen: HashSet<Vec<String>>,
    sequences: Vec<Vec<usize>>,
    budget: usize,
    exhausted: bool,
}

impl Search<'_> {
    /// Returns false when a budget ran out and the caller should stop too.
    fn walk(&mut self, marking: &Marking, sequence: &mut Vec<usize>) -> bool {
        if self.sequences.len() >= self.options.variants {
            self.exhausted = false;
            return false;
        }
        if self.budget == 0 {
            self.exhausted = false;
            return false;
        }
        self.budget -= 1;

        if *marking == self.net.final_marking {
            let trace = visible(self.net, sequence);
            if self.seen.insert(trace) {
                self.sequences.push(sequence.clone());
            }
            // The final marking ends the case here exactly as it does in the
            // stochastic walk, rather than being one more state to leave: a
            // log records completed cases, and a net that can continue past
            // its own final marking would otherwise contribute every
            // continuation as a separate "trace" nobody would ever observe.
            return true;
        }

        if sequence.len() >= self.options.max_length {
            // Not an error and not an exhausted branch: this path was cut,
            // so the language is no longer fully characterised.
            self.exhausted = false;
            return true;
        }

        for transition in 0..self.net.transition_count() {
            if !self.net.enabled(marking, transition) {
                continue;
            }
            let next = self.net.fire(marking, transition);
            sequence.push(transition);
            let keep_going = self.walk(&next, sequence);
            sequence.pop();
            if !keep_going {
                return false;
            }
        }
        true
    }
}

pub fn enumerate(net: &Net, options: &Options) -> Enumeration {
    let mut search = Search {
        net,
        options,
        seen: HashSet::new(),
        sequences: Vec::new(),
        budget: options.max_states,
        exhausted: true,
    };
    search.walk(&net.initial.clone(), &mut Vec::new());
    Enumeration { sequences: search.sequences, exhausted: search.exhausted }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soundness_core::testing::{build, fixtures};

    fn traces(net: &Net, e: &Enumeration) -> Vec<String> {
        let mut out: Vec<String> = e.sequences.iter().map(|s| visible(net, s).join(",")).collect();
        out.sort();
        out
    }

    #[test]
    fn a_sequence_has_exactly_one_trace() {
        let net = fixtures::sequence();
        let e = enumerate(&net, &Options::default());
        assert!(e.exhausted);
        assert_eq!(traces(&net, &e), vec!["A,B"]);
    }

    #[test]
    fn a_choice_has_one_trace_per_branch() {
        let net = build(2, &[("A", &[0], &[1]), ("B", &[0], &[1])], &[0], &[1]);
        let e = enumerate(&net, &Options::default());
        assert!(e.exhausted);
        assert_eq!(traces(&net, &e), vec!["A", "B"]);
    }

    #[test]
    fn concurrency_yields_every_interleaving() {
        let net = fixtures::parallel();
        let e = enumerate(&net, &Options::default());
        assert!(e.exhausted);
        // `parallel()`'s split and join are labelled transitions, so they
        // are activities of the log too; what the test is about is that both
        // orders of the two branches appear.
        assert_eq!(traces(&net, &e), vec!["split,A,B,join", "split,B,A,join"]);
    }

    #[test]
    fn a_loop_is_enumerated_up_to_the_length_bound() {
        // i -> A -> p, then either B (out) or silently back to A, so the
        // visible traces are A B, A A B, A A A B, ... without end.
        let net = build(
            3,
            &[("A", &[0], &[1]), ("", &[1], &[0]), ("B", &[1], &[2])],
            &[0],
            &[2],
        );
        let e = enumerate(&net, &Options { max_length: 7, ..Options::default() });
        assert!(!e.exhausted, "an infinite language cannot be exhausted");
        assert_eq!(traces(&net, &e), vec!["A,A,A,B", "A,A,B", "A,B"]);
    }

    #[test]
    fn the_variant_budget_stops_a_wide_language() {
        let net = fixtures::parallel();
        let e = enumerate(&net, &Options { variants: 1, ..Options::default() });
        assert_eq!(e.sequences.len(), 1);
        assert!(!e.exhausted);
    }

    #[test]
    fn a_deadlocking_net_contributes_nothing_rather_than_a_partial_trace() {
        let net = fixtures::xor_split_and_join();
        let e = enumerate(&net, &Options::default());
        assert!(e.sequences.is_empty());
    }

    #[test]
    fn silent_transitions_collapse_distinct_paths_into_one_trace() {
        // Two silent routes to the same visible activity: one trace, not two.
        let net = build(
            4,
            &[("", &[0], &[1]), ("", &[0], &[2]), ("A", &[1], &[3]), ("A", &[2], &[3])],
            &[0],
            &[3],
        );
        let e = enumerate(&net, &Options::default());
        assert_eq!(traces(&net, &e), vec!["A"]);
    }
}
