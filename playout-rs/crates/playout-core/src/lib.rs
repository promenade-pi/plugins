//! Play-out: an accepting Petri net, simulated into an event log.
//!
//! The inverse of discovery. Every miner in this workspace turns a log into a
//! model; this turns a model back into a log, which is what makes a model
//! testable — a discovered net can be played out, re-mined, and the two models
//! compared, and a miner under development can be run against logs whose
//! generating process is known exactly rather than guessed at from a
//! real-life log nobody has the ground truth for.
//!
//! > Rozinat, A., Mans, R.S., Song, M. & van der Aalst, W.M.P. (2009).
//! > *Discovering simulation models.* Information Systems 34(3), 305–327.
//!
//! is the reference for what a simulation model of a process consists of — a
//! control-flow model, case arrivals, activity durations and a resource
//! perspective — and this crate generates exactly those four, from the net
//! plus three parameters, rather than mining them.
//!
//! Two modes, answering two different questions:
//!
//! - **stochastic** — a sample of the process in operation: cases arrive as a
//!   Poisson process, activities take exponentially distributed service times,
//!   and every choice in the net is taken at random. See `engine`.
//! - **extensive** — every distinct trace the net can produce, bounded. See
//!   `extensive`.
//!
//! Pure Rust: no wasm, no host types, no JSON boundary. `../../src/lib.rs` is
//! the thin kernel that hands this crate an `AcceptingPetriNet` payload and
//! serialises the columns back.
//!
//! ```
//! use playout_core::{play_out, Options};
//! use soundness_core::testing::fixtures;
//! let log = play_out(&fixtures::sequence(), &Options { traces: 5, ..Options::default() });
//! assert_eq!(log.stats.cases, 5);
//! assert_eq!(log.stats.variants, 1);
//! ```

pub mod engine;
pub mod extensive;
pub mod log;
pub mod rng;

use engine::{simulate_case, Case, Outcome};
use rng::Rng;
use serde::{Deserialize, Serialize};
use soundness_core::net::Net;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Stochastic,
    Extensive,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Lifecycle {
    /// One event per activity, when it finished — what most real logs carry.
    Complete,
    /// A `start` and a `complete` event per activity, so durations and genuine
    /// overlap are in the log rather than only in the simulation.
    StartComplete,
}

/// What to do with a case that never reached the final marking.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Incomplete {
    /// Leave it out, so every case in the log is a complete run of the model.
    Discard,
    /// Keep the prefix it managed. Still a firing sequence of the net, just
    /// not one that finished — which is what a conformance checker being
    /// tested against known-unfitting behaviour needs.
    Keep,
}

#[derive(Clone, Debug)]
pub struct Options {
    pub mode: Mode,
    /// Cases to generate, in stochastic mode.
    pub traces: usize,
    /// Distinct traces to keep, in extensive mode.
    pub variants: usize,
    /// The most executions one case may have before it is cut off.
    pub max_length: usize,
    /// Markings the extensive search may expand in total.
    pub max_states: usize,
    pub seed: u64,
    pub lifecycle: Lifecycle,
    pub incomplete: Incomplete,
    /// Mean time between case arrivals, in minutes.
    pub arrival_minutes: f64,
    /// Mean duration of one activity, in minutes.
    pub duration_minutes: f64,
    /// Size of the resource pool; 0 leaves the log without a resource column.
    pub resources: usize,
    /// When the first case arrives, in epoch microseconds.
    pub start_us: i64,
}

/// 2025-01-06T08:00:00Z — a Monday morning, so a generated log's weekday and
/// hour-of-day distributions are the ones a reader expects rather than an
/// artefact of the Unix epoch having been a Thursday.
pub const DEFAULT_START_US: i64 = 1_736_150_400_000_000;

impl Default for Options {
    fn default() -> Self {
        Self {
            mode: Mode::Stochastic,
            traces: 1_000,
            variants: 1_000,
            max_length: 200,
            max_states: 200_000,
            seed: 42,
            lifecycle: Lifecycle::Complete,
            incomplete: Incomplete::Discard,
            arrival_minutes: 15.0,
            duration_minutes: 10.0,
            resources: 0,
            start_us: DEFAULT_START_US,
        }
    }
}

