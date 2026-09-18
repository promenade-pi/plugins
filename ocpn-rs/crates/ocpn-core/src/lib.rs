//! The Object-Centric Petri Net model.
//!
//! This crate is deliberately inert: it defines what an OCPN *is* — places,
//! transitions, arcs, object types — and nothing about how one gets
//! discovered or drawn. No wasm types, no browser APIs, no Promenade
//! artifact machinery, no layout coordinates. `ocpn-discovery` builds one of
//! these; a view lays one out; neither belongs here.
//!
//! # Identity, not generation
//!
//! Every id in this model is a pure function of what the node *means*, never
//! an arbitrary counter:
//!
//! - A labelled transition's id is a function of its activity name alone
//!   (`transition_id_for_activity`). Two object types that each produce a
//!   transition for the same activity therefore produce the *same* id — that
//!   is the merge step, not a bug to guard against. Conversely, two
//!   transitions can only share an id if they share an activity label, so an
//!   accidental merge would mean the log's own classifier called them the
//!   same activity.
//! - A silent (tau) transition's id is namespaced to the one object type
//!   whose control-flow produced it (`silent_transition_id`), so it can
//!   never collide with another object type's silent transitions, or with a
//!   labelled transition.
//! - Source and sink places are namespaced per object type
//!   (`source_place_id`, `sink_place_id`) and are never merged across types.
//!
//! Because ids are pure functions of meaning rather than of run order,
//! re-running discovery on unchanged input produces byte-identical output.

use serde::Serialize;
use std::collections::BTreeMap;

