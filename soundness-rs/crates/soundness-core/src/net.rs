//! Reads `AcceptingPetriNet`'s two wire shapes into one normalized net.
//!
//! The permissive split is the same one `plugins/bpmn-rs/crates/bpmn-core/src/petri_net.rs`
//! performs, and for the same reason: there is still no canonical Rust struct
//! for this artifact type in the codebase to depend on.
//!
//! - **Inductive / Heuristics Miner shape** — a `labels: Array<string | null>`
//!   field, self-sufficient. `labels[i] == null` means transition `i` is
//!   genuinely silent (tau).
//! - **Alpha Miner shape** — no `labels`, only bare `activities: number[]` ids
//!   that the arc lists reference directly rather than by compacted position.
//!   The name table lives in `artifact.meta`, which never crosses the wasm
//!   boundary, so names fall back to `#<id>` and one warning is recorded.
//!
//! Arcs repeat to express weight: `place_to_transition` containing `(3, 1)`
//! twice is an arc of weight 2. Every discovery plugin in this repository
//! emits weight-1 arcs only, but a hand-drawn net from the Petri Net Editor or
//! an imported PNML need not, and silently collapsing a weight would change
//! every verdict below it.

use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize, Default)]
pub struct RawNet {
    #[serde(default)]
    pub places: Vec<serde::de::IgnoredAny>,
    #[serde(default)]
    pub activities: Vec<i64>,
    #[serde(default)]
    pub labels: Option<Vec<Option<String>>>,
    #[serde(rename = "place_to_transition", default)]
    pub place_to_transition: Vec<(i64, i64)>,
    #[serde(rename = "transition_to_place", default)]
    pub transition_to_place: Vec<(i64, i64)>,
    #[serde(rename = "initial_marking", default)]
    pub initial_marking: Vec<i64>,
    #[serde(rename = "final_marking", default)]
    pub final_marking: Vec<i64>,
}

/// One place with a token count. A marking is indexed by place id.
pub type Marking = Vec<u32>;

/// `(place, weight)`.
pub type Arcs = Vec<(usize, u32)>;

pub struct Net {
    pub place_count: usize,
    /// `None` is a genuinely silent (tau) transition.
    pub labels: Vec<Option<String>>,
    /// Input places of each transition, weighted, ascending by place.
    pub pre: Vec<Arcs>,
    /// Output places of each transition, weighted, ascending by place.
    pub post: Vec<Arcs>,
    pub initial: Marking,
    pub final_marking: Marking,
    pub warnings: Vec<String>,
}

impl Net {
    pub fn transition_count(&self) -> usize {
        self.labels.len()
    }

    /// The display name of a transition: its label, or `tau` for a silent one.
    pub fn name_of(&self, transition: usize) -> String {
        match self.labels.get(transition).and_then(|l| l.clone()) {
            Some(label) => label,
            None => "\u{3c4}".to_string(),
        }
    }

    pub fn enabled(&self, marking: &Marking, transition: usize) -> bool {
        self.pre[transition].iter().all(|&(place, weight)| marking[place] >= weight)
    }

    /// Fires `transition`, which the caller has established is enabled.
    pub fn fire(&self, marking: &Marking, transition: usize) -> Marking {
        let mut next = marking.clone();
        for &(place, weight) in &self.pre[transition] {
            next[place] -= weight;
        }
        for &(place, weight) in &self.post[transition] {
            next[place] = next[place].saturating_add(weight);
        }
        next
    }
}

/// Collapses repeated arcs into weights and drops any arc naming a place or
/// transition the net does not declare — a truncated or hand-edited payload
/// otherwise panics on an out-of-range index deep inside the state search.
fn weigh(pairs: impl Iterator<Item = (usize, usize)>, count: usize, transitions: usize) -> (Vec<Arcs>, usize) {
    let mut per_transition: Vec<HashMap<usize, u32>> = vec![HashMap::new(); transitions];
    let mut dropped = 0;
    for (place, transition) in pairs {
        if place >= count || transition >= transitions {
            dropped += 1;
            continue;
        }
        *per_transition[transition].entry(place).or_insert(0) += 1;
    }
    let arcs = per_transition
        .into_iter()
        .map(|map| {
            let mut list: Arcs = map.into_iter().collect();
            list.sort_unstable();
            list
        })
        .collect();
    (arcs, dropped)
}

/// Marking place ids -> a token vector. An id outside the net is ignored;
/// a repeated id means that many tokens.
fn marking_from(ids: &[i64], place_count: usize) -> Marking {
    let mut marking = vec![0u32; place_count];
    for &id in ids {
        if id >= 0 && (id as usize) < place_count {
            marking[id as usize] += 1;
        }
    }
    marking
}

