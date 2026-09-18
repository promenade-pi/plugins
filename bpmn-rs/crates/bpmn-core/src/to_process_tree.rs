//! BPMN -> Process Tree, via the block-structure decomposition in `rpst.rs`.
//!
//! Solid only when the diagram is block-structured (single start/end event,
//! every gateway pair matched, every cycle the canonical do-redo shape) --
//! `rpst::structure` already establishes exactly that, so this module is
//! just the `Fragment` -> wire-format flattening, matching
//! `app/src/host/artifact/process-tree.ts`'s `ProcessTreePayload` field for
//! field. Rejects (does not approximate) whenever `rpst::structure` does.

use crate::rpst::{structure, Fragment};
use crate::Bpmn;
use serde::Serialize;

#[derive(Serialize)]
pub struct ProcessTreeNode {
    pub operator: Option<&'static str>,
    pub label: Option<String>,
    pub children: Vec<u32>,
}

#[derive(Serialize)]
pub struct ProcessTreePayload {
    pub root: u32,
    pub nodes: Vec<ProcessTreeNode>,
    pub activities: Vec<String>,
}

fn flatten(fragment: &Fragment, out: &mut Vec<ProcessTreeNode>) -> u32 {
    if let Fragment::Loop { body, redo } = fragment {
        let me = out.len() as u32;
        out.push(ProcessTreeNode { operator: Some("loop"), label: None, children: Vec::new() });
        let b = flatten(body, out);
        let r = flatten(redo, out);
        out[me as usize].children = vec![b, r];
        return me;
    }

    let (operator, label, children_frags): (Option<&'static str>, Option<String>, &[Fragment]) = match fragment {
        Fragment::Leaf(label) => (None, label.clone(), &[]),
        Fragment::Sequence(kids) => (Some("sequence"), None, kids.as_slice()),
        Fragment::Xor(kids) => (Some("xor"), None, kids.as_slice()),
        Fragment::And(kids) => (Some("parallel"), None, kids.as_slice()),
        Fragment::Or(kids) => (Some("or"), None, kids.as_slice()),
        Fragment::Loop { .. } => unreachable!("handled above"),
    };

    let me = out.len() as u32;
    out.push(ProcessTreeNode { operator, label, children: Vec::new() });
    let kids: Vec<u32> = children_frags.iter().map(|c| flatten(c, out)).collect();
    out[me as usize].children = kids;
    me
}

pub fn to_process_tree(bpmn: &Bpmn) -> Result<ProcessTreePayload, String> {
    let fragment = structure(bpmn).map_err(|e| e.message)?;
    let mut nodes = Vec::new();
    let root = flatten(&fragment, &mut nodes);
    let mut activities: Vec<String> = nodes.iter().filter_map(|n| n.label.clone()).collect();
    activities.sort();
    activities.dedup();
    Ok(ProcessTreePayload { root, nodes, activities })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Flow, Metadata, Node, NodeKind, SourceType};

    fn n(id: &str, kind: NodeKind, label: Option<&str>) -> Node {
        Node { id: id.into(), kind, label: label.map(String::from) }
    }
    fn f(id: &str, source: &str, target: &str) -> Flow {
        Flow { id: id.into(), source: source.into(), target: target.into(), label: None }
    }

    #[test]
    fn sequence_round_trips_through_from_process_tree() {
        use crate::from_process_tree::from_process_tree;
        use crate::process_tree::ProcessTreePayload as InputTree;

        let tree = InputTree {
            root: 0,
            nodes: vec![
                crate::process_tree::ProcessTreeNode { operator: Some("sequence".into()), label: None, children: vec![1, 2] },
                crate::process_tree::ProcessTreeNode { operator: None, label: Some("A".into()), children: vec![] },
                crate::process_tree::ProcessTreeNode { operator: None, label: Some("B".into()), children: vec![] },
            ],
            activities: vec!["A".into(), "B".into()],
        };
        let bpmn = from_process_tree(&tree).unwrap();
        let back = to_process_tree(&bpmn).unwrap();
        assert_eq!(back.nodes[back.root as usize].operator, Some("sequence"));
        assert_eq!(back.activities, vec!["A".to_string(), "B".to_string()]);
    }

    #[test]
    fn loop_shape() {
        let b = Bpmn {
            nodes: vec![
                n("s", NodeKind::StartEvent, None),
                n("g1", NodeKind::ExclusiveGateway, None),
                n("a", NodeKind::Task, Some("A")),
                n("g2", NodeKind::ExclusiveGateway, None),
                n("b", NodeKind::Task, Some("B")),
                n("e", NodeKind::EndEvent, None),
            ],
            flows: vec![
                f("f1", "s", "g1"), f("f2", "g1", "a"), f("f3", "a", "g2"),
                f("f4", "g2", "e"), f("f5", "g2", "b"), f("f6", "b", "g1"),
            ],
            metadata: Metadata::clean(SourceType::Import),
        };
        let tree = to_process_tree(&b).unwrap();
        let root = &tree.nodes[tree.root as usize];
        assert_eq!(root.operator, Some("loop"));
        assert_eq!(root.children.len(), 2);
    }

    #[test]
    fn rejects_rigid() {
        let b = Bpmn {
            nodes: vec![
                n("s", NodeKind::StartEvent, None),
                n("g1", NodeKind::ExclusiveGateway, None),
                n("a", NodeKind::Task, Some("A")),
                n("b", NodeKind::Task, Some("B")),
                n("g2", NodeKind::ExclusiveGateway, None),
                n("c", NodeKind::Task, Some("C")),
                n("g3", NodeKind::ExclusiveGateway, None),
                n("e", NodeKind::EndEvent, None),
            ],
            flows: vec![
                f("f1", "s", "g1"), f("f2", "g1", "a"), f("f3", "g1", "b"),
                f("f4", "a", "g2"), f("f5", "b", "g2"), f("f6", "g2", "c"),
                f("f7", "b", "g3"), f("f8", "c", "g3"), f("f9", "g3", "e"),
            ],
            metadata: Metadata::clean(SourceType::Import),
        };
        assert!(to_process_tree(&b).is_err());
    }
}
