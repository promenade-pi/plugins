//! Process tree -> BPMN: a direct recursive translation, solid and solved in
//! the literature (pm4py's `to_bpmn`/`recursively_add_tree` does the same
//! thing) — block-structured by construction, since a process tree already
//! is. No soundness precondition to check, unlike the Petri-net direction.
//!
//! Each recursive step returns the single entry and single exit node id of
//! the fragment it built (`None` for a tau leaf — a fragment with no node at
//! all, wired as a direct pass-through edge by whichever composer is
//! holding it). That single-entry/single-exit invariant is exactly what
//! makes the composition recursive: a caller never needs to know whether a
//! child was a leaf or a deeply nested operator.
//!
//! `or` (inclusive choice) gets the same split/join treatment as `xor`/
//! `parallel`: an OR-split paired with an OR-join at the same nesting level
//! is exactly the "structured" case the literature calls well-defined (the
//! non-local-semantics problem only arises for an *unstructured* OR-join,
//! which cannot happen here since the pairing comes from one process-tree
//! node). `interleaving` and `partialorder` have no single-gateway BPMN
//! equivalent and are rejected outright, naming the offending node — no
//! silent approximation.

use crate::process_tree::{ProcessTreeNode, ProcessTreePayload};
use crate::{Bpmn, Flow, Metadata, Node, NodeKind, SourceType};
use std::collections::HashSet;

struct Ctx {
    nodes: Vec<Node>,
    flows: Vec<Flow>,
    flow_keys: HashSet<(String, String)>,
    next_node: u32,
    next_flow: u32,
}

impl Ctx {
    fn new_node(&mut self, kind: NodeKind, label: Option<String>) -> String {
        let id = format!("n{}", self.next_node);
        self.next_node += 1;
        self.nodes.push(Node { id: id.clone(), kind, label });
        id
    }

    /// Idempotent: two tau branches into the same split/join produce one
    /// edge, not a duplicate — they are semantically identical no-ops.
    fn connect(&mut self, source: &str, target: &str) {
        let key = (source.to_string(), target.to_string());
        if self.flow_keys.contains(&key) {
            return;
        }
        self.flow_keys.insert(key.clone());
        let id = format!("f{}", self.next_flow);
        self.next_flow += 1;
        self.flows.push(Flow { id, source: key.0, target: key.1, label: None });
    }
}

type Fragment = Option<(String, String)>;

fn gateway_kind(operator: &str) -> Option<NodeKind> {
    match operator {
        "xor" => Some(NodeKind::ExclusiveGateway),
        "parallel" => Some(NodeKind::ParallelGateway),
        "or" => Some(NodeKind::InclusiveGateway),
        _ => None,
    }
}

/// Builds an XOR/AND/OR split-then-join fragment: a split gateway, a join
/// gateway, and each child wired split -> child -> join (or split -> join
/// directly, for a tau child).
fn build_choice(
    tree: &ProcessTreePayload,
    children: &[usize],
    kind: NodeKind,
    ctx: &mut Ctx,
) -> Result<Fragment, String> {
    let split = ctx.new_node(kind, None);
    let join = ctx.new_node(kind, None);
    for &c in children {
        match translate(tree, c, ctx)? {
            Some((entry, exit)) => {
                ctx.connect(&split, &entry);
                ctx.connect(&exit, &join);
            }
            None => ctx.connect(&split, &join),
        }
    }
    Ok(Some((split, join)))
}

/// Builds a sequence fragment: children in order, tau children skipped
/// (contributing no node, just letting their neighbours connect directly).
fn build_sequence(tree: &ProcessTreePayload, children: &[usize], ctx: &mut Ctx) -> Result<Fragment, String> {
    let mut entry: Option<String> = None;
    let mut last_exit: Option<String> = None;
    for &c in children {
        if let Some((e, x)) = translate(tree, c, ctx)? {
            if let Some(prev) = &last_exit {
                ctx.connect(prev, &e);
            }
            if entry.is_none() {
                entry = Some(e);
            }
            last_exit = Some(x);
        }
    }
    match (entry, last_exit) {
        (Some(e), Some(x)) => Ok(Some((e, x))),
        _ => Ok(None), // every child was tau: the whole sequence is a no-op
    }
}

