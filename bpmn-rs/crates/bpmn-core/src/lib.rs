//! The BPMN model, plus conversions to/from Petri nets and process trees.
//!
//! This crate is deliberately inert about anything but the pure control-flow
//! subset of BPMN 2.0: tasks, start/end events, exclusive/parallel/inclusive
//! gateways, sequence flows. No pools/lanes, message flows, sub-processes, or
//! boundary/timer events — none of the four conversions this crate exists
//! for need them, and inventing fields nothing else reads would just be a
//! second, unused schema riding along with the real one.
//!
//! Mirrors the host's `BpmnPayload` (`app/src/host/artifact/bpmn.ts`)
//! field-for-field — this file and that one are the same contract in two
//! languages, not two independent schemas that happen to agree today.
//!
//! # No layout coordinates
//!
//! Same convention as `ocpn-core`: layout is view state, computed at render
//! time, never persisted into the artifact.

use serde::{Deserialize, Serialize};

pub mod export_xml;
pub mod from_petri_net;
pub mod from_process_tree;
pub mod import_xml;
pub mod or_join;
pub mod petri_net;
pub mod process_tree;
pub mod rpst;
pub mod to_petri_net;
pub mod to_petri_net_direct;
pub mod to_process_tree;

pub type NodeId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    Task,
    StartEvent,
    EndEvent,
    ExclusiveGateway,
    ParallelGateway,
    InclusiveGateway,
}

impl NodeKind {
    pub fn is_gateway(self) -> bool {
        matches!(
            self,
            NodeKind::ExclusiveGateway | NodeKind::ParallelGateway | NodeKind::InclusiveGateway
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub id: NodeId,
    pub kind: NodeKind,
    /// Activity name for a task; `None` for every other kind.
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Flow {
    pub id: NodeId,
    pub source: NodeId,
    pub target: NodeId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceType {
    AcceptingPetriNet,
    ProcessTree,
    Import,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Metadata {
    #[serde(rename = "sourceType")]
    pub source_type: Option<SourceType>,
    /// False when a Petri-net-sourced diagram isn't block-structured — still
    /// a valid, behavior-preserving translation, just not a clean single
    /// XOR/AND block structure.
    pub structured: bool,
    pub warnings: Vec<String>,
}

impl Metadata {
    pub fn clean(source_type: SourceType) -> Self {
        Metadata { source_type: Some(source_type), structured: true, warnings: Vec::new() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Bpmn {
    pub nodes: Vec<Node>,
    pub flows: Vec<Flow>,
    pub metadata: Metadata,
}

impl Bpmn {
    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.iter().find(|n| n.id == id)
    }

    pub fn outgoing<'a>(&'a self, id: &'a str) -> impl Iterator<Item = &'a Flow> + 'a {
        self.flows.iter().filter(move |f| f.source == id)
    }

    pub fn incoming<'a>(&'a self, id: &'a str) -> impl Iterator<Item = &'a Flow> + 'a {
        self.flows.iter().filter(move |f| f.target == id)
    }

    /// The same boundary check `validateBpmn` performs on the TS side.
    pub fn validate(&self) -> Result<(), String> {
        let mut seen = std::collections::HashSet::new();
        for n in &self.nodes {
            if !seen.insert(n.id.as_str()) {
                return Err(format!("duplicate node id {}", n.id));
            }
            let has_label = n.label.is_some();
            if (n.kind == NodeKind::Task) != has_label {
                return Err(format!("node {} ({:?}) has an inconsistent label", n.id, n.kind));
            }
        }
        for f in &self.flows {
            if self.node(&f.source).is_none() {
                return Err(format!("flow {} references unknown source {}", f.id, f.source));
            }
            if self.node(&f.target).is_none() {
                return Err(format!("flow {} references unknown target {}", f.id, f.target));
            }
        }
        if !self.nodes.iter().any(|n| n.kind == NodeKind::StartEvent) {
            return Err("no start event".into());
        }
        if !self.nodes.iter().any(|n| n.kind == NodeKind::EndEvent) {
            return Err("no end event".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(id: &str, kind: NodeKind, label: Option<&str>) -> Node {
        Node { id: id.into(), kind, label: label.map(String::from) }
    }
    fn f(id: &str, source: &str, target: &str) -> Flow {
        Flow { id: id.into(), source: source.into(), target: target.into(), label: None }
    }

    #[test]
    fn validates_a_minimal_diagram() {
        let b = Bpmn {
            nodes: vec![
                n("s", NodeKind::StartEvent, None),
                n("t", NodeKind::Task, Some("A")),
                n("e", NodeKind::EndEvent, None),
            ],
            flows: vec![f("f1", "s", "t"), f("f2", "t", "e")],
            metadata: Metadata::clean(SourceType::Import),
        };
        assert!(b.validate().is_ok());
    }

    #[test]
    fn rejects_missing_start() {
        let b = Bpmn {
            nodes: vec![n("t", NodeKind::Task, Some("A")), n("e", NodeKind::EndEvent, None)],
            flows: vec![f("f1", "t", "e")],
            metadata: Metadata::clean(SourceType::Import),
        };
        assert_eq!(b.validate(), Err("no start event".into()));
    }

    #[test]
    fn rejects_dangling_flow() {
        let b = Bpmn {
            nodes: vec![n("s", NodeKind::StartEvent, None), n("e", NodeKind::EndEvent, None)],
            flows: vec![f("f1", "s", "ghost")],
            metadata: Metadata::clean(SourceType::Import),
        };
        assert!(b.validate().unwrap_err().contains("ghost"));
    }
}
