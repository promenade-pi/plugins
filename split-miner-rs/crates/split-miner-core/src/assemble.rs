//! The finished model, in `bpmn-core`'s own types.
//!
//! The `Bpmn` struct is imported rather than redeclared: this crate emits the
//! artifact the BPMN plugin's view renders and its `to-petrinet` /
//! `to-process-tree` conversions consume, so the two have to be the same
//! struct, not two schemas that agree today.
//!
//! `metadata.sourceType` stays `None`. Its three values name the three
//! *conversions* that type exists for — an accepting Petri net, a process
//! tree, an imported file — and a diagram mined from an event log is none of
//! them. Nothing in the app reads the field, so widening the enum (and with it
//! the host's TypeScript union, and with that a release of a plugin this one
//! merely borrows a struct from) would buy a label no screen shows. Where the
//! diagram came from is recorded where it is actually read: the artifact's own
//! provenance.

use crate::model::{Gate, Model, NodeId};
use crate::observe::Observations;
use bpmn_core::{Bpmn, Flow, Metadata, Node, NodeKind};

fn node_id(model: &Model, node: NodeId) -> String {
    if node == model.source() {
        "start".to_string()
    } else if node == model.sink() {
        "end".to_string()
    } else if model.is_activity(node) {
        format!("task_{node}")
    } else {
        format!("gw_{}", node - model.n - 2)
    }
}

pub fn to_bpmn(model: &Model, obs: &Observations, warnings: Vec<String>) -> Bpmn {
    let mut nodes = Vec::new();
    for node in model.nodes() {
        let (kind, label) = if node == model.source() {
            (NodeKind::StartEvent, None)
        } else if node == model.sink() {
            (NodeKind::EndEvent, None)
        } else if model.is_activity(node) {
            (NodeKind::Task, Some(obs.name(node).to_string()))
        } else {
            let kind = match model.gate(node) {
                Some(Gate::Xor) => NodeKind::ExclusiveGateway,
                Some(Gate::And) => NodeKind::ParallelGateway,
                // A gateway id with no kind cannot occur — `new_gate` always
                // records one — but inclusive is the safe reading of "unknown
                // routing" and matches the join fallback.
                _ => NodeKind::InclusiveGateway,
            };
            (kind, None)
        };
        nodes.push(Node { id: node_id(model, node), kind, label });
    }

    // `model.edges` is a BTreeSet, so this order is the node id order and the
    // same log always produces the same diagram, flow ids included.
    let flows = model
        .edges
        .iter()
        .enumerate()
        .map(|(i, &(a, b))| Flow {
            id: format!("flow_{i}"),
            source: node_id(model, a),
            target: node_id(model, b),
            label: None,
        })
        .collect();

    let mut bpmn =
        Bpmn { nodes, flows, metadata: Metadata { source_type: None, structured: false, warnings } };
    // Reported rather than assumed. Split Miner is explicitly not restricted to
    // block-structured output, but it is not prevented from producing it
    // either — a log whose behaviour happens to nest cleanly gets a diagram
    // that does, and saying otherwise would put a "not block-structured"
    // notice on a model that is.
    bpmn.metadata.structured = bpmn_core::rpst::structure(&bpmn).is_ok();
    bpmn
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::scan_complete;

    #[test]
    fn a_sequence_becomes_a_valid_diagram() {
        let obs = scan_complete(&[&[0, 1]], 2);
        let mut model = Model::new(2);
        model.edges.extend([(model.source(), 0), (0, 1), (1, model.sink())]);
        let bpmn = to_bpmn(&model, &obs, Vec::new());
        assert_eq!(bpmn.validate(), Ok(()));
        assert_eq!(bpmn.nodes.len(), 4);
        assert_eq!(bpmn.flows.len(), 3);
        let task = bpmn.nodes.iter().find(|n| n.kind == NodeKind::Task).unwrap();
        assert_eq!(task.label.as_deref(), Some("activity 0"));
    }

    #[test]
    fn a_sequence_is_reported_as_block_structured() {
        let obs = scan_complete(&[&[0, 1]], 2);
        let mut model = Model::new(2);
        model.edges.extend([(model.source(), 0), (0, 1), (1, model.sink())]);
        assert!(to_bpmn(&model, &obs, Vec::new()).metadata.structured);
    }

    #[test]
    fn a_model_that_does_not_nest_says_so() {
        // Two overlapping choices sharing a branch: behaviourally fine, not a
        // single nested block.
        let obs = scan_complete(&[&[0, 1, 2]], 3);
        let mut model = Model::new(3);
        let x1 = model.new_gate(Gate::Xor);
        let x2 = model.new_gate(Gate::Xor);
        let j = model.new_gate(Gate::Xor);
        model.edges.extend([
            (model.source(), x1), (x1, 0), (x1, 1), (1, x2), (x2, 2), (x2, j),
            (0, j), (2, j), (j, model.sink()),
        ]);
        assert!(!to_bpmn(&model, &obs, Vec::new()).metadata.structured);
    }

    #[test]
    fn gateway_kinds_map_onto_bpmn_gateways() {
        let obs = scan_complete(&[&[0]], 1);
        let mut model = Model::new(1);
        let xor = model.new_gate(Gate::Xor);
        let and = model.new_gate(Gate::And);
        let or = model.new_gate(Gate::Or);
        model.edges.extend([
            (model.source(), xor), (xor, and), (and, or), (or, 0), (0, model.sink()),
        ]);
        let bpmn = to_bpmn(&model, &obs, Vec::new());
        let kind_of = |id: &str| bpmn.node(id).unwrap().kind;
        assert_eq!(kind_of("gw_0"), NodeKind::ExclusiveGateway);
        assert_eq!(kind_of("gw_1"), NodeKind::ParallelGateway);
        assert_eq!(kind_of("gw_2"), NodeKind::InclusiveGateway);
        assert_eq!(bpmn.validate(), Ok(()));
    }
}
