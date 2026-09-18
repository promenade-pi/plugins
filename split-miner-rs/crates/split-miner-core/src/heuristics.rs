//! Split Miner 2.0, §3.3 — the two heuristics applied to the finished model.
//!
//! # Improper completion around a loop
//!
//! > "Although Split Miner guarantees to discover sound acyclic process models
//! > and deadlock-free cyclic process models with no dead activities, for
//! > cyclic process models it does not guarantee proper completion. However,
//! > it is possible to reduce the chances to discover process models exhibiting
//! > improper completion by applying the following heuristic: for each
//! > AND-split gateway in a process model with an outgoing edge that is a
//! > loop-edge, we create a preceding XOR-split gateway and set this latter as
//! > source of the loop-edge."
//!
//! An AND-split fires *all* its branches, so if one of them is the way back
//! round a loop, every iteration leaves another token in the branches it also
//! opened — the case finishes with work still outstanding. Taking the loop-edge
//! off the AND and putting it on a XOR in front makes going round the loop a
//! choice instead of an obligation.
//!
//! # Inclusive choice
//!
//! > "For each AND-split gateway in a process model, we consider all the
//! > successor activities and we check pairwise whether there exist traces
//! > where the pair of activities are mutually exclusive. Then, if the majority
//! > of the pairs of activities are both mutually exclusive and concurrent in
//! > different traces, we turn the AND-split gateway into an OR-split gateway
//! > and we update accordingly the OR-join gateway."
//!
//! with the paper's footnote fixing what "both" has to mean quantitatively:
//! *at least one observation of mutual exclusiveness every two observations of
//! concurrency, or vice-versa*. The paper's own worked example pins this down —
//! 3 concurrent / 3 exclusive and 4 / 2 qualify, 5 / 1 does not — so the test
//! is `2 * min >= max` with both counts non-zero, and it is asserted against
//! exactly those numbers below.

use crate::flow::{self, Dominance};
use crate::model::{Gate, Model, NodeId};
use crate::observe::Observations;
use std::collections::BTreeSet;

/// Moves every loop-edge off an AND-split onto a new XOR-split in front of it.
/// Returns how many it moved.
pub fn repair_loop_edges(model: &mut Model) -> usize {
    let mut moved = 0;
    loop {
        let back = flow::back_edges(model);
        let candidate = model
            .nodes()
            .into_iter()
            .filter(|&g| model.gate(g) == Some(Gate::And))
            .find_map(|g| back.iter().find(|&&(a, _)| a == g).map(|&edge| (g, edge)));
        let Some((and, (_, target))) = candidate else { return moved };

        let choice = model.new_gate(Gate::Xor);
        for predecessor in model.predecessors(and) {
            model.edges.remove(&(predecessor, and));
            model.edges.insert((predecessor, choice));
        }
        model.edges.remove(&(and, target));
        model.edges.insert((choice, and));
        model.edges.insert((choice, target));
        moved += 1;

        // A model with an AND-split per loop-edge would otherwise be able to
        // cycle here forever if the rewrite ever failed to remove the edge.
        if moved > model.gates.len() + model.n + 2 {
            return moved;
        }
    }
}

/// Removes gateways that route nothing.
///
/// [`repair_loop_edges`] takes an edge off an AND-split, and an AND-split
/// whose branches were *all* loop-edges is left with none — a gateway that
/// cannot be reached through, and a dead end the model is not allowed to
/// contain. The same pass also splices out a gateway left with one way in and
/// one way out, which routes nothing and only adds a node to read.
///
/// Both cascade, so this runs to a fixed point. It is a no-op on a model the
/// heuristics did not touch: a split always has at least two outgoing arcs and
/// a join at least two incoming ones, by construction.
pub fn tidy(model: &mut Model) -> usize {
    let mut removed = 0;
    loop {
        let dead = model.nodes().into_iter().find(|&g| {
            model.gate(g).is_some() && model.successors(g).is_empty()
        });
        if let Some(g) = dead {
            model.edges.retain(|&(a, b)| a != g && b != g);
            removed += 1;
            continue;
        }
        let pass_through = model.nodes().into_iter().find(|&g| {
            model.gate(g).is_some()
                && model.predecessors(g).len() == 1
                && model.successors(g).len() == 1
        });
        let Some(g) = pass_through else { return removed };
        let (before, after) = (model.predecessors(g)[0], model.successors(g)[0]);
        model.edges.retain(|&(a, b)| a != g && b != g);
        if before != after {
            model.edges.insert((before, after));
        }
        removed += 1;
    }
}

