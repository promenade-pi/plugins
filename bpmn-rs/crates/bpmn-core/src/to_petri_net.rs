//! BPMN -> `AcceptingPetriNet`, via the block-structure decomposition in
//! `rpst.rs`. Solid for the same subset `rpst::structure` accepts (tasks,
//! single start/end, XOR/AND gateways, the canonical do-redo loop) --
//! classical block-structured Petri-net synthesis, one alternating
//! place/transition pattern per fragment kind. Rejects with a diagnostic
//! for anything else, including any inclusive (OR) gateway: even a
//! *structured* OR-split/join has no compact plain-Petri-net translation
//! (representing "any non-empty subset of these branches" needs either an
//! extended net class or an exponential blow-up in the number of branches),
//! so this is refused outright rather than approximated or left to blow up.
//!
//! Emits the "Inductive-Miner shape" of `AcceptingPetriNet`
//! (`app/src/ingest/pnml.ts`'s `AcceptingPetriNetResult` -- a `labels`
//! array makes it self-sufficient) so every existing consumer
//! (`alignment-rs`, `inductive-visual-miner`, `petrinet-layered`) reads it
//! unmodified.

use crate::rpst::{structure, Fragment};
use crate::{Bpmn, NodeKind};
use serde::Serialize;

#[derive(Serialize, Debug)]
pub struct Place {
    pub id: String,
    pub inputs: Vec<u32>,
    pub outputs: Vec<u32>,
    pub kind: &'static str,
}

#[derive(Serialize, Debug)]
pub struct Stats {
    pub places: usize,
    pub transitions: usize,
    pub arcs: usize,
    pub silent_transitions: usize,
}

#[derive(Serialize, Debug)]
pub struct PetriNetPayload {
    pub activities: Vec<u32>,
    pub labels: Vec<Option<String>>,
    pub places: Vec<Place>,
    pub place_to_transition: Vec<(u32, u32)>,
    pub transition_to_place: Vec<(u32, u32)>,
    pub initial_marking: Vec<u32>,
    pub final_marking: Vec<u32>,
    pub start_activities: Vec<u32>,
    pub end_activities: Vec<u32>,
    pub stats: Stats,
}

struct Ctx {
    next_place: u32,
    labels: Vec<Option<String>>,
    p2t: Vec<(u32, u32)>,
    t2p: Vec<(u32, u32)>,
}

impl Ctx {
    fn new_place(&mut self) -> u32 {
        let id = self.next_place;
        self.next_place += 1;
        id
    }
    fn new_trans(&mut self, label: Option<String>) -> u32 {
        let id = self.labels.len() as u32;
        self.labels.push(label);
        id
    }
}

/// Builds `fragment`'s net between an already-created `entry` and `exit`
/// place -- the Petri-net analogue of `from_process_tree.rs`'s
/// entry/exit-node fragment, just alternating place/transition instead of
/// a single BPMN node id per step.
fn build(ctx: &mut Ctx, fragment: &Fragment, entry: u32, exit: u32) {
    match fragment {
        Fragment::Leaf(label) => {
            let t = ctx.new_trans(label.clone());
            ctx.p2t.push((entry, t));
            ctx.t2p.push((t, exit));
        }
        Fragment::Sequence(kids) => {
            if kids.is_empty() {
                let t = ctx.new_trans(None);
                ctx.p2t.push((entry, t));
                ctx.t2p.push((t, exit));
                return;
            }
            let mut cur = entry;
            for (i, k) in kids.iter().enumerate() {
                let next = if i + 1 == kids.len() { exit } else { ctx.new_place() };
                build(ctx, k, cur, next);
                cur = next;
            }
        }
        Fragment::Xor(kids) => {
            // Every branch shares the same entry/exit place directly -- the
            // classical free-choice XOR: whichever branch's transition
            // fires first consumes the shared entry token.
            for k in kids {
                build(ctx, k, entry, exit);
            }
        }
        Fragment::And(kids) => {
            let split = ctx.new_trans(None);
            ctx.p2t.push((entry, split));
            let join = ctx.new_trans(None);
            ctx.t2p.push((join, exit));
            for k in kids {
                let p_in = ctx.new_place();
                let p_out = ctx.new_place();
                ctx.t2p.push((split, p_in));
                build(ctx, k, p_in, p_out);
                ctx.p2t.push((p_out, join));
            }
        }
        Fragment::Or(_) => unreachable!("to_petri_net rejects any OR gateway before structuring"),
        Fragment::Loop { body, redo } => {
            let mid = ctx.new_place();
            build(ctx, body, entry, mid);
            // The choice at `mid`: leave (a silent transition to `exit`) or
            // redo (back into `entry`, re-entering the loop) -- another
            // free-choice XOR, this one place-level rather than declared.
            let leave = ctx.new_trans(None);
            ctx.p2t.push((mid, leave));
            ctx.t2p.push((leave, exit));
            build(ctx, redo, mid, entry);
        }
    }
}

