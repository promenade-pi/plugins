//! Classifying traces against a skeleton.
//!
//! This is what a log skeleton is *for*. The paper's contribution is not a
//! prettier model but a decision procedure: a trace either breaks one of the
//! recorded facts or it does not, and the answer comes with the list of facts
//! it broke. No alignment, no cost function, no search.
//!
//! The occurrence counts are checked alongside the pair relations, and they are
//! the part with the most classifying power: a trace that does something the
//! right number of times but in a novel order breaks an ordering rule, and one
//! that does something an unheard-of number of times breaks a count — the two
//! catch different things.

use crate::relations::Relation;
use declare_core::TraceIndex;
use serde::{Deserialize, Serialize};

/// A skeleton as it arrives from an artifact: the fields a checker needs.
/// Deliberately tolerant — a skeleton written by hand or by another tool
/// carries whatever else it likes.
#[derive(Clone, Debug, Deserialize)]
pub struct SkeletonSpec {
    #[serde(default)]
    pub activities: Vec<String>,
    #[serde(default)]
    pub constraints: Vec<ConstraintSpec>,
    #[serde(default)]
    pub counts: Vec<CountsSpec>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ConstraintSpec {
    pub relation: String,
    #[serde(default)]
    pub activities: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CountsSpec {
    pub activity: String,
    #[serde(default)]
    pub counts: Vec<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintResult {
    /// The relation's wire name, or `count` for an occurrence rule.
    pub relation: String,
    pub activities: Vec<String>,
    pub sentence: String,
    pub violations: u32,
    /// Violations as a share of all cases.
    pub violation_rate: f64,
    /// True when the rule mentions an activity this log never records.
    pub unknown_activity: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseResult {
    /// The log's own case index (`trace_idx`).
    pub case: i32,
    /// Indices into `constraints`.
    pub violated: Vec<u32>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub constraints: usize,
    pub traces: u32,
    /// Cases that broke nothing — the classifier's "fitting".
    pub fitting: u32,
    pub non_fitting: u32,
    /// Share of cases that fit.
    pub fitness: f64,
    pub violations: u32,
    pub events: f64,
    pub activities: usize,
    /// How many of the constraints are occurrence-count rules.
    pub count_rules: usize,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub constraints: Vec<ConstraintResult>,
    /// Non-fitting cases, worst first, capped by `max_cases`.
    pub cases: Vec<CaseResult>,
    /// Activities the skeleton names that this log never records.
    pub unknown_activities: Vec<String>,
    /// Activities in the log the skeleton says nothing about.
    pub unconstrained_activities: Vec<String>,
    /// Relation names this build does not implement, left unchecked.
    pub unknown_relations: Vec<String>,
    pub stats: Stats,
}

enum Rule {
    /// A pair relation, resolved against this log's alphabet.
    Pair { relation: Relation, a: Option<u32>, b: Option<u32> },
    /// "This activity occurs one of these many times."
    Count { activity: Option<u32>, allowed: Vec<u32> },
}

struct Resolved {
    rule: Rule,
    names: Vec<String>,
    sentence: String,
    unknown: bool,
    violations: u32,
}

pub struct Checker {
    resolved: Vec<Resolved>,
    unknown_activities: Vec<String>,
    mentioned: Vec<bool>,
    names: Vec<String>,
    traces: u32,
    events: u64,
    fitting: u32,
    violations: u32,
    cases: Vec<CaseResult>,
    max_cases: usize,
    pub unknown_relations: Vec<String>,
}

fn pair_sentence(relation: Relation, activities: &[String]) -> String {
    relation
        .sentence()
        .replace("{a}", &format!("“{}”", activities[0]))
        .replace("{b}", &format!("“{}”", activities[1]))
}

fn count_sentence(activity: &str, allowed: &[u32]) -> String {
    let numbers: Vec<String> = allowed.iter().map(u32::to_string).collect();
    format!("“{activity}” happens {} time(s) per case", numbers.join(" or "))
}

impl Checker {
    pub fn new(skeleton: &SkeletonSpec, names: &[String], max_cases: usize) -> Self {
        let id_of = |name: &str| names.iter().position(|n| n == name).map(|i| i as u32);
        let mut unknown_activities: Vec<String> = Vec::new();
        let mut mentioned = vec![false; names.len()];
        let mut unknown_relations = Vec::new();
        let mut resolved = Vec::new();
        let note = |name: &String, id: Option<u32>, mentioned: &mut Vec<bool>, unknown: &mut Vec<String>| {
            match id {
                Some(id) => mentioned[id as usize] = true,
                None => {
                    if !unknown.contains(name) {
                        unknown.push(name.clone());
                    }
                }
            }
        };

        for constraint in &skeleton.constraints {
            let Some(relation) = Relation::from_id(&constraint.relation) else {
                if !unknown_relations.contains(&constraint.relation) {
                    unknown_relations.push(constraint.relation.clone());
                }
                continue;
            };
            if constraint.activities.len() < 2 {
                continue; // a malformed rule names nothing to check
            }
            let ids: Vec<Option<u32>> = constraint.activities[..2].iter().map(|n| id_of(n)).collect();
            for (name, id) in constraint.activities[..2].iter().zip(&ids) {
                note(name, *id, &mut mentioned, &mut unknown_activities);
            }
            let names_of = constraint.activities[..2].to_vec();
            resolved.push(Resolved {
                sentence: pair_sentence(relation, &names_of),
                rule: Rule::Pair { relation, a: ids[0], b: ids[1] },
                unknown: ids.iter().any(Option::is_none),
                names: names_of,
                violations: 0,
            });
        }

        for counts in &skeleton.counts {
            let id = id_of(&counts.activity);
            note(&counts.activity, id, &mut mentioned, &mut unknown_activities);
            resolved.push(Resolved {
                sentence: count_sentence(&counts.activity, &counts.counts),
                rule: Rule::Count { activity: id, allowed: counts.counts.clone() },
                unknown: id.is_none(),
                names: vec![counts.activity.clone()],
                violations: 0,
            });
        }

        Self {
            resolved,
            unknown_activities,
            mentioned,
            names: names.to_vec(),
            traces: 0,
            events: 0,
            fitting: 0,
            violations: 0,
            cases: Vec::new(),
            max_cases,
            unknown_relations,
        }
    }

    pub fn observe(&mut self, trace: &TraceIndex, case: i32) {
        self.traces += 1;
        self.events += trace.len() as u64;

        let mut violated: Vec<u32> = Vec::new();
        for (index, constraint) in self.resolved.iter_mut().enumerate() {
            let holds = match &constraint.rule {
                Rule::Pair { relation, a, b } => {
                    let has = |x: &Option<u32>| x.is_some_and(|i| trace.contains(i));
                    match (has(a), has(b)) {
                        (true, true) => {
                            relation.holds_when_both_present(trace, a.unwrap(), b.unwrap())
                        }
                        (true, false) => relation.holds_with_one_missing(true),
                        (false, true) => relation.holds_with_one_missing(false),
                        (false, false) => true,
                    }
                }
                // An activity the log never records occurs zero times, which is
                // a real answer: a skeleton that never allows zero rejects it.
                Rule::Count { activity, allowed } => {
                    let seen = activity.map_or(0, |a| trace.count(a) as u32);
                    allowed.contains(&seen)
                }
            };
            if !holds {
                constraint.violations += 1;
                violated.push(index as u32);
            }
        }

        if violated.is_empty() {
            self.fitting += 1;
            return;
        }
        self.violations += violated.len() as u32;
        let entry = CaseResult { case, violated };
        let at = self
            .cases
            .iter()
            .position(|c| c.violated.len() < entry.violated.len())
            .unwrap_or(self.cases.len());
        if at < self.max_cases {
            self.cases.insert(at, entry);
            self.cases.truncate(self.max_cases);
        }
    }

    pub fn finish(self) -> Diagnostics {
        let constraints: Vec<ConstraintResult> = self
            .resolved
            .iter()
            .map(|c| ConstraintResult {
                relation: match &c.rule {
                    Rule::Pair { relation, .. } => relation.id().to_string(),
                    Rule::Count { .. } => "count".to_string(),
                },
                activities: c.names.clone(),
                sentence: c.sentence.clone(),
                violations: c.violations,
                violation_rate: if self.traces == 0 {
                    0.0
                } else {
                    c.violations as f64 / self.traces as f64
                },
                unknown_activity: c.unknown,
            })
            .collect();

        let count_rules = self
            .resolved
            .iter()
            .filter(|c| matches!(c.rule, Rule::Count { .. }))
            .count();
        let unconstrained: Vec<String> = self
            .names
            .iter()
            .enumerate()
            .filter(|(i, _)| !self.mentioned[*i])
            .map(|(_, name)| name.clone())
            .collect();

        Diagnostics {
            stats: Stats {
                constraints: constraints.len(),
                traces: self.traces,
                fitting: self.fitting,
                non_fitting: self.traces - self.fitting,
                fitness: if self.traces == 0 { 0.0 } else { self.fitting as f64 / self.traces as f64 },
                violations: self.violations,
                events: self.events as f64,
                activities: self.names.len(),
                count_rules,
            },
            constraints,
            cases: self.cases,
            unknown_activities: self.unknown_activities,
            unconstrained_activities: unconstrained,
            unknown_relations: self.unknown_relations,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names() -> Vec<String> {
        vec!["a".into(), "b".into(), "c".into()]
    }

    fn spec(constraints: &[(&str, &[&str])], counts: &[(&str, &[u32])]) -> SkeletonSpec {
        SkeletonSpec {
            activities: names(),
            constraints: constraints
                .iter()
                .map(|(relation, activities)| ConstraintSpec {
                    relation: (*relation).into(),
                    activities: activities.iter().map(|s| (*s).into()).collect(),
                })
                .collect(),
            counts: counts
                .iter()
                .map(|(activity, allowed)| CountsSpec {
                    activity: (*activity).into(),
                    counts: allowed.to_vec(),
                })
                .collect(),
        }
    }

    fn check(skeleton: &SkeletonSpec, traces: &[&str]) -> Diagnostics {
        let mut checker = Checker::new(skeleton, &names(), 10);
        let mut index = TraceIndex::new(3);
        for (i, trace) in traces.iter().enumerate() {
            index.reset();
            for letter in trace.chars() {
                index.push(letter as u32 - 'a' as u32);
            }
            checker.observe(&index, i as i32);
        }
        checker.finish()
    }

    #[test]
    fn a_log_that_obeys_the_skeleton_fits_completely() {
        let diagnostics = check(&spec(&[("alwaysAfter", &["a", "b"])], &[("a", &[1])]), &["ab", "ab"]);
        assert_eq!(diagnostics.stats.fitness, 1.0);
        assert_eq!(diagnostics.stats.non_fitting, 0);
        assert!(diagnostics.cases.is_empty());
    }

    #[test]
    fn a_broken_order_and_a_broken_count_are_both_caught() {
        let skeleton = spec(&[("alwaysAfter", &["a", "b"])], &[("a", &[1])]);
        let diagnostics = check(&skeleton, &["ab", "ba", "aab"]);
        assert_eq!(diagnostics.stats.non_fitting, 2, "the reversed one and the doubled one");
        let order = &diagnostics.constraints[0];
        let count = &diagnostics.constraints[1];
        assert_eq!(order.violations, 1, "ba has no b after the a");
        assert_eq!(count.violations, 1, "aab has two a's");
        assert_eq!(count.relation, "count");
        assert!(count.sentence.contains("1 time(s)"));
    }

    #[test]
    fn the_worst_cases_come_first() {
        let skeleton = spec(&[("alwaysAfter", &["a", "b"])], &[("a", &[1])]);
        let diagnostics = check(&skeleton, &["ab", "aa"]);
        assert_eq!(diagnostics.cases[0].case, 1);
        assert_eq!(diagnostics.cases[0].violated.len(), 2, "wrong order *and* wrong count");
    }

    #[test]
    fn an_activity_this_log_never_records_is_named_rather_than_ignored() {
        let diagnostics = check(&spec(&[("alwaysAfter", &["a", "z"])], &[]), &["ab", "ab"]);
        assert_eq!(diagnostics.unknown_activities, vec!["z".to_string()]);
        assert!(diagnostics.constraints[0].unknown_activity);
        assert_eq!(diagnostics.constraints[0].violations, 2);
    }

    #[test]
    fn a_count_rule_that_never_allows_zero_rejects_a_log_without_the_activity() {
        let diagnostics = check(&spec(&[], &[("c", &[1])]), &["ab", "ab"]);
        assert_eq!(diagnostics.stats.fitness, 0.0);
        assert_eq!(diagnostics.constraints[0].violations, 2);
    }

    #[test]
    fn a_relation_this_build_does_not_know_is_kept_out_and_named() {
        let skeleton = spec(&[("alwaysAfter", &["a", "b"]), ("telepathy", &["a", "b"])], &[]);
        let diagnostics = check(&skeleton, &["ab"]);
        assert_eq!(diagnostics.unknown_relations, vec!["telepathy".to_string()]);
        assert_eq!(diagnostics.constraints.len(), 1);
    }

    #[test]
    fn an_activity_no_rule_mentions_is_reported() {
        let diagnostics = check(&spec(&[("alwaysAfter", &["a", "b"])], &[]), &["abc"]);
        assert_eq!(diagnostics.unconstrained_activities, vec!["c".to_string()]);
    }
}
