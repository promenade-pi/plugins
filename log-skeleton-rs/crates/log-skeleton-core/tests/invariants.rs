//! The executable invariants.
//!
//! A log skeleton is a classifier, so its defining property is not "the model
//! looks right" but: **every trace of the log it came from fits it.** If that
//! fails, the skeleton is rejecting the evidence it was built from, and every
//! classification it makes afterwards is meaningless.
//!
//! 1. **The skeleton accepts its own log.** Discovered at no noise and checked
//!    against the same log: every case fits, every constraint is unbroken.
//! 2. **The counters' arithmetic is the counting it replaces.** Discovery
//!    derives most of its numbers rather than measuring them; that derivation
//!    is checked against a naive per-trace count on random logs.
//! 3. **The four shared relations are the DECLARE templates they claim to be.**
//!    The correspondence table in `relations.rs` is a claim about semantics,
//!    checked here against `declare-core` — including `alwaysBefore(a, b) =
//!    precedence(b, a)`, which is the one an author gets backwards.
//! 4. **Noise only widens.** A higher threshold keeps every constraint a lower
//!    one kept, and allows every count it allowed.
//! 5. **It rejects what it should.** A skeleton checked against traces built to
//!    break it reports them — a classifier that accepts everything is not a
//!    classifier.
//!
//! `SKELETON_CHECK_CASES` raises the case count; the default is what
//! `package.sh` gates on.

use declare_core::templates::Template;
use declare_core::TraceIndex;
use log_skeleton_core::conformance::{Checker, ConstraintSpec, CountsSpec, SkeletonSpec};
use log_skeleton_core::counters::{Assessment, Counters};
use log_skeleton_core::relations::{Relation, ALL};
use log_skeleton_core::{discover, Options, Skeleton};