pub fn to_petri_net(bpmn: &Bpmn) -> Result<PetriNetPayload, String> {
    let inclusive: Vec<&str> = bpmn
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::InclusiveGateway)
        .map(|n| n.id.as_str())
        .collect();
    if !inclusive.is_empty() {
        // Deliberately not applied here. `or_join::replace` changes what the
        // diagram *is* — it adds gateways — so doing it silently inside a
        // conversion would hand back a Petri net for a model the caller never
        // saw. Run it as its own step, look at what it did, then convert that.
        return Err(format!(
            "inclusive (OR) gateway{} {} {} no compact Petri net translation. Run \"Replace OR-joins\" first: it rewrites every inclusive join it can prove equivalent to a combination of exclusive and parallel gateways, and tells you about any it cannot",
            if inclusive.len() == 1 { "" } else { "s" },
            inclusive.join(", "),
            if inclusive.len() == 1 { "has" } else { "have" },
        ));
    }
    // The block-structured synthesis produces the smaller net, so it is still
    // what gets tried; but a model that does not nest is not a model that
    // cannot be converted, it just needs the mapping that needs no structure.
    let fragment = match structure(bpmn) {
        Ok(fragment) => fragment,
        Err(_) => return crate::to_petri_net_direct::to_petri_net_direct(bpmn),
    };

    let mut ctx = Ctx { next_place: 0, labels: Vec::new(), p2t: Vec::new(), t2p: Vec::new() };
    let entry = ctx.new_place();
    let exit = ctx.new_place();
    build(&mut ctx, &fragment, entry, exit);

    // A workflow net's source place has no incoming arc and its sink no
    // outgoing one — that is the definition, and every soundness statement
    // rests on it. The synthesis above can break it in one case: a *loop at
    // the root* closes back onto the place it started from, so the place the
    // case begins in is also the place the loop returns to. The model is
    // fine; the net's entry point is no longer unambiguous, and a checker is
    // right to refuse it (this is what `SND`/`WF-SOURCE` reports).
    //
    // The textbook construction avoids it by always bracketing the body with
    // a silent transition at each end. Doing that only when it is needed
    // keeps every other net exactly as small as it was, and a discovered
    // model with a loop at the root — the Inductive Miner's flower model is
    // one — converts to a proper workflow net instead of an unsound-looking
    // one.
    let mut source = entry;
    if ctx.t2p.iter().any(|&(_, p)| p == entry) {
        let place = ctx.new_place();
        let begin = ctx.new_trans(None);
        ctx.p2t.push((place, begin));
        ctx.t2p.push((begin, entry));
        source = place;
    }
    let mut sink = exit;
    if ctx.p2t.iter().any(|&(p, _)| p == exit) {
        let place = ctx.new_place();
        let end = ctx.new_trans(None);
        ctx.p2t.push((exit, end));
        ctx.t2p.push((end, place));
        sink = place;
    }

    let place_count = ctx.next_place;
    let mut place_inputs = vec![Vec::new(); place_count as usize];
    let mut place_outputs = vec![Vec::new(); place_count as usize];
    for &(t, p) in &ctx.t2p {
        place_inputs[p as usize].push(t);
    }
    for &(p, t) in &ctx.p2t {
        place_outputs[p as usize].push(t);
    }
    let places: Vec<Place> = (0..place_count)
        .map(|p| Place {
            id: format!("p{p}"),
            inputs: place_inputs[p as usize].clone(),
            outputs: place_outputs[p as usize].clone(),
            kind: if p == source { "initial" } else if p == sink { "final" } else { "derived" },
        })
        .collect();

    let activities: Vec<u32> = (0..ctx.labels.len() as u32).collect();
    let mut start_activities: Vec<u32> = ctx.p2t.iter().filter(|&&(p, _)| p == source).map(|&(_, t)| t).collect();
    start_activities.sort();
    start_activities.dedup();
    let mut end_activities: Vec<u32> = ctx.t2p.iter().filter(|&&(_, p)| p == sink).map(|&(t, _)| t).collect();
    end_activities.sort();
    end_activities.dedup();

    let silent_transitions = ctx.labels.iter().filter(|l| l.is_none()).count();
    let stats = Stats { places: place_count as usize, transitions: ctx.labels.len(), arcs: ctx.p2t.len() + ctx.t2p.len(), silent_transitions };

    Ok(PetriNetPayload {
        activities,
        labels: ctx.labels,
        places,
        place_to_transition: ctx.p2t,
        transition_to_place: ctx.t2p,
        initial_marking: vec![source],
        final_marking: vec![sink],
        start_activities,
        end_activities,
        stats,
    })
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

    /// A plain Petri net simulator: fires a workflow net from its initial
    /// marking, exploring every enabled transition, and checks the given
    /// activity-label sequence is a reachable firing sequence ending in the
    /// final marking. Used to check semantic behaviour, not just shape.
    fn accepts_trace(net: &PetriNetPayload, trace: &[&str]) -> bool {
        use std::collections::HashMap as Map;
        let label_of = |t: u32| net.labels[t as usize].clone();
        let mut markings: Vec<Map<u32, u32>> = vec![{
            let mut m = Map::new();
            m.insert(net.initial_marking[0], 1);
            m
        }];
        for &want in trace {
            let mut next_markings = Vec::new();
            for marking in &markings {
                // Fire zero or more silent transitions, then exactly one
                // transition labelled `want`, closing over silents again.
                let mut frontier = vec![marking.clone()];
                let mut seen_silent_closure = Vec::new();
                while let Some(m) = frontier.pop() {
                    seen_silent_closure.push(m.clone());
                    for &(p, t) in &net.p2t_enabled(&m) {
                        if label_of(t).is_none() {
                            let mut m2 = m.clone();
                            fire(net, &mut m2, p, t);
                            frontier.push(m2);
                        }
                    }
                }
                for m in seen_silent_closure {
                    for &(p, t) in &net.p2t_enabled(&m) {
                        if label_of(t).as_deref() == Some(want) {
                            let mut m2 = m.clone();
                            fire(net, &mut m2, p, t);
                            next_markings.push(m2);
                        }
                    }
                }
            }
            next_markings.sort_by_key(|m| { let mut v: Vec<_> = m.iter().collect(); v.sort(); format!("{v:?}") });
            next_markings.dedup_by_key(|m| { let mut v: Vec<_> = m.iter().collect(); v.sort(); format!("{v:?}") });
            if next_markings.is_empty() {
                return false;
            }
            markings = next_markings;
        }
        // Close over trailing silents, then check the final marking is reachable.
        let mut frontier = markings;
        let mut all = Vec::new();
        while let Some(m) = frontier.pop() {
            all.push(m.clone());
            for &(p, t) in &net.p2t_enabled(&m) {
                if label_of(t).is_none() {
                    let mut m2 = m.clone();
                    fire(net, &mut m2, p, t);
                    frontier.push(m2);
                }
            }
        }
        all.iter().any(|m| m.get(&net.final_marking[0]).copied().unwrap_or(0) >= 1 && m.values().filter(|&&c| c > 0).count() == 1)
    }

    trait EnabledExt {
        fn p2t_enabled(&self, marking: &std::collections::HashMap<u32, u32>) -> Vec<(u32, u32)>;
    }
    impl EnabledExt for PetriNetPayload {
        fn p2t_enabled(&self, marking: &std::collections::HashMap<u32, u32>) -> Vec<(u32, u32)> {
            self.place_to_transition.iter().filter(|&&(p, _)| marking.get(&p).copied().unwrap_or(0) >= 1).copied().collect()
        }
    }
    fn fire(net: &PetriNetPayload, marking: &mut std::collections::HashMap<u32, u32>, p: u32, t: u32) {
        *marking.entry(p).or_insert(0) -= 1;
        if marking[&p] == 0 {
            marking.remove(&p);
        }
        for &(tt, pp) in &net.transition_to_place {
            if tt == t {
                *marking.entry(pp).or_insert(0) += 1;
            }
        }
    }

    #[test]
    fn simple_sequence_behaves() {
        let b = bpmn(
            vec![n("s", NodeKind::StartEvent, None), n("a", NodeKind::Task, Some("A")), n("b", NodeKind::Task, Some("B")), n("e", NodeKind::EndEvent, None)],
            vec![f("f1", "s", "a"), f("f2", "a", "b"), f("f3", "b", "e")],
        );
        let net = to_petri_net(&b).unwrap();
        assert!(accepts_trace(&net, &["A", "B"]));
        assert!(!accepts_trace(&net, &["B", "A"]));
    }

    #[test]
    fn xor_behaves() {
        let b = bpmn(
            vec![
                n("s", NodeKind::StartEvent, None), n("g1", NodeKind::ExclusiveGateway, None),
                n("a", NodeKind::Task, Some("A")), n("b", NodeKind::Task, Some("B")),
                n("g2", NodeKind::ExclusiveGateway, None), n("e", NodeKind::EndEvent, None),
            ],
            vec![f("f1", "s", "g1"), f("f2", "g1", "a"), f("f3", "g1", "b"), f("f4", "a", "g2"), f("f5", "b", "g2"), f("f6", "g2", "e")],
        );
        let net = to_petri_net(&b).unwrap();
        assert!(accepts_trace(&net, &["A"]));
        assert!(accepts_trace(&net, &["B"]));
        assert!(!accepts_trace(&net, &["A", "B"]));
    }

    #[test]
    fn parallel_behaves() {
        let b = bpmn(
            vec![
                n("s", NodeKind::StartEvent, None), n("g1", NodeKind::ParallelGateway, None),
                n("a", NodeKind::Task, Some("A")), n("b", NodeKind::Task, Some("B")),
                n("g2", NodeKind::ParallelGateway, None), n("e", NodeKind::EndEvent, None),
            ],
            vec![f("f1", "s", "g1"), f("f2", "g1", "a"), f("f3", "g1", "b"), f("f4", "a", "g2"), f("f5", "b", "g2"), f("f6", "g2", "e")],
        );
        let net = to_petri_net(&b).unwrap();
        assert!(accepts_trace(&net, &["A", "B"]));
        assert!(accepts_trace(&net, &["B", "A"]));
        assert!(!accepts_trace(&net, &["A"]));
    }

    #[test]
    fn loop_behaves() {
        let b = bpmn(
            vec![
                n("s", NodeKind::StartEvent, None), n("g1", NodeKind::ExclusiveGateway, None),
                n("a", NodeKind::Task, Some("A")), n("g2", NodeKind::ExclusiveGateway, None),
                n("b", NodeKind::Task, Some("B")), n("e", NodeKind::EndEvent, None),
            ],
            vec![f("f1", "s", "g1"), f("f2", "g1", "a"), f("f3", "a", "g2"), f("f4", "g2", "e"), f("f5", "g2", "b"), f("f6", "b", "g1")],
        );
        let net = to_petri_net(&b).unwrap();
        assert!(accepts_trace(&net, &["A"]));
        assert!(accepts_trace(&net, &["A", "B", "A"]));
        assert!(accepts_trace(&net, &["A", "B", "A", "B", "A"]));
        assert!(!accepts_trace(&net, &["A", "B"])); // must end right after an A, not a B
    }

    /// A loop at the root closes back onto the place the case started in.
    /// The synthesis has to bracket it, or the initial place ends up with
    /// incoming arcs and the result is not a workflow net at all — every
    /// soundness statement about it would then be about something else.
    #[test]
    fn a_loop_at_the_root_still_gives_a_workflow_net() {
        // start -> x1 -> A -> x2 -{redo}-> x1, x2 -> end: the canonical
        // do-redo loop with nothing around it.
        let b = bpmn(
            vec![
                n("s", NodeKind::StartEvent, None), n("x1", NodeKind::ExclusiveGateway, None),
                n("a", NodeKind::Task, Some("A")), n("x2", NodeKind::ExclusiveGateway, None),
                n("r", NodeKind::Task, Some("R")), n("e", NodeKind::EndEvent, None),
            ],
            vec![
                f("f1", "s", "x1"), f("f2", "x1", "a"), f("f3", "a", "x2"),
                f("f4", "x2", "r"), f("f5", "r", "x1"), f("f6", "x2", "e"),
            ],
        );
        let net = to_petri_net(&b).unwrap();

        let initial = net.initial_marking[0];
        let source = net.places.iter().find(|p| p.id == format!("p{initial}")).unwrap();
        assert!(source.inputs.is_empty(), "the source place must have no incoming arc");
        assert!(net.transition_to_place.iter().all(|&(_, p)| p != initial));

        let final_place = net.final_marking[0];
        let sink = net.places.iter().find(|p| p.id == format!("p{final_place}")).unwrap();
        assert!(sink.outputs.is_empty(), "the sink place must have no outgoing arc");

        // And the behaviour is untouched: one or more A, each followed by an
        // optional R that returns to the start of the loop.
        assert!(accepts_trace(&net, &["A"]));
        assert!(accepts_trace(&net, &["A", "R", "A"]));
        assert!(!accepts_trace(&net, &["A", "R"]));
    }

    /// The bracketing is only added where it is needed, so every net that was
    /// already a workflow net stays exactly the size it was.
    #[test]
    fn a_net_that_needs_no_bracketing_gains_nothing() {
        let b = bpmn(
            vec![
                n("s", NodeKind::StartEvent, None), n("a", NodeKind::Task, Some("A")),
                n("e", NodeKind::EndEvent, None),
            ],
            vec![f("f1", "s", "a"), f("f2", "a", "e")],
        );
        let net = to_petri_net(&b).unwrap();
        assert_eq!(net.stats.places, 2);
        assert_eq!(net.stats.transitions, 1);
        assert_eq!(net.stats.silent_transitions, 0);
    }

    #[test]
    fn rejects_inclusive_gateway() {
        let b = bpmn(
            vec![
                n("s", NodeKind::StartEvent, None), n("g1", NodeKind::InclusiveGateway, None),
                n("a", NodeKind::Task, Some("A")), n("g2", NodeKind::InclusiveGateway, None),
                n("e", NodeKind::EndEvent, None),
            ],
            vec![f("f1", "s", "g1"), f("f2", "g1", "a"), f("f3", "a", "g2"), f("f4", "g2", "e")],
        );
        let err = to_petri_net(&b).unwrap_err();
        assert!(err.contains("g1"));
        assert!(err.contains("OR"));
    }
}
