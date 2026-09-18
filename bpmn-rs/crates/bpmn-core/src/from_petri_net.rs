//! Petri net (`AcceptingPetriNet`) -> BPMN.
//!
//! Solid for a sound, free-choice workflow net (single source place, single
//! sink place, every transition on a start->end path); degrades to a
//! flagged, still-valid, behavior-preserving translation otherwise — never
//! rejects, per the literature (Kalenkova et al.) and this plugin's own
//! research pass. What this crate actually checks, precisely stated: the
//! **structural** WF-net shape (exactly one source place, one sink place)
//! and the **free-choice** property (no place's outgoing-transition set
//! partially overlaps another's — either disjoint or identical). This is
//! *not* full soundness verification (option-to-complete, proper
//! completion, no dead transitions all require reachability-graph analysis,
//! a separate, much larger undertaking) — it is the structural proxy this
//! algorithm actually needs, because the same construction below runs
//! either way and only the confidence in calling its output "clean" changes.
//!
//! # The construction
//!
//! Every place and every transition resolves to zero, one, or two BPMN
//! nodes, via the same single-entry/single-exit `Option<(entry, exit)>`
//! fragment shape `from_process_tree.rs` uses:
//!
//! - A **place** becomes `None` (a bare wire, elided) when it is internal
//!   (not the net's source or sink) and has exactly one incoming and one
//!   outgoing arc — pure structural padding, not a real routing decision.
//!   Otherwise: a `startEvent`/`endEvent` for the true source/sink, plus an
//!   `exclusiveGateway` when it also needs to fan in (>1 incoming) and/or
//!   fan out (>1 outgoing) — a place is a *choice* point, so XOR.
//! - A **transition** becomes `None` (elided) when it is silent (no
//!   activity label) with exactly one incoming and one outgoing arc.
//!   Otherwise: a `task` when labelled, plus a `parallelGateway` when it
//!   also needs to synchronize (>1 incoming, an AND-join — firing needs a
//!   token in *every* input place) and/or fan out (>1 outgoing, an
//!   AND-split — firing produces a token in *every* output place).
//!
//! Wiring then walks every original arc, chasing forward through any
//! elided (pass-through) node to the next real materialized entry —
//! exactly the same "skip tau, connect its neighbours directly" idea
//! `from_process_tree.rs` uses for a tau leaf, just walked over arcs
//! instead of over tree children.

use crate::petri_net::{normalize, NormalizedPetriNet, RawAcceptingPetriNet};
use crate::{Bpmn, Metadata, Node, NodeKind, SourceType};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Ref {
    Place(usize),
    Transition(usize),
}

struct Net {
    n: NormalizedPetriNet,
    /// place -> transitions it feeds (place_to_transition, grouped).
    place_out: Vec<Vec<usize>>,
    /// place -> transitions feeding it (transition_to_place, grouped by place).
    place_in: Vec<Vec<usize>>,
    /// transition -> places it feeds.
    trans_out: Vec<Vec<usize>>,
    /// transition -> places feeding it.
    trans_in: Vec<Vec<usize>>,
}

impl Net {
    fn from_normalized(n: NormalizedPetriNet) -> Self {
        let transition_count = n.transition_labels.len();
        let mut place_out = vec![Vec::new(); n.place_count];
        let mut trans_in = vec![Vec::new(); transition_count];
        for &(p, t) in &n.place_to_transition {
            place_out[p].push(t);
            trans_in[t].push(p);
        }
        let mut trans_out = vec![Vec::new(); transition_count];
        let mut place_in = vec![Vec::new(); n.place_count];
        for &(t, p) in &n.transition_to_place {
            trans_out[t].push(p);
            place_in[p].push(t);
        }
        Net { n, place_out, place_in, trans_out, trans_in }
    }

    fn transition_count(&self) -> usize {
        self.n.transition_labels.len()
    }

    fn successors(&self, r: Ref) -> Vec<Ref> {
        match r {
            Ref::Place(p) => self.place_out[p].iter().map(|&t| Ref::Transition(t)).collect(),
            Ref::Transition(t) => self.trans_out[t].iter().map(|&p| Ref::Place(p)).collect(),
        }
    }
}

