//! BPMN -> `AcceptingPetriNet` for a diagram that does **not** nest.
//!
//! The block-structured synthesis in `to_petri_net.rs` builds a small net by
//! recursing through a fragment tree, and refuses anything that has no such
//! tree. That refusal covers every model a miner that is not restricted to
//! block-structured output produces — which is most of them, and all the
//! interesting ones.
//!
//! This is the other standard mapping, the one that needs no structure at all:
//!
//! > Dijkman, R., Dumas, M. & Ouyang, C. (2008). *Semantics and analysis of
//! > business process models in BPMN.* Information and Software Technology
//! > 50(12), 1281–1294.
//!
//! — reference [18] of the Split Miner paper, for exactly this reason. It is a
//! direct, local transliteration:
//!
//! | BPMN | Petri net |
//! |---|---|
//! | each sequence flow | one place |
//! | a task | one transition, from its incoming place to its outgoing place |
//! | a parallel gateway | one transition, consuming *all* its input places and producing *all* its output places |
//! | an exclusive gateway | one silent transition per input/output pair — the choice is the choice of transition |
//! | the start event's outgoing flow | the initial marking |
//! | the end event's incoming flow | the final marking |
//!
//! The result is larger than the block-structured synthesis would produce on a
//! model where both apply — a place per flow rather than per block — so the
//! nicer one is still tried first. It is equivalent, and it always exists.

use crate::to_petri_net::{PetriNetPayload, Place, Stats};
use crate::{Bpmn, NodeKind};
use std::collections::HashMap;

struct Net {
    labels: Vec<Option<String>>,
    p2t: Vec<(u32, u32)>,
    t2p: Vec<(u32, u32)>,
}

impl Net {
    /// One transition consuming every place in `inputs` and producing every
    /// place in `outputs`.
    fn transition(&mut self, label: Option<String>, inputs: &[u32], outputs: &[u32]) {
        let id = self.labels.len() as u32;
        self.labels.push(label);
        for &place in inputs {
            self.p2t.push((place, id));
        }
        for &place in outputs {
            self.t2p.push((id, place));
        }
    }
}

