//! State-space exploration, and the unboundedness oracle that makes it total.
//!
//! Soundness is a statement about *reachable* markings, so a coverability
//! graph's \u{3c9}-markings cannot answer it directly — \u{3c9} over-approximates, and an
//! over-approximation can invent a deadlock that no real firing sequence
//! reaches. What the coverability construction actually contributes is
//! Karp and Miller's covering test (*Parallel program schemata*, JCSS 3(2),
//! 1969), and that is what is used here:
//!
//! > if `M \u{2192}\u{3c3} M'` with `M' \u{2265} M` and `M' \u{2260} M`, then \u{3c3} can be repeated forever,
//! > each round strictly adding tokens — the net is unbounded.
//!
//! So this walks the reachability graph breadth-first and, for every marking
//! it generates, tests it against its own ancestors in the search tree. Three
//! outcomes, and no fourth:
//!
//! - **Unbounded** — an ancestor was covered. The pair *is* the proof, and it
//!   comes with the firing sequence that demonstrates it. A WF-net that is not
//!   bounded is not sound, so the search stops here.
//! - **Complete** — the frontier emptied. Since no ancestor was ever covered,
//!   the graph is finite and *exact*: every soundness property below it is
//!   decided, not estimated.
//! - **Truncated** — the state cap was reached first. Nothing is claimed
//!   except what a partial graph genuinely witnesses (a transition that did
//!   fire, a deadlock that was actually reached).
//!
//! Termination is Dickson's lemma: on an unbounded net every infinite firing
//! path contains a covering pair, so one appears at finite depth. The state cap
//! is therefore a guard against a *large bounded* net, not against divergence.

use crate::net::{Marking, Net};
use std::collections::HashMap;

pub struct StateGraph {
    pub markings: Vec<Marking>,
    /// `(predecessor state, transition)` in the breadth-first tree, so a
    /// shortest firing sequence to any state is a parent walk.
    pub parent: Vec<Option<(usize, usize)>>,
    /// `(transition, successor state)` per state.
    pub out: Vec<Vec<(usize, usize)>>,
    pub fired: Vec<bool>,
    /// Whether this state's successors were generated. A state left on the
    /// frontier by the cap has no outgoing edges *yet*, which must never be
    /// mistaken for a deadlock.
    pub expanded: Vec<bool>,
    index: HashMap<Marking, usize>,
}

impl StateGraph {
    /// The shortest firing sequence from the initial marking to `state`.
    pub fn trace_to(&self, state: usize) -> Vec<usize> {
        let mut sequence = Vec::new();
        let mut at = state;
        while let Some((previous, transition)) = self.parent[at] {
            sequence.push(transition);
            at = previous;
        }
        sequence.reverse();
        sequence
    }

    pub fn state_of(&self, marking: &Marking) -> Option<usize> {
        self.index.get(marking).copied()
    }
}

/// The firing sequence that proves a net unbounded: `prefix` reaches a
/// marking, `pump` returns to one that strictly covers it.
pub struct UnboundedWitness {
    pub prefix: Vec<usize>,
    pub pump: Vec<usize>,
    /// Places that strictly gain tokens per round of `pump`.
    pub growing: Vec<usize>,
}

pub enum Exploration {
    Complete(StateGraph),
    Truncated(StateGraph),
    Unbounded { graph: StateGraph, witness: UnboundedWitness },
}

impl Exploration {
    pub fn graph(&self) -> &StateGraph {
        match self {
            Exploration::Complete(g) | Exploration::Truncated(g) => g,
            Exploration::Unbounded { graph, .. } => graph,
        }
    }
}

/// `a <= b` componentwise, and not equal.
fn strictly_covered(a: &Marking, b: &Marking) -> bool {
    let mut strict = false;
    for (x, y) in a.iter().zip(b.iter()) {
        if x > y {
            return false;
        }
        if x < y {
            strict = true;
        }
    }
    strict
}