/// One simulated case: its executions and when it arrived.
#[derive(Clone, Debug)]
pub struct SimulatedCase {
    pub case: Case,
    pub arrival_us: i64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub mode: String,
    /// Cases actually written to the log.
    pub cases: usize,
    pub events: usize,
    /// Distinct visible traces among the cases written.
    pub variants: usize,
    pub activities: usize,
    /// Cases that ran out of enabled transitions before the final marking.
    pub deadlocked: usize,
    /// Cases cut off at the step limit.
    pub truncated: usize,
    /// Of the above, how many were left out of the log entirely.
    pub discarded: usize,
    pub seed: u64,
    /// Extensive mode only: whether the search closed the model's language.
    pub language_exhausted: Option<bool>,
}

#[derive(Clone, Debug)]
pub struct Playout {
    pub columns: log::LogColumns,
    pub stats: Stats,
    /// Facts about the run a reader has to see for the numbers to mean what
    /// they look like — an unsound net, a net with no labels, a truncated
    /// language.
    pub warnings: Vec<String>,
}

/// Case arrival times: a Poisson process, i.e. exponential gaps.
fn arrivals(count: usize, rng: &mut Rng, options: &Options) -> Vec<i64> {
    let mut at = options.start_us;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        out.push(at);
        at += (rng.exponential(options.arrival_minutes) * 60_000_000.0).round() as i64;
    }
    out
}

