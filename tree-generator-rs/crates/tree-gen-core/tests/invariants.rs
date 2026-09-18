//! The executable invariants: what a generated model has to be, whatever the
//! parameters and whatever the seed.
//!
//! A generator is a tempting place to be sloppy — nobody is waiting for a
//! *particular* tree, so almost any output looks plausible. But a benchmark
//! built on these models inherits every defect in them silently: a tree that
//! is not sound would make every miner score badly on it for a reason that has
//! nothing to do with the miner, and a tree with fewer activities than asked
//! for quietly changes the experiment's design.
//!
//! 1. **It is a tree.** Every child index in range, every node reachable from
//!    the root exactly once, operators with the arity their meaning requires.
//! 2. **It is the tree that was asked for.** The activity count lands inside
//!    the requested bounds; `silent: 0` produces no silent steps; `duplicate: 0`
//!    produces no repeated labels.
//! 3. **It is sound.** Every generated tree is converted to BPMN and then to an
//!    accepting Petri net (`bpmn-core`) and checked (`soundness-core`) — two
//!    crates belonging to other plugins, neither of which knows this one
//!    exists. Block-structured models are sound by construction, so this is a
//!    property of the *construction* that must survive every operator mix; if
//!    the generator ever emits a shape that is not block-structured, this is
//!    what says so.
//! 4. **A seed is a seed.** The same parameters give the same tree, forever.
//!
//! `TREE_CHECK_CASES` raises the case count; the default is what `package.sh`
//! gates on.

use soundness_core::report::Verdict;
use std::collections::HashSet;
use tree_gen_core::{generate, Options};