pub fn normalize(raw: RawNet) -> Net {
    let place_count = raw.places.len();
    let mut warnings = Vec::new();

    // The two shapes differ only in how a transition is addressed: by position
    // in `labels`, or by its own id in `activities`. Both are reduced here to
    // positions `0..labels.len()`.
    let (labels, index_of): (Vec<Option<String>>, Option<HashMap<i64, usize>>) = match raw.labels {
        Some(labels) => (labels, None),
        None => {
            if !raw.activities.is_empty() {
                warnings.push(
                    "this net carries no label table (Alpha Miner shape), so transitions are named by id"
                        .into(),
                );
            }
            (
                raw.activities.iter().map(|&a| Some(format!("#{a}"))).collect(),
                Some(raw.activities.iter().enumerate().map(|(i, &a)| (a, i)).collect()),
            )
        }
    };
    let transitions = labels.len();
    let resolve = |t: i64| -> Option<usize> {
        match &index_of {
            Some(map) => map.get(&t).copied(),
            None => usize::try_from(t).ok(),
        }
    };

    // An arc is malformed whether its endpoint failed to resolve to a
    // transition at all or resolved to a place outside the declared range;
    // both are the same defect to a reader, so they are counted together.
    let mut malformed = 0;
    let resolved_pre: Vec<(usize, usize)> = raw
        .place_to_transition
        .iter()
        .filter_map(|&(p, t)| match (usize::try_from(p).ok(), resolve(t)) {
            (Some(place), Some(transition)) => Some((place, transition)),
            _ => {
                malformed += 1;
                None
            }
        })
        .collect();
    let resolved_post: Vec<(usize, usize)> = raw
        .transition_to_place
        .iter()
        .filter_map(|&(t, p)| match (usize::try_from(p).ok(), resolve(t)) {
            (Some(place), Some(transition)) => Some((place, transition)),
            _ => {
                malformed += 1;
                None
            }
        })
        .collect();
    let (pre, dropped_pre) = weigh(resolved_pre.into_iter(), place_count, transitions);
    let (post, dropped_post) = weigh(resolved_post.into_iter(), place_count, transitions);
    malformed += dropped_pre + dropped_post;
    if malformed > 0 {
        warnings.push(format!(
            "{malformed} arc(s) referenced a place or transition this net does not declare and were ignored"
        ));
    }

    let mut initial = marking_from(&raw.initial_marking, place_count);
    let mut final_marking = marking_from(&raw.final_marking, place_count);

    // A net that declares no marking is still worth diagnosing: fall back to
    // the structural source/sink places, which is exactly what PNML import
    // does when a file carries no `<finalmarkings>` block.
    if initial.iter().all(|&t| t == 0) {
        let sources: Vec<usize> = (0..place_count)
            .filter(|&p| post.iter().all(|arcs| !arcs.iter().any(|&(q, _)| q == p)))
            .collect();
        if !sources.is_empty() && sources.len() < place_count {
            warnings.push(
                "this net declares no initial marking; one token in each source place is assumed".into(),
            );
            for p in sources {
                initial[p] = 1;
            }
        }
    }
    if final_marking.iter().all(|&t| t == 0) {
        let sinks: Vec<usize> = (0..place_count)
            .filter(|&p| pre.iter().all(|arcs| !arcs.iter().any(|&(q, _)| q == p)))
            .collect();
        if !sinks.is_empty() && sinks.len() < place_count {
            warnings.push(
                "this net declares no final marking; one token in each sink place is assumed".into(),
            );
            for p in sinks {
                final_marking[p] = 1;
            }
        }
    }

    Net { place_count, labels, pre, post, initial, final_marking, warnings }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(labels: Option<Vec<Option<String>>>) -> RawNet {
        RawNet {
            places: vec![serde::de::IgnoredAny, serde::de::IgnoredAny],
            activities: vec![7],
            labels,
            place_to_transition: vec![(0, 7)],
            transition_to_place: vec![(7, 1)],
            initial_marking: vec![0],
            final_marking: vec![1],
            ..Default::default()
        }
    }

    #[test]
    fn inductive_shape_is_self_sufficient() {
        let mut r = raw(Some(vec![Some("A".into())]));
        r.place_to_transition = vec![(0, 0)];
        r.transition_to_place = vec![(0, 1)];
        let net = normalize(r);
        assert_eq!(net.labels, vec![Some("A".to_string())]);
        assert_eq!(net.pre[0], vec![(0, 1)]);
        assert_eq!(net.post[0], vec![(1, 1)]);
        assert!(net.warnings.is_empty());
    }

    #[test]
    fn alpha_shape_addresses_transitions_by_id() {
        let net = normalize(raw(None));
        assert_eq!(net.labels, vec![Some("#7".to_string())]);
        assert_eq!(net.pre[0], vec![(0, 1)]);
        assert_eq!(net.post[0], vec![(1, 1)]);
        assert_eq!(net.warnings.len(), 1);
    }

    #[test]
    fn repeated_arcs_become_weights() {
        let mut r = raw(Some(vec![Some("A".into())]));
        r.place_to_transition = vec![(0, 0), (0, 0)];
        r.transition_to_place = vec![(0, 1)];
        let net = normalize(r);
        assert_eq!(net.pre[0], vec![(0, 2)]);
        assert!(!net.enabled(&vec![1, 0], 0));
        assert!(net.enabled(&vec![2, 0], 0));
        assert_eq!(net.fire(&vec![2, 0], 0), vec![0, 1]);
    }

    #[test]
    fn out_of_range_arcs_are_dropped_with_a_warning() {
        let mut r = raw(Some(vec![Some("A".into())]));
        r.place_to_transition = vec![(0, 0), (99, 0)];
        r.transition_to_place = vec![(0, 1)];
        let net = normalize(r);
        assert_eq!(net.pre[0], vec![(0, 1)]);
        assert!(net.warnings.iter().any(|w| w.contains("does not declare")));
    }

    #[test]
    fn missing_markings_fall_back_to_source_and_sink() {
        let mut r = raw(Some(vec![Some("A".into())]));
        r.place_to_transition = vec![(0, 0)];
        r.transition_to_place = vec![(0, 1)];
        r.initial_marking = vec![];
        r.final_marking = vec![];
        let net = normalize(r);
        assert_eq!(net.initial, vec![1, 0]);
        assert_eq!(net.final_marking, vec![0, 1]);
        assert_eq!(net.warnings.len(), 2);
    }
}