pub fn to_petri_net_direct(bpmn: &Bpmn) -> Result<PetriNetPayload, String> {
    if let Some(gateway) = bpmn.nodes.iter().find(|n| n.kind == NodeKind::InclusiveGateway) {
        return Err(format!(
            "inclusive (OR) gateway '{}' has no compact Petri net translation. Run \"Replace OR-joins\" first",
            gateway.id
        ));
    }

    // One place per sequence flow. Everything else is arcs into and out of them.
    let place_of: HashMap<&str, u32> =
        bpmn.flows.iter().enumerate().map(|(i, f)| (f.id.as_str(), i as u32)).collect();
    let mut net = Net { labels: Vec::new(), p2t: Vec::new(), t2p: Vec::new() };

    let starts: Vec<&crate::Node> =
        bpmn.nodes.iter().filter(|n| n.kind == NodeKind::StartEvent).collect();
    let ends: Vec<&crate::Node> =
        bpmn.nodes.iter().filter(|n| n.kind == NodeKind::EndEvent).collect();
    if starts.len() != 1 || ends.len() != 1 {
        return Err(format!(
            "an accepting Petri net needs one start and one end event; this diagram has {} and {}",
            starts.len(),
            ends.len()
        ));
    }

    for node in &bpmn.nodes {
        let inputs: Vec<u32> = bpmn.incoming(&node.id).map(|f| place_of[f.id.as_str()]).collect();
        let outputs: Vec<u32> = bpmn.outgoing(&node.id).map(|f| place_of[f.id.as_str()]).collect();

        match node.kind {
            // The events are the markings, not transitions of their own.
            NodeKind::StartEvent | NodeKind::EndEvent => {}
            NodeKind::Task => {
                if inputs.len() != 1 || outputs.len() != 1 {
                    return Err(format!(
                        "task '{}' has {} incoming and {} outgoing flows; a task that branches has \
                         no unambiguous meaning — put a gateway there",
                        node.id,
                        inputs.len(),
                        outputs.len()
                    ));
                }
                net.transition(node.label.clone(), &inputs, &outputs);
            }
            NodeKind::ParallelGateway => {
                // Synchronise everything, then produce everything: one
                // transition is exactly that.
                net.transition(None, &inputs, &outputs);
            }
            NodeKind::ExclusiveGateway => {
                // The choice *is* which transition fires, so there is one per
                // way through: n incoming and m outgoing give n x m, which for
                // the usual split (1 x m) or join (n x 1) is just m or n.
                for &input in &inputs {
                    for &output in &outputs {
                        net.transition(None, &[input], &[output]);
                    }
                }
            }
            NodeKind::InclusiveGateway => unreachable!("rejected above"),
        }
    }

    let initial: Vec<u32> = bpmn.outgoing(&starts[0].id).map(|f| place_of[f.id.as_str()]).collect();
    let final_marking: Vec<u32> =
        bpmn.incoming(&ends[0].id).map(|f| place_of[f.id.as_str()]).collect();

    let places: Vec<Place> = bpmn
        .flows
        .iter()
        .enumerate()
        .map(|(i, flow)| {
            let id = i as u32;
            Place {
                id: format!("p_{}", flow.id),
                inputs: net.t2p.iter().filter(|(_, p)| *p == id).map(|(t, _)| *t).collect(),
                outputs: net.p2t.iter().filter(|(p, _)| *p == id).map(|(_, t)| *t).collect(),
                kind: if initial.contains(&id) {
                    "initial"
                } else if final_marking.contains(&id) {
                    "final"
                } else {
                    "derived"
                },
            }
        })
        .collect();

    let start_activities: Vec<u32> =
        net.p2t.iter().filter(|(p, _)| initial.contains(p)).map(|(_, t)| *t).collect();
    let end_activities: Vec<u32> =
        net.t2p.iter().filter(|(_, p)| final_marking.contains(p)).map(|(t, _)| *t).collect();

    let stats = Stats {
        places: places.len(),
        transitions: net.labels.len(),
        arcs: net.p2t.len() + net.t2p.len(),
        silent_transitions: net.labels.iter().filter(|l| l.is_none()).count(),
    };

    Ok(PetriNetPayload {
        activities: (0..net.labels.len() as u32).collect(),
        labels: net.labels,
        places,
        place_to_transition: net.p2t,
        transition_to_place: net.t2p,
        initial_marking: initial,
        final_marking,
        start_activities,
        end_activities,
        stats,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Flow, Metadata, Node};

    fn n(id: &str, kind: NodeKind) -> Node {
        Node { id: id.into(), kind, label: (kind == NodeKind::Task).then(|| id.to_string()) }
    }
    fn f(id: &str, source: &str, target: &str) -> Flow {
        Flow { id: id.into(), source: source.into(), target: target.into(), label: None }
    }
    fn diagram(nodes: Vec<Node>, flows: Vec<Flow>) -> Bpmn {
        Bpmn { nodes, flows, metadata: Metadata { source_type: None, structured: false, warnings: Vec::new() } }
    }

    #[test]
    fn a_sequence_becomes_a_chain() {
        let bpmn = diagram(
            vec![n("s", NodeKind::StartEvent), n("a", NodeKind::Task), n("e", NodeKind::EndEvent)],
            vec![f("f1", "s", "a"), f("f2", "a", "e")],
        );
        let net = to_petri_net_direct(&bpmn).unwrap();
        assert_eq!(net.stats.places, 2);
        assert_eq!(net.stats.transitions, 1);
        assert_eq!(net.labels, vec![Some("a".to_string())]);
        assert_eq!(net.initial_marking, vec![0]);
        assert_eq!(net.final_marking, vec![1]);
        assert_eq!(net.place_to_transition, vec![(0, 0)]);
        assert_eq!(net.transition_to_place, vec![(0, 1)]);
    }

    #[test]
    fn an_exclusive_gateway_becomes_one_transition_per_branch() {
        let bpmn = diagram(
            vec![
                n("s", NodeKind::StartEvent), n("x", NodeKind::ExclusiveGateway),
                n("a", NodeKind::Task), n("b", NodeKind::Task),
                n("j", NodeKind::ExclusiveGateway), n("e", NodeKind::EndEvent),
            ],
            vec![
                f("f1", "s", "x"), f("f2", "x", "a"), f("f3", "x", "b"),
                f("f4", "a", "j"), f("f5", "b", "j"), f("f6", "j", "e"),
            ],
        );
        let net = to_petri_net_direct(&bpmn).unwrap();
        // 2 tasks + 2 for the split + 2 for the join.
        assert_eq!(net.stats.transitions, 6);
        assert_eq!(net.stats.silent_transitions, 4);
        assert_eq!(net.stats.places, 6);
    }

    #[test]
    fn a_parallel_gateway_becomes_one_synchronising_transition() {
        let bpmn = diagram(
            vec![
                n("s", NodeKind::StartEvent), n("p", NodeKind::ParallelGateway),
                n("a", NodeKind::Task), n("b", NodeKind::Task),
                n("j", NodeKind::ParallelGateway), n("e", NodeKind::EndEvent),
            ],
            vec![
                f("f1", "s", "p"), f("f2", "p", "a"), f("f3", "p", "b"),
                f("f4", "a", "j"), f("f5", "b", "j"), f("f6", "j", "e"),
            ],
        );
        let net = to_petri_net_direct(&bpmn).unwrap();
        assert_eq!(net.stats.transitions, 4, "two tasks, one split, one join");
        // The split transition produces both branch places at once.
        let split = net.labels.iter().position(|l| l.is_none()).unwrap() as u32;
        assert_eq!(net.transition_to_place.iter().filter(|(t, _)| *t == split).count(), 2);
    }

    #[test]
    fn a_diagram_that_does_not_nest_converts_anyway() {
        // The overlapping choices `rpst` rejects: x1 -> {a, b}, b -> x2 -> {c,
        // join}, everything merging. No block structure, no problem here.
        let bpmn = diagram(
            vec![
                n("s", NodeKind::StartEvent), n("x1", NodeKind::ExclusiveGateway),
                n("a", NodeKind::Task), n("b", NodeKind::Task), n("c", NodeKind::Task),
                n("x2", NodeKind::ExclusiveGateway), n("j", NodeKind::ExclusiveGateway),
                n("e", NodeKind::EndEvent),
            ],
            vec![
                f("f1", "s", "x1"), f("f2", "x1", "a"), f("f3", "x1", "b"),
                f("f4", "b", "x2"), f("f5", "x2", "c"), f("f6", "x2", "j"),
                f("f7", "a", "j"), f("f8", "c", "j"), f("f9", "j", "e"),
            ],
        );
        assert!(crate::rpst::structure(&bpmn).is_err(), "the fixture must not be block-structured");
        let net = to_petri_net_direct(&bpmn).unwrap();
        assert_eq!(net.stats.places, 9, "one per flow");
        assert_eq!(net.initial_marking, vec![0]);
        assert_eq!(net.final_marking, vec![8]);
    }

    #[test]
    fn an_inclusive_gateway_is_still_refused() {
        let bpmn = diagram(
            vec![n("s", NodeKind::StartEvent), n("o", NodeKind::InclusiveGateway), n("e", NodeKind::EndEvent)],
            vec![f("f1", "s", "o"), f("f2", "o", "e")],
        );
        assert!(to_petri_net_direct(&bpmn).unwrap_err().contains("Replace OR-joins"));
    }

    #[test]
    fn a_branching_task_is_named_rather_than_guessed_at() {
        let bpmn = diagram(
            vec![
                n("s", NodeKind::StartEvent), n("a", NodeKind::Task),
                n("b", NodeKind::Task), n("c", NodeKind::Task), n("e", NodeKind::EndEvent),
            ],
            vec![f("f1", "s", "a"), f("f2", "a", "b"), f("f3", "a", "c"), f("f4", "b", "e"), f("f5", "c", "e")],
        );
        assert!(to_petri_net_direct(&bpmn).unwrap_err().contains("task 'a'"));
    }
}
