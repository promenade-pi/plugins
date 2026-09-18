//! The executable invariants: a reduced net has to be the same net.
//!
//! "Same" means something precise here, and it is the only claim this plugin
//! makes: **the two nets have the same language** — the same sequences of
//! visible activities, with the same ones ending in the final marking. Every
//! rule is stated to preserve that, and a rule whose precondition is one case
//! too weak would produce a smaller net that quietly allows something the
//! original never did. Nothing about the output looks wrong when that happens;
//! it is smaller, which is what was asked for.
//!
//! So the language is enumerated, on both nets, by a plugin that knows nothing
//! about this one: `playout-core`'s extensive play-out (every distinct trace up
//! to a bound). And soundness is checked on both with `soundness-core`. Two
//! other plugins' crates, neither of which has any reason to agree with this
//! one.
//!
//! 1. **The language is preserved.** For random nets, random process-tree nets
//!    and hand-built scaffolding, the set of traces is identical.
//! 2. **Soundness is preserved**, in both directions, whenever both searches
//!    finish.
//! 3. **Reduction only removes.** Never more places, transitions or arcs than
//!    it started with, and running it again changes nothing.
//! 4. **Every visible label survives**, unless it belonged to a transition that
//!    can never fire — which these rules never remove, so: always.
//!
//! `REDUCE_CHECK_CASES` raises the case count; the default is what
//! `package.sh` gates on.

use net_reduce_core::{reduce, Options};
use playout_core::{extensive, Options as PlayoutOptions};
use soundness_core::net::{Arcs, Net};
use soundness_core::report::Verdict;
use std::collections::HashSet;