pub type PlaceId = String;
pub type TransitionId = String;
pub type ArcId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaceKind {
    Normal,
    Source,
    Sink,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Place {
    pub id: PlaceId,
    #[serde(rename = "objectType")]
    pub object_type: String,
    pub kind: PlaceKind,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Transition {
    pub id: TransitionId,
    /// `None` for a silent (tau) transition.
    pub activity: Option<String>,
    /// Every object type this transition participates in — one entry for an
    /// activity private to one object type's lifecycle, several once shared
    /// activities have been merged.
    #[serde(rename = "objectTypes")]
    pub object_types: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NodeRef {
    Place { id: PlaceId },
    Transition { id: TransitionId },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Arc {
    pub id: ArcId,
    pub source: NodeRef,
    pub target: NodeRef,
    /// Which object type's flow this arc carries. An arc always touches
    /// exactly one place (typed to this object type) and one transition; the
    /// object type is carried on the arc, not inferred from either endpoint,
    /// because a shared transition's own `object_types` may list several.
    #[serde(rename = "objectType")]
    pub object_type: String,
    /// Set when a single firing of the transition can consume/produce more
    /// than one token of this object type at once — i.e. the underlying
    /// activity does not always relate to exactly one object of this type.
    /// See `ocpn-discovery`'s variable-arc detection for exactly how this is
    /// computed; the flag here is the artifact-level fact, independent of how
    /// it was derived.
    pub variable: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ObjectTypeStats {
    pub places: usize,
    pub transitions: usize,
    pub arcs: usize,
    #[serde(rename = "silentTransitions")]
    pub silent_transitions: usize,
    #[serde(rename = "variableArcs")]
    pub variable_arcs: usize,
    pub traces: u64,
    pub events: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SkippedObjectType {
    #[serde(rename = "objectType")]
    pub object_type: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiscoveryParametersEcho {
    /// `"IM"` or `"IMf"`.
    pub variant: &'static str,
    #[serde(rename = "noiseThreshold")]
    pub noise_threshold: f64,
    #[serde(rename = "objectTypes")]
    pub object_types: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Metadata {
    /// Keyed by object type; a `BTreeMap` rather than a `HashMap` so
    /// serialization order is deterministic without a separate sort step.
    #[serde(rename = "perObjectType")]
    pub per_object_type: BTreeMap<String, ObjectTypeStats>,
    #[serde(rename = "skippedObjectTypes")]
    pub skipped_object_types: Vec<SkippedObjectType>,
    pub parameters: DiscoveryParametersEcho,
    /// Set by the wasm boundary when the host's activity dictionary had to
    /// truncate the alphabet to stay inside the kernel's bound — `0` on
    /// every native (non-wasm) discovery, which never truncates. Lives on
    /// `Metadata`, not a wrapper around the whole net, so the artifact this
    /// crate produces is always a bare `ObjectCentricPetriNet` — the same
    /// convention every other Promenade miner's own output type follows.
    #[serde(rename = "activitiesDropped")]
    pub activities_dropped: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ObjectCentricPetriNet {
    #[serde(rename = "objectTypes")]
    pub object_types: Vec<String>,
    pub places: Vec<Place>,
    pub transitions: Vec<Transition>,
    pub arcs: Vec<Arc>,
    pub metadata: Metadata,
}

// ---------------------------------------------------------- deterministic ids

/// Id of the shared transition for `activity`. The merge key: two sub-nets
/// producing a transition for the same activity necessarily produce this
/// same id.
pub fn transition_id_for_activity(activity: &str) -> TransitionId {
    format!("t:{activity}")
}

/// Id of a silent transition, namespaced to `object_type` so it can never
/// collide with another object type's silent transitions or with any
/// labelled transition. `ordinal` only has to be unique and deterministic
/// within one object type's own conversion pass (e.g. pre-order position in
/// the process tree).
pub fn silent_transition_id(object_type: &str, ordinal: usize) -> TransitionId {
    format!("t:silent:{object_type}:{ordinal}")
}

pub fn source_place_id(object_type: &str) -> PlaceId {
    format!("p:{object_type}:src")
}

pub fn sink_place_id(object_type: &str) -> PlaceId {
    format!("p:{object_type}:snk")
}

/// Id of an internal (non-source/sink) place, namespaced to `object_type`.
/// `ordinal` need only be unique and deterministic within that object type's
/// own conversion pass.
pub fn internal_place_id(object_type: &str, ordinal: usize) -> PlaceId {
    format!("p:{object_type}:{ordinal}")
}

// ----------------------------------------------------------------- validation

/// Structural validation the host (or a test) runs at the artifact boundary,
/// the same role `validateProcessTree` plays for `ProcessTree` on the
/// TypeScript side. A discovery bug should fail loudly here rather than
/// reach a viewer that trusts the shape and crashes on it.
pub fn validate(net: &ObjectCentricPetriNet) -> Result<(), String> {
    let place_ix: BTreeMap<&str, &Place> =
        net.places.iter().map(|p| (p.id.as_str(), p)).collect();
    let transition_ix: BTreeMap<&str, &Transition> =
        net.transitions.iter().map(|t| (t.id.as_str(), t)).collect();
    let types: std::collections::BTreeSet<&str> =
        net.object_types.iter().map(String::as_str).collect();

    for p in &net.places {
        if !types.contains(p.object_type.as_str()) {
            return Err(format!("place {} has undeclared object type {}", p.id, p.object_type));
        }
    }
    for t in &net.transitions {
        for ot in &t.object_types {
            if !types.contains(ot.as_str()) {
                return Err(format!("transition {} has undeclared object type {ot}", t.id));
            }
        }
        if t.activity.is_none() && t.object_types.len() != 1 {
            return Err(format!("silent transition {} must belong to exactly one object type", t.id));
        }
    }

    for a in &net.arcs {
        if !types.contains(a.object_type.as_str()) {
            return Err(format!("arc {} has undeclared object type {}", a.id, a.object_type));
        }
        let is_place = |r: &NodeRef| matches!(r, NodeRef::Place { .. });
        if is_place(&a.source) == is_place(&a.target) {
            return Err(format!("arc {} does not alternate place/transition", a.id));
        }
        for end in [&a.source, &a.target] {
            match end {
                NodeRef::Place { id } => {
                    let p = place_ix.get(id.as_str())
                        .ok_or_else(|| format!("arc {} references unknown place {id}", a.id))?;
                    if p.object_type != a.object_type {
                        return Err(format!(
                            "arc {} object type {} does not match place {} object type {}",
                            a.id, a.object_type, id, p.object_type
                        ));
                    }
                }
                NodeRef::Transition { id } => {
                    let t = transition_ix.get(id.as_str())
                        .ok_or_else(|| format!("arc {} references unknown transition {id}", a.id))?;
                    if !t.object_types.iter().any(|ot| ot == &a.object_type) {
                        return Err(format!(
                            "arc {} object type {} not among transition {}'s object types",
                            a.id, a.object_type, id
                        ));
                    }
                }
            }
        }
        if let NodeRef::Place { id } = &a.target {
            if place_ix[id.as_str()].kind == PlaceKind::Source {
                return Err(format!("arc {} targets source place {id}", a.id));
            }
        }
        if let NodeRef::Place { id } = &a.source {
            if place_ix[id.as_str()].kind == PlaceKind::Sink {
                return Err(format!("arc {} leaves sink place {id}", a.id));
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trivial_net() -> ObjectCentricPetriNet {
        let ot = "Order".to_string();
        let src = source_place_id(&ot);
        let snk = sink_place_id(&ot);
        let t = transition_id_for_activity("Ship");
        ObjectCentricPetriNet {
            object_types: vec![ot.clone()],
            places: vec![
                Place { id: src.clone(), object_type: ot.clone(), kind: PlaceKind::Source },
                Place { id: snk.clone(), object_type: ot.clone(), kind: PlaceKind::Sink },
            ],
            transitions: vec![Transition {
                id: t.clone(),
                activity: Some("Ship".to_string()),
                object_types: vec![ot.clone()],
            }],
            arcs: vec![
                Arc {
                    id: "a1".to_string(),
                    source: NodeRef::Place { id: src.clone() },
                    target: NodeRef::Transition { id: t.clone() },
                    object_type: ot.clone(),
                    variable: false,
                },
                Arc {
                    id: "a2".to_string(),
                    source: NodeRef::Transition { id: t.clone() },
                    target: NodeRef::Place { id: snk.clone() },
                    object_type: ot.clone(),
                    variable: false,
                },
            ],
            metadata: Metadata {
                per_object_type: BTreeMap::new(),
                skipped_object_types: vec![],
                parameters: DiscoveryParametersEcho {
                    variant: "IMf", noise_threshold: 0.2, object_types: vec![ot],
                },
                activities_dropped: 0,
            },
        }
    }

    #[test]
    fn validates_a_trivial_net() {
        assert_eq!(validate(&trivial_net()), Ok(()));
    }

    #[test]
    fn activity_id_is_pure_function_of_label() {
        assert_eq!(transition_id_for_activity("Ship"), transition_id_for_activity("Ship"));
        assert_ne!(transition_id_for_activity("Ship"), transition_id_for_activity("Pack"));
    }

    #[test]
    fn silent_ids_never_collide_across_object_types() {
        assert_ne!(silent_transition_id("Order", 0), silent_transition_id("Item", 0));
    }

    #[test]
    fn rejects_an_incoming_arc_on_a_source_place() {
        let mut net = trivial_net();
        let src = source_place_id("Order");
        let t = transition_id_for_activity("Ship");
        net.arcs.push(Arc {
            id: "bad".to_string(),
            source: NodeRef::Transition { id: t },
            target: NodeRef::Place { id: src },
            object_type: "Order".to_string(),
            variable: false,
        });
        assert!(validate(&net).is_err());
    }

    #[test]
    fn rejects_arc_object_type_mismatch() {
        let mut net = trivial_net();
        net.arcs[0].object_type = "Item".to_string(); // not declared
        assert!(validate(&net).is_err());
    }
}