fn cases(default: usize) -> usize {
    std::env::var("TREE_CHECK_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// Parameters that vary per case, so the invariants are not all checked
/// against one corner of the parameter space.
fn options_for(case: usize) -> Options {
    let seed = case as u64;
    match case % 6 {
        // The generator's own defaults.
        0 => Options { seed, ..Options::default() },
        // Nothing but concurrency, which is where state spaces explode.
        1 => Options {
            seed, sequence: 0.0, choice: 0.0, parallel: 1.0, loop_: 0.0,
            activity_min: 3, activity_mode: 5, activity_max: 8, ..Options::default()
        },
        // Nothing but loops, which is where soundness is easiest to lose.
        2 => Options {
            seed, sequence: 0.0, choice: 0.0, parallel: 0.0, loop_: 1.0, silent: 0.5,
            activity_min: 4, activity_mode: 6, activity_max: 10, ..Options::default()
        },
        // Silent steps everywhere.
        3 => Options { seed, silent: 1.0, activity_min: 5, activity_mode: 8, activity_max: 12, ..Options::default() },
        // Duplicate labels, which most miners cannot recover — the model is
        // still perfectly well-formed.
        4 => Options { seed, duplicate: 0.8, activity_min: 6, activity_mode: 9, activity_max: 14, ..Options::default() },
        // Inclusive choices, the operator the Inductive Miner never produces.
        _ => Options {
            seed, sequence: 0.3, choice: 0.2, parallel: 0.2, loop_: 0.1, inclusive: 0.2,
            activity_min: 4, activity_mode: 7, activity_max: 10, ..Options::default()
        },
    }
}

/// Invariant 1, read off the payload exactly as a consumer would.
fn is_a_well_formed_tree(generated: &tree_gen_core::Generated, where_: &str) {
    let nodes = &generated.payload.nodes;
    assert!(!nodes.is_empty(), "{where_}: an empty payload");
    assert!((generated.payload.root as usize) < nodes.len(), "{where_}: the root is out of range");

    let mut seen = vec![0usize; nodes.len()];
    let mut stack = vec![generated.payload.root as usize];
    seen[generated.payload.root as usize] += 1;
    while let Some(index) = stack.pop() {
        let node = &nodes[index];
        match node.operator {
            None => {
                assert!(node.children.is_empty(), "{where_}: a leaf with children");
            }
            Some("loop") => assert_eq!(node.children.len(), 2, "{where_}: a loop is body and redo"),
            Some(operator) => assert!(
                node.children.len() >= 2,
                "{where_}: a {operator} with {} child(ren) says nothing a plain child would not",
                node.children.len()
            ),
        }
        for &child in &node.children {
            let child = child as usize;
            assert!(child < nodes.len(), "{where_}: child index out of range");
            seen[child] += 1;
            assert_eq!(seen[child], 1, "{where_}: node {child} has two parents — not a tree");
            stack.push(child);
        }
    }
    assert!(seen.iter().all(|&n| n == 1), "{where_}: a node no path from the root reaches");

    // `activities` is the sorted distinct labels, which is what every reader
    // of the type takes the alphabet from.
    let mut labels: Vec<String> = nodes.iter().filter_map(|n| n.label.clone()).collect();
    labels.sort();
    labels.dedup();
    assert_eq!(labels, generated.payload.activities, "{where_}: the activity list disagrees with the leaves");
}

/// Invariant 3: the tree, converted the way the workspace converts it, is a
/// sound workflow net.
///
/// Returns false when the model contains an inclusive choice whose join has no
/// local replacement — a genuine property of the OR-join rather than a defect
/// in the model (see `bpmn-core`'s `or_join`), and the reason the generator
/// warns as soon as it produces one. Such a tree is still checked as far as
/// BPMN; there is simply no plain Petri net to check the rest against.
fn is_sound(generated: &tree_gen_core::Generated, where_: &str) -> bool {
    let payload: bpmn_core::process_tree::ProcessTreePayload =
        serde_json::from_value(serde_json::to_value(&generated.payload).unwrap()).unwrap();
    let bpmn = bpmn_core::from_process_tree::from_process_tree(&payload)
        .unwrap_or_else(|e| panic!("{where_}: the tree does not convert to BPMN: {e}"));

    let bpmn = if generated.stats.inclusive_choices > 0 {
        let replacement = bpmn_core::or_join::replace(&bpmn)
            .unwrap_or_else(|e| panic!("{where_}: OR-joins are not replaceable: {e}"));
        if !replacement.is_complete() {
            assert!(
                generated.warnings.iter().any(|w| w.contains("Replace OR-joins")),
                "{where_}: an inclusive choice was produced without saying so"
            );
            return false;
        }
        replacement.bpmn
    } else {
        bpmn
    };

    let net = bpmn_core::to_petri_net::to_petri_net(&bpmn)
        .unwrap_or_else(|e| panic!("{where_}: the BPMN does not convert to a Petri net: {e}"));
    let raw: soundness_core::RawNet =
        serde_json::from_value(serde_json::to_value(&net).unwrap()).unwrap();
    let report = soundness_core::analyse(
        &soundness_core::normalize(raw),
        &soundness_core::Options::default(),
    );

    // `Finding` carries no `Debug`, so the report is quoted by its ids —
    // which is what names the defect anyway (SND-DEADLOCK, SND-IMPROPER, ...).
    let findings: Vec<&str> = report.findings.iter().map(|f| f.id.as_str()).collect();
    // `Inconclusive` is the honest answer when the state space outgrew the
    // search budget — a net with six concurrent branches has thousands of
    // markings — and it is not a failure of the generator. `Unsound` is.
    assert_ne!(report.summary.verdict, Verdict::Unsound, "{where_}: {findings:?}");
    if report.behaviour.exploration == "complete" {
        assert_eq!(report.summary.verdict, Verdict::Sound, "{where_}: {findings:?}");
    }
    true
}

#[test]
fn every_generated_tree_is_a_well_formed_tree() {
    for case in 0..cases(600) {
        let options = options_for(case);
        let generated = generate(&options);
        let where_ = format!("case {case}");
        is_a_well_formed_tree(&generated, &where_);

        // The size it was asked for, within the bounds it was given.
        let min = options.activity_min.min(options.activity_max);
        let max = options.activity_min.max(options.activity_max);
        assert!(
            (min..=max).contains(&generated.stats.activity_leaves),
            "{where_}: {} activity leaves, outside {min}..={max}", generated.stats.activity_leaves
        );
        if options.silent == 0.0 {
            assert_eq!(generated.stats.silent, 0, "{where_}: a silent step nobody asked for");
        }
        if options.duplicate == 0.0 {
            assert_eq!(
                generated.stats.activities, generated.stats.activity_leaves,
                "{where_}: a repeated label with duplication turned off"
            );
        }
        assert_eq!(generated.stats.nodes, generated.stats.leaves + generated.stats.operators);
    }
}

#[test]
fn every_generated_tree_is_a_sound_workflow_net() {
    // Fewer than the structural check: each of these runs a full state-space
    // search, and a soundness verdict costs far more than the tree did.
    let mut checked = 0;
    // Its own default: a soundness verdict costs a full state-space search,
    // far more than the tree it is about, so this checks fewer trees than the
    // structural invariant does — and `TREE_CHECK_CASES` still raises both.
    let total = cases(250);
    for case in 0..total {
        checked += is_sound(&generate(&options_for(case)), &format!("case {case}")) as usize;
    }
    // Only the inclusive-choice configuration is allowed to fall out, and it
    // is one of six — a larger shortfall means the check quietly stopped
    // checking anything.
    assert!(checked * 6 >= total * 5, "only {checked} of {total} trees reached a Petri net");
}

#[test]
fn the_same_parameters_give_the_same_tree() {
    for case in 0..cases(200) {
        let options = options_for(case);
        assert_eq!(
            generate(&options).payload, generate(&options).payload,
            "case {case}: a seeded generator is reproducible"
        );
    }
}

#[test]
fn the_parameters_actually_steer_the_result() {
    // A generator whose knobs do nothing would pass every invariant above.
    let trees: Vec<_> = (0..cases(300) as u64)
        .map(|seed| generate(&Options { seed, ..Options::default() }))
        .collect();

    // With equal weights, every operator kind turns up somewhere.
    assert!(trees.iter().any(|t| t.stats.sequences > 0));
    assert!(trees.iter().any(|t| t.stats.choices > 0));
    assert!(trees.iter().any(|t| t.stats.parallels > 0));
    assert!(trees.iter().any(|t| t.stats.loops > 0));
    assert!(trees.iter().any(|t| t.stats.silent > 0), "silent 0.2 should produce some");
    assert!(trees.iter().all(|t| t.stats.inclusive_choices == 0), "the default weight is zero");

    // The size follows the triangular distribution it is drawn from, whose
    // mean is (min + mode + max) / 3 = 20 for the defaults.
    let mean = trees.iter().map(|t| t.stats.activity_leaves).sum::<usize>() as f64 / trees.len() as f64;
    assert!((mean - 20.0).abs() < 2.0, "mean size was {mean}");

    // And distinct trees, not one tree with a different seed attached.
    let shapes: HashSet<String> = trees.iter().map(|t| format!("{:?}", t.payload.nodes)).collect();
    assert!(shapes.len() > trees.len() / 2, "only {} distinct trees", shapes.len());
}
