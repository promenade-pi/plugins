//! Object-Centric Petri Net discovery.
//!
//! ```text
//! for each selected object type:
//!     project the OCEL onto that type (one case per object; an event
//!     related to k objects of the type contributes to k cases) — the
//!     caller's job, see the crate-level docs below
//!   -> a trace-variant EventLog, over a *global* activity dictionary shared
//!      by every object type (this is what makes the later merge step exact)
//!   -> Inductive Miner (reused from `inductive-miner-core`, unmodified)
//!   -> a ProcessTree
//!   -> tree_to_net::tree_to_subnet: a Petri net tagged with this object type
//! merge every sub-net's transitions by activity label (see `ocpn-core`'s id
//!   scheme — activity-labelled transitions with the same label already
//!   share an id, so the merge is a map insert, not a separate pass)
//! flag variable arcs from a precomputed (object type, activity) cardinality
//!   signal (see `Parameters`/`discover`'s `variable_multiplicity` argument)
//! ```
//!
//! # What this crate does *not* do
//!
//! It does not touch OCEL, SQL, OPFS, or wasm. It consumes an already
//! per-object-type-projected `EventLog` per type (over a global activity id
//! space) plus a small precomputed variable-multiplicity signal — both are
//! the caller's job (the wasm boundary in `promenade-ocpn`'s `src/lib.rs`, or
//! a test fixture here). That split mirrors `inductive-miner-core` itself:
//! the expensive, OCEL-shaped work (projection, dictionary encoding) belongs
//! to the host/SQL layer; this crate only ever sees compact, already-reduced
//! data.
//!
//! # Variable arcs
//!
//! For object type `OT` and activity `A`: if any single occurrence of `A` in
//! the *original* (unprojected) event-object relation touches more than one
//! object of type `OT`, every arc between `A`'s transition and `OT`'s places
//! is variable — a firing of that transition can consume/produce more than
//! one token of that type at once. This is symmetric in direction (it is a
//! property of the `(activity, object type)` relation's cardinality, not of
//! flow direction) and is computed from data the per-object-type projection
//! itself cannot recover (the projection is one-object-at-a-time by
//! construction), which is why it arrives as a separate signal rather than
//! being inferred from the mined trees.
//!
//! # Sparse and isolated object types
//!
//! No frequency threshold is applied. An object type with events, however
//! few, is mined like any other — Inductive Miner handles small logs without
//! special-casing. An object type with *zero* relevant events is excluded
//! from the result and reported in `metadata.skippedObjectTypes` with a
//! reason, rather than emitting a degenerate empty net.

pub mod fixtures;
mod tree_to_net;

use inductive_miner_core::Variant as ImVariant;
use ocpn_core::{
    DiscoveryParametersEcho, Metadata, NodeRef, ObjectCentricPetriNet, ObjectTypeStats,
    SkippedObjectType, Transition, TransitionId,
};
use std::collections::BTreeMap;

pub use inductive_miner_core::EventLog;