pub fn explore(net: &Net, max_states: usize) -> Exploration {
    let mut graph = StateGraph {
        markings: vec![net.initial.clone()],
        parent: vec![None],
        out: vec![Vec::new()],
        fired: vec![false; net.transition_count()],
        expanded: vec![false],
        index: HashMap::from([(net.initial.clone(), 0)]),
    };

    let mut frontier = std::collections::VecDeque::from([0usize]);
    while let Some(state) = frontier.pop_front() {
        for transition in 0..net.transition_count() {
            if !net.enabled(&graph.markings[state], transition) {
                continue;
            }
            graph.fired[transition] = true;
            let next = net.fire(&graph.markings[state], transition);

            // The covering test, against this marking's own ancestors — the
            // parent chain is a real firing sequence from the initial marking,
            // which is what makes the pair a proof rather than a heuristic.
            let mut ancestor = Some(state);
            while let Some(at) = ancestor {
                if strictly_covered(&graph.markings[at], &next) {
                    let growing = graph.markings[at]
                        .iter()
                        .zip(next.iter())
                        .enumerate()
                        .filter(|(_, (a, b))| b > a)
                        .map(|(place, _)| place)
                        .collect();
                    let prefix = graph.trace_to(at);
                    let mut pump = graph.trace_to(state)[prefix.len()..].to_vec();
                    pump.push(transition);
                    return Exploration::Unbounded {
                        graph,
                        witness: UnboundedWitness { prefix, pump, growing },
                    };
                }
                ancestor = graph.parent[at].map(|(previous, _)| previous);
            }

            let target = match graph.index.get(&next) {
                Some(&existing) => existing,
                None => {
                    if graph.markings.len() >= max_states {
                        return Exploration::Truncated(graph);
                    }
                    let id = graph.markings.len();
                    graph.index.insert(next.clone(), id);
                    graph.markings.push(next);
                    graph.parent.push(Some((state, transition)));
                    graph.out.push(Vec::new());
                    graph.expanded.push(false);
                    frontier.push_back(id);
                    id
                }
            };
            graph.out[state].push((transition, target));
        }
        // *After* the loop, never before: returning `Truncated` from the middle
        // of an expansion would otherwise leave a state marked expanded with no
        // outgoing edges, which reads downstream as a deadlock that is not one.
        graph.expanded[state] = true;
    }
    Exploration::Complete(graph)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::build;

    #[test]
    fn a_sequence_has_one_state_per_step() {
        let net = build(3, &[("A", &[0], &[1]), ("B", &[1], &[2])], &[0], &[2]);
        match explore(&net, 1000) {
            Exploration::Complete(g) => {
                assert_eq!(g.markings.len(), 3);
                assert!(g.fired.iter().all(|&f| f));
                assert_eq!(g.trace_to(2), vec![0, 1]);
            }
            _ => panic!("a sequence is bounded"),
        }
    }

    #[test]
    fn a_token_generator_is_proven_unbounded() {
        // A consumes nothing from p1 and keeps adding to it.
        let net = build(2, &[("A", &[0], &[0, 1])], &[0], &[1]);
        match explore(&net, 1000) {
            Exploration::Unbounded { witness, .. } => {
                assert_eq!(witness.pump, vec![0]);
                assert_eq!(witness.growing, vec![1]);
            }
            _ => panic!("this net grows p1 without bound"),
        }
    }

    #[test]
    fn a_loop_that_returns_its_token_stays_bounded() {
        let net = build(2, &[("A", &[0], &[1]), ("B", &[1], &[0])], &[0], &[1]);
        assert!(matches!(explore(&net, 1000), Exploration::Complete(_)));
    }

    #[test]
    fn the_state_cap_truncates_rather_than_lying() {
        // Two independent two-state loops: four reachable markings, all bounded.
        let net = build(
            4,
            &[("A", &[0], &[1]), ("B", &[1], &[0]), ("C", &[2], &[3]), ("D", &[3], &[2])],
            &[0, 2],
            &[1, 3],
        );
        assert!(matches!(explore(&net, 1000), Exploration::Complete(_)));
        assert!(matches!(explore(&net, 2), Exploration::Truncated(_)));
    }

    #[test]
    fn the_covering_test_outranks_the_cap() {
        // An unbounded net must be reported as unbounded, not as truncated,
        // however small the cap — the proof needs two markings, not a budget.
        let net = build(2, &[("A", &[0], &[0, 1])], &[0], &[1]);
        assert!(matches!(explore(&net, 1), Exploration::Unbounded { .. }));
    }
}
