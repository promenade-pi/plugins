//! Workflow-net structure and soundness diagnosis for accepting Petri nets.
//!
//! Pure Rust: no wasm, no host types, no JSON boundary. `../../src/lib.rs` is
//! the thin kernel that hands this crate an `AcceptingPetriNet` payload and
//! serializes the [`report::Report`] back.
//!
//! ```
//! use soundness_core::{analyse, testing::fixtures, Options};
//! let report = analyse(&fixtures::sequence(), &Options::default());
//! assert_eq!(report.summary.errors, 0);
//! ```

pub mod analysis;
pub mod explore;
pub mod net;
pub mod report;
pub mod structure;
pub mod testing;

pub use analysis::{analyse, Options};
pub use net::{normalize, Net, RawNet};
pub use report::Report;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::report::{Outcome, Verdict};
    use crate::testing::fixtures;

    fn report_of(net: &Net) -> Report {
        analyse(net, &Options::default())
    }

    #[test]
    fn a_sequence_is_sound() {
        let r = report_of(&fixtures::sequence());
        assert_eq!(r.summary.verdict, Verdict::Sound);
        assert!(r.summary.is_workflow_net);
        assert_eq!(r.summary.errors, 0);
    }

    #[test]
    fn a_parallel_block_is_sound() {
        let r = report_of(&fixtures::parallel());
        assert_eq!(r.summary.verdict, Verdict::Sound);
        assert_eq!(r.behaviour.exploration, "complete");
    }

    #[test]
    fn an_xor_split_joined_by_an_and_deadlocks() {
        let r = report_of(&fixtures::xor_split_and_join());
        assert_eq!(r.summary.verdict, Verdict::Unsound);
        assert_eq!(r.summary.option_to_complete, Outcome::Fail);
        assert!(!r.behaviour.deadlocks.is_empty());
        // The witness is a real firing sequence, not a description of one.
        assert!(!r.behaviour.deadlocks[0].trace.is_empty());
        assert!(r.findings.iter().any(|f| f.id == "SND-DEADLOCK"));
    }

    #[test]
    fn an_and_split_joined_by_an_xor_completes_improperly() {
        let r = report_of(&fixtures::and_split_xor_join());
        assert_eq!(r.summary.verdict, Verdict::Unsound);
        assert_eq!(r.summary.proper_completion, Outcome::Fail);
        assert!(r.findings.iter().any(|f| f.id == "SND-IMPROPER"));
    }

    #[test]
    fn a_transition_that_can_never_fire_is_named() {
        let r = report_of(&fixtures::dead_transition());
        assert_eq!(r.summary.verdict, Verdict::Unsound);
        assert_eq!(r.summary.no_dead_transitions, Outcome::Fail);
        assert!(r.summary.is_workflow_net, "the fixture is structurally a WF-net");
        let dead: Vec<&str> =
            r.behaviour.dead_transitions.iter().map(|&t| r.net.labels[t].as_deref().unwrap()).collect();
        assert_eq!(dead, vec!["E", "F"]);
    }

    #[test]
    fn a_token_minting_loop_is_unbounded() {
        let r = report_of(&fixtures::unbounded());
        assert_eq!(r.summary.verdict, Verdict::Unsound);
        assert_eq!(r.summary.bounded, Outcome::Fail);
        assert_eq!(r.behaviour.exploration, "unbounded");
        let unbounded = r.behaviour.unbounded.as_ref().unwrap();
        assert!(!unbounded.pump.is_empty());
        assert!(unbounded.growing_places.contains(&2));
        // The search stops at the covering pair, so the states it happened to
        // enumerate say nothing about the final marking — and this net's final
        // marking *is* reachable, by A then B.
        assert!(
            !r.findings.iter().any(|f| f.id == "SND-FINAL-UNREACHABLE"),
            "a partial search must not claim the final marking is unreachable"
        );
        assert_eq!(r.behaviour.final_reachable, None);
    }

    #[test]
    fn the_echoed_net_keeps_the_ids_the_findings_use() {
        let r = report_of(&fixtures::dead_transition());
        for finding in &r.findings {
            assert!(finding.transitions.iter().all(|&t| t < r.net.labels.len()));
            assert!(finding.places.iter().all(|&p| p < r.net.places.len()));
        }
        // Weighted arcs are expanded back into repeated pairs.
        assert_eq!(r.net.place_to_transition.iter().filter(|&&(p, t)| p == 1 && t == 1).count(), 2);
    }

    #[test]
    fn a_truncated_search_decides_nothing_it_did_not_see() {
        let r = analyse(&fixtures::parallel(), &Options { max_states: 2 });
        assert_eq!(r.behaviour.exploration, "truncated");
        assert_eq!(r.summary.verdict, Verdict::Inconclusive);
        assert_eq!(r.summary.no_dead_transitions, Outcome::Unknown);
        assert_eq!(r.summary.option_to_complete, Outcome::Unknown);
        assert!(r.behaviour.deadlocks.is_empty(), "an unexpanded state is not a deadlock");
    }

    #[test]
    fn an_empty_net_does_not_panic() {
        let net = normalize(RawNet::default());
        let r = report_of(&net);
        assert_eq!(r.structure.place_count, 0);
        assert_eq!(r.behaviour.states, 1);
    }
}
