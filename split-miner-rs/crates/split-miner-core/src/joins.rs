//! Join discovery.
//!
//! > "We introduce a join gateway every time a task `t` has more than one
//! > incoming edge. This gateway will be the target of all incoming edges of
//! > `t` and it will precede `t`, whilst its type (XOR, AND, OR) is set
//! > according to the following two rules. If `t` is within an acyclic
//! > homogeneous Single-Entry-Single-Exit region (SESE), we match the type of
//! > the entry gateway of the SESE region, otherwise its type is set to OR.
//! > These rules guarantee soundness for acyclic models and deadlock-freedom
//! > for cyclic models."
//! > — Augusto et al., §III.E
//!
//! Placing the gateways is mechanical. Typing them is where the work is, and
//! it rests on one identification: an SESE region is a dominance/post-dominance
//! pair. For a join `j`, walk `j`'s dominators from the innermost outwards and
//! take the first `d` that `j` post-dominates — that pair `(d, j)` brackets the
//! innermost region `j` closes. The region is everything dominated by `d` and
//! post-dominated by `j`. Then:
//!
//! - *acyclic* — no back edge has both ends inside the closed region;
//! - *homogeneous* — every gateway in it, `d` included, is of one kind;
//!
//! and if both hold the join takes `d`'s kind. Anything else is an OR-join,
//! which is the paper's own fallback and the reason it can claim
//! deadlock-freedom without claiming block-structuredness.
//!
//! Joins are typed innermost first (topological order of the loop-free
//! skeleton), because a nested region's homogeneity is a statement about
//! gateways that include the joins inside it.

use crate::flow::{self, Dominance};
use crate::model::{Gate, Model, NodeId};
use std::collections::BTreeSet;

pub struct Joins {
    /// Every join gateway introduced, with the node it now precedes.
    pub placed: Vec<(NodeId, NodeId)>,
    pub or_joins: usize,
}

pub fn discover(model: &mut Model) -> Joins {
    let mut placed = Vec::new();
    for node in model.nodes() {
        if node == model.source() {
            continue;
        }
        let incoming = model.predecessors(node);
        if incoming.len() < 2 {
            continue;
        }
        // Provisionally an OR — the fallback the rule falls back *to*, so a
        // join that somehow escapes typing is still the safe kind rather than
        // an accidental AND.
        let join = model.new_gate(Gate::Or);
        for source in incoming {
            model.edges.remove(&(source, node));
            model.edges.insert((source, join));
        }
        model.edges.insert((join, node));
        placed.push((join, node));
    }

    let back = flow::back_edges(model);
    let dominance = flow::analyse(model, &back);

    let mut order: Vec<(NodeId, NodeId)> = placed.clone();
    let position = |node: NodeId| dominance.order.iter().position(|&n| n == node).unwrap_or(usize::MAX);
    order.sort_by_key(|&(join, _)| position(join));

    let mut or_joins = 0;
    for (join, _) in order {
        let kind = type_of(model, &dominance, &back, join);
        if kind == Gate::Or {
            or_joins += 1;
        }
        model.set_gate(join, kind);
    }

    Joins { placed, or_joins }
}

