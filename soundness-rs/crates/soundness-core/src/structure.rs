//! The structural half of the diagnosis: is this a workflow net at all?
//!
//! van der Aalst's definition (*The application of Petri nets to workflow
//! management*, JCSC 8(1), 1998): a Petri net is a **WF-net** when it has one
//! source place `i` with no incoming arc, one sink place `o` with no outgoing
//! arc, and every node lies on a path from `i` to `o`.
//!
//! These are cheap, total, and they are what makes the behavioural verdict
//! below them interpretable — "not sound" on a net with two sink places means
//! something different from "not sound" on a genuine WF-net. They are reported
//! whether or not the behavioural search runs.

use crate::net::Net;
use std::collections::HashSet;

/// A place or a transition, as the connectivity walk sees them.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Node {
    Place(usize),
    Transition(usize),
}

pub struct Structure {
    /// Places with no incoming arc.
    pub sources: Vec<usize>,
    /// Places with no outgoing arc.
    pub sinks: Vec<usize>,
    /// Nodes that are not on any path from a source place to a sink place.
    pub disconnected: Vec<Node>,
    /// Transitions with no input place — enabled from the start, forever.
    pub no_input_transitions: Vec<usize>,
    /// Transitions with no output place — every token reaching them is lost.
    pub no_output_transitions: Vec<usize>,
    /// Places touched by no arc at all.
    pub isolated_places: Vec<usize>,
    /// `t1 \u{2022} \u{2229} \u{2022} t2 \u{2260} \u{2205} \u{21d2} \u{2022}t1 = \u{2022}t2` — choice and synchronisation never
    /// interfere. Many classical results (including Woflan's) only hold here.
    pub free_choice: bool,
    /// Every transition has exactly one input and one output place.
    pub state_machine: bool,
    /// Every place has exactly one input and one output transition.
    pub marked_graph: bool,
    pub is_workflow_net: bool,
}

fn place_predecessors(net: &Net, place: usize) -> Vec<usize> {
    (0..net.transition_count())
        .filter(|&t| net.post[t].iter().any(|&(p, _)| p == place))
        .collect()
}

fn place_successors(net: &Net, place: usize) -> Vec<usize> {
    (0..net.transition_count())
        .filter(|&t| net.pre[t].iter().any(|&(p, _)| p == place))
        .collect()
}

/// Forward or backward closure over the bipartite net graph.
fn reach(net: &Net, seeds: &[Node], forward: bool) -> HashSet<Node> {
    let mut seen: HashSet<Node> = seeds.iter().copied().collect();
    let mut stack: Vec<Node> = seeds.to_vec();
    while let Some(node) = stack.pop() {
        let next: Vec<Node> = match node {
            Node::Place(p) => {
                let ts = if forward { place_successors(net, p) } else { place_predecessors(net, p) };
                ts.into_iter().map(Node::Transition).collect()
            }
            Node::Transition(t) => {
                let arcs = if forward { &net.post[t] } else { &net.pre[t] };
                arcs.iter().map(|&(p, _)| Node::Place(p)).collect()
            }
        };
        for node in next {
            if seen.insert(node) {
                stack.push(node);
            }
        }
    }
    seen
}

