//! The executable invariants: the semantics, the arithmetic, and the two
//! halves of the plugin agreeing with each other.
//!
//! A declarative model is a list of claims about a log, and every one of them
//! is checkable — which makes "the discovery is right" an ordinary property
//! rather than a matter of taste. Four things have to hold:
//!
//! 1. **Every template means what its definition says.** The indexed evaluator
//!    (`TraceIndex`, which uses position lists and binary search) is compared
//!    against a literal transcription of each template's definition — nested
//!    loops over the trace, no cleverness — on randomised traces.
//! 2. **The counters' arithmetic is the counting it stands in for.** Discovery
//!    derives most of its numbers rather than measuring them (a `response`
//!    with no activation is satisfied without ever being looked at), and that
//!    derivation is checked against a naive per-trace count on random logs.
//! 3. **Discovery and conformance agree.** A model discovered from a log,
//!    checked against the same log, must report exactly the violations
//!    discovery measured — the two halves share the templates and nothing
//!    else. A model discovered at full support must then check clean.
//! 4. **Pruning removes only redundancy.** Every constraint pruned away is
//!    implied by one that survived, and lowering a threshold only ever adds
//!    constraints.
//!
//! `DECLARE_CHECK_CASES` raises the case count; the default is what
//! `package.sh` gates on.

use declare_core::conformance::{Checker, ConstraintSpec, ModelSpec};
use declare_core::counters::Assessment;
use declare_core::discover::{discover, Options};
use declare_core::templates::{Activation, Template, ALL};
use declare_core::{Counters, TraceIndex};

fn cases(default: usize) -> usize {
    std::env::var("DECLARE_CHECK_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// xorshift64*, so a failing case is reproducible from its seed alone.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 { 0 } else { (self.next() % n as u64) as usize }
    }
}

// --- a literal transcription of the definitions ------------------------

/// Each template, written the way it is written in the papers: quantifiers
/// over positions, nothing else. Shares no code with `TraceIndex`.
fn definition(template: Template, trace: &[u32], a: u32, b: u32) -> bool {
    let has = |x: u32| trace.contains(&x);
    let n = trace.len();
    match template {
        Template::Existence => has(a),
        Template::Absence => !has(a),
        Template::ExactlyOne => trace.iter().filter(|&&x| x == a).count() == 1,
        Template::Init => trace.first() == Some(&a),
        Template::End => trace.last() == Some(&a),

        Template::RespondedExistence => !has(a) || has(b),
        Template::Response => (0..n).all(|i| trace[i] != a || (i + 1..n).any(|j| trace[j] == b)),
        Template::Precedence => (0..n).all(|i| trace[i] != b || (0..i).any(|j| trace[j] == a)),
        Template::Succession => {
            definition(Template::Response, trace, a, b)
                && definition(Template::Precedence, trace, a, b)
        }
        // After each `a`, a `b` before the next `a`.
        Template::AltResponse => (0..n).all(|i| {
            trace[i] != a
                || (i + 1..n).any(|j| trace[j] == b && (i + 1..j).all(|k| trace[k] != a))
        }),
        // Before each `b`, an `a` with no other `b` in between.
        Template::AltPrecedence => (0..n).all(|i| {
            trace[i] != b || (0..i).any(|j| trace[j] == a && (j + 1..i).all(|k| trace[k] != b))
        }),
        Template::AltSuccession => {
            definition(Template::AltResponse, trace, a, b)
                && definition(Template::AltPrecedence, trace, a, b)
        }
        Template::ChainResponse => {
            (0..n).all(|i| trace[i] != a || (i + 1 < n && trace[i + 1] == b))
        }
        Template::ChainPrecedence => {
            (0..n).all(|i| trace[i] != b || (i > 0 && trace[i - 1] == a))
        }
        Template::ChainSuccession => {
            definition(Template::ChainResponse, trace, a, b)
                && definition(Template::ChainPrecedence, trace, a, b)
        }
        Template::NotCoExistence => !(has(a) && has(b)),
        Template::NotSuccession => {
            !(0..n).any(|i| trace[i] == a && (i + 1..n).any(|j| trace[j] == b))
        }
        Template::NotChainSuccession => {
            !(0..n).any(|i| trace[i] == a && i + 1 < n && trace[i + 1] == b)
        }
    }
}