/// The do-redo loop pattern: a merge gateway (`g1`, the fragment's entry —
/// predecessor and the redo branch both flow in), the body, a split gateway
/// after it (`g2`) choosing between the redo branch (looping back to `g1`)
/// and leaving the loop. Reflects exactly what Promenade's own Inductive
/// Miner emits for a loop node: `[body, redo]`, or `[body, redo, exit]` when
/// the exit condition is not itself tau (see `inductive-miner-rs`'s
/// `tree.rs`) — everything past index 2 is only ever an exit-condition
/// slot, never additional redo branches, so no n-ary/pairwise normalization
/// is needed here.
fn build_loop(tree: &ProcessTreePayload, children: &[usize], ctx: &mut Ctx) -> Result<Fragment, String> {
    if children.len() < 2 || children.len() > 3 {
        return Err(format!(
            "loop node has {} children, expected 2 (body, redo) or 3 (body, redo, exit)",
            children.len()
        ));
    }
    let g1 = ctx.new_node(NodeKind::ExclusiveGateway, None); // entry / merge
    let g2 = ctx.new_node(NodeKind::ExclusiveGateway, None); // split after body

    match translate(tree, children[0], ctx)? {
        Some((be, bx)) => {
            ctx.connect(&g1, &be);
            ctx.connect(&bx, &g2);
        }
        None => ctx.connect(&g1, &g2),
    }
    match translate(tree, children[1], ctx)? {
        Some((re, rx)) => {
            ctx.connect(&g2, &re);
            ctx.connect(&rx, &g1);
        }
        None => ctx.connect(&g2, &g1),
    }
    let exit = match children.get(2) {
        Some(&idx) => match translate(tree, idx, ctx)? {
            Some((ee, ex)) => {
                ctx.connect(&g2, &ee);
                ex
            }
            None => g2.clone(),
        },
        None => g2.clone(),
    };
    Ok(Some((g1, exit)))
}

fn translate(tree: &ProcessTreePayload, idx: usize, ctx: &mut Ctx) -> Result<Fragment, String> {
    let node: &ProcessTreeNode = tree
        .nodes
        .get(idx)
        .ok_or_else(|| format!("process tree references unknown node {idx}"))?;

    match &node.operator {
        None => {
            if node.is_tau() {
                Ok(None)
            } else {
                let id = ctx.new_node(NodeKind::Task, node.label.clone());
                Ok(Some((id.clone(), id)))
            }
        }
        Some(op) => {
            let children = node.children.clone();
            match op.as_str() {
                "sequence" => build_sequence(tree, &children, ctx),
                "xor" | "parallel" | "or" => {
                    let kind = gateway_kind(op).unwrap();
                    build_choice(tree, &children, kind, ctx)
                }
                "loop" => build_loop(tree, &children, ctx),
                other => Err(format!(
                    "process tree node {idx} uses operator '{other}', which has no BPMN equivalent — not converted"
                )),
            }
        }
    }
}