pub fn analyse(net: &Net) -> Structure {
    let transitions = net.transition_count();
    let sources: Vec<usize> =
        (0..net.place_count).filter(|&p| place_predecessors(net, p).is_empty()).collect();
    let sinks: Vec<usize> =
        (0..net.place_count).filter(|&p| place_successors(net, p).is_empty()).collect();

    let isolated_places: Vec<usize> = (0..net.place_count)
        .filter(|&p| place_predecessors(net, p).is_empty() && place_successors(net, p).is_empty())
        .collect();
    let no_input_transitions: Vec<usize> = (0..transitions).filter(|&t| net.pre[t].is_empty()).collect();
    let no_output_transitions: Vec<usize> = (0..transitions).filter(|&t| net.post[t].is_empty()).collect();

    // Connectivity is judged from the structural source/sink places. When a
    // net has none (a pure cycle), nothing is on a source-to-sink path and
    // every node is reported — which is the honest answer, not a crash.
    let from_sources = reach(net, &sources.iter().map(|&p| Node::Place(p)).collect::<Vec<_>>(), true);
    let to_sinks = reach(net, &sinks.iter().map(|&p| Node::Place(p)).collect::<Vec<_>>(), false);
    let mut disconnected: Vec<Node> = (0..net.place_count)
        .map(Node::Place)
        .chain((0..transitions).map(Node::Transition))
        .filter(|node| !(from_sources.contains(node) && to_sinks.contains(node)))
        .collect();
    disconnected.sort_by_key(|node| match node {
        Node::Place(p) => (0, *p),
        Node::Transition(t) => (1, *t),
    });

    let free_choice = (0..transitions).all(|a| {
        let pre_a: HashSet<usize> = net.pre[a].iter().map(|&(p, _)| p).collect();
        (0..transitions).filter(|&b| b != a).all(|b| {
            let pre_b: HashSet<usize> = net.pre[b].iter().map(|&(p, _)| p).collect();
            pre_a.is_disjoint(&pre_b) || pre_a == pre_b
        })
    });
    let state_machine = (0..transitions).all(|t| {
        net.pre[t].iter().map(|&(_, w)| w).sum::<u32>() == 1
            && net.post[t].iter().map(|&(_, w)| w).sum::<u32>() == 1
    });
    let marked_graph = (0..net.place_count)
        .all(|p| place_predecessors(net, p).len() == 1 && place_successors(net, p).len() == 1);

    let is_workflow_net = sources.len() == 1 && sinks.len() == 1 && disconnected.is_empty();

    Structure {
        sources,
        sinks,
        disconnected,
        no_input_transitions,
        no_output_transitions,
        isolated_places,
        free_choice,
        state_machine,
        marked_graph,
        is_workflow_net,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::build;

    #[test]
    fn a_sequence_is_a_workflow_net() {
        // i -> A -> p -> B -> o
        let net = build(3, &[("A", &[0], &[1]), ("B", &[1], &[2])], &[0], &[2]);
        let s = analyse(&net);
        assert_eq!(s.sources, vec![0]);
        assert_eq!(s.sinks, vec![2]);
        assert!(s.disconnected.is_empty());
        assert!(s.is_workflow_net);
        assert!(s.free_choice);
        assert!(s.state_machine);
    }

    #[test]
    fn a_second_sink_disqualifies_the_net() {
        // i -> A -> o1, i -> B -> o2
        let net = build(3, &[("A", &[0], &[1]), ("B", &[0], &[2])], &[0], &[1]);
        let s = analyse(&net);
        assert_eq!(s.sinks, vec![1, 2]);
        assert!(!s.is_workflow_net);
    }

    #[test]
    fn a_node_off_every_source_to_sink_path_is_named() {
        // i -> A -> o, plus an isolated cycle p3 -> C -> p3
        let net = build(4, &[("A", &[0], &[1]), ("C", &[2], &[2]), ("D", &[3], &[3])], &[0], &[1]);
        let s = analyse(&net);
        assert!(s.disconnected.contains(&Node::Place(2)));
        assert!(s.disconnected.contains(&Node::Transition(1)));
        assert!(!s.disconnected.contains(&Node::Place(0)));
        assert!(!s.is_workflow_net);
    }

    #[test]
    fn a_shared_but_unequal_preset_is_not_free_choice() {
        // A: {p0}, B: {p0, p1} -> they overlap without being equal.
        let net = build(4, &[("A", &[0], &[2]), ("B", &[0, 1], &[3])], &[0], &[2]);
        assert!(!analyse(&net).free_choice);
    }
}