fn activated_by_definition(template: Template, trace: &[u32], a: u32, b: u32) -> bool {
    let has = |x: u32| trace.contains(&x);
    match template.activation() {
        Activation::Always => true,
        Activation::First => has(a),
        Activation::Second => has(b),
        Activation::Either => has(a) || has(b),
    }
}

// --- random logs -------------------------------------------------------

fn random_trace(rng: &mut Rng, alphabet: u32, max_len: usize) -> Vec<u32> {
    (0..rng.below(max_len + 1)).map(|_| rng.below(alphabet as usize) as u32).collect()
}

/// A log with real structure in it, so discovery has something to find rather
/// than only noise to reject: every case starts with `0`, ends with `1`, and
/// `2` is always immediately followed by `3` when it occurs at all.
fn structured_log(rng: &mut Rng, traces: usize) -> Vec<Vec<u32>> {
    (0..traces)
        .map(|_| {
            let mut trace = vec![0];
            for _ in 0..rng.below(5) {
                match rng.below(3) {
                    0 => trace.push(4),
                    1 => {
                        trace.push(2);
                        trace.push(3);
                    }
                    _ => trace.push(5),
                }
            }
            trace.push(1);
            trace
        })
        .collect()
}

fn index_of(trace: &[u32], alphabet: usize) -> TraceIndex {
    let mut index = TraceIndex::new(alphabet);
    for &activity in trace {
        index.push(activity);
    }
    index
}

fn counters_of(log: &[Vec<u32>], alphabet: usize) -> Counters {
    let mut counters = Counters::new(alphabet);
    let mut index = TraceIndex::new(alphabet);
    for trace in log {
        index.reset();
        for &activity in trace {
            index.push(activity);
        }
        counters.observe(&index);
    }
    counters
}

fn names(alphabet: usize) -> Vec<String> {
    (0..alphabet).map(|i| ((b'a' + i as u8) as char).to_string()).collect()
}

// --- the invariants ----------------------------------------------------

#[test]
fn every_template_means_what_its_definition_says() {
    let mut rng = Rng(0xDEC1_A2E5_0000_0001);
    let alphabet = 4;
    for case in 0..cases(4_000) {
        let trace = random_trace(&mut rng, alphabet, 9);
        let index = index_of(&trace, alphabet as usize);
        for template in ALL {
            for a in 0..alphabet {
                for b in 0..alphabet {
                    if template.is_binary() && a == b {
                        continue;
                    }
                    let (ia, ib) = (Some(a), Some(b));
                    assert_eq!(
                        index.holds(template, ia, ib),
                        definition(template, &trace, a, b),
                        "case {case}: {} of {a},{b} on {trace:?}", template.id()
                    );
                    assert_eq!(
                        index.activates(template, ia, ib),
                        activated_by_definition(template, &trace, a, b),
                        "case {case}: activation of {} on {trace:?}", template.id()
                    );
                }
            }
        }
    }
}

#[test]
fn the_counters_arithmetic_is_the_counting_it_replaces() {
    let mut rng = Rng(0xC0FF_EE00_0000_0001);
    let alphabet = 5usize;
    for case in 0..cases(400) {
        let log: Vec<Vec<u32>> =
            { let n = 1 + rng.below(12); (0..n).map(|_| random_trace(&mut rng, alphabet as u32, 8)).collect() };
        let counters = counters_of(&log, alphabet);

        for template in ALL {
            for a in 0..alphabet as u32 {
                for b in 0..alphabet as u32 {
                    if template.is_binary() && a == b {
                        continue;
                    }
                    // The same question, counted one trace at a time.
                    let mut activated = 0;
                    let mut violated = 0;
                    for trace in &log {
                        if activated_by_definition(template, trace, a, b) {
                            activated += 1;
                        }
                        if !definition(template, trace, a, b) {
                            violated += 1;
                        }
                    }
                    assert_eq!(
                        counters.assess(template, a, b),
                        Assessment { activated, violated, traces: log.len() as u32 },
                        "case {case}: {} of {a},{b}", template.id()
                    );
                }
            }
        }
    }
}

