//! Block-structure decomposition of a BPMN diagram's control-flow graph.
//!
//! This is **not** a full RPST (Refined Process Structure Tree, Vanhatalo et
//! al. — a triconnected-component/SPQR-tree decomposition of the flow
//! graph's underlying undirected multigraph). That is a substantially larger
//! algorithm. What is implemented instead is a well-known, simpler
//! alternative that is exactly correct for the same purpose on a
//! block-structured (or close to it) graph: repeatedly apply local
//! graph-rewriting rules --
//!
//! - **sequence**: `a -> b` where `a`'s only outgoing edge is to `b` and
//!   `b`'s only incoming edge is from `a`, collapses into one node.
//! - **gateway pair**: a split gateway `s` (kind `K`, >=2 outgoing) whose
//!   every branch is used exclusively by `s` and leads, in exactly one hop,
//!   to a single join `j` of the *same* kind `K`, with no other incoming
//!   edge -- collapses `s`, every branch, and `j` into one `Xor`/`And`/`Or`
//!   node.
//! - **loop**: the canonical do-redo shape this plugin's own
//!   `from_process_tree` produces -- a merge gateway `m` (in-degree 2,
//!   out-degree 1) feeding a split gateway `g2` (in-degree 1, out-degree 2)
//!   where one of `g2`'s branches leads back to `m` (directly, or through
//!   one more fully-reduced node) -- collapses into one `Loop` node.
//!
//! -- until the graph is one node (fully block-structured; that node's
//! `Fragment` is the whole diagram) or no rule applies with more than one
//! node left (a genuinely non-block-structured, "rigid" remainder -- the
//! literature's own conclusion here is that no equivalent block-structured
//! model exists to fall back to, so this returns the offending node ids
//! rather than approximating).
//!
//! Being simpler than full RPST, this can reject a small class of
//! block-structured graphs a triconnected-component analysis would still
//! accept (a "bond" region whose branches share internal sub-structure in a
//! way these three local rules don't happen to peel in the right order).
//! It never does the reverse: every graph this *does* accept is genuinely
//! block-structured, which is the property both `to_process_tree` and
//! `to_petri_net` need — reject, never approximate.

use crate::{Bpmn, NodeKind};
use std::collections::HashMap;

/// Sentinels for the stripped start/end events: present in the edge list
/// (so a node's degree still counts the boundary connection -- the loop
/// rule's merge gateway needs to see its true in-degree of 2, external plus
/// redo) but never a key in `fragments`/`kinds`, so they are never
/// themselves a reduction target.
const START_ID: u32 = u32::MAX;
const END_ID: u32 = u32::MAX - 1;

#[derive(Debug, Clone, PartialEq)]
pub enum Fragment {
    /// A task's activity label, or `None` for a tau (silent) leaf -- a
    /// stripped start/end event boundary, or a gateway with no real work.
    Leaf(Option<String>),
    Sequence(Vec<Fragment>),
    Xor(Vec<Fragment>),
    And(Vec<Fragment>),
    Or(Vec<Fragment>),
    Loop { body: Box<Fragment>, redo: Box<Fragment> },
}

impl Fragment {
    fn sequence_of(a: Fragment, b: Fragment) -> Fragment {
        let mut kids = Vec::new();
        match a {
            Fragment::Sequence(v) => kids.extend(v),
            other => kids.push(other),
        }
        match b {
            Fragment::Sequence(v) => kids.extend(v),
            other => kids.push(other),
        }
        Fragment::Sequence(kids)
    }
}

pub struct StructuringError {
    pub message: String,
}

struct Work {
    fragments: HashMap<u32, Fragment>,
    /// Only present for a node still exactly as BPMN declared it (a gateway
    /// whose split/join role may not yet be matched) -- absent once a node
    /// has been folded into any composite, since it no longer has a single
    /// BPMN kind of its own.
    kinds: HashMap<u32, NodeKind>,
    edges: Vec<(u32, u32)>,
    next_id: u32,
}

impl Work {
    fn out_edges(&self, id: u32) -> Vec<u32> {
        let mut v: Vec<u32> = self.edges.iter().filter(|(s, _)| *s == id).map(|(_, t)| *t).collect();
        v.sort();
        v
    }
    fn in_edges(&self, id: u32) -> Vec<u32> {
        let mut v: Vec<u32> = self.edges.iter().filter(|(_, t)| *t == id).map(|(s, _)| *s).collect();
        v.sort();
        v
    }