/// Converts a process tree to a BPMN diagram. Never rejects for a
/// structural reason on the well-supported operators (sequence, xor,
/// parallel, or, loop) — only `interleaving`/`partialorder` are refused.
pub fn from_process_tree(tree: &ProcessTreePayload) -> Result<Bpmn, String> {
    let mut ctx = Ctx {
        nodes: Vec::new(),
        flows: Vec::new(),
        flow_keys: HashSet::new(),
        next_node: 0,
        next_flow: 0,
    };
    let body = translate(tree, tree.root, &mut ctx)?;

    let start = ctx.new_node(NodeKind::StartEvent, None);
    let end = ctx.new_node(NodeKind::EndEvent, None);
    match body {
        Some((entry, exit)) => {
            ctx.connect(&start, &entry);
            ctx.connect(&exit, &end);
        }
        None => ctx.connect(&start, &end),
    }

    let bpmn = Bpmn {
        nodes: ctx.nodes,
        flows: ctx.flows,
        metadata: Metadata::clean(SourceType::ProcessTree),
    };
    bpmn.validate()?;
    Ok(bpmn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(label: Option<&str>) -> ProcessTreeNode {
        ProcessTreeNode { operator: None, label: label.map(String::from), children: vec![] }
    }
    fn op(operator: &str, children: Vec<usize>) -> ProcessTreeNode {
        ProcessTreeNode { operator: Some(operator.into()), label: None, children }
    }

    fn count(bpmn: &Bpmn, kind: NodeKind) -> usize {
        bpmn.nodes.iter().filter(|n| n.kind == kind).count()
    }

    #[test]
    fn single_activity() {
        let tree = ProcessTreePayload { root: 0, nodes: vec![leaf(Some("A"))], activities: vec!["A".into()] };
        let bpmn = from_process_tree(&tree).unwrap();
        assert_eq!(count(&bpmn, NodeKind::Task), 1);
        assert_eq!(count(&bpmn, NodeKind::StartEvent), 1);
        assert_eq!(count(&bpmn, NodeKind::EndEvent), 1);
        assert_eq!(bpmn.flows.len(), 2);
    }

    #[test]
    fn sequence_of_two() {
        // seq(A, B)
        let tree = ProcessTreePayload {
            root: 0,
            nodes: vec![op("sequence", vec![1, 2]), leaf(Some("A")), leaf(Some("B"))],
            activities: vec!["A".into(), "B".into()],
        };
        let bpmn = from_process_tree(&tree).unwrap();
        assert_eq!(count(&bpmn, NodeKind::Task), 2);
        assert_eq!(count(&bpmn, NodeKind::ExclusiveGateway), 0);
        assert_eq!(bpmn.flows.len(), 3); // start->A, A->B, B->end
    }

    #[test]
    fn xor_choice_with_tau_branch() {
        // xor(tau, A) -- optional A
        let tree = ProcessTreePayload {
            root: 0,
            nodes: vec![op("xor", vec![1, 2]), leaf(None), leaf(Some("A"))],
            activities: vec!["A".into()],
        };
        let bpmn = from_process_tree(&tree).unwrap();
        assert_eq!(count(&bpmn, NodeKind::Task), 1);
        assert_eq!(count(&bpmn, NodeKind::ExclusiveGateway), 2); // split + join
        bpmn.validate().unwrap();
    }

    #[test]
    fn parallel_of_two() {
        // and(A, B)
        let tree = ProcessTreePayload {
            root: 0,
            nodes: vec![op("parallel", vec![1, 2]), leaf(Some("A")), leaf(Some("B"))],
            activities: vec!["A".into(), "B".into()],
        };
        let bpmn = from_process_tree(&tree).unwrap();
        assert_eq!(count(&bpmn, NodeKind::ParallelGateway), 2);
        assert_eq!(count(&bpmn, NodeKind::Task), 2);
    }

    #[test]
    fn loop_body_redo() {
        // loop(A, B): A at least once, optionally B then A again
        let tree = ProcessTreePayload {
            root: 0,
            nodes: vec![op("loop", vec![1, 2]), leaf(Some("A")), leaf(Some("B"))],
            activities: vec!["A".into(), "B".into()],
        };
        let bpmn = from_process_tree(&tree).unwrap();
        assert_eq!(count(&bpmn, NodeKind::ExclusiveGateway), 2); // g1 merge, g2 split
        assert_eq!(count(&bpmn, NodeKind::Task), 2);
        // g2 has a back-edge into g1 and an exit edge onward: 2 outgoing.
        let g2 = bpmn.nodes.iter().find(|n| n.kind == NodeKind::ExclusiveGateway
            && bpmn.incoming(&n.id).count() == 1
            && bpmn.outgoing(&n.id).count() == 2
            && bpmn.incoming(&n.id).next().unwrap().source != n.id).unwrap();
        assert_eq!(bpmn.outgoing(&g2.id).count(), 2);
    }

    #[test]
    fn self_loop_tau_redo() {
        // loop(A, tau): A repeats one or more times with nothing between.
        let tree = ProcessTreePayload {
            root: 0,
            nodes: vec![op("loop", vec![1, 2]), leaf(Some("A")), leaf(None)],
            activities: vec!["A".into()],
        };
        let bpmn = from_process_tree(&tree).unwrap();
        bpmn.validate().unwrap();
        assert_eq!(count(&bpmn, NodeKind::Task), 1);
    }

    #[test]
    fn rejects_interleaving() {
        let tree = ProcessTreePayload {
            root: 0,
            nodes: vec![op("interleaving", vec![1, 2]), leaf(Some("A")), leaf(Some("B"))],
            activities: vec!["A".into(), "B".into()],
        };
        let err = from_process_tree(&tree).unwrap_err();
        assert!(err.contains("interleaving"));
        assert!(err.contains('0'));
    }

    #[test]
    fn whole_tree_is_tau() {
        let tree = ProcessTreePayload { root: 0, nodes: vec![leaf(None)], activities: vec![] };
        let bpmn = from_process_tree(&tree).unwrap();
        assert_eq!(bpmn.nodes.len(), 2); // just start, end
        assert_eq!(bpmn.flows.len(), 1);
    }

    #[test]
    fn nested_xor_of_sequences_round_trips_activity_count() {
        // seq(A, xor(B, seq(C, D)))
        let tree = ProcessTreePayload {
            root: 0,
            nodes: vec![
                op("sequence", vec![1, 2]),
                leaf(Some("A")),
                op("xor", vec![3, 4]),
                leaf(Some("B")),
                op("sequence", vec![5, 6]),
                leaf(Some("C")),
                leaf(Some("D")),
            ],
            activities: vec!["A".into(), "B".into(), "C".into(), "D".into()],
        };
        let bpmn = from_process_tree(&tree).unwrap();
        assert_eq!(count(&bpmn, NodeKind::Task), 4);
        bpmn.validate().unwrap();
    }
}