/// Turns an AND-split whose branches are sometimes exclusive into an OR-split,
/// and the join that closes its region with it. Returns how many it promoted.
pub fn promote_inclusive_splits(model: &mut Model, obs: &Observations) -> usize {
    let back = flow::back_edges(model);
    let dominance = flow::analyse(model, &back);

    let splits: Vec<NodeId> = model
        .nodes()
        .into_iter()
        .filter(|&g| model.gate(g) == Some(Gate::And) && model.successors(g).len() > 1)
        .collect();

    let mut promoted = 0;
    for split in splits {
        let branches: Vec<BTreeSet<NodeId>> =
            model.successors(split).into_iter().map(|b| leading_activities(model, b)).collect();
        let mut eligible = 0;
        let mut total = 0;
        for i in 0..branches.len() {
            for j in (i + 1)..branches.len() {
                for &a in &branches[i] {
                    for &b in &branches[j] {
                        total += 1;
                        if inclusive_pair(obs, a, b) {
                            eligible += 1;
                        }
                    }
                }
            }
        }
        if total == 0 || eligible * 2 <= total {
            continue;
        }
        model.set_gate(split, Gate::Or);
        for join in closing_joins(model, &dominance, split) {
            model.set_gate(join, Gate::Or);
        }
        promoted += 1;
    }
    promoted
}

/// A pair counts when the log shows it *both* ways round and neither way is a
/// rounding error against the other.
fn inclusive_pair(obs: &Observations, a: NodeId, b: NodeId) -> bool {
    if a >= obs.activity_count || b >= obs.activity_count {
        return false;
    }
    let (together, apart) = (obs.both(a, b), obs.only_one(a, b));
    if together == 0 || apart == 0 {
        return false;
    }
    2 * together.min(apart) >= together.max(apart)
}

/// The first activities on a branch, descending through gateways only. A
/// branch that is a task is that task; a branch that is a nested gateway is
/// whatever activities it can start with.
fn leading_activities(model: &Model, from: NodeId) -> BTreeSet<NodeId> {
    let mut found = BTreeSet::new();
    let mut seen = BTreeSet::from([from]);
    let mut queue = vec![from];
    while let Some(node) = queue.pop() {
        if model.is_activity(node) {
            found.insert(node);
            continue;
        }
        if node == model.sink() {
            continue;
        }
        for next in model.successors(node) {
            if seen.insert(next) {
                queue.push(next);
            }
        }
    }
    found
}