    fn rewire_and_insert(&mut self, removed: &[u32], fragment: Fragment) -> u32 {
        let new_id = self.next_id;
        self.next_id += 1;
        for r in removed {
            self.fragments.remove(r);
            self.kinds.remove(r);
        }
        self.fragments.insert(new_id, fragment);
        for e in self.edges.iter_mut() {
            if removed.contains(&e.0) {
                e.0 = new_id;
            }
            if removed.contains(&e.1) {
                e.1 = new_id;
            }
        }
        self.edges.retain(|&(s, t)| !(s == new_id && t == new_id));
        self.edges.sort();
        self.edges.dedup();
        new_id
    }
}

fn try_sequence(work: &mut Work) -> bool {
    let ids: Vec<u32> = work.fragments.keys().copied().collect();
    for a in ids {
        let outs = work.out_edges(a);
        if outs.len() != 1 {
            continue;
        }
        let b = outs[0];
        if a == b || b == START_ID || b == END_ID {
            continue;
        }
        let ins_b = work.in_edges(b);
        if ins_b.len() != 1 || ins_b[0] != a {
            continue;
        }
        // Don't erase a still-active gateway's identity: a join (in-degree
        // > 1) must stay individually recognisable by kind until the
        // gateway rule has matched it against its split.
        if let Some(k) = work.kinds.get(&a) {
            if k.is_gateway() && work.in_edges(a).len() > 1 {
                continue;
            }
        }
        if let Some(k) = work.kinds.get(&b) {
            if k.is_gateway() && work.out_edges(b).len() > 1 {
                continue;
            }
        }
        let fa = work.fragments.get(&a).unwrap().clone();
        let fb = work.fragments.get(&b).unwrap().clone();
        work.rewire_and_insert(&[a, b], Fragment::sequence_of(fa, fb));
        return true;
    }
    false
}

/// A split's branch can be a private intermediate node leading to the join
/// in one hop (the ordinary case), or -- for a tau child, since
/// `from_process_tree.rs`'s `build_choice` connects a tau branch straight
/// from the split to the join with no node in between at all -- the branch
/// target can just *be* the join directly. Both shapes have to be
/// recognised, or every gateway with a tau/optional branch (an `xor(tau,
/// A)`, extremely common in a mined tree) fails to reduce.
fn try_gateway(work: &mut Work) -> bool {
    let ids: Vec<u32> = work.fragments.keys().copied().collect();
    for s in ids {
        let Some(k) = work.kinds.get(&s).copied() else { continue };
        if !k.is_gateway() {
            continue;
        }
        let branch_targets = work.out_edges(s);
        if branch_targets.len() < 2 {
            continue;
        }

        let mut j_candidates: Vec<u32> = Vec::new();
        for &b in &branch_targets {
            j_candidates.push(b); // the direct/tau shape
            let outs = work.out_edges(b);
            if outs.len() == 1 {
                j_candidates.push(outs[0]); // the ordinary one-hop shape
            }
        }
        j_candidates.sort();
        j_candidates.dedup();

        'candidates: for &j in &j_candidates {
            if j == s || work.kinds.get(&j).copied() != Some(k) {
                continue;
            }
            let mut private_nodes = Vec::new();
            for &b in &branch_targets {
                if b == j {
                    continue; // the direct/tau branch -- no node to remove
                }
                let ins = work.in_edges(b);
                if ins.len() != 1 || ins[0] != s {
                    continue 'candidates;
                }
                if work.out_edges(b) != vec![j] {
                    continue 'candidates;
                }
                private_nodes.push(b);
            }
            if work.in_edges(j).len() != branch_targets.len() {
                continue 'candidates;
            }

            let children: Vec<Fragment> = branch_targets
                .iter()
                .map(|&b| if b == j { Fragment::Leaf(None) } else { work.fragments.get(&b).unwrap().clone() })
                .collect();
            let merged = match k {
                NodeKind::ExclusiveGateway => Fragment::Xor(children),
                NodeKind::ParallelGateway => Fragment::And(children),
                NodeKind::InclusiveGateway => Fragment::Or(children),
                _ => unreachable!("is_gateway() guards this"),
            };
            let mut removed = private_nodes;
            removed.push(s);
            removed.push(j);
            work.rewire_and_insert(&removed, merged);
            return true;
        }
    }
    false
}