#[test]
fn a_discovered_model_is_confirmed_by_checking_it_against_the_same_log() {
    let mut rng = Rng(0xA11E_6ED0_0000_0001);
    let alphabet = 6usize;
    for case in 0..cases(300) {
        let log = if case % 2 == 0 {
            { let n = 4 + rng.below(20); structured_log(&mut rng, n) }
        } else {
            { let n = 4 + rng.below(20); (0..n).map(|_| random_trace(&mut rng, alphabet as u32, 8)).collect() }
        };
        let counters = counters_of(&log, alphabet);
        let options = Options {
            min_support: 0.6,
            min_confidence: 0.6,
            prune: case % 3 == 0,
            ..Options::default()
        };
        let model = discover(&counters, &names(alphabet), &options);

        // The other half of the plugin, reading the model back.
        let spec = ModelSpec {
            activities: model.activities.clone(),
            constraints: model
                .constraints
                .iter()
                .map(|c| ConstraintSpec {
                    template: c.template.clone(),
                    activities: c.activities.clone(),
                })
                .collect(),
        };
        let mut checker = Checker::new(&spec, &names(alphabet), 10_000);
        let mut index = TraceIndex::new(alphabet);
        for (i, trace) in log.iter().enumerate() {
            index.reset();
            for &activity in trace {
                index.push(activity);
            }
            checker.observe(&index, i as i32);
        }
        let diagnostics = checker.finish();
        assert!(checker_templates_all_known(&diagnostics));

        assert_eq!(diagnostics.constraints.len(), model.constraints.len());
        for (discovered, checked) in model.constraints.iter().zip(&diagnostics.constraints) {
            assert_eq!(discovered.template, checked.template);
            assert_eq!(
                discovered.violations, checked.violations,
                "case {case}: {} disagrees between discovery and checking", discovered.sentence
            );
            assert_eq!(discovered.activations, checked.activations, "case {case}: {}", discovered.sentence);
        }
    }
}

fn checker_templates_all_known(diagnostics: &declare_core::conformance::Diagnostics) -> bool {
    diagnostics.unknown_templates.is_empty() && diagnostics.unknown_activities.is_empty()
}

#[test]
fn a_model_discovered_at_full_support_has_nothing_to_report_on_its_own_log() {
    let mut rng = Rng(0xFACE_D0C5_0000_0001);
    let alphabet = 6usize;
    for case in 0..cases(200) {
        let n = 5 + rng.below(25);
        let log = structured_log(&mut rng, n);
        let counters = counters_of(&log, alphabet);
        let model = discover(
            &counters,
            &names(alphabet),
            &Options { min_support: 1.0, min_confidence: 1.0, ..Options::default() },
        );
        assert!(!model.constraints.is_empty(), "case {case}: a structured log has rules");
        assert!(model.constraints.iter().all(|c| c.violations == 0));

        let spec = ModelSpec {
            activities: model.activities.clone(),
            constraints: model
                .constraints
                .iter()
                .map(|c| ConstraintSpec { template: c.template.clone(), activities: c.activities.clone() })
                .collect(),
        };
        let mut checker = Checker::new(&spec, &names(alphabet), 10);
        let mut index = TraceIndex::new(alphabet);
        for (i, trace) in log.iter().enumerate() {
            index.reset();
            for &activity in trace {
                index.push(activity);
            }
            checker.observe(&index, i as i32);
        }
        let diagnostics = checker.finish();
        assert_eq!(diagnostics.stats.conformance, 1.0, "case {case}");
        assert_eq!(diagnostics.stats.violations, 0);
        assert!(diagnostics.cases.is_empty());
    }
}

#[test]
fn the_structure_that_was_put_in_is_what_comes_out() {
    // Not a property of random data but of a known generator: every case
    // starts with `a`, ends with `b`, and a `c` is always immediately
    // followed by a `d`. A miner that cannot recover those is not a miner.
    let mut rng = Rng(0x5EED_0000_0000_0007);
    let log = structured_log(&mut rng, 200);
    let alphabet = 6;
    let model = discover(
        &counters_of(&log, alphabet),
        &names(alphabet),
        &Options { min_support: 1.0, min_confidence: 1.0, prune: false, ..Options::default() },
    );
    let has = |template: &str, activities: &[&str]| {
        model.constraints.iter().any(|c| {
            c.template == template
                && c.activities.iter().map(String::as_str).eq(activities.iter().copied())
        })
    };
    assert!(has("init", &["a"]), "every case starts with a");
    assert!(has("end", &["b"]), "every case ends with b");
    assert!(has("chainResponse", &["c", "d"]), "c is always followed immediately by d");
    assert!(has("existence", &["a"]));
    assert!(!has("existence", &["c"]), "c is optional");
    assert!(!has("chainResponse", &["d", "c"]), "and the reverse is not true");
}

