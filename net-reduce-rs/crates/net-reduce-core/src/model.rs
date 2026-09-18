//! An editable net, and the `AcceptingPetriNet` payload it is read from and
//! written back to.
//!
//! `soundness-core`'s `Net` is the reader — it already knows both wire shapes
//! and collapses repeated arcs into weights — but it is deliberately immutable
//! and indexed by position, which a reduction cannot use: removing place 3
//! would renumber every arc that mentions a later one. So the rules work on
//! this structure, where a place or transition is *retired* rather than
//! removed, and the renumbering happens once, at the end, when the payload is
//! built.

use serde::Serialize;
use soundness_core::net::Net;

/// `(place, weight)`, ascending by place — the same convention `soundness-core`
/// uses, so arcs can be compared without normalising first.
pub type Arcs = Vec<(usize, u32)>;

#[derive(Clone, Debug)]
pub struct Place {
    pub initial: u32,
    pub final_marking: u32,
    pub alive: bool,
}

#[derive(Clone, Debug)]
pub struct Transition {
    /// `None` is a silent (tau) transition — the only kind most rules may touch.
    pub label: Option<String>,
    pub pre: Arcs,
    pub post: Arcs,
    pub alive: bool,
}

#[derive(Clone, Debug)]
pub struct Model {
    pub places: Vec<Place>,
    pub transitions: Vec<Transition>,
}

impl Model {
    pub fn from_net(net: &Net) -> Self {
        Model {
            places: (0..net.place_count)
                .map(|p| Place {
                    initial: net.initial[p],
                    final_marking: net.final_marking[p],
                    alive: true,
                })
                .collect(),
            transitions: (0..net.transition_count())
                .map(|t| Transition {
                    label: net.labels[t].clone(),
                    pre: net.pre[t].clone(),
                    post: net.post[t].clone(),
                    alive: true,
                })
                .collect(),
        }
    }

    pub fn live_places(&self) -> impl Iterator<Item = usize> + '_ {
        (0..self.places.len()).filter(|&p| self.places[p].alive)
    }

    pub fn live_transitions(&self) -> impl Iterator<Item = usize> + '_ {
        (0..self.transitions.len()).filter(|&t| self.transitions[t].alive)
    }

    pub fn place_count(&self) -> usize {
        self.live_places().count()
    }

    pub fn transition_count(&self) -> usize {
        self.live_transitions().count()
    }

    pub fn arc_count(&self) -> usize {
        self.live_transitions()
            .map(|t| self.transitions[t].pre.len() + self.transitions[t].post.len())
            .sum()
    }

    /// Live transitions that put tokens into `p`.
    pub fn producers(&self, p: usize) -> Vec<usize> {
        self.live_transitions()
            .filter(|&t| self.transitions[t].post.iter().any(|&(q, _)| q == p))
            .collect()
    }

    /// Live transitions that take tokens out of `p`.
    pub fn consumers(&self, p: usize) -> Vec<usize> {
        self.live_transitions()
            .filter(|&t| self.transitions[t].pre.iter().any(|&(q, _)| q == p))
            .collect()
    }

    pub fn weight_in(&self, t: usize, p: usize) -> u32 {
        self.transitions[t].pre.iter().find(|&&(q, _)| q == p).map_or(0, |&(_, w)| w)
    }

    pub fn weight_out(&self, t: usize, p: usize) -> u32 {
        self.transitions[t].post.iter().find(|&&(q, _)| q == p).map_or(0, |&(_, w)| w)
    }

    /// Whether some live place other than `p` holds an initial token.
    ///
    /// A rule that removes the last initially marked place leaves a payload
    /// with an empty initial marking — and an empty marking is not "no
    /// tokens" to a reader: `soundness-core`'s normaliser treats a net that
    /// declares no initial marking as one whose markings were lost, and puts
    /// a token in every source place. The reduction would then be handing the
    /// next reader a different net than the one it reduced.
    pub fn another_marked_place(&self, p: usize) -> bool {
        self.live_places().any(|q| q != p && self.places[q].initial > 0)
    }

    /// Whether some live place other than `p` carries the final marking — the
    /// same reasoning as `another_marked_place`, for the other end of the run.
    pub fn another_final_place(&self, p: usize) -> bool {
        self.live_places().any(|q| q != p && self.places[q].final_marking > 0)
    }

    /// Redirects every arc that mentions `from` to `into`, merging weights.
    pub fn rename_place(&mut self, from: usize, into: usize) {
        fn redirect(arcs: &mut Arcs, from: usize, into: usize) {
            let moved: u32 = arcs.iter().filter(|&&(p, _)| p == from).map(|&(_, w)| w).sum();
            if moved == 0 {
                return;
            }
            arcs.retain(|&(p, _)| p != from);
            match arcs.iter_mut().find(|(p, _)| *p == into) {
                Some((_, weight)) => *weight += moved,
                None => arcs.push((into, moved)),
            }
            arcs.sort_unstable();
        }

        for t in 0..self.transitions.len() {
            if !self.transitions[t].alive {
                continue;
            }
            redirect(&mut self.transitions[t].pre, from, into);
            redirect(&mut self.transitions[t].post, from, into);
        }
    }
}