fn type_of(model: &Model, dominance: &Dominance, back: &BTreeSet<(NodeId, NodeId)>, join: NodeId) -> Gate {
    for entry in dominance.dominator_chain(join) {
        if !dominance.post_dominates(join, entry) {
            continue;
        }
        // The innermost region `join` closes. Whether it types the join or
        // not, the search stops here: an outer region is a different region,
        // not a second chance at this one.
        let Some(kind) = model.gate(entry) else { return Gate::Or };

        let region: BTreeSet<NodeId> = model
            .nodes()
            .into_iter()
            .filter(|&x| x != entry && x != join)
            .filter(|&x| dominance.dominates(entry, x) && dominance.post_dominates(join, x))
            .collect();

        // Dominance is computed on the loop-free skeleton, so a loop-edge out
        // of the region is invisible to it — and a region a cycle leaves by
        // some other door than its exit is not single-exit, however acyclic
        // the skeleton looks. Each back edge is therefore checked against the
        // region boundary directly:
        //
        //   - both ends inside          a cycle within the region
        //   - inside (not the exit) -> out   a second way out
        //   - out -> inside (not the entry)  a second way in
        //
        // A loop-edge that re-enters at the entry, or leaves from the exit, is
        // the region *being* a loop body and keeps it single-entry-single-exit.
        let mut closed = region.clone();
        closed.insert(entry);
        closed.insert(join);
        let breaks_region = back.iter().any(|&(a, b)| {
            let (inside_a, inside_b) = (closed.contains(&a), closed.contains(&b));
            (inside_a && inside_b)
                || (inside_a && a != join && !inside_b)
                || (inside_b && b != entry && !inside_a)
        });
        if breaks_region {
            return Gate::Or;
        }
        let homogeneous =
            region.iter().all(|&x| model.gate(x).map_or(true, |g| g == kind));
        return if homogeneous { kind } else { Gate::Or };
    }
    Gate::Or
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `source -> split -> {a, b} -> (join) -> sink`, for a given split kind.
    fn diamond(kind: Gate) -> Model {
        let mut m = Model::new(2);
        let split = m.new_gate(kind);
        m.edges.extend([(m.source(), split), (split, 0), (split, 1), (0, m.sink()), (1, m.sink())]);
        m
    }

    #[test]
    fn a_homogeneous_xor_region_gets_a_xor_join() {
        let mut m = diamond(Gate::Xor);
        let joins = discover(&mut m);
        assert_eq!(joins.placed.len(), 1);
        assert_eq!(m.gate(joins.placed[0].0), Some(Gate::Xor));
        assert_eq!(joins.or_joins, 0);
    }

    #[test]
    fn a_homogeneous_and_region_gets_an_and_join() {
        let mut m = diamond(Gate::And);
        let joins = discover(&mut m);
        assert_eq!(m.gate(joins.placed[0].0), Some(Gate::And));
    }

    #[test]
    fn a_heterogeneous_region_falls_back_to_or() {
        // source -> and -> { a, xor -> {b, c} }, everything merging on sink:
        // the region holds gateways of two kinds, so its join is inclusive.
        let mut m = Model::new(3);
        let and = m.new_gate(Gate::And);
        let xor = m.new_gate(Gate::Xor);
        m.edges.extend([
            (m.source(), and), (and, 0), (and, xor), (xor, 1), (xor, 2),
            (0, m.sink()), (1, m.sink()), (2, m.sink()),
        ]);
        let joins = discover(&mut m);
        let outer = joins.placed.iter().find(|&&(_, t)| t == m.sink()).unwrap().0;
        assert_eq!(m.gate(outer), Some(Gate::Or));
        assert_eq!(joins.or_joins, 1);
    }

    #[test]
    fn a_cyclic_region_falls_back_to_or() {
        let mut m = diamond(Gate::Xor);
        // A branch loops back to the split: the region is no longer acyclic.
        m.edges.insert((1, 4));
        let joins = discover(&mut m);
        let join = joins.placed.iter().find(|&&(_, t)| t == m.sink()).unwrap().0;
        assert_eq!(m.gate(join), Some(Gate::Or));
    }

    #[test]
    fn nested_regions_are_typed_innermost_first() {
        // source -> xor1 -> {a, xor2 -> {b, c}}; b and c merge on d, then d
        // and a merge. Both joins should come out XOR, which only happens if
        // the inner one is typed before the outer one reads it.
        let mut m = Model::new(4);
        let xor1 = m.new_gate(Gate::Xor);
        let xor2 = m.new_gate(Gate::Xor);
        m.edges.extend([
            (m.source(), xor1), (xor1, 0), (xor1, xor2), (xor2, 1), (xor2, 2),
            (1, 3), (2, 3), (3, m.sink()), (0, m.sink()),
        ]);
        let joins = discover(&mut m);
        for (join, _) in &joins.placed {
            assert_eq!(m.gate(*join), Some(Gate::Xor), "join {join} should be exclusive");
        }
        assert_eq!(joins.or_joins, 0);
    }

    #[test]
    fn a_single_incoming_edge_needs_no_join() {
        let mut m = Model::new(1);
        m.edges.extend([(m.source(), 0), (0, m.sink())]);
        assert!(discover(&mut m).placed.is_empty());
        assert!(m.gates.is_empty());
    }
}