fn cases(default: usize) -> usize {
    std::env::var("SKELETON_CHECK_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(default)
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

const ALPHABET: usize = 5;

fn names() -> Vec<String> {
    (0..ALPHABET).map(|i| ((b'a' + i as u8) as char).to_string()).collect()
}

fn random_trace(rng: &mut Rng, max_len: usize) -> Vec<u32> {
    (0..rng.below(max_len + 1)).map(|_| rng.below(ALPHABET) as u32).collect()
}

/// A log with real structure: every case starts with `a`, ends with `b`, and
/// `c` always comes immediately before `d` when it occurs.
fn structured_log(rng: &mut Rng, traces: usize) -> Vec<Vec<u32>> {
    (0..traces)
        .map(|_| {
            let mut trace = vec![0];
            for _ in 0..rng.below(4) {
                match rng.below(2) {
                    0 => trace.push(4),
                    _ => {
                        trace.push(2);
                        trace.push(3);
                    }
                }
            }
            trace.push(1);
            trace
        })
        .collect()
}

fn index_of(trace: &[u32]) -> TraceIndex {
    let mut index = TraceIndex::new(ALPHABET);
    for &activity in trace {
        index.push(activity);
    }
    index
}

fn counters_of(log: &[Vec<u32>]) -> Counters {
    let mut counters = Counters::new(ALPHABET);
    let mut index = TraceIndex::new(ALPHABET);
    for trace in log {
        index.reset();
        for &activity in trace {
            index.push(activity);
        }
        counters.observe(&index);
    }
    counters
}

/// The skeleton, in the shape the checker reads back.
fn spec_of(skeleton: &Skeleton) -> SkeletonSpec {
    SkeletonSpec {
        activities: skeleton.activities.clone(),
        constraints: skeleton
            .constraints
            .iter()
            .map(|c| ConstraintSpec { relation: c.relation.clone(), activities: c.activities.clone() })
            .collect(),
        counts: skeleton
            .counts
            .iter()
            .map(|c| CountsSpec { activity: c.activity.clone(), counts: c.counts.clone() })
            .collect(),
    }
}

fn check(skeleton: &Skeleton, log: &[Vec<u32>]) -> log_skeleton_core::conformance::Diagnostics {
    let mut checker = Checker::new(&spec_of(skeleton), &names(), 10_000);
    let mut index = TraceIndex::new(ALPHABET);
    for (i, trace) in log.iter().enumerate() {
        index.reset();
        for &activity in trace {
            index.push(activity);
        }
        checker.observe(&index, i as i32);
    }
    checker.finish()
}

// --- the invariants -----------------------------------------------------

#[test]
fn a_skeleton_accepts_the_log_it_came_from() {
    let mut rng = Rng(0x5CE1_0000_0000_0001);
    for case in 0..cases(400) {
        let log = if case % 2 == 0 {
            let n = 3 + rng.below(20);
            structured_log(&mut rng, n)
        } else {
            let n = 3 + rng.below(20);
            (0..n).map(|_| random_trace(&mut rng, 8)).collect()
        };
        let skeleton = discover(&counters_of(&log), &names(), &Options::default());
        assert!(skeleton.constraints.iter().all(|c| c.violations == 0), "case {case}: noise 0 admits no violation");

        let diagnostics = check(&skeleton, &log);
        assert_eq!(
            diagnostics.stats.non_fitting, 0,
            "case {case}: the skeleton rejects {} of the {} cases it was built from — e.g. {:?}",
            diagnostics.stats.non_fitting, log.len(),
            diagnostics.cases.first().map(|c| c.violated.len())
        );
        assert_eq!(diagnostics.stats.fitness, 1.0, "case {case}");
        assert!(diagnostics.unknown_activities.is_empty(), "case {case}");
    }
}

#[test]
fn the_counters_arithmetic_is_the_counting_it_replaces() {
    let mut rng = Rng(0xC0FF_EE00_0000_0002);
    for case in 0..cases(400) {
        let n = 1 + rng.below(12);
        let log: Vec<Vec<u32>> = (0..n).map(|_| random_trace(&mut rng, 8)).collect();
        let counters = counters_of(&log);

        for relation in ALL {
            for a in 0..ALPHABET as u32 {
                for b in 0..ALPHABET as u32 {
                    if a == b {
                        continue;
                    }
                    let mut violated = 0;
                    for trace in &log {
                        let index = index_of(trace);
                        let (has_a, has_b) = (index.contains(a), index.contains(b));
                        let holds = match (has_a, has_b) {
                            (true, true) => relation.holds_when_both_present(&index, a, b),
                            (true, false) => relation.holds_with_one_missing(true),
                            (false, true) => relation.holds_with_one_missing(false),
                            (false, false) => true,
                        };
                        if !holds {
                            violated += 1;
                        }
                    }
                    assert_eq!(
                        counters.assess(relation, a, b),
                        Assessment { violated, traces: log.len() as u32 },
                        "case {case}: {} of {a},{b}", relation.id()
                    );
                }
            }
        }
    }
}

#[test]
fn the_shared_relations_are_the_declare_templates_they_claim_to_be() {
    let mut rng = Rng(0xDEC1_A2E5_0000_0003);
    for case in 0..cases(3_000) {
        let trace = random_trace(&mut rng, 9);
        let index = index_of(&trace);
        for relation in ALL {
            let Some((template, swapped)) = relation.as_template() else { continue };
            for a in 0..ALPHABET as u32 {
                for b in 0..ALPHABET as u32 {
                    if a == b || !index.contains(a) || !index.contains(b) {
                        continue;
                    }
                    let (x, y) = if swapped { (b, a) } else { (a, b) };
                    assert_eq!(
                        relation.holds_when_both_present(&index, a, b),
                        index.holds_when_both_present(template, x, y),
                        "case {case}: {} of {a},{b} disagrees with {}", relation.id(), template.id()
                    );
                }
            }
        }
    }
    // The one that is easy to get backwards, stated as its own claim.
    let index = index_of(&[1, 0]); // b then a
    assert!(Relation::AlwaysBefore.holds_when_both_present(&index, 0, 1), "a has a b before it");
    assert!(index.holds_when_both_present(Template::Precedence, 1, 0), "precedence(b, a)");
    assert!(!index.holds_when_both_present(Template::Precedence, 0, 1), "and not precedence(a, b)");
}

#[test]
fn a_higher_noise_threshold_only_widens_the_skeleton() {
    let mut rng = Rng(0x0151_0000_0000_0004);
    for case in 0..cases(300) {
        let n = 5 + rng.below(20);
        let log: Vec<Vec<u32>> = (0..n).map(|_| random_trace(&mut rng, 7)).collect();
        let counters = counters_of(&log);

        let strict = discover(&counters, &names(), &Options { noise: 0.0, ..Options::default() });
        let loose = discover(&counters, &names(), &Options { noise: 0.3, ..Options::default() });

        for constraint in &strict.constraints {
            assert!(
                loose.constraints.iter().any(|c| c.relation == constraint.relation
                    && c.activities == constraint.activities),
                "case {case}: “{}” survived no noise but not 30%", constraint.sentence
            );
        }
        // Counts go the other way: more noise means *fewer* allowed counts,
        // because the rare ones are dropped. That is the point of the
        // threshold, and it is the one place a wider skeleton is narrower.
        for (tight, wide) in strict.counts.iter().zip(&loose.counts) {
            assert_eq!(tight.activity, wide.activity);
            assert!(
                wide.counts.iter().all(|c| tight.counts.contains(c)),
                "case {case}: noise invented an occurrence count for “{}”", wide.activity
            );
        }
    }
}

#[test]
fn the_skeleton_rejects_traces_built_to_break_it() {
    let mut rng = Rng(0xBAD0_0000_0000_0005);
    let mut rejected_by_order = 0;
    let mut rejected_by_count = 0;
    let total = cases(200);
    for _ in 0..total {
        let n = 10 + rng.below(20);
        let log = structured_log(&mut rng, n);
        let skeleton = discover(&counters_of(&log), &names(), &Options::default());

        // A trace that reverses the fixed start and end.
        let reversed: Vec<Vec<u32>> = log.iter().map(|t| t.iter().rev().copied().collect()).collect();
        if check(&skeleton, &reversed).stats.non_fitting > 0 {
            rejected_by_order += 1;
        }

        // A trace that does `a` far more often than any case ever did.
        let mut greedy = log[0].clone();
        for _ in 0..5 {
            greedy.push(0);
        }
        if check(&skeleton, &[greedy]).stats.non_fitting > 0 {
            rejected_by_count += 1;
        }
    }
    assert_eq!(rejected_by_order, total, "a reversed case broke nothing");
    assert_eq!(rejected_by_count, total, "five extra a's broke nothing");
}