// ------------------------------------------------- the artifact payload

#[derive(Serialize, Clone, Debug)]
pub struct PayloadPlace {
    pub id: String,
    pub inputs: Vec<u32>,
    pub outputs: Vec<u32>,
    pub kind: &'static str,
}

#[derive(Serialize, Clone, Debug)]
pub struct Stats {
    pub places: usize,
    pub transitions: usize,
    pub arcs: usize,
    pub silent_transitions: usize,
}

/// The "Inductive Miner shape" of `AcceptingPetriNet`: a `labels` array makes
/// it self-sufficient, so every existing consumer (alignment, the layered
/// renderer, play-out, the soundness checker) reads it unmodified. Transcribed
/// from `plugins/bpmn-rs/crates/bpmn-core/src/to_petri_net.rs`, which is where
/// the shape is documented.
#[derive(Serialize, Clone, Debug)]
pub struct PetriNetPayload {
    pub activities: Vec<u32>,
    pub labels: Vec<Option<String>>,
    pub places: Vec<PayloadPlace>,
    pub place_to_transition: Vec<(u32, u32)>,
    pub transition_to_place: Vec<(u32, u32)>,
    pub initial_marking: Vec<u32>,
    pub final_marking: Vec<u32>,
    pub start_activities: Vec<u32>,
    pub end_activities: Vec<u32>,
    pub stats: Stats,
}