/// Walks forward from `start` through a plain chain of nodes -- each with
/// exactly one incoming and one outgoing edge, and not itself an
/// as-yet-unresolved gateway (a raw `kind` entry means some split/join
/// elsewhere still needs it intact; walking through it here would be
/// premature, not incorrect to eventually retry) -- until it reaches
/// `target` or gets stuck. Returns the chain's node ids in order, excluding
/// `target` itself.
///
/// This exists *inside* the loop rule, rather than relying on the generic
/// sequence rule to have already collapsed the body/redo chain, because the
/// sequence rule deliberately refuses to touch a multi-in-degree gateway
/// like `m` (the loop's own merge point) -- correctly so, since it cannot
/// tell a loop-merge apart from an ordinary not-yet-matched join. The loop
/// rule already knows exactly which shape it's looking for, so it does its
/// own walking instead.
fn walk_chain_to(work: &Work, start: u32, target: u32) -> Option<Vec<u32>> {
    let mut chain = Vec::new();
    let mut cur = start;
    let mut visited = std::collections::HashSet::new();
    loop {
        if cur == target {
            return Some(chain);
        }
        if !visited.insert(cur) {
            return None; // cycled back without ever reaching target
        }
        if work.kinds.contains_key(&cur) {
            return None; // an unresolved gateway mid-chain -- not ready yet
        }
        let outs = work.out_edges(cur);
        let ins = work.in_edges(cur);
        if outs.len() != 1 || ins.len() != 1 {
            return None;
        }
        chain.push(cur);
        cur = outs[0];
    }
}

fn chain_fragment(work: &Work, chain: &[u32]) -> Fragment {
    match chain {
        [] => Fragment::Leaf(None),
        [only] => work.fragments.get(only).unwrap().clone(),
        many => {
            let mut kids = Vec::new();
            for id in many {
                match work.fragments.get(id).unwrap().clone() {
                    Fragment::Sequence(v) => kids.extend(v),
                    other => kids.push(other),
                }
            }
            Fragment::Sequence(kids)
        }
    }
}

fn try_loop(work: &mut Work) -> bool {
    let ids: Vec<u32> = work.fragments.keys().copied().collect();
    for m in ids {
        if work.kinds.get(&m).copied() != Some(NodeKind::ExclusiveGateway) {
            continue;
        }
        let ins_m = work.in_edges(m);
        if ins_m.len() != 2 {
            continue;
        }
        let outs_m = work.out_edges(m);
        if outs_m.len() != 1 {
            continue;
        }

        // Walk the body forward from `m` until a fresh candidate split
        // `g2` (a distinct exclusive gateway, singly-fed) turns up.
        let mut body_chain = Vec::new();
        let mut cur = outs_m[0];
        let g2 = loop {
            if cur == m {
                break None;
            }
            if work.kinds.get(&cur).copied() == Some(NodeKind::ExclusiveGateway) && work.in_edges(cur).len() == 1 {
                break Some(cur);
            }
            let outs = work.out_edges(cur);
            let ins = work.in_edges(cur);
            if outs.len() != 1 || ins.len() != 1 {
                break None;
            }
            body_chain.push(cur);
            cur = outs[0];
        };
        let Some(g2) = g2 else { continue };

        let outs_g2 = work.out_edges(g2);
        if outs_g2.len() != 2 {
            continue;
        }
        // Exactly one of g2's two branches must walk back to `m`; the
        // other is the loop's own exit and is left untouched (the sequence
        // rule picks it up naturally once this loop node exists).
        let redo_chains: Vec<(u32, Vec<u32>)> =
            outs_g2.iter().filter_map(|&t| walk_chain_to(work, t, m).map(|c| (t, c))).collect();
        if redo_chains.len() != 1 {
            continue;
        }
        let (_redo_start, redo_chain) = &redo_chains[0];

        let body = chain_fragment(work, &body_chain);
        let redo = chain_fragment(work, redo_chain);
        let merged = Fragment::Loop { body: Box::new(body), redo: Box::new(redo) };

        let mut removed = vec![m, g2];
        removed.extend(body_chain.iter().copied());
        removed.extend(redo_chain.iter().copied());
        work.rewire_and_insert(&removed, merged);
        return true;
    }
    false
}

