//! Checking a declarative model against a log.
//!
//! The counterpart of alignment-based conformance, and a much simpler
//! question: a declarative model is a list of rules, so conformance is a list
//! of which rules each case broke. There is no search, no cost function and
//! nothing to optimise — which is exactly the appeal. When a case is
//! non-conforming, the answer is a sentence ("every claim must be assessed
//! before it is paid, and case 4118 paid first"), not a distance.
//!
//! Two asymmetries are worth stating, because both are places where a checker
//! could quietly mislead:
//!
//! - **An activity the model names but the log never records** is treated as
//!   an activity that did not occur, which is what it is. That makes rules
//!   about it violated (if they demand it) or vacuously satisfied (if they
//!   forbid it), and both are reported rather than hidden — the activity is
//!   named in `unknownActivities` so the reader can tell a genuine violation
//!   from a log that does not speak the model's language.
//! - **A rule a case never activates is not a pass.** It is counted separately
//!   (`activations`), because a model whose rules never trigger describes
//!   nothing, and a conformance report that scored that 100% would be worse
//!   than useless.

use crate::templates::Template;
use crate::trace::TraceIndex;
use serde::{Deserialize, Serialize};

/// A model as it arrives from an artifact: the fields a checker needs, and
/// nothing else. Deserialize-only, and deliberately tolerant — a model written
/// by hand or by another tool carries whatever else it likes.
#[derive(Clone, Debug, Deserialize)]
pub struct ModelSpec {
    #[serde(default)]
    pub activities: Vec<String>,
    #[serde(default)]
    pub constraints: Vec<ConstraintSpec>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ConstraintSpec {
    pub template: String,
    #[serde(default)]
    pub activities: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintResult {
    pub template: String,
    pub activities: Vec<String>,
    pub sentence: String,
    /// Cases in which the rule could have been broken.
    pub activations: u32,
    /// Cases in which it was.
    pub violations: u32,
    /// Violations as a share of activations; 0 for a rule never activated.
    pub violation_rate: f64,
    /// True when the rule mentions an activity this log never records.
    pub unknown_activity: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseResult {
    /// The log's own case index (`trace_idx`), which is what the host's tables
    /// key cases by.
    pub case: i32,
    /// Indices into `constraints`.
    pub violated: Vec<u32>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub constraints: usize,
    pub traces: u32,
    /// Cases that broke no rule at all.
    pub conforming: u32,
    pub violating: u32,
    /// Share of cases that broke no rule.
    pub conformance: f64,
    /// Total rule violations across all cases.
    pub violations: u32,
    pub events: f64,
    pub activities: usize,
    /// Rules that were never once activated — a model that says nothing about
    /// this log says so here.
    pub inactive_constraints: usize,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub constraints: Vec<ConstraintResult>,
    /// Violating cases, worst first, capped by `max_cases`.
    pub cases: Vec<CaseResult>,
    /// Activities the model names that this log never records.
    pub unknown_activities: Vec<String>,
    /// Activities in the log the model says nothing about.
    pub unconstrained_activities: Vec<String>,
    /// Constraint types the model uses that this build does not implement —
    /// a model from another tool with a template Promenade has no semantics
    /// for. Left out of the check rather than guessed at.
    pub unknown_templates: Vec<String>,
    pub stats: Stats,
}

/// One constraint resolved against this log's alphabet.
struct Resolved {
    template: Template,
    a: Option<u32>,
    b: Option<u32>,
    names: Vec<String>,
    unknown: bool,
    activations: u32,
    violations: u32,
}

pub struct Checker {
    resolved: Vec<Resolved>,
    unknown_activities: Vec<String>,
    mentioned: Vec<bool>,
    names: Vec<String>,
    traces: u32,
    events: u64,
    conforming: u32,
    violations: u32,
    /// Violating cases, in the order seen, kept up to the cap.
    cases: Vec<CaseResult>,
    max_cases: usize,
    /// Constraints the model lists that this build does not know.
    pub unknown_templates: Vec<String>,
}

impl Checker {
    /// `names` is the log's alphabet, in the host's id order.
    pub fn new(model: &ModelSpec, names: &[String], max_cases: usize) -> Self {
        let id_of = |name: &str| names.iter().position(|n| n == name).map(|i| i as u32);
        let mut unknown_activities: Vec<String> = Vec::new();
        let mut mentioned = vec![false; names.len()];
        let mut unknown_templates = Vec::new();
        let mut resolved = Vec::new();

        for constraint in &model.constraints {
            let Some(template) = Template::from_id(&constraint.template) else {
                if !unknown_templates.contains(&constraint.template) {
                    unknown_templates.push(constraint.template.clone());
                }
                continue;
            };
            let wanted = if template.is_binary() { 2 } else { 1 };
            if constraint.activities.len() < wanted {
                continue; // a malformed rule names nothing to check
            }
            let ids: Vec<Option<u32>> =
                constraint.activities[..wanted].iter().map(|n| id_of(n)).collect();
            for (name, id) in constraint.activities[..wanted].iter().zip(&ids) {
                match id {
                    Some(id) => mentioned[*id as usize] = true,
                    None => {
                        if !unknown_activities.contains(name) {
                            unknown_activities.push(name.clone());
                        }
                    }
                }
            }
            resolved.push(Resolved {
                template,
                a: ids[0],
                b: ids.get(1).copied().flatten(),
                names: constraint.activities[..wanted].to_vec(),
                unknown: ids.iter().any(Option::is_none),
                activations: 0,
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
            conforming: 0,
            violations: 0,
            cases: Vec::new(),
            max_cases,
            unknown_templates,
        }
    }

    pub fn observe(&mut self, trace: &TraceIndex, case: i32) {
        self.traces += 1;
        self.events += trace.len() as u64;

        let mut violated: Vec<u32> = Vec::new();
        for (index, constraint) in self.resolved.iter_mut().enumerate() {
            if trace.activates(constraint.template, constraint.a, constraint.b) {
                constraint.activations += 1;
            }
            if !trace.holds(constraint.template, constraint.a, constraint.b) {
                constraint.violations += 1;
                violated.push(index as u32);
            }
        }

        if violated.is_empty() {
            self.conforming += 1;
            return;
        }
        self.violations += violated.len() as u32;
        // The worst cases are the interesting ones, so the sample is the ones
        // that broke the most rules rather than the ones that happened to be
        // scanned first. Kept by insertion into a bounded list: a log has far
        // more cases than the cap, and sorting them all afterwards would mean
        // holding every case's result in memory to show a hundred.
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
                template: c.template.id().to_string(),
                sentence: sentence_for(c.template, &c.names),
                activities: c.names.clone(),
                activations: c.activations,
                violations: c.violations,
                violation_rate: if c.activations == 0 {
                    0.0
                } else {
                    c.violations as f64 / c.activations as f64
                },
                unknown_activity: c.unknown,
            })
            .collect();

        let inactive = constraints.iter().filter(|c| c.activations == 0).count();
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
                conforming: self.conforming,
                violating: self.traces - self.conforming,
                conformance: if self.traces == 0 {
                    0.0
                } else {
                    self.conforming as f64 / self.traces as f64
                },
                violations: self.violations,
                events: self.events as f64,
                activities: self.names.len(),
                inactive_constraints: inactive,
            },
            constraints,
            cases: self.cases,
            unknown_activities: self.unknown_activities,
            unconstrained_activities: unconstrained,
            unknown_templates: self.unknown_templates,
        }
    }
}

fn sentence_for(template: Template, activities: &[String]) -> String {
    let mut text = template.sentence().replace("{a}", &format!("“{}”", activities[0]));
    if let Some(b) = activities.get(1) {
        text = text.replace("{b}", &format!("“{b}”"));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names() -> Vec<String> {
        vec!["a".into(), "b".into(), "c".into()]
    }

    fn model(constraints: &[(&str, &[&str])]) -> ModelSpec {
        ModelSpec {
            activities: names(),
            constraints: constraints
                .iter()
                .map(|(template, activities)| ConstraintSpec {
                    template: (*template).into(),
                    activities: activities.iter().map(|s| (*s).into()).collect(),
                })
                .collect(),
        }
    }

    fn check(model: &ModelSpec, traces: &[&str]) -> Diagnostics {
        let mut checker = Checker::new(model, &names(), 10);
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
    fn a_conforming_log_breaks_nothing() {
        let diagnostics = check(&model(&[("response", &["a", "b"])]), &["ab", "acb", "c"]);
        assert_eq!(diagnostics.stats.violating, 0);
        assert_eq!(diagnostics.stats.conformance, 1.0);
        assert_eq!(diagnostics.constraints[0].activations, 2, "only the traces with an a");
        assert!(diagnostics.cases.is_empty());
    }

    #[test]
    fn a_violation_names_the_case_and_the_rule() {
        let diagnostics = check(&model(&[("response", &["a", "b"]), ("init", &["a"])]), &["ab", "ba", "a"]);
        assert_eq!(diagnostics.stats.violating, 2, "case 1 (b first) and case 2 (a unanswered)");
        assert_eq!(diagnostics.constraints[0].violations, 2, "b-then-a, and an a with no b at all");
        assert_eq!(diagnostics.constraints[1].violations, 1, "one trace does not start with a");
        let worst = &diagnostics.cases[0];
        assert!(worst.violated.len() >= 1);
        assert!(diagnostics.cases.iter().any(|c| c.case == 1));
        assert!(diagnostics.cases.iter().any(|c| c.case == 2));
    }

    #[test]
    fn the_worst_cases_come_first() {
        // Case 1 breaks both rules; case 0 breaks one.
        let diagnostics = check(
            &model(&[("response", &["a", "b"]), ("end", &["b"])]),
            &["ab", "a", "ab"],
        );
        assert_eq!(diagnostics.cases[0].case, 1);
        assert_eq!(diagnostics.cases[0].violated.len(), 2);
    }

    #[test]
    fn an_activity_the_log_never_records_is_named_rather_than_silently_failing() {
        let spec = model(&[("response", &["a", "z"])]);
        let diagnostics = check(&spec, &["ab", "ab"]);
        assert_eq!(diagnostics.unknown_activities, vec!["z".to_string()]);
        assert!(diagnostics.constraints[0].unknown_activity);
        assert_eq!(diagnostics.constraints[0].violations, 2, "every a demands a z that cannot come");
    }

    #[test]
    fn a_rule_this_log_never_triggers_is_reported_as_inactive() {
        let diagnostics = check(&model(&[("response", &["c", "a"])]), &["ab", "ab"]);
        assert_eq!(diagnostics.constraints[0].activations, 0);
        assert_eq!(diagnostics.constraints[0].violations, 0);
        assert_eq!(diagnostics.stats.inactive_constraints, 1);
        assert_eq!(diagnostics.stats.conformance, 1.0, "vacuously");
    }

    #[test]
    fn an_activity_no_rule_mentions_is_reported_too() {
        let diagnostics = check(&model(&[("response", &["a", "b"])]), &["abc"]);
        assert_eq!(diagnostics.unconstrained_activities, vec!["c".to_string()]);
    }

    #[test]
    fn a_template_this_build_does_not_know_is_kept_out_and_named() {
        let spec = model(&[("response", &["a", "b"]), ("teleportation", &["a", "b"])]);
        let mut checker = Checker::new(&spec, &names(), 5);
        let mut index = TraceIndex::new(3);
        index.push(0);
        index.push(1);
        checker.observe(&index, 0);
        assert_eq!(checker.unknown_templates, vec!["teleportation".to_string()]);
        let diagnostics = checker.finish();
        assert_eq!(diagnostics.constraints.len(), 1);
    }
}
