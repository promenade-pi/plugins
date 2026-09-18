//! Algorithms 2, 3 and 4 — split discovery.
//!
//! For every node with more than one outgoing arc, Split Miner builds a
//! *hierarchy* of gateways between it and its successors, using two bookkeeping
//! functions over the successors:
//!
//! - **cover** `C(s)` — the tasks reachable only by going through `s`. A task
//!   covers itself; a gateway covers everything under it.
//! - **future** `F(s)` — the other successors that are concurrent with `s`.
//!
//! and two rules, applied alternately until one successor is left:
//!
//! - **XOR** (Algorithm 3): successors sharing the *same* future are mutually
//!   exclusive, because "mutually exclusive successors of a given task must
//!   share the same concurrency relations". They become the branches of a
//!   XOR-split, whose cover is the union of theirs and whose future is the one
//!   they shared.
//! - **AND** (Algorithm 4): successors sharing the same *union* of cover and
//!   future are meant to run together. They become the branches of an
//!   AND-split, whose cover is the union of theirs and whose future is the
//!   *intersection* of theirs.
//!
//! Worked through on the paper's own example (its Table I) in the tests below.

use crate::concurrency::Concurrency;
use crate::model::{Gate, Model, NodeId};
use std::collections::{BTreeMap, BTreeSet};

type Sets = BTreeMap<NodeId, BTreeSet<NodeId>>;

/// Algorithm 2, for one node. `successors` is that node's successor set in the
/// filtered graph; the arcs out of `node` are replaced by the gateway
/// hierarchy this builds.
pub fn discover(model: &mut Model, node: NodeId, successors: &[NodeId], conc: &Concurrency) -> Option<String> {
    if successors.len() < 2 {
        return None;
    }
    let mut k: BTreeSet<NodeId> = successors.iter().copied().collect();
    let mut cover: Sets = k.iter().map(|&s| (s, BTreeSet::from([s]))).collect();
    let mut future: Sets = k
        .iter()
        .map(|&s1| {
            let f = k.iter().copied().filter(|&s2| s2 != s1 && conc.get(s1, s2)).collect();
            (s1, f)
        })
        .collect();

    model.edges.retain(|&(x, _)| x != node);

    let mut warning = None;
    while k.len() > 1 {
        let progressed = discover_xor(model, &mut k, &mut cover, &mut future)
            | discover_and(model, &mut k, &mut cover, &mut future);
        if !progressed {
            // Not reachable on any relation the oracle can produce, but the
            // paper's loop has no exit of its own and a miner that hangs on
            // an unforeseen relation is worse than one that says so: collapse
            // what is left into a XOR and record it.
            let rest: Vec<NodeId> = k.iter().copied().collect();
            let gate = model.new_gate(Gate::Xor);
            for &r in &rest {
                model.edges.insert((gate, r));
            }
            warning = Some(format!(
                "split discovery for node {node} could not reduce {} successors by either rule; they were joined by a XOR-split",
                rest.len()
            ));
            k.clear();
            k.insert(gate);
            break;
        }
    }

    if let Some(&root) = k.iter().next() {
        model.edges.insert((node, root));
    }
    warning
}

/// Algorithm 3. Returns whether it introduced anything.
fn discover_xor(model: &mut Model, k: &mut BTreeSet<NodeId>, cover: &mut Sets, future: &mut Sets) -> bool {
    let mut progressed = false;
    loop {
        let mut group: Option<(NodeId, BTreeSet<NodeId>)> = None;
        for &k1 in k.iter() {
            let shared: BTreeSet<NodeId> =
                k.iter().copied().filter(|&k2| k2 != k1 && future[&k2] == future[&k1]).collect();
            if !shared.is_empty() {
                let mut all = shared;
                all.insert(k1);
                group = Some((k1, all));
                break;
            }
        }
        let Some((k1, members)) = group else { return progressed };

        // The shared future is what made the members exclusive, so it becomes
        // the gateway's future. Read before the loop below, which removes the
        // members — including `k1` — from `future`.
        let shared_future = future.get(&k1).cloned().unwrap_or_default();

        let gate = model.new_gate(Gate::Xor);
        let mut union = BTreeSet::new();
        for &m in &members {
            model.edges.insert((gate, m));
            union.extend(cover.remove(&m).unwrap_or_default());
            future.remove(&m);
            k.remove(&m);
        }
        cover.insert(gate, union);
        future.insert(gate, shared_future);
        k.insert(gate);
        progressed = true;
    }
}