/// Plays `net` out into a log under `options`.
///
/// Never fails: a net that cannot complete a single case produces an empty log
/// and a warning saying so, which is a finding about the model rather than an
/// error in the run. The caller decides what an empty log means to it.
pub fn play_out(net: &Net, options: &Options) -> Playout {
    let mut rng = Rng::new(options.seed);
    let mut warnings = net.warnings.clone();

    let (cases, exhausted) = match options.mode {
        Mode::Stochastic => {
            let arrivals = arrivals(options.traces, &mut rng, options);
            let cases = arrivals
                .into_iter()
                .map(|arrival_us| SimulatedCase {
                    case: simulate_case(net, arrival_us, &mut rng, options),
                    arrival_us,
                })
                .collect::<Vec<_>>();
            (cases, None)
        }
        Mode::Extensive => {
            let enumeration = extensive::enumerate(net, options);
            let arrivals = arrivals(enumeration.sequences.len(), &mut rng, options);
            let cases = enumeration
                .sequences
                .iter()
                .zip(arrivals)
                .map(|(sequence, arrival_us)| SimulatedCase {
                    case: log::time_sequence(net, sequence, arrival_us, &mut rng, options),
                    arrival_us,
                })
                .collect::<Vec<_>>();
            (cases, Some(enumeration.exhausted))
        }
    };

    let deadlocked = cases.iter().filter(|c| c.case.outcome == Outcome::Deadlock).count();
    let truncated = cases.iter().filter(|c| c.case.outcome == Outcome::Truncated).count();
    let kept: Vec<&SimulatedCase> = cases
        .iter()
        .filter(|c| options.incomplete == Incomplete::Keep || c.case.outcome == Outcome::Complete)
        .filter(|c| !c.case.executions.is_empty())
        .collect();
    let discarded = cases.len() - kept.len();

    let built = log::build(net, &kept, options);

    if deadlocked > 0 {
        warnings.push(format!(
            "{deadlocked} of {} cases reached a marking with nothing enabled before the final marking \
             — the net deadlocks. Run Check Soundness on it to see where.",
            cases.len()
        ));
    }
    if truncated > 0 {
        warnings.push(format!(
            "{truncated} of {} cases were still running at the {}-step limit; a loop the walk did not \
             leave, usually. Raise the step limit, or check the net for a livelock.",
            cases.len(),
            options.max_length
        ));
    }
    if discarded > 0 {
        warnings.push(format!(
            "{discarded} case(s) never completed and are not in the log, so it is shorter than asked for."
        ));
    }
    if exhausted == Some(false) {
        warnings.push(
            "the model's language is larger than the limits allowed, so this is some of what it can \
             produce rather than all of it — raise the trace-length or variant limit to see more."
                .into(),
        );
    }
    if built.stats.cases > 0 && built.stats.events == 0 {
        warnings.push(
            "every transition this net can fire is silent, so the cases are real but empty — \
             a log needs labelled transitions to record anything."
                .into(),
        );
    }
    if built.stats.cases == 0 {
        warnings.push(
            "no case completed, so the log is empty. A net that never reaches its final marking \
             cannot be played out."
                .into(),
        );
    }

    let stats = Stats {
        mode: match options.mode {
            Mode::Stochastic => "stochastic".into(),
            Mode::Extensive => "extensive".into(),
        },
        seed: options.seed,
        deadlocked,
        truncated,
        discarded,
        language_exhausted: exhausted,
        ..built.stats
    };

    Playout { columns: built.columns, stats, warnings }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soundness_core::testing::{build, fixtures};

    #[test]
    fn a_sequence_gives_one_variant_and_one_event_per_activity() {
        let log = play_out(&fixtures::sequence(), &Options { traces: 20, ..Options::default() });
        assert_eq!(log.stats.cases, 20);
        assert_eq!(log.stats.events, 40);
        assert_eq!(log.stats.variants, 1);
        assert_eq!(log.stats.activities, 2);
        assert!(log.warnings.is_empty(), "{:?}", log.warnings);
    }

    #[test]
    fn the_same_seed_gives_the_same_log() {
        let options = Options { traces: 30, resources: 4, ..Options::default() };
        let a = play_out(&fixtures::parallel(), &options);
        let b = play_out(&fixtures::parallel(), &options);
        let c = play_out(&fixtures::parallel(), &Options { seed: 99, ..options.clone() });
        assert_eq!(a.columns, b.columns);
        assert_ne!(a.columns, c.columns, "a different seed is a different sample");
    }

    #[test]
    fn a_deadlocking_net_reports_it_instead_of_writing_broken_cases() {
        let log = play_out(&fixtures::xor_split_and_join(), &Options { traces: 10, ..Options::default() });
        assert_eq!(log.stats.deadlocked, 10);
        assert_eq!(log.stats.cases, 0);
        assert!(log.warnings.iter().any(|w| w.contains("deadlocks")));
        assert!(log.warnings.iter().any(|w| w.contains("log is empty")));
    }

    #[test]
    fn incomplete_cases_can_be_kept_on_purpose() {
        let options = Options { traces: 10, incomplete: Incomplete::Keep, ..Options::default() };
        let log = play_out(&fixtures::xor_split_and_join(), &options);
        assert_eq!(log.stats.cases, 10, "the prefixes are the log now");
        assert_eq!(log.stats.discarded, 0);
        assert!(log.warnings.iter().any(|w| w.contains("deadlocks")));
    }

    #[test]
    fn extensive_mode_writes_one_case_per_distinct_trace() {
        let options = Options { mode: Mode::Extensive, ..Options::default() };
        let log = play_out(&fixtures::parallel(), &options);
        assert_eq!(log.stats.cases, 2, "A,B and B,A");
        assert_eq!(log.stats.variants, 2);
        assert_eq!(log.stats.language_exhausted, Some(true));
    }

    #[test]
    fn an_unexhausted_language_is_declared_rather_than_passed_off_as_complete() {
        let net = build(3, &[("A", &[0], &[1]), ("back", &[1], &[0]), ("B", &[1], &[2])], &[0], &[2]);
        let log = play_out(&net, &Options { mode: Mode::Extensive, max_length: 6, ..Options::default() });
        assert_eq!(log.stats.language_exhausted, Some(false));
        assert!(log.warnings.iter().any(|w| w.contains("larger than the limits")));
    }

    #[test]
    fn a_nets_own_warnings_reach_the_log() {
        // The Alpha Miner shape: no label table, so names fall back to ids —
        // `normalize` records that, and a log named `#0`, `#1` is exactly the
        // kind of surprise the user has to be told about rather than discover.
        let raw: soundness_core::RawNet = serde_json::from_str(
            r#"{"places":[0,1],"activities":[7],"place_to_transition":[[0,7]],
                "transition_to_place":[[7,1]],"initial_marking":[0],"final_marking":[1]}"#,
        )
        .unwrap();
        let net = soundness_core::normalize(raw);
        let log = play_out(&net, &Options { traces: 3, ..Options::default() });
        assert!(log.warnings.iter().any(|w| w.contains("named by id")));
        assert_eq!(log.columns.events.activity[0], "#7");
    }
}