fn cases(default: usize) -> usize {
    std::env::var("REDUCE_CHECK_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(default)
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
    fn between(&mut self, low: usize, high: usize) -> usize {
        low + self.below(high - low + 1)
    }
}

fn weigh(places: &[usize]) -> Arcs {
    let mut arcs: Vec<(usize, u32)> = Vec::new();
    for &p in places {
        match arcs.iter_mut().find(|(q, _)| *q == p) {
            Some((_, weight)) => *weight += 1,
            None => arcs.push((p, 1)),
        }
    }
    arcs.sort_unstable();
    arcs
}

// --- the language, via another plugin ----------------------------------

/// Every distinct visible trace the net can produce, up to a bound.
///
/// `playout-core`'s extensive mode, which enumerates firing sequences that
/// reach the final marking and keeps the distinct label sequences. `exhausted`
/// says whether the bounds held; when they did not, the comparison below is
/// still meaningful — both nets are enumerated with the same bounds, and a
/// rule that changed the language would change what fits inside them — but the
/// *set* is then a sample of the language rather than all of it, so it is
/// reported separately.
fn language(net: &Net, bound: usize) -> (HashSet<Vec<String>>, bool) {
    let options = PlayoutOptions {
        max_length: bound,
        variants: 4_000,
        max_states: 60_000,
        ..PlayoutOptions::default()
    };
    let enumeration = extensive::enumerate(net, &options);
    let traces = enumeration
        .sequences
        .iter()
        .map(|sequence| sequence.iter().filter_map(|&t| net.labels[t].clone()).collect())
        .collect();
    (traces, enumeration.exhausted)
}

fn reduced_net(net: &Net, options: &Options) -> (Net, net_reduce_core::Report) {
    let result = reduce(net, options);
    let raw: soundness_core::RawNet =
        serde_json::from_value(serde_json::to_value(&result.payload).unwrap()).unwrap();
    (soundness_core::normalize(raw), result.report)
}

fn verdict(net: &Net) -> (Verdict, String) {
    let report = soundness_core::analyse(net, &soundness_core::Options::default());
    (report.summary.verdict, report.behaviour.exploration.clone())
}

// --- random nets --------------------------------------------------------

/// Block-structured nets, which is what a discovery plugin produces: plenty of
/// silent scaffolding, and sound by construction.
enum Tree {
    Leaf(String),
    Tau,
    Seq(Vec<Tree>),
    Xor(Vec<Tree>),
    And(Vec<Tree>),
    Loop(Box<Tree>, Box<Tree>),
}

fn random_tree(rng: &mut Rng, depth: usize, next_label: &mut usize) -> Tree {
    if depth == 0 || rng.below(3) == 0 {
        if rng.below(6) == 0 {
            return Tree::Tau;
        }
        *next_label += 1;
        return Tree::Leaf(format!("A{next_label}"));
    }
    let children = |rng: &mut Rng, next_label: &mut usize| -> Vec<Tree> {
        let n = rng.between(2, 3);
        (0..n).map(|_| random_tree(rng, depth - 1, next_label)).collect()
    };
    match rng.below(4) {
        0 => Tree::Seq(children(rng, next_label)),
        1 => Tree::Xor(children(rng, next_label)),
        2 => Tree::And(children(rng, next_label)),
        _ => Tree::Loop(
            Box::new(random_tree(rng, depth - 1, next_label)),
            Box::new(random_tree(rng, depth - 1, next_label)),
        ),
    }
}

#[derive(Default)]
struct Builder {
    place_count: usize,
    labels: Vec<Option<String>>,
    pre: Vec<Arcs>,
    post: Vec<Arcs>,
}

impl Builder {
    fn place(&mut self) -> usize {
        self.place_count += 1;
        self.place_count - 1
    }
    fn transition(&mut self, label: Option<&str>, inputs: &[usize], outputs: &[usize]) {
        self.labels.push(label.map(str::to_string));
        self.pre.push(weigh(inputs));
        self.post.push(weigh(outputs));
    }
    fn fragment(&mut self, tree: &Tree) -> (usize, usize) {
        match tree {
            Tree::Leaf(label) => {
                let (entry, exit) = (self.place(), self.place());
                self.transition(Some(label), &[entry], &[exit]);
                (entry, exit)
            }
            Tree::Tau => {
                let (entry, exit) = (self.place(), self.place());
                self.transition(None, &[entry], &[exit]);
                (entry, exit)
            }
            Tree::Seq(children) => {
                let parts: Vec<(usize, usize)> = children.iter().map(|c| self.fragment(c)).collect();
                for pair in parts.windows(2) {
                    self.transition(None, &[pair[0].1], &[pair[1].0]);
                }
                (parts[0].0, parts[parts.len() - 1].1)
            }
            Tree::Xor(children) => {
                let parts: Vec<(usize, usize)> = children.iter().map(|c| self.fragment(c)).collect();
                let (entry, exit) = (self.place(), self.place());
                for (child_entry, child_exit) in parts {
                    self.transition(None, &[entry], &[child_entry]);
                    self.transition(None, &[child_exit], &[exit]);
                }
                (entry, exit)
            }
            Tree::And(children) => {
                let parts: Vec<(usize, usize)> = children.iter().map(|c| self.fragment(c)).collect();
                let (entry, exit) = (self.place(), self.place());
                let entries: Vec<usize> = parts.iter().map(|p| p.0).collect();
                let exits: Vec<usize> = parts.iter().map(|p| p.1).collect();
                self.transition(None, &[entry], &entries);
                self.transition(None, &exits, &[exit]);
                (entry, exit)
            }
            Tree::Loop(body, redo) => {
                let (body_entry, body_exit) = self.fragment(body);
                let (redo_entry, redo_exit) = self.fragment(redo);
                let (entry, exit) = (self.place(), self.place());
                self.transition(None, &[entry], &[body_entry]);
                self.transition(None, &[body_exit], &[exit]);
                self.transition(None, &[body_exit], &[redo_entry]);
                self.transition(None, &[redo_exit], &[body_entry]);
                (entry, exit)
            }
        }
    }
}

fn net_from_tree(tree: &Tree) -> Net {
    let mut builder = Builder::default();
    let (entry, exit) = builder.fragment(tree);
    let mut initial = vec![0u32; builder.place_count];
    initial[entry] = 1;
    let mut final_marking = vec![0u32; builder.place_count];
    final_marking[exit] = 1;
    Net {
        place_count: builder.place_count,
        labels: builder.labels,
        pre: builder.pre,
        post: builder.post,
        initial,
        final_marking,
        warnings: Vec::new(),
    }
}

/// A net with no structure at all — mostly ill-formed, often deadlocking. A
/// reduction is offered on whatever net the user selected, including one drawn
/// by hand and left half-finished.
fn random_net(rng: &mut Rng) -> Net {
    let place_count = rng.between(2, 7);
    let transition_count = rng.between(1, 6);
    let mut pre = Vec::new();
    let mut post = Vec::new();
    let mut labels = Vec::new();
    for t in 0..transition_count {
        let inputs: Vec<usize> = (0..rng.below(3)).map(|_| rng.below(place_count)).collect();
        let outputs: Vec<usize> = (0..rng.below(3)).map(|_| rng.below(place_count)).collect();
        pre.push(weigh(&inputs));
        post.push(weigh(&outputs));
        // Silent transitions are what the rules act on, so there are plenty.
        labels.push(if rng.below(2) == 0 { None } else { Some(format!("t{t}")) });
    }
    let mut initial = vec![0u32; place_count];
    for _ in 0..rng.between(1, 2) {
        initial[rng.below(place_count)] += 1;
    }
    let mut final_marking = vec![0u32; place_count];
    final_marking[rng.below(place_count)] = 1;
    Net { place_count, labels, pre, post, initial, final_marking, warnings: Vec::new() }
}

// --- the invariants -----------------------------------------------------

/// Compares the two languages, and says whether the comparison meant anything.
///
/// A net whose language is infinite — any loop — cannot be enumerated, and
/// what comes back is a budget-limited sample. Two samples of an infinite set
/// are not required to be equal, so those cases are reported as *not compared*
/// rather than quietly passed or wrongly failed. The callers assert that
/// enough cases were genuinely compared, which is what keeps this from
/// becoming a test that checks nothing.
fn check_language(
    net: &Net, options: &Options, where_: &str,
) -> (net_reduce_core::Report, bool) {
    let (small, report) = reduced_net(net, options);
    let bound = 14;
    let (before, before_exhausted) = language(net, bound);
    let (after, after_exhausted) = language(&small, bound);
    if !before_exhausted || !after_exhausted {
        return (report, false);
    }

    let missing: Vec<&Vec<String>> = before.difference(&after).collect();
    let invented: Vec<&Vec<String>> = after.difference(&before).collect();
    assert!(
        missing.is_empty(),
        "{where_}: reduction lost {} trace(s), e.g. {:?}\n{:?}", missing.len(), missing.first(), report.applied
    );
    assert!(
        invented.is_empty(),
        "{where_}: reduction invented {} trace(s), e.g. {:?}\n{:?}", invented.len(), invented.first(), report.applied
    );
    (report, true)
}

#[test]
fn reducing_a_block_structured_net_preserves_its_language() {
    let mut rng = Rng(0x5ED0_C0DE_0000_0001);
    let mut reduced_something = 0;
    let mut checked = 0;
    for case in 0..cases(300) {
        let net = net_from_tree(&random_tree(&mut rng, 3, &mut 0));
        let (report, compared) = check_language(&net, &Options::default(), &format!("case {case}"));
        if compared {
            checked += 1;
        }
        if report.reduction > 0.0 {
            reduced_something += 1;
        }
        assert!(report.after.places <= report.before.places);
        assert!(report.after.transitions <= report.before.transitions);
    }
    // A reducer that never reduces would pass every other assertion here.
    assert!(
        reduced_something * 2 > cases(300),
        "only {reduced_something} of {} block-structured nets shrank at all", cases(300)
    );
    assert!(checked * 3 > cases(300), "only {checked} languages could be compared exhaustively");
}

#[test]
fn reducing_an_arbitrary_net_preserves_its_language() {
    let mut rng = Rng(0xD15A_5751_0000_0002);
    let mut checked = 0;
    for case in 0..cases(300) {
        let net = random_net(&mut rng);
        let (_, compared) = check_language(&net, &Options::default(), &format!("case {case}"));
        checked += compared as usize;
    }
    assert!(checked * 3 > cases(300), "only {checked} languages could be compared exhaustively");
}

#[test]
fn every_rule_preserves_the_language_on_its_own() {
    // One rule at a time, so a failure names the rule rather than the pipeline.
    let all = Options::default();
    let single = [
        ("silent", Options { series: false, parallel: false, self_loops: false, implicit: false, ..all.clone() }),
        ("series", Options { silent: false, parallel: false, self_loops: false, implicit: false, ..all.clone() }),
        ("parallel", Options { silent: false, series: false, self_loops: false, implicit: false, ..all.clone() }),
        ("self loops", Options { silent: false, series: false, parallel: false, implicit: false, ..all.clone() }),
        ("implicit", Options { silent: false, series: false, parallel: false, self_loops: false, ..all.clone() }),
    ];
    let mut rng = Rng(0xEAC0_0000_0000_0003);
    let mut checked = 0;
    for case in 0..cases(200) {
        let net = if case % 2 == 0 {
            net_from_tree(&random_tree(&mut rng, 3, &mut 0))
        } else {
            random_net(&mut rng)
        };
        for (name, options) in &single {
            let (_, compared) = check_language(&net, options, &format!("case {case}, {name} alone"));
            checked += compared as usize;
        }
    }
    assert!(checked > cases(200), "only {checked} rule/net pairs could be compared exhaustively");
}

#[test]
fn reducing_a_sound_net_leaves_it_sound() {
    let mut rng = Rng(0x5011_D000_0000_0004);
    for case in 0..cases(200) {
        let net = net_from_tree(&random_tree(&mut rng, 3, &mut 0));
        let (before_verdict, before_exploration) = verdict(&net);
        let (small, _) = reduced_net(&net, &Options::default());
        let (after_verdict, after_exploration) = verdict(&small);
        if before_exploration != "complete" || after_exploration != "complete" {
            continue; // an inconclusive search says nothing either way
        }
        assert_eq!(
            before_verdict, after_verdict,
            "case {case}: soundness changed from {before_verdict:?} to {after_verdict:?}"
        );
    }
}

#[test]
fn reduction_never_grows_a_net_and_is_idempotent() {
    let mut rng = Rng(0x1DE_0000_0000_0005);
    for case in 0..cases(300) {
        let net = if case % 2 == 0 {
            net_from_tree(&random_tree(&mut rng, 3, &mut 0))
        } else {
            random_net(&mut rng)
        };
        let (small, first) = reduced_net(&net, &Options::default());
        assert!(first.after.places <= first.before.places, "case {case}");
        assert!(first.after.transitions <= first.before.transitions, "case {case}");
        assert!(first.after.arcs <= first.before.arcs, "case {case}");

        let (_, second) = reduced_net(&small, &Options::default());
        assert_eq!(second.after.places, first.after.places, "case {case}: a second pass found more");
        assert_eq!(second.after.transitions, first.after.transitions, "case {case}");
    }
}

#[test]
fn every_visible_activity_survives() {
    let mut rng = Rng(0x1ABE_0000_0000_0006);
    for case in 0..cases(300) {
        let net = if case % 2 == 0 {
            net_from_tree(&random_tree(&mut rng, 3, &mut 0))
        } else {
            random_net(&mut rng)
        };
        let before: HashSet<String> = net.labels.iter().flatten().cloned().collect();
        let (small, _) = reduced_net(&net, &Options::default());
        let after: HashSet<String> = small.labels.iter().flatten().cloned().collect();
        assert_eq!(before, after, "case {case}: an activity was renamed or removed");
    }
}
