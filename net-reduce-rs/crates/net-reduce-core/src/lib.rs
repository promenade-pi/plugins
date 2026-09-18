//! Behaviour-preserving reduction of an accepting Petri net.
//!
//! A discovered or converted net is usually bigger than the process it
//! describes. The structure-free BPMN mapping writes one place per sequence
//! flow and a silent transition per gateway pair; the Inductive Miner's
//! block construction brackets every operator with taus. None of that is
//! wrong — it is just scaffolding, and it is in the way of everything that
//! reads the net afterwards: a state-space search pays for every extra place,
//! an alignment pays for every silent step, and a person reading the diagram
//! pays most of all.
//!
//! Reduction removes the scaffolding without changing what the net *does*.
//!
//! > Murata, T. (1989). *Petri nets: properties, analysis and applications.*
//! > Proceedings of the IEEE 77(4), 541–580.
//!
//! > Berthelot, G. (1986). *Transformations and decompositions of nets.*
//! > Advances in Petri Nets, LNCS 254, 359–376.
//!
//! The promise is language equivalence — the same sequences of visible
//! activities, ending in the final marking in the same cases — which is
//! stronger than what the classical rules are stated to preserve, because a
//! labelled net cannot fuse two visible transitions without losing a label.
//! Each rule in `rules` carries the precondition that keeps that promise, and
//! `tests/invariants.rs` establishes it the only way worth trusting: by
//! enumerating both nets' languages with another plugin's play-out and
//! comparing them.

pub mod model;
pub mod rules;

use model::{to_payload, Model, PetriNetPayload, Stats};
use serde::Serialize;
use soundness_core::net::Net;

#[derive(Clone, Debug)]
pub struct Options {
    /// Drop silent transitions that change no marking.
    pub silent: bool,
    /// Fuse transitions and places in series through a silent step.
    pub series: bool,
    /// Fuse transitions and places wired identically.
    pub parallel: bool,
    /// Drop marked self-loop places.
    pub self_loops: bool,
    /// Drop places another place already constrains.
    pub implicit: bool,
    /// Safety bound on the fixpoint loop.
    pub max_rounds: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self { silent: true, series: true, parallel: true, self_loops: true, implicit: true, max_rounds: 64 }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub silent_no_ops: usize,
    pub series_transitions: usize,
    pub series_places: usize,
    pub parallel_transitions: usize,
    pub parallel_places: usize,
    pub self_loop_places: usize,
    pub implicit_places: usize,
    pub isolated_places: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Places, transitions, arcs and silent transitions before and after.
    pub before: Stats,
    pub after: Stats,
    pub applied: Applied,
    pub rounds: usize,
    /// How much of the net went away, as a share of its nodes.
    pub reduction: f64,
    pub warnings: Vec<String>,
}

pub struct Reduction {
    pub payload: PetriNetPayload,
    pub report: Report,
}