#[test]
fn pruning_removes_only_what_something_else_already_says() {
    let mut rng = Rng(0xBEEF_0000_0000_0001);
    let alphabet = 5usize;
    for case in 0..cases(300) {
        let log = if case % 2 == 0 {
            { let n = 4 + rng.below(15); structured_log(&mut rng, n) }
        } else {
            { let n = 4 + rng.below(15); (0..n).map(|_| random_trace(&mut rng, alphabet as u32, 7)).collect() }
        };
        let counters = counters_of(&log, alphabet);
        let names = names(alphabet);
        let base = Options { min_support: 0.8, min_confidence: 0.8, ..Options::default() };

        let verbose = discover(&counters, &names, &Options { prune: false, ..base.clone() });
        let pruned = discover(&counters, &names, &Options { prune: true, ..base.clone() });

        // A subset, and the numbers of the survivors are untouched.
        for constraint in &pruned.constraints {
            assert!(
                verbose.constraints.contains(constraint),
                "case {case}: pruning invented {}", constraint.sentence
            );
        }
        assert_eq!(pruned.stats.pruned, verbose.constraints.len() - pruned.constraints.len());

        // And the pruned model still *says* everything the verbose one did:
        // every constraint removed follows from the ones that survived, by
        // one or more implication steps. (One step is not enough to state
        // this: `chainPrecedence` can knock out `precedence`, which in turn
        // is what knocks out the reversed `respondedExistence`.)
        let closure = consequences_of(&pruned.constraints);
        for removed in verbose.constraints.iter().filter(|c| !pruned.constraints.contains(c)) {
            assert!(
                closure.contains(&(removed.template.clone(), removed.activities.clone())),
                "case {case}: pruning dropped “{}”, which nothing that survived implies",
                removed.sentence
            );
        }
    }
}

/// Everything the given constraints imply, including themselves: the
/// implication relation applied until nothing new appears.
fn consequences_of(
    constraints: &[declare_core::discover::Constraint],
) -> std::collections::HashSet<(String, Vec<String>)> {
    let mut closure: std::collections::HashSet<(String, Vec<String>)> = constraints
        .iter()
        .map(|c| (c.template.clone(), c.activities.clone()))
        .collect();
    loop {
        let mut added = false;
        for (template, activities) in closure.clone() {
            let Some(current) = Template::from_id(&template) else { continue };
            for next in ALL {
                if declare_core::templates::implies(current, next)
                    && closure.insert((next.id().to_string(), activities.clone()))
                {
                    added = true;
                }
            }
            // The one cross-direction implication `prune` also applies.
            if current == Template::Precedence && activities.len() == 2 {
                let swapped = vec![activities[1].clone(), activities[0].clone()];
                if closure.insert((Template::RespondedExistence.id().to_string(), swapped)) {
                    added = true;
                }
            }
        }
        if !added {
            break;
        }
    }
    closure
}

#[test]
fn lowering_a_threshold_can_only_add_constraints() {
    let mut rng = Rng(0x7B4E_5401_0000_0001);
    let alphabet = 5usize;
    for case in 0..cases(200) {
        let log: Vec<Vec<u32>> =
            { let n = 3 + rng.below(15); (0..n).map(|_| random_trace(&mut rng, alphabet as u32, 7)).collect() };
        let counters = counters_of(&log, alphabet);
        let names = names(alphabet);

        let strict = discover(
            &counters, &names,
            &Options { min_support: 0.9, min_confidence: 0.9, prune: false, ..Options::default() },
        );
        let lenient = discover(
            &counters, &names,
            &Options { min_support: 0.5, min_confidence: 0.5, prune: false, ..Options::default() },
        );
        for constraint in &strict.constraints {
            assert!(
                lenient.constraints.contains(constraint),
                "case {case}: “{}” survived a stricter threshold than a looser one",
                constraint.sentence
            );
        }
    }
}
