//! Dominance on the model's flow graph — the machinery join typing needs.
//!
//! Split Miner types a join by the SESE region it closes, and a
//! single-entry-single-exit region is exactly a dominance/post-dominance pair:
//! `d` dominates every node in the region (nothing enters except through `d`)
//! and the exit `j` post-dominates every node in it (nothing leaves except
//! through `j`). That is the standard characterisation — Johnson, Pearson and
//! Pingali's program structure tree — and it is what makes "the entry gateway
//! of the SESE region" a computable thing rather than a picture.
//!
//! Dominator *sets* are computed rather than an immediate-dominator tree. The
//! graphs here are a discovered process model — hundreds of nodes at the very
//! most — so the simpler fixpoint is not worth trading for the asymptotically
//! better algorithm, and `dominates`, `post-dominates` and "the dominators of
//! `j`, innermost first" all fall straight out of the sets.

use crate::model::{Model, NodeId};
use std::collections::{BTreeMap, BTreeSet};

/// Edges whose target is an ancestor of their source in a depth-first walk
/// from the start event — the model's cycles, in other words.
pub fn back_edges(model: &Model) -> BTreeSet<(NodeId, NodeId)> {
    let mut back = BTreeSet::new();
    let mut on_stack: BTreeSet<NodeId> = BTreeSet::new();
    let mut done: BTreeSet<NodeId> = BTreeSet::new();
    // Explicit stack of (node, next successor index) so a deep model cannot
    // overflow the real one.
    let mut stack: Vec<(NodeId, usize)> = vec![(model.source(), 0)];
    on_stack.insert(model.source());

    while let Some(&mut (node, ref mut cursor)) = stack.last_mut() {
        let successors = model.successors(node);
        if *cursor < successors.len() {
            let next = successors[*cursor];
            *cursor += 1;
            if on_stack.contains(&next) {
                back.insert((node, next));
            } else if !done.contains(&next) {
                on_stack.insert(next);
                stack.push((next, 0));
            }
        } else {
            on_stack.remove(&node);
            done.insert(node);
            stack.pop();
        }
    }
    back
}

/// `Dom(entry) = {entry}`, `Dom(n) = {n} ∪ ⋂ Dom(p) over p ∈ preds(n)`.
/// Only nodes reachable from `entry` get an entry: dominance over a node no
/// path reaches is vacuous, and including them lets "everything dominates it"
/// leak into a region.
fn dominator_sets(
    nodes: &BTreeSet<NodeId>,
    entry: NodeId,
    preds: &BTreeMap<NodeId, Vec<NodeId>>,
    succs: &BTreeMap<NodeId, Vec<NodeId>>,
) -> BTreeMap<NodeId, BTreeSet<NodeId>> {
    let mut reachable = BTreeSet::from([entry]);
    let mut queue = vec![entry];
    while let Some(node) = queue.pop() {
        for &next in succs.get(&node).map(Vec::as_slice).unwrap_or(&[]) {
            if reachable.insert(next) {
                queue.push(next);
            }
        }
    }
    let _ = nodes;

    let mut dom: BTreeMap<NodeId, BTreeSet<NodeId>> =
        reachable.iter().map(|&n| (n, if n == entry { BTreeSet::from([entry]) } else { reachable.clone() })).collect();

    let mut changed = true;
    while changed {
        changed = false;
        for &node in &reachable {
            if node == entry {
                continue;
            }
            let mut next: Option<BTreeSet<NodeId>> = None;
            for &p in preds.get(&node).map(Vec::as_slice).unwrap_or(&[]) {
                let Some(pd) = dom.get(&p) else { continue };
                next = Some(match next {
                    None => pd.clone(),
                    Some(acc) => acc.intersection(pd).copied().collect(),
                });
            }
            let mut next = next.unwrap_or_default();
            next.insert(node);
            if dom[&node] != next {
                dom.insert(node, next);
                changed = true;
            }
        }
    }
    dom
}

/// Dominance and post-dominance over one acyclic view of a model.
pub struct Dominance {
    pub dom: BTreeMap<NodeId, BTreeSet<NodeId>>,
    pub post: BTreeMap<NodeId, BTreeSet<NodeId>>,
    /// Topological order of the acyclic view; nodes it cannot place come last.
    pub order: Vec<NodeId>,
}

