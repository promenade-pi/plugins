//! Turning counters into a model: candidates, thresholds, pruning.
//!
//! Discovery here is the straightforward, honest version of Maggi, Bose and
//! van der Aalst's approach: enumerate every candidate the parameters allow,
//! measure it, keep the ones that clear both thresholds, and then remove the
//! ones that only repeat something stronger already in the model. There is no
//! clever search, because there is nothing to search — the measuring was done
//! in one pass over the log, and every candidate's numbers are already known.
//!
//! What the parameters are for is *reading*. A log of thirty activities offers
//! roughly sixteen thousand candidates; a model of sixteen thousand rules is
//! not a model. Support says how often a rule held, confidence how often it
//! held when it could have been broken, and pruning removes the rule that says
//! less than its neighbour. Those three between them are the difference
//! between a list and a description.

use crate::counters::{Assessment, Counters};
use crate::templates::{self, Family, Template};
use serde::Serialize;

#[derive(Clone, Debug)]
pub struct Options {
    /// Families to consider at all.
    pub families: Vec<Family>,
    /// Keep a constraint only if it holds in at least this share of traces.
    pub min_support: f64,
    /// ...and in at least this share of the traces that could have broken it.
    pub min_confidence: f64,
    /// Drop a constraint another kept constraint already implies.
    pub prune: bool,
    /// Hard cap on the model's size, applied after ranking.
    pub limit: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            families: vec![
                Family::Unary,
                Family::Relation,
                Family::Alternating,
                Family::Chain,
                Family::Negative,
            ],
            min_support: 0.9,
            min_confidence: 0.9,
            prune: true,
            limit: 1_000,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Constraint {
    /// The template's wire name, e.g. `chainResponse`.
    pub template: String,
    /// One name for a unary template, two for a binary one.
    pub activities: Vec<String>,
    /// The rule in words, with the activity names filled in — the model's own
    /// statement of what it means, not the view's.
    pub sentence: String,
    pub support: f64,
    pub confidence: f64,
    /// Traces in which the rule could have been broken.
    pub activations: u32,
    /// Traces in which it was.
    pub violations: u32,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub constraints: usize,
    pub candidates: usize,
    /// Constraints that cleared the thresholds but repeat a stronger rule.
    pub pruned: usize,
    /// Constraints left out because the model hit its size cap.
    pub dropped: usize,
    pub activities: usize,
    pub traces: u32,
    pub events: f64,
    pub min_support: f64,
    pub min_confidence: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub activities: Vec<String>,
    pub constraints: Vec<Constraint>,
    pub stats: Stats,
}

fn sentence_for(template: Template, activities: &[String]) -> String {
    let mut text = template.sentence().replace("{a}", &format!("“{}”", activities[0]));
    if let Some(b) = activities.get(1) {
        text = text.replace("{b}", &format!("“{b}”"));
    }
    text
}

/// A constraint with the ids it was measured on, kept alongside the public
/// form so pruning can compare candidates without parsing names back out.
struct Candidate {
    template: Template,
    a: u32,
    b: u32,
    assessment: Assessment,
}

pub fn discover(counters: &Counters, names: &[String], options: &Options) -> Model {
    let n = counters.n.min(names.len());
    let mut kept: Vec<Candidate> = Vec::new();
    let mut candidates = 0usize;

    for &template in templates::ALL.iter() {
        if !options.families.contains(&template.family()) {
            continue;
        }
        for a in 0..n as u32 {
            if template.is_binary() {
                for b in 0..n as u32 {
                    if a == b {
                        continue;
                    }
                    candidates += 1;
                    let assessment = counters.assess(template, a, b);
                    if assessment.support() >= options.min_support
                        && assessment.confidence() >= options.min_confidence
                    {
                        kept.push(Candidate { template, a, b, assessment });
                    }
                }
            } else {
                candidates += 1;
                let assessment = counters.assess(template, a, 0);
                if assessment.support() >= options.min_support
                    && assessment.confidence() >= options.min_confidence
                {
                    kept.push(Candidate { template, a, b: a, assessment });
                }
            }
        }
    }

    let before_pruning = kept.len();
    if options.prune {
        kept = prune(kept);
    }
    let pruned = before_pruning - kept.len();

    // Strongest first: a reader scanning the top of the list should meet the
    // rules that hold most reliably and say the most, and the size cap should
    // cut the tail rather than an arbitrary slice.
    kept.sort_by(|left, right| {
        right
            .assessment
            .confidence()
            .total_cmp(&left.assessment.confidence())
            .then(right.assessment.activated.cmp(&left.assessment.activated))
            .then(left.template.cmp(&right.template))
            .then((left.a, left.b).cmp(&(right.a, right.b)))
    });
    let dropped = kept.len().saturating_sub(options.limit);
    kept.truncate(options.limit);

    let constraints: Vec<Constraint> = kept
        .iter()
        .map(|candidate| {
            let activities = if candidate.template.is_binary() {
                vec![names[candidate.a as usize].clone(), names[candidate.b as usize].clone()]
            } else {
                vec![names[candidate.a as usize].clone()]
            };
            Constraint {
                template: candidate.template.id().to_string(),
                sentence: sentence_for(candidate.template, &activities),
                activities,
                support: candidate.assessment.support(),
                confidence: candidate.assessment.confidence(),
                activations: candidate.assessment.activated,
                violations: candidate.assessment.violated,
            }
        })
        .collect();

    Model {
        stats: Stats {
            constraints: constraints.len(),
            candidates,
            pruned,
            dropped,
            activities: n,
            traces: counters.traces,
            events: counters.events as f64,
            min_support: options.min_support,
            min_confidence: options.min_confidence,
        },
        activities: names[..n].to_vec(),
        constraints,
    }
}

/// Removes every constraint that another kept constraint already implies.
///
/// Implication is between templates over the *same* activities in the same
/// order (`templates::implies`), and it is transitive, so a candidate is
/// dropped when any kept candidate reaches it through one or more steps. The
/// stronger rule is the one that survives: `chainResponse(a, b)` says
/// everything `response(a, b)` does and more, so reporting both is reporting
/// the weaker one for nothing.
///
/// One rule is not a template relation and is applied here too: a
/// `precedence(b, a)` implies `respondedExistence(a, b)` — if every `a` has a
/// `b` before it then an `a` guarantees a `b`. It is the one cross-direction
/// implication in the set, and leaving it out leaves a redundant rule in every
/// model that has a precedence in it.
fn prune(candidates: Vec<Candidate>) -> Vec<Candidate> {
    let implied = |stronger: &Candidate, weaker: &Candidate| -> bool {
        if stronger.template == weaker.template {
            return false;
        }
        let same_pair = stronger.a == weaker.a && stronger.b == weaker.b;
        let swapped = stronger.a == weaker.b && stronger.b == weaker.a;
        if same_pair && reaches(stronger.template, weaker.template) {
            return true;
        }
        swapped
            && stronger.template == Template::Precedence
            && weaker.template == Template::RespondedExistence
    };

    let mut out = Vec::with_capacity(candidates.len());
    for (index, candidate) in candidates.iter().enumerate() {
        let redundant = candidates
            .iter()
            .enumerate()
            .any(|(other, stronger)| other != index && implied(stronger, candidate));
        if !redundant {
            out.push(Candidate {
                template: candidate.template,
                a: candidate.a,
                b: candidate.b,
                assessment: candidate.assessment,
            });
        }
    }
    out
}

/// Transitive closure of `templates::implies`, computed by walking: the
/// relation has eighteen members and a depth of three, so a search is cheaper
/// and clearer than a precomputed matrix.
fn reaches(stronger: Template, weaker: Template) -> bool {
    let mut frontier = vec![stronger];
    let mut seen = vec![stronger];
    while let Some(current) = frontier.pop() {
        for &next in templates::ALL.iter() {
            if templates::implies(current, next) && !seen.contains(&next) {
                if next == weaker {
                    return true;
                }
                seen.push(next);
                frontier.push(next);
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::TraceIndex;

    fn names(n: usize) -> Vec<String> {
        (0..n).map(|i| ((b'a' + i as u8) as char).to_string()).collect()
    }

    fn counters_for(traces: &[&str]) -> Counters {
        let mut counters = Counters::new(6);
        let mut index = TraceIndex::new(6);
        for trace in traces {
            index.reset();
            for letter in trace.chars() {
                index.push(letter as u32 - 'a' as u32);
            }
            counters.observe(&index);
        }
        counters
    }

    fn model_of(traces: &[&str], options: Options) -> Model {
        discover(&counters_for(traces), &names(6), &options)
    }

    fn has(model: &Model, template: &str, activities: &[&str]) -> bool {
        model.constraints.iter().any(|c| {
            c.template == template && c.activities.iter().map(String::as_str).eq(activities.iter().copied())
        })
    }

    #[test]
    fn a_log_where_a_is_always_followed_by_b_yields_a_response() {
        let model = model_of(&["ab", "acb", "ab"], Options { prune: false, ..Options::default() });
        assert!(has(&model, "response", &["a", "b"]));
        assert!(has(&model, "precedence", &["a", "b"]));
        assert!(has(&model, "succession", &["a", "b"]));
        assert!(!has(&model, "response", &["b", "a"]), "b is never followed by a");
    }

    #[test]
    fn pruning_keeps_the_strongest_statement_and_drops_what_it_implies() {
        // Every a is immediately followed by b, so every weaker ordering rule
        // over the same pair holds as well.
        let traces = ["ab", "abab", "ab"];
        let verbose = model_of(&traces, Options { prune: false, ..Options::default() });
        assert!(has(&verbose, "chainResponse", &["a", "b"]));
        assert!(has(&verbose, "response", &["a", "b"]));
        assert!(has(&verbose, "respondedExistence", &["a", "b"]));

        let pruned = model_of(&traces, Options::default());
        // Every a is immediately followed by b *and* every b immediately
        // preceded by a, so the one rule that survives is the strongest of
        // all of them.
        assert!(has(&pruned, "chainSuccession", &["a", "b"]));
        assert!(!has(&pruned, "chainResponse", &["a", "b"]), "implied by the chain succession");
        assert!(!has(&pruned, "response", &["a", "b"]), "implied by the chain response");
        assert!(!has(&pruned, "altResponse", &["a", "b"]));
        assert!(!has(&pruned, "respondedExistence", &["a", "b"]));
        assert!(pruned.stats.pruned > 0);
        assert!(pruned.constraints.len() < verbose.constraints.len());
    }

    #[test]
    fn a_precedence_makes_the_reverse_responded_existence_redundant() {
        // b only ever follows a, so "if b happens, a happens" adds nothing.
        // The doubled b keeps the alternating and chain rules out of it, so
        // the plain precedence is what survives pruning.
        let model = model_of(&["abb", "a", "abb"], Options::default());
        assert!(has(&model, "precedence", &["a", "b"]));
        assert!(!has(&model, "respondedExistence", &["b", "a"]));
    }

    #[test]
    fn a_family_that_was_switched_off_contributes_nothing() {
        let options = Options {
            families: vec![Family::Relation],
            prune: false,
            ..Options::default()
        };
        let model = model_of(&["ab", "ab"], options);
        assert!(model.constraints.iter().all(|c| {
            matches!(c.template.as_str(), "respondedExistence" | "response" | "precedence" | "succession")
        }), "{:?}", model.constraints.iter().map(|c| c.template.clone()).collect::<Vec<_>>());
        assert!(!has(&model, "existence", &["a"]));
    }

    #[test]
    fn the_thresholds_are_what_decides_membership() {
        // a is followed by b in three traces out of four.
        let traces = ["ab", "ab", "ab", "ba"];
        let strict = model_of(&traces, Options { min_support: 1.0, prune: false, ..Options::default() });
        assert!(!has(&strict, "response", &["a", "b"]));

        let lenient = model_of(&traces, Options { min_support: 0.7, min_confidence: 0.7, prune: false, ..Options::default() });
        assert!(has(&lenient, "response", &["a", "b"]));
        let response = lenient.constraints.iter().find(|c| c.template == "response" && c.activities[0] == "a").unwrap();
        assert_eq!(response.violations, 1);
        assert_eq!(response.activations, 4);
        assert!((response.support - 0.75).abs() < 1e-9);
    }

    #[test]
    fn the_sentence_is_the_rule_with_the_names_filled_in() {
        let model = model_of(&["ab", "ab"], Options { prune: false, ..Options::default() });
        let constraint = model.constraints.iter().find(|c| c.template == "chainResponse").unwrap();
        assert_eq!(constraint.sentence, "“a” is always immediately followed by “b”");
    }

    #[test]
    fn the_size_cap_cuts_the_weakest_and_says_how_many() {
        let traces = ["abc", "abc", "abc"];
        let model = model_of(&traces, Options { limit: 3, prune: false, ..Options::default() });
        assert_eq!(model.constraints.len(), 3);
        assert!(model.stats.dropped > 0);
        // Sorted strongest first, so the survivors are full-confidence rules.
        assert!(model.constraints.iter().all(|c| c.confidence >= 0.99));
    }
}
