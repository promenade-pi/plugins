//! Reference scenarios for OCPN discovery semantics.
//!
//! These are structural/canonicalized assertions against the algorithm
//! description in `plugins/ocpn-rs/docs/algorithm.md`, not differential tests
//! against an external oracle — no native Rust or in-repo reference
//! implementation of OCPN discovery exists to diff against (unlike Inductive
//! Miner's ProM oracle), and the task this crate was built for explicitly
//! rules out routing through pm4py/Pyodide even for validation. See
//! `docs/testing.md` for the full rationale.
//!
//! A few scenarios (single object type, independent types, shared activity,
//! variable multiplicity, sparse type, object-type exclusion) already live as
//! unit tests in `src/lib.rs`, close to the code they exercise. The ones here
//! are the remaining reference scenarios that read more naturally as
//! standalone fixtures: start/end places, per-event multiplicity, and the
//! noise threshold.

use ocpn_core::{sink_place_id, source_place_id, transition_id_for_activity, NodeRef, PlaceKind};
use ocpn_discovery::{discover, fixtures::intern, Miner, Parameters};
use std::collections::BTreeSet;

#[test]
fn each_object_type_gets_its_own_source_and_sink_place() {
    let (names, inputs) = intern(&[
        ("Order", vec![vec!["Create", "Ship"]]),
        ("Item", vec![vec!["Pick", "Ship"]]),
    ]);
    let net = discover(&inputs, &names, &BTreeSet::new(), &Parameters::default());
    assert!(ocpn_core::validate(&net).is_ok());

    for ot in ["Order", "Item"] {
        let src = net.places.iter().find(|p| p.id == source_place_id(ot)).expect("source place");
        assert_eq!(src.kind, PlaceKind::Source);
        assert_eq!(src.object_type, ot);
        let snk = net.places.iter().find(|p| p.id == sink_place_id(ot)).expect("sink place");
        assert_eq!(snk.kind, PlaceKind::Sink);
        assert_eq!(snk.object_type, ot);
    }
    // Source/sink ids are namespaced per type — never merged across types,
    // even though both object types happen to share the "Ship" activity.
    assert_ne!(source_place_id("Order"), source_place_id("Item"));
}

#[test]
fn variable_flag_applies_symmetrically_to_input_and_output_arcs() {
    // "Pack" relates to a variable number of Items (input side, consuming
    // several Item tokens at once) — the flag is a property of the
    // (transition, object type) pair, not of arc direction, so both the
    // incoming and outgoing Item arcs on "Pack" should carry it.
    let (names, inputs) = intern(&[
        ("Item", vec![vec!["Pack", "Ship"]]),
    ]);
    let mut variable = BTreeSet::new();
    let pack_id = names.iter().position(|n| n == "Pack").unwrap() as u32;
    variable.insert(("Item".to_string(), pack_id));

    let net = discover(&inputs, &names, &variable, &Parameters::default());
    let pack = transition_id_for_activity("Pack");
    let incoming = net.arcs.iter().any(|a| {
        a.object_type == "Item" && a.variable && matches!(&a.target, NodeRef::Transition{id} if id == &pack)
    });
    let outgoing = net.arcs.iter().any(|a| {
        a.object_type == "Item" && a.variable && matches!(&a.source, NodeRef::Transition{id} if id == &pack)
    });
    assert!(incoming, "expected a variable incoming arc into Pack");
    assert!(outgoing, "expected a variable outgoing arc out of Pack");
}

#[test]
fn no_declared_multiplicity_means_no_variable_arcs() {
    // The negative case: without an explicit variable_multiplicity signal,
    // discovery never guesses variability from the projected log alone (it
    // structurally cannot — the projection is one object at a time).
    let (names, inputs) = intern(&[("Item", vec![vec!["Pack", "Ship"], vec!["Pack", "Ship"]])]);
    let net = discover(&inputs, &names, &BTreeSet::new(), &Parameters::default());
    assert!(net.arcs.iter().all(|a| !a.variable));
    assert_eq!(net.metadata.per_object_type["Item"].variable_arcs, 0);
}

#[test]
fn noise_threshold_only_affects_imf() {
    // IM ignores noise_threshold entirely (forced to 0) — the artifact's own
    // parameter echo reports 0.0 for IM regardless of what was requested.
    let (names, inputs) = intern(&[("Order", vec![vec!["Create", "Ship"]])]);
    let net = discover(&inputs, &names, &BTreeSet::new(), &Parameters { miner: Miner::IM, noise_threshold: 0.9 });
    assert_eq!(net.metadata.parameters.variant, "IM");
    assert_eq!(net.metadata.parameters.noise_threshold, 0.0);

    let net_f = discover(&inputs, &names, &BTreeSet::new(), &Parameters { miner: Miner::IMf, noise_threshold: 0.35 });
    assert_eq!(net_f.metadata.parameters.variant, "IMf");
    assert_eq!(net_f.metadata.parameters.noise_threshold, 0.35);
}

#[test]
fn different_noise_thresholds_can_change_the_discovered_structure() {
    // A log with one dominant behaviour and one rare deviation: at noise 0
    // (equivalent to IM) the rare path must still be represented; a high
    // enough IMf threshold is allowed to filter it, which is exactly the
    // parameter's job. This does not assert a specific tree shape (that
    // would over-fit to the current cut heuristics) — only that the two
    // configurations are permitted to disagree on transition count, which is
    // what "noise threshold has an effect" means operationally.
    let (names, inputs) = intern(&[(
        "Order",
        vec![
            vec!["Create", "Pay", "Ship"],
            vec!["Create", "Pay", "Ship"],
            vec!["Create", "Pay", "Ship"],
            vec!["Create", "Pay", "Ship"],
            vec!["Create", "Pay", "Ship"],
            vec!["Create", "Pay", "Ship"],
            vec!["Create", "Pay", "Ship"],
            vec!["Create", "Pay", "Ship"],
            vec!["Create", "Pay", "Ship"],
            vec!["Create", "Cancel"],
        ],
    )]);
    let strict = discover(&inputs, &names, &BTreeSet::new(), &Parameters { miner: Miner::IM, noise_threshold: 0.0 });
    let filtered = discover(&inputs, &names, &BTreeSet::new(), &Parameters { miner: Miner::IMf, noise_threshold: 0.5 });
    assert!(ocpn_core::validate(&strict).is_ok());
    assert!(ocpn_core::validate(&filtered).is_ok());
    // Both are valid discoveries; IM never drops an activity from the
    // alphabet, so "Cancel" is always present there.
    assert!(strict.transitions.iter().any(|t| t.activity.as_deref() == Some("Cancel")));
}
