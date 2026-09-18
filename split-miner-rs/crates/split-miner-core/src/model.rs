//! The BPMN process model while it is being built.
//!
//! The paper's own definition:
//!
//! > A BPMN process model is a connected graph `M = (i, o, T, G+, G×, G°, Em)`,
//! > where `T` is a non-empty set of tasks, `i` the start event, `o` the end
//! > event, `G+` the AND-gateways, `G×` the XOR-gateways and `G°` the
//! > OR-gateways.
//!
//! Here that is one flat id space so a gateway and a task can be handled
//! uniformly by the split, join and dominator passes — all of which care about
//! graph shape, not about which of the two a node happens to be:
//!
//! ```text
//!   0 .. n        activities, in the host's own activity-id numbering
//!   n             the start event
//!   n + 1         the end event
//!   n + 2 ..      gateways, in creation order
//! ```

use std::collections::BTreeSet;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Gate {
    Xor,
    And,
    Or,
}

pub type NodeId = usize;

#[derive(Clone)]
pub struct Model {
    pub n: usize,
    pub gates: Vec<Gate>,
    pub edges: BTreeSet<(NodeId, NodeId)>,
    /// Activities that carry a self-loop, restored before the gateways are
    /// discovered so the loop gets the routing it needs.
    pub self_loops: BTreeSet<NodeId>,
}

impl Model {
    pub fn new(n: usize) -> Self {
        Self { n, gates: Vec::new(), edges: BTreeSet::new(), self_loops: BTreeSet::new() }
    }

    pub fn source(&self) -> NodeId {
        self.n
    }
    pub fn sink(&self) -> NodeId {
        self.n + 1
    }
    pub fn is_activity(&self, node: NodeId) -> bool {
        node < self.n
    }
    pub fn gate(&self, node: NodeId) -> Option<Gate> {
        node.checked_sub(self.n + 2).and_then(|i| self.gates.get(i).copied())
    }
    pub fn set_gate(&mut self, node: NodeId, kind: Gate) {
        if let Some(i) = node.checked_sub(self.n + 2) {
            if let Some(slot) = self.gates.get_mut(i) {
                *slot = kind;
            }
        }
    }
    pub fn new_gate(&mut self, kind: Gate) -> NodeId {
        self.gates.push(kind);
        self.n + 1 + self.gates.len()
    }

    pub fn successors(&self, a: NodeId) -> Vec<NodeId> {
        self.edges.iter().filter(|(x, _)| *x == a).map(|(_, y)| *y).collect()
    }
    pub fn predecessors(&self, b: NodeId) -> Vec<NodeId> {
        self.edges.iter().filter(|(_, y)| *y == b).map(|(x, _)| *x).collect()
    }
    pub fn nodes(&self) -> BTreeSet<NodeId> {
        let mut nodes: BTreeSet<NodeId> = BTreeSet::from([self.source(), self.sink()]);
        for &(a, b) in &self.edges {
            nodes.insert(a);
            nodes.insert(b);
        }
        nodes
    }

    /// Replaces `from`'s outgoing arcs with a single arc to `to`.
    pub fn redirect_out(&mut self, from: NodeId, to: NodeId) {
        self.edges.retain(|&(x, _)| x != from);
        self.edges.insert((from, to));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_ids_do_not_collide_with_activities_or_events() {
        let mut m = Model::new(3);
        let g1 = m.new_gate(Gate::Xor);
        let g2 = m.new_gate(Gate::And);
        assert_eq!(m.source(), 3);
        assert_eq!(m.sink(), 4);
        assert_eq!((g1, g2), (5, 6));
        assert_eq!(m.gate(g1), Some(Gate::Xor));
        assert_eq!(m.gate(g2), Some(Gate::And));
        assert_eq!(m.gate(0), None);
        assert_eq!(m.gate(m.sink()), None);
        assert!(m.is_activity(0) && !m.is_activity(m.source()));
    }
}