/// Renumbers what survived and writes the payload.
///
/// A marking with more than one token in a place is written as that place's id
/// repeated, which is how the wire shape expresses multiplicity — the same
/// convention `soundness-core`'s reader expects on the way in, so a reduced net
/// can be reduced again.
pub fn to_payload(model: &Model) -> PetriNetPayload {
    let place_ids: Vec<usize> = model.live_places().collect();
    let transition_ids: Vec<usize> = model.live_transitions().collect();
    let place_index = |p: usize| place_ids.iter().position(|&q| q == p).unwrap() as u32;

    let labels: Vec<Option<String>> =
        transition_ids.iter().map(|&t| model.transitions[t].label.clone()).collect();

    let mut place_to_transition = Vec::new();
    let mut transition_to_place = Vec::new();
    for (new_t, &t) in transition_ids.iter().enumerate() {
        for &(p, weight) in &model.transitions[t].pre {
            for _ in 0..weight {
                place_to_transition.push((place_index(p), new_t as u32));
            }
        }
        for &(p, weight) in &model.transitions[t].post {
            for _ in 0..weight {
                transition_to_place.push((new_t as u32, place_index(p)));
            }
        }
    }

    let places: Vec<PayloadPlace> = place_ids
        .iter()
        .enumerate()
        .map(|(new_p, &p)| PayloadPlace {
            id: format!("p{new_p}"),
            inputs: transition_to_place
                .iter()
                .filter(|&&(_, q)| q == new_p as u32)
                .map(|&(t, _)| t)
                .collect(),
            outputs: place_to_transition
                .iter()
                .filter(|&&(q, _)| q == new_p as u32)
                .map(|&(_, t)| t)
                .collect(),
            kind: if model.places[p].initial > 0 {
                "initial"
            } else if model.places[p].final_marking > 0 {
                "final"
            } else {
                "derived"
            },
        })
        .collect();

    let mut initial_marking = Vec::new();
    let mut final_marking = Vec::new();
    for (new_p, &p) in place_ids.iter().enumerate() {
        for _ in 0..model.places[p].initial {
            initial_marking.push(new_p as u32);
        }
        for _ in 0..model.places[p].final_marking {
            final_marking.push(new_p as u32);
        }
    }

    let mut start_activities: Vec<u32> =
        place_to_transition.iter().filter(|&&(p, _)| initial_marking.contains(&p)).map(|&(_, t)| t).collect();
    start_activities.sort_unstable();
    start_activities.dedup();
    let mut end_activities: Vec<u32> =
        transition_to_place.iter().filter(|&&(_, p)| final_marking.contains(&p)).map(|&(t, _)| t).collect();
    end_activities.sort_unstable();
    end_activities.dedup();

    let stats = Stats {
        places: places.len(),
        transitions: labels.len(),
        arcs: place_to_transition.len() + transition_to_place.len(),
        silent_transitions: labels.iter().filter(|l| l.is_none()).count(),
    };

    PetriNetPayload {
        activities: (0..labels.len() as u32).collect(),
        labels,
        places,
        place_to_transition,
        transition_to_place,
        initial_marking,
        final_marking,
        start_activities,
        end_activities,
        stats,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soundness_core::testing::fixtures;

    #[test]
    fn a_net_round_trips_through_the_payload_unchanged() {
        let net = fixtures::parallel();
        let model = Model::from_net(&net);
        let payload = to_payload(&model);
        assert_eq!(payload.stats.places, 6);
        assert_eq!(payload.stats.transitions, 4);
        assert_eq!(payload.initial_marking, vec![0]);
        assert_eq!(payload.final_marking, vec![5]);
        assert_eq!(payload.places[0].kind, "initial");
        assert_eq!(payload.places[5].kind, "final");

        // And reading it back gives the same net.
        let raw: soundness_core::RawNet =
            serde_json::from_value(serde_json::to_value(&payload).unwrap()).unwrap();
        let again = soundness_core::normalize(raw);
        assert_eq!(again.place_count, net.place_count);
        assert_eq!(again.labels, net.labels);
        assert_eq!(again.pre, net.pre);
        assert_eq!(again.post, net.post);
        assert_eq!(again.initial, net.initial);
        assert_eq!(again.final_marking, net.final_marking);
    }

    #[test]
    fn a_retired_place_is_renumbered_out_of_the_payload() {
        let net = fixtures::sequence();
        let mut model = Model::from_net(&net);
        // Retire the middle place by folding it into the sink, the way a rule
        // would: every arc that mentioned it now mentions the sink.
        model.rename_place(1, 2);
        model.places[1].alive = false;
        let payload = to_payload(&model);
        assert_eq!(payload.stats.places, 2);
        assert_eq!(payload.place_to_transition, vec![(0, 0), (1, 1)]);
        assert_eq!(payload.transition_to_place, vec![(0, 1), (1, 1)]);
    }

    #[test]
    fn a_weighted_arc_is_written_as_repeated_pairs() {
        let net = soundness_core::testing::build(
            2,
            &[("A", &[0, 0], &[1])],
            &[0, 0],
            &[1],
        );
        let payload = to_payload(&Model::from_net(&net));
        assert_eq!(payload.place_to_transition, vec![(0, 0), (0, 0)]);
        assert_eq!(payload.initial_marking, vec![0, 0]);
    }
}