/// Reduces `net` as far as the enabled rules take it.
pub fn reduce(net: &Net, options: &Options) -> Reduction {
    let mut model = Model::from_net(net);
    let before = to_payload(&model).stats;
    let mut applied = Applied::default();
    let mut rounds = 0;

    // Rules are applied to a fixpoint rather than in one pass: fusing a series
    // creates the pattern the next rule matches, which is the whole reason a
    // chain of gateway taus collapses to nothing.
    while rounds < options.max_rounds {
        rounds += 1;
        let mut changed = 0;
        if options.silent {
            let n = rules::silent_no_ops(&mut model);
            applied.silent_no_ops += n;
            changed += n;
        }
        if options.series {
            let n = rules::series_transitions(&mut model);
            applied.series_transitions += n;
            changed += n;
            let n = rules::series_places(&mut model);
            applied.series_places += n;
            changed += n;
        }
        if options.parallel {
            let n = rules::parallel_transitions(&mut model);
            applied.parallel_transitions += n;
            changed += n;
            let n = rules::parallel_places(&mut model);
            applied.parallel_places += n;
            changed += n;
        }
        if options.self_loops {
            let n = rules::self_loop_places(&mut model);
            applied.self_loop_places += n;
            changed += n;
        }
        if options.implicit {
            let n = rules::implicit_places(&mut model);
            applied.implicit_places += n;
            changed += n;
        }
        let n = rules::isolated_places(&mut model);
        applied.isolated_places += n;
        changed += n;

        if changed == 0 {
            rounds -= 1; // the last round established the fixpoint, it did not use it
            break;
        }
    }

    let payload = to_payload(&model);
    let after = payload.stats.clone();
    let mut warnings = net.warnings.clone();
    if rounds >= options.max_rounds {
        warnings.push(format!(
            "the rules were still finding work after {} rounds and were stopped; the net is \
             reduced, just not necessarily as far as it goes.",
            options.max_rounds
        ));
    }
    if after.places == before.places && after.transitions == before.transitions {
        warnings.push(
            "nothing could be reduced: this net has no silent scaffolding, no duplicated \
             structure and no redundant places."
                .into(),
        );
    }

    let nodes_before = (before.places + before.transitions) as f64;
    let nodes_after = (after.places + after.transitions) as f64;
    let reduction = if nodes_before == 0.0 { 0.0 } else { 1.0 - nodes_after / nodes_before };

    Reduction {
        report: Report { before, after, applied, rounds, reduction, warnings },
        payload,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soundness_core::testing::{build, fixtures};

    #[test]
    fn a_chain_of_silent_steps_collapses_to_nothing() {
        // i -tau-> p -tau-> q -A-> o: two taus of scaffolding around one task.
        let net = build(
            4,
            &[("", &[0], &[1]), ("", &[1], &[2]), ("A", &[2], &[3])],
            &[0],
            &[3],
        );
        let reduced = reduce(&net, &Options::default());
        assert_eq!(reduced.payload.stats.transitions, 1);
        assert_eq!(reduced.payload.stats.places, 2);
        assert_eq!(reduced.payload.labels, vec![Some("A".to_string())]);
        assert_eq!(reduced.payload.initial_marking, vec![0]);
        assert_eq!(reduced.payload.final_marking, vec![1]);
    }

    #[test]
    fn a_net_with_nothing_to_remove_is_returned_as_it_was_and_says_so() {
        let net = fixtures::sequence();
        let reduced = reduce(&net, &Options::default());
        assert_eq!(reduced.payload.stats.places, 3);
        assert_eq!(reduced.payload.stats.transitions, 2);
        assert_eq!(reduced.report.reduction, 0.0);
        assert!(reduced.report.warnings.iter().any(|w| w.contains("nothing could be reduced")));
    }

    #[test]
    fn a_disabled_rule_does_not_fire() {
        let net = build(4, &[("", &[0], &[1]), ("", &[1], &[2]), ("A", &[2], &[3])], &[0], &[3]);
        let options = Options { series: false, ..Options::default() };
        let reduced = reduce(&net, &options);
        assert_eq!(reduced.report.applied.series_transitions, 0);
        assert_eq!(reduced.report.applied.series_places, 0);
        assert!(reduced.payload.stats.transitions >= 3);
    }

    #[test]
    fn the_block_structured_scaffolding_of_a_parallel_block_shrinks() {
        // What a block construction actually emits: silent split and join
        // around the two real activities, with a place on each side of each.
        // `fixtures::parallel()` labels its gateways, so it is *not* this —
        // and correctly reduces to nothing, since every transition there is
        // an activity someone could observe.
        let net = build(
            8,
            &[
                ("", &[0], &[1, 2]),
                ("A", &[1], &[3]),
                ("B", &[2], &[4]),
                ("", &[3, 4], &[5]),
                ("", &[5], &[6]),
                ("C", &[6], &[7]),
            ],
            &[0],
            &[7],
        );
        let reduced = reduce(&net, &Options::default());
        assert!(reduced.report.reduction > 0.0, "{:?}", reduced.report);
        assert!(
            reduced.payload.stats.silent_transitions < 3,
            "the scaffolding shrinks: {:?}", reduced.report.applied
        );
        // The three real activities survive, whatever else goes.
        let labels: Vec<String> = reduced.payload.labels.iter().flatten().cloned().collect();
        for activity in ["A", "B", "C"] {
            assert!(labels.contains(&activity.to_string()), "{activity} was lost");
        }
    }

    #[test]
    fn a_net_of_nothing_but_visible_transitions_is_left_alone() {
        let reduced = reduce(&fixtures::parallel(), &Options::default());
        assert_eq!(reduced.report.reduction, 0.0);
        assert_eq!(reduced.payload.stats.transitions, 4);
    }

    #[test]
    fn reduction_is_idempotent() {
        let net = build(
            6,
            &[("", &[0], &[1]), ("A", &[1], &[2]), ("", &[2], &[3]), ("", &[3], &[4]), ("B", &[4], &[5])],
            &[0],
            &[5],
        );
        let once = reduce(&net, &Options::default());
        let raw: soundness_core::RawNet =
            serde_json::from_value(serde_json::to_value(&once.payload).unwrap()).unwrap();
        let twice = reduce(&soundness_core::normalize(raw), &Options::default());
        assert_eq!(twice.payload.stats.places, once.payload.stats.places);
        assert_eq!(twice.payload.stats.transitions, once.payload.stats.transitions);
        assert_eq!(twice.report.reduction, 0.0);
    }
}
