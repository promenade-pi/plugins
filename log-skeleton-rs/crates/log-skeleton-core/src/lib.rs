//! Log skeletons: discovery and conformance.
//!
//! > Verbeek, H.M.W. & de Carvalho, R.M. (2018). *Log skeletons: a
//! > classification approach to process discovery.* arXiv:1806.08247.
//!
//! A log skeleton is not a model you can walk through. It is the list of facts
//! that held in every trace of a log — which activities always follow which,
//! which never co-occur, which occur equally often, and how many times each may
//! occur — and its purpose is to answer one question about a *new* trace: does
//! it break any of them? The paper entered it in the Process Discovery Contest
//! on exactly that basis, and it won by classifying rather than by modelling.
//!
//! Pure Rust: no wasm, no host types. `../../src/lib.rs` is the thin kernel
//! that feeds this the event stream and serialises the skeleton back.

pub mod conformance;
pub mod counters;
pub mod relations;

/// The trace index every relation is evaluated against, re-exported so the
/// kernel depends on this crate alone — the DECLARE plugin's crate is an
/// implementation detail of the relations, not part of this one's contract.
pub use declare_core::TraceIndex;

use counters::Counters;
use relations::{Relation, ALL};
use serde::Serialize;

#[derive(Clone, Debug)]
pub struct Options {
    /// Relations to look for at all.
    pub relations: Vec<Relation>,
    /// Record how many times each activity may occur.
    pub counts: bool,
    /// The share of traces a constraint may be broken in and still be kept.
    /// 0 means "held in every single trace", which is the paper's own setting.
    pub noise: f64,
    /// Cap on the number of pair constraints, applied after ranking.
    pub limit: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self { relations: ALL.to_vec(), counts: true, noise: 0.0, limit: 2_000 }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Constraint {
    /// The relation's wire name, e.g. `alwaysAfter`.
    pub relation: String,
    pub activities: Vec<String>,
    /// The rule in words, with the activity names filled in.
    pub sentence: String,
    /// The share of traces it held in.
    pub support: f64,
    /// Traces it did not hold in — zero unless a noise threshold was allowed.
    pub violations: u32,
}

/// How often one activity may occur in a case.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityCounts {
    pub activity: String,
    /// The occurrence counts this activity was seen with, ascending.
    pub counts: Vec<u32>,
    /// Traces whose count is in the list.
    pub covered: u32,
    /// Traces whose count was dropped as noise.
    pub dropped: u32,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub constraints: usize,
    pub candidates: usize,
    pub activities: usize,
    pub traces: u32,
    pub events: f64,
    pub noise: f64,
    pub equivalence: usize,
    pub always_before: usize,
    pub always_after: usize,
    pub never_together: usize,
    pub directly_follows: usize,
    /// Constraints left out because the model hit its size cap.
    pub dropped: usize,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skeleton {
    pub activities: Vec<String>,
    pub constraints: Vec<Constraint>,
    pub counts: Vec<ActivityCounts>,
    pub stats: Stats,
}

fn sentence_for(relation: Relation, activities: &[String]) -> String {
    relation
        .sentence()
        .replace("{a}", &format!("“{}”", activities[0]))
        .replace("{b}", &format!("“{}”", activities[1]))
}

/// Which occurrence counts to keep for one activity.
///
/// With no noise allowed, every count ever seen is part of the skeleton — that
/// is what makes it a classifier: a trace with a count nobody ever had is
/// rejected. A noise threshold drops the rarest counts first, until dropping
/// another would exceed it, so a single freak case does not widen the model.
fn allowed_counts(mut frequencies: Vec<(u32, u32)>, traces: u32, noise: f64) -> (Vec<u32>, u32, u32) {
    frequencies.sort_by_key(|&(count, seen)| (std::cmp::Reverse(seen), count));
    let budget = (noise * traces as f64).floor() as u32;
    let mut dropped = 0;
    let mut kept: Vec<u32> = Vec::new();
    // Rarest last: walk from the most frequent and stop dropping when the
    // budget would be exceeded.
    for (index, &(count, seen)) in frequencies.iter().enumerate().rev() {
        if index > 0 && dropped + seen <= budget {
            dropped += seen;
        } else {
            kept.push(count);
        }
    }
    kept.sort_unstable();
    (kept, traces - dropped, dropped)
}

pub fn discover(counters: &Counters, names: &[String], options: &Options) -> Skeleton {
    let n = counters.n.min(names.len());
    let budget = (options.noise * counters.traces as f64).floor() as u32;
    let mut constraints: Vec<(Relation, u32, u32, counters::Assessment)> = Vec::new();
    let mut candidates = 0usize;

    for &relation in &options.relations {
        // Equivalence and never-together say the same thing about `(b, a)` as
        // about `(a, b)`, so only one of the two orders is a candidate. The
        // asymmetric relations need both.
        let symmetric = matches!(relation, Relation::Equivalence | Relation::NeverTogether);
        for a in 0..n as u32 {
            for b in 0..n as u32 {
                if a == b || (symmetric && b < a) {
                    continue;
                }
                candidates += 1;
                let assessment = counters.assess(relation, a, b);
                if assessment.violated <= budget {
                    constraints.push((relation, a, b, assessment));
                }
            }
        }
    }

    // Strongest first, so the size cap cuts the tail.
    constraints.sort_by(|left, right| {
        left.3
            .violated
            .cmp(&right.3.violated)
            .then(left.0.cmp(&right.0))
            .then((left.1, left.2).cmp(&(right.1, right.2)))
    });
    let dropped = constraints.len().saturating_sub(options.limit);
    constraints.truncate(options.limit);

    let counted = |relation: Relation| {
        constraints.iter().filter(|(r, _, _, _)| *r == relation).count()
    };
    let stats = Stats {
        constraints: constraints.len(),
        candidates,
        activities: n,
        traces: counters.traces,
        events: counters.events as f64,
        noise: options.noise,
        equivalence: counted(Relation::Equivalence),
        always_before: counted(Relation::AlwaysBefore),
        always_after: counted(Relation::AlwaysAfter),
        never_together: counted(Relation::NeverTogether),
        directly_follows: counted(Relation::DirectlyFollows),
        dropped,
    };

    let counts = if options.counts {
        (0..n as u32)
            .map(|a| {
                let (counts, covered, dropped) =
                    allowed_counts(counters.frequencies(a), counters.traces, options.noise);
                ActivityCounts { activity: names[a as usize].clone(), counts, covered, dropped }
            })
            .collect()
    } else {
        Vec::new()
    };

    Skeleton {
        activities: names[..n].to_vec(),
        constraints: constraints
            .into_iter()
            .map(|(relation, a, b, assessment)| {
                let activities =
                    vec![names[a as usize].clone(), names[b as usize].clone()];
                Constraint {
                    relation: relation.id().to_string(),
                    sentence: sentence_for(relation, &activities),
                    activities,
                    support: assessment.support(),
                    violations: assessment.violated,
                }
            })
            .collect(),
        counts,
        stats,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use declare_core::TraceIndex;

    fn names(n: usize) -> Vec<String> {
        (0..n).map(|i| ((b'a' + i as u8) as char).to_string()).collect()
    }

    fn skeleton_of(traces: &[&str], options: Options) -> Skeleton {
        let mut counters = Counters::new(5);
        let mut index = TraceIndex::new(5);
        for trace in traces {
            index.reset();
            for letter in trace.chars() {
                index.push(letter as u32 - 'a' as u32);
            }
            counters.observe(&index);
        }
        discover(&counters, &names(5), &options)
    }

    fn has(skeleton: &Skeleton, relation: &str, activities: &[&str]) -> bool {
        skeleton.constraints.iter().any(|c| {
            c.relation == relation
                && c.activities.iter().map(String::as_str).eq(activities.iter().copied())
        })
    }

    #[test]
    fn a_log_of_one_shape_yields_the_facts_of_that_shape() {
        let skeleton = skeleton_of(&["abc", "abc", "abc"], Options::default());
        assert!(has(&skeleton, "alwaysAfter", &["a", "b"]), "a is always followed by b");
        assert!(has(&skeleton, "alwaysBefore", &["b", "a"]), "b never happens before a");
        assert!(has(&skeleton, "directlyFollows", &["a", "b"]));
        assert!(has(&skeleton, "equivalence", &["a", "b"]), "one of each, every time");
        assert!(!has(&skeleton, "neverTogether", &["a", "b"]));
    }

    #[test]
    fn a_symmetric_relation_is_reported_once() {
        let skeleton = skeleton_of(&["ab", "ab"], Options::default());
        assert!(has(&skeleton, "equivalence", &["a", "b"]));
        assert!(!has(&skeleton, "equivalence", &["b", "a"]), "the same fact, the other way round");
    }

    #[test]
    fn activities_that_never_meet_are_never_together() {
        let skeleton = skeleton_of(&["a", "b", "a", "b"], Options::default());
        assert!(has(&skeleton, "neverTogether", &["a", "b"]));
        assert!(!has(&skeleton, "equivalence", &["a", "b"]), "one has 1 and the other 0");
    }

    #[test]
    fn the_counts_are_every_number_of_occurrences_seen() {
        let skeleton = skeleton_of(&["a", "aa", "b"], Options::default());
        let a = skeleton.counts.iter().find(|c| c.activity == "a").unwrap();
        assert_eq!(a.counts, vec![0, 1, 2]);
        assert_eq!(a.dropped, 0);
        let c = skeleton.counts.iter().find(|c| c.activity == "c").unwrap();
        assert_eq!(c.counts, vec![0], "an activity this log never records happens zero times");
    }

    #[test]
    fn noise_lets_a_rule_through_that_one_trace_breaks() {
        let traces = ["ab", "ab", "ab", "ba"];
        let strict = skeleton_of(&traces, Options::default());
        assert!(!has(&strict, "alwaysAfter", &["a", "b"]));

        let lenient = skeleton_of(&traces, Options { noise: 0.25, ..Options::default() });
        assert!(has(&lenient, "alwaysAfter", &["a", "b"]));
        let rule = lenient.constraints.iter().find(|c| c.relation == "alwaysAfter" && c.activities[0] == "a").unwrap();
        assert_eq!(rule.violations, 1);
        assert!((rule.support - 0.75).abs() < 1e-9);
    }

    #[test]
    fn noise_drops_the_rarest_counts_first() {
        // Nine traces with one `a`, one with five.
        let mut traces = vec!["a"; 9];
        traces.push("aaaaa");
        let strict = skeleton_of(&traces, Options::default());
        assert_eq!(strict.counts.iter().find(|c| c.activity == "a").unwrap().counts, vec![1, 5]);

        let lenient = skeleton_of(&traces, Options { noise: 0.1, ..Options::default() });
        let a = lenient.counts.iter().find(|c| c.activity == "a").unwrap();
        assert_eq!(a.counts, vec![1], "the freak case is the noise");
        assert_eq!(a.dropped, 1);
    }

    #[test]
    fn a_relation_that_was_switched_off_contributes_nothing() {
        let options = Options { relations: vec![Relation::AlwaysAfter], ..Options::default() };
        let skeleton = skeleton_of(&["abc", "abc"], options);
        assert!(skeleton.constraints.iter().all(|c| c.relation == "alwaysAfter"));
        assert_eq!(skeleton.stats.equivalence, 0);
        assert!(skeleton.stats.always_after > 0);
    }

    #[test]
    fn the_sentence_is_the_rule_with_the_names_filled_in() {
        let skeleton = skeleton_of(&["ab", "ab"], Options::default());
        let rule = skeleton.constraints.iter().find(|c| c.relation == "directlyFollows").unwrap();
        assert_eq!(rule.sentence, "“a” is always immediately followed by “b”");
    }
}