/// Converts a BPMN diagram to a `Fragment` tree, or reports the node ids
/// that could not be reduced. Requires exactly one start and one end event
/// -- a process tree (and this crate's Petri-net synthesis) has exactly one
/// implicit start/end by construction, so more than one of either is a hard
/// rejection here, not just a "not structured" flag.
pub fn structure(bpmn: &Bpmn) -> Result<Fragment, StructuringError> {
    let starts: Vec<_> = bpmn.nodes.iter().filter(|n| n.kind == NodeKind::StartEvent).collect();
    let ends: Vec<_> = bpmn.nodes.iter().filter(|n| n.kind == NodeKind::EndEvent).collect();
    if starts.len() != 1 {
        return Err(StructuringError { message: format!("{} start events; a process tree has exactly one", starts.len()) });
    }
    if ends.len() != 1 {
        return Err(StructuringError { message: format!("{} end events; a process tree has exactly one", ends.len()) });
    }
    let start_id = &starts[0].id;
    let end_id = &ends[0].id;

    let mut id_of: HashMap<&str, u32> = HashMap::new();
    let mut next_id = 0u32;
    for n in &bpmn.nodes {
        if n.id == *start_id || n.id == *end_id {
            continue;
        }
        id_of.insert(&n.id, next_id);
        next_id += 1;
    }
    let real_id_of = |id: &str| -> u32 {
        if id == start_id.as_str() {
            START_ID
        } else if id == end_id.as_str() {
            END_ID
        } else {
            id_of[id]
        }
    };

    let mut fragments = HashMap::new();
    let mut kinds = HashMap::new();
    for n in &bpmn.nodes {
        if n.id == *start_id || n.id == *end_id {
            continue; // kept only as edge-list sentinels -- never a reduction target
        }
        let id = id_of[n.id.as_str()];
        let frag = match n.kind {
            NodeKind::Task => Fragment::Leaf(n.label.clone()),
            _ => Fragment::Leaf(None), // an as-yet-unmatched gateway; its kind carries the real meaning
        };
        fragments.insert(id, frag);
        if n.kind.is_gateway() {
            kinds.insert(id, n.kind);
        }
    }

    let mut edges: Vec<(u32, u32)> =
        bpmn.flows.iter().map(|f| (real_id_of(&f.source), real_id_of(&f.target))).collect();
    edges.sort();
    edges.dedup();

    let mut work = Work { fragments, kinds, edges, next_id };

    loop {
        if work.fragments.len() == 1 {
            break;
        }
        if try_sequence(&mut work) {
            continue;
        }
        if try_gateway(&mut work) {
            continue;
        }
        if try_loop(&mut work) {
            continue;
        }
        let id_to_name: HashMap<u32, &str> = id_of.iter().map(|(&name, &id)| (id, name)).collect();
        let remaining: Vec<&str> = work.fragments.keys().filter_map(|id| id_to_name.get(id).copied()).collect();
        return Err(StructuringError {
            message: format!(
                "not block-structured: {} region(s) couldn't be reduced to a single block ({})",
                remaining.len(),
                remaining.join(", ")
            ),
        });
    }

    Ok(work.fragments.into_values().next().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Flow, Metadata, Node, SourceType};

    fn n(id: &str, kind: NodeKind, label: Option<&str>) -> Node {
        Node { id: id.into(), kind, label: label.map(String::from) }
    }
    fn f(id: &str, source: &str, target: &str) -> Flow {
        Flow { id: id.into(), source: source.into(), target: target.into(), label: None }
    }
    fn bpmn(nodes: Vec<Node>, flows: Vec<Flow>) -> Bpmn {
        Bpmn { nodes, flows, metadata: Metadata::clean(SourceType::Import) }
    }

    #[test]
    fn sequence_of_two_tasks() {
        let b = bpmn(
            vec![n("s", NodeKind::StartEvent, None), n("a", NodeKind::Task, Some("A")), n("b", NodeKind::Task, Some("B")), n("e", NodeKind::EndEvent, None)],
            vec![f("f1", "s", "a"), f("f2", "a", "b"), f("f3", "b", "e")],
        );
        let frag = structure(&b).ok().unwrap();
        assert_eq!(frag, Fragment::Sequence(vec![Fragment::Leaf(Some("A".into())), Fragment::Leaf(Some("B".into()))]));
    }

    #[test]
    fn xor_choice() {
        let b = bpmn(
            vec![
                n("s", NodeKind::StartEvent, None),
                n("g1", NodeKind::ExclusiveGateway, None),
                n("a", NodeKind::Task, Some("A")),
                n("b", NodeKind::Task, Some("B")),
                n("g2", NodeKind::ExclusiveGateway, None),
                n("e", NodeKind::EndEvent, None),
            ],
            vec![f("f1", "s", "g1"), f("f2", "g1", "a"), f("f3", "g1", "b"), f("f4", "a", "g2"), f("f5", "b", "g2"), f("f6", "g2", "e")],
        );
        let frag = structure(&b).ok().unwrap();
        match frag {
            Fragment::Xor(children) => {
                assert_eq!(children.len(), 2);
                assert!(children.contains(&Fragment::Leaf(Some("A".into()))));
                assert!(children.contains(&Fragment::Leaf(Some("B".into()))));
            }
            other => panic!("expected Xor, got {other:?}"),
        }
    }

    #[test]
    fn parallel_split_join() {
        let b = bpmn(
            vec![
                n("s", NodeKind::StartEvent, None),
                n("g1", NodeKind::ParallelGateway, None),
                n("a", NodeKind::Task, Some("A")),
                n("b", NodeKind::Task, Some("B")),
                n("g2", NodeKind::ParallelGateway, None),
                n("e", NodeKind::EndEvent, None),
            ],
            vec![f("f1", "s", "g1"), f("f2", "g1", "a"), f("f3", "g1", "b"), f("f4", "a", "g2"), f("f5", "b", "g2"), f("f6", "g2", "e")],
        );
        let frag = structure(&b).ok().unwrap();
        assert!(matches!(frag, Fragment::And(_)));
    }

    #[test]
    fn do_redo_loop() {
        // start -> g1(merge) -> A -> g2(split) -> {exit: end, redo: B -> back to g1}
        let b = bpmn(
            vec![
                n("s", NodeKind::StartEvent, None),
                n("g1", NodeKind::ExclusiveGateway, None),
                n("a", NodeKind::Task, Some("A")),
                n("g2", NodeKind::ExclusiveGateway, None),
                n("b", NodeKind::Task, Some("B")),
                n("e", NodeKind::EndEvent, None),
            ],
            vec![
                f("f1", "s", "g1"),
                f("f2", "g1", "a"),
                f("f3", "a", "g2"),
                f("f4", "g2", "e"),
                f("f5", "g2", "b"),
                f("f6", "b", "g1"),
            ],
        );
        let frag = structure(&b).ok().unwrap();
        match frag {
            Fragment::Loop { body, redo } => {
                assert_eq!(*body, Fragment::Leaf(Some("A".into())));
                assert_eq!(*redo, Fragment::Leaf(Some("B".into())));
            }
            other => panic!("expected Loop, got {other:?}"),
        }
    }

    #[test]
    fn self_loop_tau_redo() {
        let b = bpmn(
            vec![
                n("s", NodeKind::StartEvent, None),
                n("g1", NodeKind::ExclusiveGateway, None),
                n("a", NodeKind::Task, Some("A")),
                n("g2", NodeKind::ExclusiveGateway, None),
                n("e", NodeKind::EndEvent, None),
            ],
            vec![f("f1", "s", "g1"), f("f2", "g1", "a"), f("f3", "a", "g2"), f("f4", "g2", "e"), f("f5", "g2", "g1")],
        );
        let frag = structure(&b).ok().unwrap();
        match frag {
            Fragment::Loop { body, redo } => {
                assert_eq!(*body, Fragment::Leaf(Some("A".into())));
                assert_eq!(*redo, Fragment::Leaf(None));
            }
            other => panic!("expected Loop, got {other:?}"),
        }
    }

    #[test]
    fn xor_with_direct_tau_branch() {
        // xor(tau, A): the split connects straight to the join for the tau
        // branch -- exactly what `from_process_tree`'s `build_choice` emits.
        let b = bpmn(
            vec![n("s", NodeKind::StartEvent, None), n("g1", NodeKind::ExclusiveGateway, None), n("a", NodeKind::Task, Some("A")), n("g2", NodeKind::ExclusiveGateway, None), n("e", NodeKind::EndEvent, None)],
            vec![f("f1", "s", "g1"), f("f2", "g1", "a"), f("f3", "a", "g2"), f("f4", "g1", "g2"), f("f5", "g2", "e")],
        );
        let frag = structure(&b).ok().unwrap();
        match frag {
            Fragment::Xor(children) => {
                assert_eq!(children.len(), 2);
                assert!(children.contains(&Fragment::Leaf(None)));
                assert!(children.contains(&Fragment::Leaf(Some("A".into()))));
            }
            other => panic!("expected Xor, got {other:?}"),
        }
    }

    #[test]
    fn or_block() {
        let b = bpmn(
            vec![
                n("s", NodeKind::StartEvent, None),
                n("g1", NodeKind::InclusiveGateway, None),
                n("a", NodeKind::Task, Some("A")),
                n("b", NodeKind::Task, Some("B")),
                n("g2", NodeKind::InclusiveGateway, None),
                n("e", NodeKind::EndEvent, None),
            ],
            vec![f("f1", "s", "g1"), f("f2", "g1", "a"), f("f3", "g1", "b"), f("f4", "a", "g2"), f("f5", "b", "g2"), f("f6", "g2", "e")],
        );
        let frag = structure(&b).ok().unwrap();
        assert!(matches!(frag, Fragment::Or(_)));
    }

    #[test]
    fn loop_followed_by_more_sequence() {
        // start -> [loop: g1 -> A -> g2 -(redo B)-> g1, exit] -> C -> end
        let b = bpmn(
            vec![
                n("s", NodeKind::StartEvent, None),
                n("g1", NodeKind::ExclusiveGateway, None),
                n("a", NodeKind::Task, Some("A")),
                n("g2", NodeKind::ExclusiveGateway, None),
                n("b", NodeKind::Task, Some("B")),
                n("c", NodeKind::Task, Some("C")),
                n("e", NodeKind::EndEvent, None),
            ],
            vec![
                f("f1", "s", "g1"),
                f("f2", "g1", "a"),
                f("f3", "a", "g2"),
                f("f4", "g2", "c"),
                f("f5", "g2", "b"),
                f("f6", "b", "g1"),
                f("f7", "c", "e"),
            ],
        );
        let frag = structure(&b).ok().unwrap();
        match frag {
            Fragment::Sequence(kids) => {
                assert_eq!(kids.len(), 2);
                assert!(matches!(kids[0], Fragment::Loop { .. }));
                assert_eq!(kids[1], Fragment::Leaf(Some("C".into())));
            }
            other => panic!("expected Sequence(Loop, C), got {other:?}"),
        }
    }

    #[test]
    fn rejects_multiple_start_events() {
        let b = bpmn(
            vec![n("s1", NodeKind::StartEvent, None), n("s2", NodeKind::StartEvent, None), n("e", NodeKind::EndEvent, None)],
            vec![f("f1", "s1", "e"), f("f2", "s2", "e")],
        );
        let err = structure(&b).err().unwrap();
        assert!(err.message.contains("start events"));
    }

    #[test]
    fn rejects_rigid_graph() {
        // The classic non-structured "diamond with a crossing" -- two XOR
        // splits/joins whose branches interleave rather than nest.
        let b = bpmn(
            vec![
                n("s", NodeKind::StartEvent, None),
                n("g1", NodeKind::ExclusiveGateway, None),
                n("a", NodeKind::Task, Some("A")),
                n("b", NodeKind::Task, Some("B")),
                n("g2", NodeKind::ExclusiveGateway, None),
                n("c", NodeKind::Task, Some("C")),
                n("g3", NodeKind::ExclusiveGateway, None),
                n("e", NodeKind::EndEvent, None),
            ],
            vec![
                f("f1", "s", "g1"),
                f("f2", "g1", "a"),
                f("f3", "g1", "b"),
                f("f4", "a", "g2"),
                f("f5", "b", "g2"),
                f("f6", "g2", "c"),
                // A second path that bypasses `c`, breaking the clean nesting.
                f("f7", "b", "g3"),
                f("f8", "c", "g3"),
                f("f9", "g3", "e"),
            ],
        );
        let err = structure(&b).err().unwrap();
        assert!(err.message.contains("not block-structured"));
    }

    #[test]
    fn nested_sequence_inside_xor() {
        let b = bpmn(
            vec![
                n("s", NodeKind::StartEvent, None),
                n("g1", NodeKind::ExclusiveGateway, None),
                n("a", NodeKind::Task, Some("A")),
                n("b", NodeKind::Task, Some("B")),
                n("c", NodeKind::Task, Some("C")),
                n("g2", NodeKind::ExclusiveGateway, None),
                n("e", NodeKind::EndEvent, None),
            ],
            vec![
                f("f1", "s", "g1"),
                f("f2", "g1", "a"),
                f("f3", "a", "b"),
                f("f4", "g1", "c"),
                f("f5", "b", "g2"),
                f("f6", "c", "g2"),
                f("f7", "g2", "e"),
            ],
        );
        let frag = structure(&b).ok().unwrap();
        match frag {
            Fragment::Xor(children) => {
                assert!(children.contains(&Fragment::Sequence(vec![Fragment::Leaf(Some("A".into())), Fragment::Leaf(Some("B".into()))])));
                assert!(children.contains(&Fragment::Leaf(Some("C".into()))));
            }
            other => panic!("expected Xor, got {other:?}"),
        }
    }
}