/// The free-choice property: for every two places, their sets of outgoing
/// transitions are either disjoint or identical. A place with >1 outgoing
/// transitions is only a *clean* XOR-split when nothing else entangles
/// those same transitions with a different input set.
fn is_free_choice(net: &Net) -> bool {
    let sets: Vec<HashSet<usize>> = net.place_out.iter().map(|v| v.iter().copied().collect()).collect();
    for i in 0..sets.len() {
        for j in (i + 1)..sets.len() {
            if sets[i].is_empty() || sets[j].is_empty() {
                continue;
            }
            let shares_any = sets[i].intersection(&sets[j]).next().is_some();
            if shares_any && sets[i] != sets[j] {
                return false;
            }
        }
    }
    true
}

struct Ctx {
    nodes: Vec<Node>,
    flows: Vec<crate::Flow>,
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

    fn connect(&mut self, source: &str, target: &str) {
        let key = (source.to_string(), target.to_string());
        if self.flow_keys.contains(&key) {
            return;
        }
        self.flow_keys.insert(key.clone());
        let id = format!("f{}", self.next_flow);
        self.next_flow += 1;
        self.flows.push(crate::Flow { id, source: key.0, target: key.1, label: None });
    }
}

type Fragment = Option<(String, String)>;

fn resolve_place(net: &Net, p: usize, ctx: &mut Ctx) -> Fragment {
    let in_deg = net.place_in[p].len();
    let out_deg = net.place_out[p].len();
    let is_source = in_deg == 0;
    let is_sink = out_deg == 0;

    if !is_source && !is_sink && in_deg <= 1 && out_deg <= 1 {
        return None; // pure wire between two transitions
    }

    let mut chain: Vec<String> = Vec::new();
    if is_source {
        chain.push(ctx.new_node(NodeKind::StartEvent, None));
    } else if in_deg > 1 {
        chain.push(ctx.new_node(NodeKind::ExclusiveGateway, None));
    }
    if is_sink {
        chain.push(ctx.new_node(NodeKind::EndEvent, None));
    } else if out_deg > 1 {
        chain.push(ctx.new_node(NodeKind::ExclusiveGateway, None));
    }
    if chain.is_empty() {
        // Internal place, in_deg<=1 and out_deg<=1 already excluded above,
        // so this is unreachable; kept only for defensive symmetry with
        // resolve_transition.
        chain.push(ctx.new_node(NodeKind::ExclusiveGateway, None));
    }
    for w in chain.windows(2) {
        ctx.connect(&w[0], &w[1]);
    }
    Some((chain.first().unwrap().clone(), chain.last().unwrap().clone()))
}

fn resolve_transition(net: &Net, t: usize, ctx: &mut Ctx) -> Fragment {
    let in_deg = net.trans_in[t].len();
    let out_deg = net.trans_out[t].len();
    let label = net.n.transition_labels[t].clone();

    if label.is_none() && in_deg <= 1 && out_deg <= 1 {
        return None; // silent, no synchronization role: pure pass-through
    }

    let mut chain: Vec<String> = Vec::new();
    if in_deg > 1 {
        chain.push(ctx.new_node(NodeKind::ParallelGateway, None));
    }
    if let Some(l) = label {
        chain.push(ctx.new_node(NodeKind::Task, Some(l)));
    }
    if out_deg > 1 {
        chain.push(ctx.new_node(NodeKind::ParallelGateway, None));
    }
    for w in chain.windows(2) {
        ctx.connect(&w[0], &w[1]);
    }
    Some((chain.first().unwrap().clone(), chain.last().unwrap().clone()))
}

fn resolve(net: &Net, r: Ref, ctx: &mut Ctx, cache: &mut HashMap<Ref, Fragment>) -> Fragment {
    if let Some(v) = cache.get(&r) {
        return v.clone();
    }
    let v = match r {
        Ref::Place(p) => resolve_place(net, p, ctx),
        Ref::Transition(t) => resolve_transition(net, t, ctx),
    };
    cache.insert(r, v.clone());
    v
}

/// Chases forward through elided (pass-through) nodes to the next real
/// entry, following the single arc a pass-through node always has out
/// (guarded against a cycle made entirely of pass-through nodes, which a
/// well-formed WF-net cannot contain but a malformed one might).
fn next_materialized_entry(
    net: &Net,
    from: Ref,
    ctx: &mut Ctx,
    cache: &mut HashMap<Ref, Fragment>,
    visited: &mut HashSet<Ref>,
) -> Result<String, String> {
    if !visited.insert(from) {
        return Err("net contains a cycle of unlabelled, single-in/single-out nodes with no start or end in it".into());
    }
    match resolve(net, from, ctx, cache) {
        Some((entry, _)) => Ok(entry),
        None => {
            let succs = net.successors(from);
            let succ = succs.first().copied().ok_or_else(|| {
                "internal error: a pass-through node has no successor".to_string()
            })?;
            next_materialized_entry(net, succ, ctx, cache, visited)
        }
    }
}