/// One object type's already-projected event log, over the *global* activity
/// id space shared by every object type in the run.
#[derive(Debug, Clone)]
pub struct ObjectTypeInput {
    pub object_type: String,
    pub log: EventLog,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Miner {
    /// Fitness-guaranteeing; noise threshold is ignored.
    IM,
    /// Infrequent-behaviour tolerant. The usual choice.
    IMf,
}

#[derive(Debug, Clone)]
pub struct Parameters {
    pub miner: Miner,
    /// `0..=1`, ignored for `Miner::IM`.
    pub noise_threshold: f64,
}

impl Default for Parameters {
    fn default() -> Self {
        Parameters { miner: Miner::IMf, noise_threshold: 0.2 }
    }
}

/// Discovers one merged OCPN from a set of per-object-type projected logs.
///
/// `activity_names` is the global activity dictionary every `log`'s
/// `ActivityId`s index into. `variable_multiplicity` names every
/// `(object_type, activity_id)` pair whose activity has ever related to more
/// than one object of that type in a single event — see the module docs.
pub fn discover(
    inputs: &[ObjectTypeInput],
    activity_names: &[String],
    variable_multiplicity: &std::collections::BTreeSet<(String, u32)>,
    params: &Parameters,
) -> ObjectCentricPetriNet {
    let im_params = inductive_miner_core::Parameters {
        variant: match params.miner {
            Miner::IM => ImVariant::IM,
            Miner::IMf => ImVariant::IMf,
        },
        noise_threshold: params.noise_threshold,
        ..Default::default()
    };

    let mut object_types = Vec::new();
    let mut places = Vec::new();
    let mut arcs = Vec::new();
    let mut transitions: BTreeMap<TransitionId, Transition> = BTreeMap::new();
    let mut per_object_type: BTreeMap<String, ObjectTypeStats> = BTreeMap::new();
    let mut skipped = Vec::new();

    for input in inputs {
        if input.log.trace_count() == 0 {
            skipped.push(SkippedObjectType {
                object_type: input.object_type.clone(),
                reason: "no events for this object type".to_string(),
            });
            continue;
        }

        let discovery = match inductive_miner_core::discover(&input.log, &im_params) {
            Ok(d) => d,
            Err(e) => {
                skipped.push(SkippedObjectType {
                    object_type: input.object_type.clone(),
                    reason: format!("discovery failed: {e}"),
                });
                continue;
            }
        };

        let (sub_places, sub_arcs) = tree_to_net::tree_to_subnet(
            &input.object_type,
            &discovery.tree,
            activity_names,
            &mut transitions,
        );

        object_types.push(input.object_type.clone());
        per_object_type.insert(
            input.object_type.clone(),
            ObjectTypeStats {
                places: sub_places.len(),
                arcs: sub_arcs.len(),
                traces: input.log.trace_count(),
                events: input.log.event_count(),
                ..Default::default()
            },
        );
        places.extend(sub_places);
        arcs.extend(sub_arcs);
    }

    // Transition counts are only known once every object type has
    // contributed — a shared transition's `object_types` is not final until
    // the whole merge has run.
    for t in transitions.values() {
        for ot in &t.object_types {
            if let Some(s) = per_object_type.get_mut(ot) {
                s.transitions += 1;
                if t.activity.is_none() {
                    s.silent_transitions += 1;
                }
            }
        }
    }

    let activity_id_of: BTreeMap<&str, u32> =
        activity_names.iter().enumerate().map(|(i, n)| (n.as_str(), i as u32)).collect();
    for arc in &mut arcs {
        let transition_id = match (&arc.source, &arc.target) {
            (NodeRef::Transition { id }, _) => id,
            (_, NodeRef::Transition { id }) => id,
            _ => continue,
        };
        let Some(label) = transitions.get(transition_id).and_then(|t| t.activity.as_deref()) else { continue };
        let Some(&aid) = activity_id_of.get(label) else { continue };
        if variable_multiplicity.contains(&(arc.object_type.clone(), aid)) {
            arc.variable = true;
        }
    }
    for (ot, stats) in per_object_type.iter_mut() {
        stats.variable_arcs = arcs.iter().filter(|a| &a.object_type == ot && a.variable).count();
    }

    ObjectCentricPetriNet {
        object_types: object_types.clone(),
        places,
        transitions: transitions.into_values().collect(),
        arcs,
        metadata: Metadata {
            per_object_type,
            skipped_object_types: skipped,
            parameters: DiscoveryParametersEcho {
                variant: match params.miner {
                    Miner::IM => "IM",
                    Miner::IMf => "IMf",
                },
                noise_threshold: match params.miner {
                    Miner::IM => 0.0,
                    Miner::IMf => params.noise_threshold,
                },
                object_types,
            },
            // Always 0 here — truncation is a wasm-boundary concern (the
            // kernel's activity-count bound); the wasm shell overwrites this
            // after calling `discover()`. Native/CLI callers never truncate.
            activities_dropped: 0,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::intern;
    use std::collections::BTreeSet;

    #[test]
    fn single_object_type_reduces_to_a_traditional_lifecycle() {
        let (names, inputs) = intern(&[("Order", vec![
            vec!["Create", "Pay", "Ship"],
            vec!["Create", "Pay", "Ship"],
        ])]);
        let net = discover(&inputs, &names, &BTreeSet::new(), &Parameters::default());
        assert_eq!(net.object_types, vec!["Order".to_string()]);
        assert!(ocpn_core::validate(&net).is_ok());
        // One transition per activity, all belonging to Order alone.
        let labels: BTreeSet<_> = net.transitions.iter().filter_map(|t| t.activity.clone()).collect();
        assert_eq!(labels, BTreeSet::from(["Create".to_string(), "Pay".to_string(), "Ship".to_string()]));
        for t in &net.transitions {
            if t.activity.is_some() {
                assert_eq!(t.object_types, vec!["Order".to_string()]);
            }
        }
    }

    #[test]
    fn independent_object_types_do_not_accidentally_synchronize() {
        let (names, inputs) = intern(&[
            ("Order", vec![vec!["CreateOrder", "CloseOrder"]]),
            ("Invoice", vec![vec!["CreateInvoice", "CloseInvoice"]]),
        ]);
        let net = discover(&inputs, &names, &BTreeSet::new(), &Parameters::default());
        assert!(ocpn_core::validate(&net).is_ok());
        for t in net.transitions.iter().filter(|t| t.activity.is_some()) {
            assert_eq!(t.object_types.len(), 1, "activity {:?} unexpectedly shared", t.activity);
        }
    }

    #[test]
    fn shared_activity_produces_one_transition_with_both_types() {
        let (names, inputs) = intern(&[
            ("Order", vec![vec!["Create", "Ship"]]),
            ("Package", vec![vec!["Pack", "Ship"]]),
        ]);
        let net = discover(&inputs, &names, &BTreeSet::new(), &Parameters::default());
        assert!(ocpn_core::validate(&net).is_ok());
        let ship = net.transitions.iter().find(|t| t.activity.as_deref() == Some("Ship")).unwrap();
        let mut ots = ship.object_types.clone();
        ots.sort();
        assert_eq!(ots, vec!["Order".to_string(), "Package".to_string()]);
        // Exactly one transition id for "Ship" — not one per object type.
        assert_eq!(net.transitions.iter().filter(|t| t.activity.as_deref() == Some("Ship")).count(), 1);
    }

    #[test]
    fn sparse_object_type_is_skipped_with_a_reason() {
        let (names, mut inputs) = intern(&[("Order", vec![vec!["Create"]])]);
        inputs.push(ObjectTypeInput { object_type: "Ghost".to_string(), log: EventLog::new() });
        let net = discover(&inputs, &names, &BTreeSet::new(), &Parameters::default());
        assert_eq!(net.object_types, vec!["Order".to_string()]);
        assert_eq!(net.metadata.skipped_object_types.len(), 1);
        assert_eq!(net.metadata.skipped_object_types[0].object_type, "Ghost");
    }

    #[test]
    fn variable_multiplicity_flags_only_the_declared_pair() {
        let (names, inputs) = intern(&[
            ("Order", vec![vec!["Create", "Pack", "Ship"]]),
            ("Item", vec![vec!["Pack", "Ship"]]),
        ]);
        let mut variable = BTreeSet::new();
        let pack_id = names.iter().position(|n| n == "Pack").unwrap() as u32;
        variable.insert(("Item".to_string(), pack_id));
        let net = discover(&inputs, &names, &variable, &Parameters::default());
        assert!(ocpn_core::validate(&net).is_ok());
        for arc in &net.arcs {
            let touches_pack = matches!(&arc.source, NodeRef::Transition{id} if id == &ocpn_core::transition_id_for_activity("Pack"))
                || matches!(&arc.target, NodeRef::Transition{id} if id == &ocpn_core::transition_id_for_activity("Pack"));
            if touches_pack && arc.object_type == "Item" {
                assert!(arc.variable, "Item/Pack arc should be variable");
            }
            if touches_pack && arc.object_type == "Order" {
                assert!(!arc.variable, "Order/Pack arc should not be variable");
            }
        }
    }

    #[test]
    fn excluded_object_types_do_not_appear() {
        let (names, inputs) = intern(&[("Order", vec![vec!["Create"]])]);
        let net = discover(&inputs, &names, &BTreeSet::new(), &Parameters::default());
        assert!(!net.object_types.iter().any(|t| t == "Employee"));
        assert!(net.places.iter().all(|p| p.object_type != "Employee"));
    }
}