impl Dominance {
    pub fn dominates(&self, d: NodeId, x: NodeId) -> bool {
        self.dom.get(&x).is_some_and(|set| set.contains(&d))
    }
    pub fn post_dominates(&self, p: NodeId, x: NodeId) -> bool {
        self.post.get(&x).is_some_and(|set| set.contains(&p))
    }
    /// The dominators of `x` other than itself, innermost first. A node's
    /// dominators are totally ordered by dominance, so ordering them by how
    /// many dominators they have in turn is that chain.
    pub fn dominator_chain(&self, x: NodeId) -> Vec<NodeId> {
        let Some(set) = self.dom.get(&x) else { return Vec::new() };
        let mut chain: Vec<NodeId> = set.iter().copied().filter(|&d| d != x).collect();
        chain.sort_by_key(|d| std::cmp::Reverse(self.dom.get(d).map_or(0, BTreeSet::len)));
        chain
    }
}

/// Builds dominance over the model with its back edges removed — "acyclic
/// SESE region" is a statement about the loop-free skeleton, and leaving the
/// cycles in makes every dominator set collapse to the entry.
pub fn analyse(model: &Model, back: &BTreeSet<(NodeId, NodeId)>) -> Dominance {
    let nodes = model.nodes();
    let mut succs: BTreeMap<NodeId, Vec<NodeId>> = BTreeMap::new();
    let mut preds: BTreeMap<NodeId, Vec<NodeId>> = BTreeMap::new();
    for &(a, b) in &model.edges {
        if back.contains(&(a, b)) {
            continue;
        }
        succs.entry(a).or_default().push(b);
        preds.entry(b).or_default().push(a);
    }

    let dom = dominator_sets(&nodes, model.source(), &preds, &succs);
    let post = dominator_sets(&nodes, model.sink(), &succs, &preds);

    // Kahn's algorithm over the acyclic view.
    let mut indegree: BTreeMap<NodeId, usize> =
        nodes.iter().map(|&n| (n, preds.get(&n).map_or(0, Vec::len))).collect();
    let mut ready: Vec<NodeId> = indegree.iter().filter(|(_, &d)| d == 0).map(|(&n, _)| n).collect();
    let mut order = Vec::new();
    while let Some(node) = ready.pop() {
        order.push(node);
        for &next in succs.get(&node).map(Vec::as_slice).unwrap_or(&[]) {
            let slot = indegree.get_mut(&next).unwrap();
            *slot -= 1;
            if *slot == 0 {
                ready.push(next);
            }
        }
    }
    for &node in &nodes {
        if !order.contains(&node) {
            order.push(node);
        }
    }

    Dominance { dom, post, order }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Gate, Model};

    /// source -> g(xor) -> {a, b} -> j -> sink
    fn diamond() -> Model {
        let mut m = Model::new(2);
        let g = m.new_gate(Gate::Xor);
        let j = m.new_gate(Gate::Xor);
        m.edges.extend([(m.source(), g), (g, 0), (g, 1), (0, j), (1, j), (j, m.sink())]);
        m
    }

    #[test]
    fn a_diamond_has_no_back_edges() {
        assert!(back_edges(&diamond()).is_empty());
    }

    #[test]
    fn the_split_dominates_the_branches_and_the_join_post_dominates_them() {
        let m = diamond();
        let (g, j) = (4, 5);
        let d = analyse(&m, &back_edges(&m));
        assert!(d.dominates(g, 0) && d.dominates(g, 1));
        assert!(d.post_dominates(j, 0) && d.post_dominates(j, 1));
        assert!(d.post_dominates(j, g), "the join closes the region the split opens");
        assert!(!d.dominates(0, 1), "sibling branches dominate nothing of each other");
        assert_eq!(d.dominator_chain(j).first(), Some(&g), "the split is the nearest dominator");
    }

    #[test]
    fn a_loop_edge_is_found_and_excluded_from_dominance() {
        let mut m = diamond();
        m.edges.insert((5, 4)); // join back to split
        let back = back_edges(&m);
        assert_eq!(back, BTreeSet::from([(5, 4)]));
        let d = analyse(&m, &back);
        assert!(d.dominates(4, 0), "dominance still sees the acyclic skeleton");
    }
}