pub fn from_petri_net(raw: RawAcceptingPetriNet) -> Result<Bpmn, String> {
    let normalized = normalize(raw);
    let mut warnings = normalized.warnings.clone();
    let net = Net::from_normalized(normalized);

    let source_places: Vec<usize> = (0..net.n.place_count).filter(|&p| net.place_in[p].is_empty()).collect();
    let sink_places: Vec<usize> = (0..net.n.place_count).filter(|&p| net.place_out[p].is_empty()).collect();
    if source_places.is_empty() {
        return Err("net has no source place (every place has an incoming arc) -- nothing to anchor a start event to".into());
    }
    if sink_places.is_empty() {
        return Err("net has no sink place (every place has an outgoing arc) -- nothing to anchor an end event to".into());
    }

    let free_choice = is_free_choice(&net);
    let mut structured = true;
    if source_places.len() != 1 {
        structured = false;
        warnings.push(format!("{} source places, not a single-entry workflow net", source_places.len()));
    }
    if sink_places.len() != 1 {
        structured = false;
        warnings.push(format!("{} sink places, not a single-exit workflow net", sink_places.len()));
    }
    if !free_choice {
        structured = false;
        warnings.push("not free-choice: some place's outgoing transitions overlap another's without matching exactly".into());
    }

    let mut ctx = Ctx { nodes: Vec::new(), flows: Vec::new(), flow_keys: HashSet::new(), next_node: 0, next_flow: 0 };
    let mut cache: HashMap<Ref, Fragment> = HashMap::new();

    let all_refs: Vec<Ref> = (0..net.n.place_count)
        .map(Ref::Place)
        .chain((0..net.transition_count()).map(Ref::Transition))
        .collect();

    // Materialize every node first (order doesn't matter -- resolve() is memoized).
    for &r in &all_refs {
        resolve(&net, r, &mut ctx, &mut cache);
    }

    for &r in &all_refs {
        let exit = match cache.get(&r).cloned().flatten() {
            Some((_, exit)) => exit,
            None => continue,
        };
        for succ in net.successors(r) {
            let entry = match cache.get(&succ).cloned().flatten() {
                Some((entry, _)) => entry,
                None => {
                    let mut visited = HashSet::new();
                    next_materialized_entry(&net, succ, &mut ctx, &mut cache, &mut visited)?
                }
            };
            ctx.connect(&exit, &entry);
        }
    }

    let bpmn = Bpmn {
        nodes: ctx.nodes,
        flows: ctx.flows,
        metadata: Metadata { source_type: Some(SourceType::AcceptingPetriNet), structured, warnings },
    };
    bpmn.validate()?;
    Ok(bpmn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn net(
        place_count: usize,
        labels: Vec<Option<&str>>,
        p2t: Vec<(i64, i64)>,
        t2p: Vec<(i64, i64)>,
    ) -> RawAcceptingPetriNet {
        RawAcceptingPetriNet {
            places: (0..place_count).map(|_| serde::de::IgnoredAny).collect(),
            activities: (0..labels.len() as i64).collect(),
            labels: Some(labels.into_iter().map(|l| l.map(String::from)).collect()),
            place_to_transition: p2t,
            transition_to_place: t2p,
        }
    }

    fn count(bpmn: &Bpmn, kind: NodeKind) -> usize {
        bpmn.nodes.iter().filter(|n| n.kind == kind).count()
    }

    #[test]
    fn simple_sequence() {
        // p0 -[t0:A]-> p1 -[t1:B]-> p2
        let raw = net(3, vec![Some("A"), Some("B")], vec![(0, 0), (1, 1)], vec![(0, 1), (1, 2)]);
        let bpmn = from_petri_net(raw).unwrap();
        assert_eq!(count(&bpmn, NodeKind::Task), 2);
        assert_eq!(count(&bpmn, NodeKind::StartEvent), 1);
        assert_eq!(count(&bpmn, NodeKind::EndEvent), 1);
        assert_eq!(bpmn.nodes.len(), 4); // p1 elided (in1,out1)
        assert!(bpmn.metadata.structured);
    }

    #[test]
    fn xor_choice_free_choice() {
        // p0 -[t0:A]-> p1(sink), p0 -[t1:B]-> p1
        let raw = net(2, vec![Some("A"), Some("B")], vec![(0, 0), (0, 1)], vec![(0, 1), (1, 1)]);
        let bpmn = from_petri_net(raw).unwrap();
        assert_eq!(count(&bpmn, NodeKind::ExclusiveGateway), 2); // split at p0, join at p1
        assert_eq!(count(&bpmn, NodeKind::Task), 2);
        assert!(bpmn.metadata.structured);
        bpmn.validate().unwrap();
    }

    #[test]
    fn silent_pass_through_is_elided() {
        // p0 -[t0:silent]-> p1(sink)
        let raw = net(2, vec![None], vec![(0, 0)], vec![(0, 1)]);
        let bpmn = from_petri_net(raw).unwrap();
        assert_eq!(bpmn.nodes.len(), 2); // just start, end
        assert_eq!(bpmn.flows.len(), 1);
    }

    #[test]
    fn silent_and_split_join() {
        // p0 -[t0:A]-> p1 -[t1:silent]-> {p2 -[t2:B]-> p4(sink), p3 -[t3:C]-> p4}
        // t1 is silent with out_deg 2 -> AND-split.
        let raw = net(
            5,
            vec![Some("A"), None, Some("B"), Some("C")],
            vec![(0, 0), (1, 1), (2, 2), (3, 3)],
            vec![(0, 1), (1, 2), (1, 3), (2, 4), (3, 4)],
        );
        let bpmn = from_petri_net(raw).unwrap();
        assert_eq!(count(&bpmn, NodeKind::ParallelGateway), 1); // the AND-split; no AND-join needed (p4 is XOR since it's a place)
        assert_eq!(count(&bpmn, NodeKind::Task), 3);
        bpmn.validate().unwrap();
    }

    #[test]
    fn not_free_choice_still_converts_but_flagged() {
        // p0(source) -> {t0:A, t1:B}; p1(source) -> {t1:B, t2:C}: t1 shared
        // between p0's and p1's outgoing sets, but the sets differ ({t0,t1}
        // vs {t1,t2}) -> not free-choice. p3, p4 are the sinks.
        let raw = RawAcceptingPetriNet {
            places: vec![serde::de::IgnoredAny; 5],
            activities: vec![0, 1, 2],
            labels: Some(vec![Some("A".into()), Some("B".into()), Some("C".into())]),
            place_to_transition: vec![(0, 0), (0, 1), (1, 1), (1, 2)],
            transition_to_place: vec![(0, 3), (1, 3), (2, 4)],
        };
        let bpmn = from_petri_net(raw).unwrap();
        assert!(!bpmn.metadata.structured);
        assert!(bpmn.metadata.warnings.iter().any(|w| w.contains("free-choice")));
        bpmn.validate().unwrap();
    }

    #[test]
    fn multiple_sinks_flagged_not_structured_but_valid() {
        let raw = net(3, vec![Some("A"), Some("B")], vec![(0, 0), (0, 1)], vec![(0, 1), (1, 2)]);
        let bpmn = from_petri_net(raw).unwrap();
        assert!(!bpmn.metadata.structured); // two sink places: p1 and p2
        assert_eq!(count(&bpmn, NodeKind::EndEvent), 2);
        bpmn.validate().unwrap();
    }

    #[test]
    fn alpha_miner_shape_labels_by_id_with_warning() {
        let raw = RawAcceptingPetriNet {
            places: vec![serde::de::IgnoredAny, serde::de::IgnoredAny],
            activities: vec![9],
            labels: None,
            place_to_transition: vec![(0, 9)],
            transition_to_place: vec![(9, 1)],
        };
        let bpmn = from_petri_net(raw).unwrap();
        assert!(bpmn.nodes.iter().any(|n| n.label.as_deref() == Some("#9")));
        assert_eq!(bpmn.metadata.warnings.len(), 1);
    }

    #[test]
    fn rejects_net_with_no_source_place() {
        // A single place with a self-loop transition and no true source.
        let raw = net(1, vec![Some("A")], vec![(0, 0)], vec![(0, 0)]);
        let err = from_petri_net(raw).unwrap_err();
        assert!(err.contains("no source place"));
    }
}