/// The join gateways whose innermost SESE region is opened by `split`.
fn closing_joins(model: &Model, dominance: &Dominance, split: NodeId) -> Vec<NodeId> {
    model
        .nodes()
        .into_iter()
        .filter(|&j| model.gate(j).is_some() && model.predecessors(j).len() > 1)
        .filter(|&j| {
            dominance
                .dominator_chain(j)
                .into_iter()
                .find(|&entry| dominance.post_dominates(j, entry))
                == Some(split)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observe::Phase::Complete;
    use crate::testing::scan_complete;

    #[test]
    fn a_loop_edge_moves_off_the_and_split() {
        // source -> a -> and -> {b, back to a}
        let mut m = Model::new(2);
        let and = m.new_gate(Gate::And);
        m.edges.extend([(m.source(), 0), (0, and), (and, 1), (and, 0), (1, m.sink())]);
        assert_eq!(repair_loop_edges(&mut m), 1);

        // The AND no longer sources the loop-edge; a XOR in front of it does.
        assert!(!m.edges.contains(&(and, 0)));
        let choice = m.predecessors(and);
        assert_eq!(choice.len(), 1);
        let choice = choice[0];
        assert_eq!(m.gate(choice), Some(Gate::Xor));
        assert!(m.edges.contains(&(choice, 0)), "the loop-edge now starts at the XOR");
        assert!(m.edges.contains(&(m.source(), choice)) || m.edges.contains(&(0, choice)));
    }

    #[test]
    fn a_model_with_no_loop_edge_on_an_and_is_left_alone() {
        let mut m = Model::new(2);
        let and = m.new_gate(Gate::And);
        m.edges.extend([(m.source(), and), (and, 0), (and, 1), (0, m.sink()), (1, m.sink())]);
        let before = m.edges.clone();
        assert_eq!(repair_loop_edges(&mut m), 0);
        assert_eq!(m.edges, before);
    }

    /// The paper's own worked numbers: B/C 3 concurrent and 3 exclusive, B/D
    /// 4 and 2, C/D 5 and 1. Two of the three pairs qualify, so the AND
    /// becomes an OR.
    #[test]
    fn the_papers_example_promotes_the_and_to_an_or() {
        // Activities: a=0, B=1, C=2, D=3, e=4.
        let mut traces: Vec<Vec<usize>> = Vec::new();
        traces.extend(vec![vec![0, 1, 2, 3, 4]; 3]); // B, C and D together x3
        traces.push(vec![0, 1, 3, 4]); //               B and D, C absent
        traces.extend(vec![vec![0, 2, 3, 4]; 2]); //    C and D, B absent x2
        let refs = crate::testing::as_refs(&traces);
        let obs = scan_complete(&refs, 5);

        assert_eq!((obs.both(1, 2), obs.only_one(1, 2)), (3, 3), "B/C");
        assert_eq!((obs.both(1, 3), obs.only_one(1, 3)), (4, 2), "B/D");
        assert_eq!((obs.both(2, 3), obs.only_one(2, 3)), (5, 1), "C/D");
        assert!(inclusive_pair(&obs, 1, 2));
        assert!(inclusive_pair(&obs, 1, 3));
        assert!(!inclusive_pair(&obs, 2, 3), "one exclusive in five is not a choice");

        let mut m = Model::new(5);
        let and = m.new_gate(Gate::And);
        m.edges.extend([
            (m.source(), 0), (0, and), (and, 1), (and, 2), (and, 3),
            (1, 4), (2, 4), (3, 4), (4, m.sink()),
        ]);
        let joins = crate::joins::discover(&mut m);
        assert_eq!(promote_inclusive_splits(&mut m, &obs), 1);
        assert_eq!(m.gate(and), Some(Gate::Or));
        for (join, _) in &joins.placed {
            assert_eq!(m.gate(*join), Some(Gate::Or), "the join follows its split");
        }
    }

    #[test]
    fn a_genuinely_parallel_and_stays_an_and() {
        // b and c always occur together: never exclusive, so never inclusive.
        let traces = vec![vec![0, 1, 2, 3], vec![0, 2, 1, 3]];
        let refs = crate::testing::as_refs(&traces);
        let obs = scan_complete(&refs, 4);
        assert_eq!(obs.only_one(1, 2), 0);

        let mut m = Model::new(4);
        let and = m.new_gate(Gate::And);
        m.edges.extend([(m.source(), 0), (0, and), (and, 1), (and, 2), (1, 3), (2, 3), (3, m.sink())]);
        crate::joins::discover(&mut m);
        assert_eq!(promote_inclusive_splits(&mut m, &obs), 0);
        assert_eq!(m.gate(and), Some(Gate::And));
    }

    #[test]
    fn leading_activities_descend_through_nested_gateways() {
        let mut m = Model::new(3);
        let xor = m.new_gate(Gate::Xor);
        m.edges.extend([(xor, 0), (xor, 1)]);
        assert_eq!(leading_activities(&m, xor), BTreeSet::from([0, 1]));
        assert_eq!(leading_activities(&m, 2), BTreeSet::from([2]));
        let _ = Complete;
    }
}