/// Algorithm 4. One AND-split per call, as the paper writes it.
fn discover_and(model: &mut Model, k: &mut BTreeSet<NodeId>, cover: &mut Sets, future: &mut Sets) -> bool {
    let union_of = |node: &NodeId, cover: &Sets, future: &Sets| -> BTreeSet<NodeId> {
        cover[node].union(&future[node]).copied().collect()
    };

    let mut group: Option<BTreeSet<NodeId>> = None;
    for &k1 in k.iter() {
        let target = union_of(&k1, cover, future);
        let shared: BTreeSet<NodeId> =
            k.iter().copied().filter(|&k2| k2 != k1 && union_of(&k2, cover, future) == target).collect();
        if !shared.is_empty() {
            let mut all = shared;
            all.insert(k1);
            group = Some(all);
            break;
        }
    }
    let Some(members) = group else { return false };

    let gate = model.new_gate(Gate::And);
    let mut union = BTreeSet::new();
    let mut intersection: Option<BTreeSet<NodeId>> = None;
    for &m in &members {
        model.edges.insert((gate, m));
        union.extend(cover.remove(&m).unwrap_or_default());
        let f = future.remove(&m).unwrap_or_default();
        intersection = Some(match intersection {
            None => f,
            Some(acc) => acc.intersection(&f).copied().collect(),
        });
        k.remove(&m);
    }
    cover.insert(gate, union);
    future.insert(gate, intersection.unwrap_or_default());
    k.insert(gate);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The paper's Figure 2c / Table I: task `a` has successors `b`, `c`, `d`
    /// with `b || c` and `b || d`. The expected answer is an AND-split over
    /// `b` and a XOR-split of `c` and `d`.
    fn paper_example() -> (Model, Concurrency, Vec<NodeId>) {
        let (b, c, d) = (1usize, 2usize, 3usize);
        // The relation is built the way the oracle would build it, from a log
        // that exhibits exactly b||c and b||d — not hand-set, so the fixture
        // cannot drift away from what the oracle can actually produce.
        // b is interleaved with both c and d, while c and d keep a fixed
        // order and so fail condition (1) outright.
        let obs = crate::testing::scan_complete(
            &[&[0, b, c, d, 4], &[0, c, b, d, 4], &[0, c, d, b, 4]],
            8,
        );
        let g = crate::dfg::build(&obs, crate::dfg::Relation::Classic);
        let conc = crate::concurrency::discover_classic(&obs, &g, 0.5);
        assert!(conc.get(b, c) && conc.get(b, d), "fixture must exhibit b||c and b||d");
        assert!(!conc.get(c, d), "fixture must not make c and d concurrent");
        (Model::new(8), conc, vec![b, c, d])
    }

    #[test]
    fn the_paper_example_yields_an_and_over_b_and_a_xor_of_c_and_d() {
        let (mut model, conc, successors) = paper_example();
        assert_eq!(discover(&mut model, 0, &successors, &conc), None);

        // a has exactly one successor now, and it is an AND-split.
        let roots = model.successors(0);
        assert_eq!(roots.len(), 1);
        let and = roots[0];
        assert_eq!(model.gate(and), Some(Gate::And));

        let mut branches = model.successors(and);
        branches.sort();
        assert_eq!(branches.len(), 2);
        // One branch is task b; the other is a XOR over c and d.
        assert!(branches.contains(&1));
        let xor = *branches.iter().find(|&&x| x != 1).unwrap();
        assert_eq!(model.gate(xor), Some(Gate::Xor));
        let mut leaves = model.successors(xor);
        leaves.sort();
        assert_eq!(leaves, vec![2, 3]);
    }

    #[test]
    fn successors_with_no_concurrency_become_one_xor() {
        let obs = crate::testing::scan_complete(&[&[0, 1, 3], &[0, 2, 3]], 4);
        let g = crate::dfg::build(&obs, crate::dfg::Relation::Classic);
        let conc = crate::concurrency::discover_classic(&obs, &g, 0.1);
        let mut model = Model::new(4);
        discover(&mut model, 0, &[1, 2], &conc);
        let roots = model.successors(0);
        assert_eq!(model.gate(roots[0]), Some(Gate::Xor));
        let mut leaves = model.successors(roots[0]);
        leaves.sort();
        assert_eq!(leaves, vec![1, 2]);
    }

    #[test]
    fn two_concurrent_successors_become_one_and() {
        let obs = crate::testing::scan_complete(&[&[0, 1, 2, 3], &[0, 2, 1, 3]], 4);
        let g = crate::dfg::build(&obs, crate::dfg::Relation::Classic);
        let conc = crate::concurrency::discover_classic(&obs, &g, 0.1);
        let mut model = Model::new(4);
        discover(&mut model, 0, &[1, 2], &conc);
        let roots = model.successors(0);
        assert_eq!(model.gate(roots[0]), Some(Gate::And));
    }

    #[test]
    fn a_single_successor_needs_no_gateway() {
        let conc = Concurrency::empty(3);
        let mut model = Model::new(3);
        model.edges.insert((0, 1));
        assert_eq!(discover(&mut model, 0, &[1], &conc), None);
        assert!(model.gates.is_empty());
        assert_eq!(model.successors(0), vec![1]);
    }
}
