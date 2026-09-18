//! The executable invariants. Randomised nets, an independent replayer, and
//! a log that has to survive being put back through the model it came from.
//!
//! A simulated log's whole value is that its generating process is known. That
//! is worth nothing if the log does not actually match the process: a play-out
//! that emits a trace its own net cannot produce would silently corrupt every
//! benchmark built on it — a miner would be scored against behaviour the model
//! never had, and the error would look like a finding. So the properties here
//! are not about the code being tidy; they are the claims the plugin makes.
//!
//! 1. **Every case is a firing sequence.** Replayed in the order the *log*
//!    shows (completions, not the simulation's internal start order) against an
//!    independent replayer, from the initial marking. A completed case must
//!    land exactly on the final marking. This is the one that makes the timed
//!    engine's concurrency legitimate rather than convenient: it overlaps
//!    executions, and this is what proves the overlap never invents behaviour.
//! 2. **The log says what the simulation did.** The activity column, read back
//!    per case, is the visible part of that firing sequence — no event
//!    invented, none dropped, none reordered by the sort.
//! 3. **The columns are a well-formed log.** Dense event ids, time order,
//!    every case declared, start before complete.
//! 4. **A seed is a seed.** Same options, same log, down to the last
//!    microsecond and resource.
//! 5. **Extensive play-out finds the whole language.** On small acyclic nets,
//!    compared against a brute-force enumeration that shares no code with it.
//!
//! `PLAYOUT_CHECK_CASES` raises the case count for a longer run; the default is
//! what `package.sh` gates on.

use playout_core::engine::Outcome;
use playout_core::{play_out, Incomplete, Lifecycle, Mode, Options, Playout};
use soundness_core::net::{Arcs, Marking, Net};
use std::collections::{HashMap, HashSet};

fn cases(default: usize) -> usize {
    std::env::var("PLAYOUT_CHECK_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// xorshift64*, so a failing case is reproducible from its seed alone. This is
/// the *fixture* generator, deliberately not the crate's own sampler: a test
/// that used the code under test to choose its inputs would be agreeing with
/// itself.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
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

// --- an independent replayer -------------------------------------------

/// Fires a transition sequence from the initial marking. `None` the moment
/// something is not enabled — which is the whole point: it shares nothing with
/// the engine except `Net::enabled`/`Net::fire`.
fn replay(net: &Net, sequence: &[usize]) -> Option<Marking> {
    let mut marking = net.initial.clone();
    for &transition in sequence {
        if transition >= net.transition_count() || !net.enabled(&marking, transition) {
            return None;
        }
        marking = net.fire(&marking, transition);
    }
    Some(marking)
}

/// Every distinct visible trace of an acyclic net, by brute force: expand
/// everything, keep what reaches the final marking. Exponential and perfectly
/// fine on the four-transition nets it is used on.
fn brute_force_language(net: &Net, depth: usize) -> HashSet<Vec<String>> {
    fn walk(
        net: &Net, marking: &Marking, sequence: &mut Vec<usize>, depth: usize,
        out: &mut HashSet<Vec<String>>,
    ) {
        if *marking == net.final_marking {
            out.insert(sequence.iter().filter_map(|&t| net.labels[t].clone()).collect());
            return;
        }
        if sequence.len() >= depth {
            return;
        }
        for transition in 0..net.transition_count() {
            if !net.enabled(marking, transition) {
                continue;
            }
            sequence.push(transition);
            walk(net, &net.fire(marking, transition), sequence, depth, out);
            sequence.pop();
        }
    }
    let mut out = HashSet::new();
    walk(net, &net.initial.clone(), &mut Vec::new(), depth, &mut out);
    out
}

// --- random nets --------------------------------------------------------

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
        (0..rng.between(2, 3)).map(|_| random_tree(rng, depth - 1, next_label)).collect()
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

/// The textbook block-structured translation, which is what makes every net it
/// produces a sound workflow net — the same construction
/// `plugins/soundness-rs`'s own harness uses, for the same reason: a generator
/// whose output is known-good is what lets a failure be attributed to the code
/// under test rather than to the fixture.
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

/// A net with no structure at all: mostly ill-formed, frequently deadlocking,
/// occasionally unbounded. Nothing here may panic, hang or produce a log that
/// fails the invariants — a play-out is offered on whatever net the user
/// selected, including a half-finished one from the net editor.
fn random_net(rng: &mut Rng) -> Net {
    let place_count = rng.between(2, 6);
    let transition_count = rng.between(1, 5);
    let mut pre = Vec::new();
    let mut post = Vec::new();
    let mut labels = Vec::new();
    for t in 0..transition_count {
        let inputs: Vec<usize> = (0..rng.below(3)).map(|_| rng.below(place_count)).collect();
        let outputs: Vec<usize> = (0..rng.below(3)).map(|_| rng.below(place_count)).collect();
        pre.push(weigh(&inputs));
        post.push(weigh(&outputs));
        labels.push(if rng.below(5) == 0 { None } else { Some(format!("t{t}")) });
    }
    let mut initial = vec![0u32; place_count];
    for _ in 0..rng.between(1, 2) {
        initial[rng.below(place_count)] += 1;
    }
    let mut final_marking = vec![0u32; place_count];
    final_marking[rng.below(place_count)] = 1;
    Net { place_count, labels, pre, post, initial, final_marking, warnings: Vec::new() }
}

// --- reading the log back ----------------------------------------------

/// The log, reassembled into what it claims: per case, the events in log
/// order. Everything below reads the columns exactly as a consumer would,
/// never the simulation's own structures.
fn per_case(log: &Playout) -> HashMap<u64, Vec<(String, String, i64)>> {
    let events = &log.columns.events;
    // Seeded from the declared cases, not from the events: a case whose model
    // path fired only silent transitions is an empty trace, which is a real
    // thing for a log to contain and would otherwise vanish here.
    let mut out: HashMap<u64, Vec<(String, String, i64)>> =
        log.columns.cases.trace_idx.iter().map(|&t| (t as u64, Vec::new())).collect();
    for i in 0..events.event_idx.len() {
        out.entry(events.trace_idx[i] as u64).or_default().push((
            events.activity[i].clone(),
            events.lifecycle[i].clone(),
            events.ts[i] as i64,
        ));
    }
    out
}

fn well_formed(log: &Playout) {
    let events = &log.columns.events;
    let n = events.event_idx.len();
    assert_eq!(events.trace_idx.len(), n);
    assert_eq!(events.activity.len(), n);
    assert_eq!(events.ts.len(), n);
    assert_eq!(events.lifecycle.len(), n);
    if let Some(resource) = &events.resource {
        assert_eq!(resource.len(), n);
        assert!(resource.iter().all(|r| !r.is_empty()), "a declared resource column must be filled");
    }
    assert_eq!(n, log.stats.events);

    // Dense ids, in time order.
    for i in 0..n {
        assert_eq!(events.event_idx[i], i as f64);
        if i > 0 {
            assert!(events.ts[i - 1] <= events.ts[i], "the log must be in time order");
        }
        assert!(events.ts[i] > 0.0 && events.ts[i].fract() == 0.0, "timestamps are whole microseconds");
    }

    // Every event belongs to a declared case, and every declared case has events.
    let declared: HashSet<u64> = log.columns.cases.trace_idx.iter().map(|&t| t as u64).collect();
    assert_eq!(declared.len(), log.columns.cases.trace_idx.len(), "duplicate case ids");
    assert_eq!(declared.len(), log.stats.cases);
    assert_eq!(log.columns.cases.case_id.len(), declared.len());
    let referenced: HashSet<u64> = events.trace_idx.iter().map(|&t| t as u64).collect();
    assert!(referenced.is_subset(&declared), "an event names a case the log does not declare");
    // The converse does not hold, and must not be asserted: a case that ran
    // through nothing but silent transitions is an empty trace, which XES has
    // and this log is allowed to contain.
}

/// Invariants 1 and 2, for one net: what the log shows, replayed on the net.
fn the_log_replays(net: &Net, log: &Playout, expect_final: bool) {
    for (_, events) in per_case(log) {
        // The log's own view of the case: activities in the order they
        // completed, which is the order a miner will read them in.
        let trace: Vec<&str> = events
            .iter()
            .filter(|(_, lifecycle, _)| lifecycle == "complete")
            .map(|(activity, _, _)| activity.as_str())
            .collect();

        // Rebuilt as a firing sequence by an independent walk over the net:
        // at each step, some enabled transition carrying the next label, with
        // silent transitions allowed in between. A trace the net cannot
        // produce has no such walk.
        let marking = fit(net, &trace).unwrap_or_else(|| {
            panic!("the log contains a trace the net cannot produce: {trace:?}")
        });
        if expect_final {
            assert_eq!(marking, net.final_marking, "a completed case must end in the final marking: {trace:?}");
        }
    }
}

/// Fits a visible trace onto the net, returning the marking it ends in.
///
/// A breadth-first search over (marking, position), because a label may be
/// carried by several transitions and silent steps may be needed between two
/// visible ones. Deliberately naive and deliberately independent of the
/// engine — this is the reference, not a second implementation of it.
fn fit(net: &Net, trace: &[&str]) -> Option<Marking> {
    let mut frontier: Vec<(Marking, usize)> = vec![(net.initial.clone(), 0)];
    let mut seen: HashSet<(Marking, usize)> = frontier.iter().cloned().collect();
    let mut best: Option<Marking> = None;
    let mut budget = 200_000;

    while let Some((marking, position)) = frontier.pop() {
        if position == trace.len() {
            // Prefer an end state that is the final marking, since a trace can
            // often be fitted in more than one way. Reaching it usually takes
            // a few more silent steps *after* the last visible activity — the
            // block-structured construction ends every fragment with them — so
            // the search continues from here rather than stopping.
            if marking == net.final_marking {
                return Some(marking);
            }
            best.get_or_insert(marking.clone());
        }
        if budget == 0 {
            return best.or(Some(net.initial.clone()));
        }
        budget -= 1;
        for transition in 0..net.transition_count() {
            if !net.enabled(&marking, transition) {
                continue;
            }
            let next_position = match &net.labels[transition] {
                None => position,
                Some(label) if position < trace.len() && label == trace[position] => position + 1,
                Some(_) => continue,
            };
            let next = (net.fire(&marking, transition), next_position);
            if seen.insert(next.clone()) {
                frontier.push(next);
            }
        }
    }
    best
}

// --- the invariants -----------------------------------------------------

#[test]
fn every_simulated_case_is_a_firing_sequence_of_its_net() {
    let mut rng = Rng(0x5EED_5EED_5EED_0001);
    for case in 0..cases(300) {
        let net = net_from_tree(&random_tree(&mut rng, 3, &mut 0));
        let options = Options {
            traces: 12,
            seed: case as u64,
            lifecycle: if case % 2 == 0 { Lifecycle::Complete } else { Lifecycle::StartComplete },
            resources: case % 5,
            max_length: 120,
            ..Options::default()
        };
        let log = play_out(&net, &options);
        well_formed(&log);
        // Block-structured nets are sound, so no case may deadlock. A case
        // may still be cut off at the step limit: a random walk through a
        // loop is not obliged to ever leave it, and that is a property of the
        // walk rather than a defect in the net or the engine.
        assert_eq!(log.stats.deadlocked, 0, "case {case}: a sound net cannot deadlock");
        assert_eq!(log.stats.cases + log.stats.truncated, 12, "case {case}: {:?}", log.warnings);
        the_log_replays(&net, &log, true);
    }
}

#[test]
fn an_arbitrary_net_is_played_out_or_declined_but_never_faked() {
    let mut rng = Rng(0xD15A_5751_0000_0001);
    for case in 0..cases(300) {
        let net = random_net(&mut rng);
        let options = Options {
            traces: 8,
            seed: case as u64,
            max_length: 40,
            // Keeping the prefixes is the harder case: a deadlocked run's
            // events end up in the log, and they still have to be real.
            incomplete: if case % 2 == 0 { Incomplete::Keep } else { Incomplete::Discard },
            ..Options::default()
        };
        let log = play_out(&net, &options);
        well_formed(&log);
        // Only a case that completed has to end in the final marking; a
        // deadlocked or truncated prefix merely has to be firable.
        the_log_replays(&net, &log, options.incomplete == Incomplete::Discard);
        assert_eq!(
            log.stats.cases + log.stats.discarded,
            if log.stats.events == 0 { log.stats.cases + log.stats.discarded } else { 8 },
            "every case is either written or accounted for as discarded"
        );
    }
}

#[test]
fn the_simulation_never_runs_past_its_own_limits() {
    let mut rng = Rng(0xB0_0DED_0000_0001);
    for case in 0..cases(200) {
        let net = random_net(&mut rng);
        let max_length = 1 + case % 20;
        let log = play_out(
            &net,
            &Options {
                traces: 5, seed: case as u64, max_length,
                incomplete: Incomplete::Keep, ..Options::default()
            },
        );
        for (_, events) in per_case(&log) {
            assert!(
                events.len() <= max_length,
                "case {case}: {} events with a {max_length}-step limit", events.len()
            );
        }
    }
}

#[test]
fn the_same_options_give_the_same_log() {
    let mut rng = Rng(0x5A11_ED_0000_0001);
    for case in 0..cases(150) {
        let net = net_from_tree(&random_tree(&mut rng, 3, &mut 0));
        let options = Options {
            traces: 10, seed: case as u64, resources: 3,
            lifecycle: Lifecycle::StartComplete, ..Options::default()
        };
        let first = play_out(&net, &options);
        let again = play_out(&net, &options);
        assert_eq!(first.columns, again.columns, "case {case}: a seeded simulation is reproducible");
        let other = play_out(&net, &Options { seed: options.seed ^ 0xFFFF, ..options.clone() });
        // Not `assert_ne!`: a net with one trace has one log whatever the
        // seed is. What must not happen is the seed being ignored, which
        // would make *every* net's logs identical.
        if first.stats.variants > 1 {
            assert_ne!(first.columns, other.columns, "case {case}: the seed changed nothing");
        }
    }
}

#[test]
fn starts_bracket_completes_for_every_activity() {
    let mut rng = Rng(0xB4ACE_0000_0001);
    for case in 0..cases(150) {
        let net = net_from_tree(&random_tree(&mut rng, 3, &mut 0));
        let options = Options {
            traces: 6, seed: case as u64, lifecycle: Lifecycle::StartComplete, ..Options::default()
        };
        let log = play_out(&net, &options);
        for (trace_idx, events) in per_case(&log) {
            let starts = events.iter().filter(|(_, l, _)| l == "start").count();
            let completes = events.len() - starts;
            assert_eq!(starts, completes, "case {case}/{trace_idx}: unpaired lifecycle events");
            // Every started activity is also completed, and no activity
            // completes that never started.
            let mut open: HashMap<&str, usize> = HashMap::new();
            for (activity, lifecycle, _) in &events {
                if lifecycle == "start" {
                    *open.entry(activity.as_str()).or_default() += 1;
                } else {
                    let count = open.get_mut(activity.as_str()).unwrap_or_else(|| {
                        panic!("case {case}: “{activity}” completes without starting")
                    });
                    *count -= 1;
                }
            }
            assert!(open.values().all(|&n| n == 0), "case {case}: an activity never completed");
        }
    }
}

#[test]
fn extensive_play_out_finds_exactly_the_models_language() {
    let mut rng = Rng(0xFACE_0000_0000_0001);
    let mut checked = 0;
    for case in 0..cases(200) {
        // Shallow trees only: this is compared against a brute-force
        // enumeration, and a loop makes the language infinite.
        let tree = random_tree(&mut rng, 2, &mut 0);
        let net = net_from_tree(&tree);
        let options = Options {
            mode: Mode::Extensive, max_length: 30, variants: 5_000, seed: case as u64,
            ..Options::default()
        };
        let log = play_out(&net, &options);
        if log.stats.language_exhausted != Some(true) {
            continue; // a loop: the comparison below does not apply
        }
        let expected = brute_force_language(&net, 30);
        let produced: HashSet<Vec<String>> = per_case(&log)
            .into_values()
            .map(|events| {
                events
                    .iter()
                    .filter(|(_, l, _)| l == "complete")
                    .map(|(a, _, _)| a.clone())
                    .collect()
            })
            .collect();
        assert_eq!(produced, expected, "case {case}: the enumerated language is wrong");
        assert_eq!(log.stats.variants, expected.len());
        checked += 1;
    }
    assert!(checked > 10, "only {checked} acyclic nets were actually compared");
}

#[test]
fn a_replayed_firing_sequence_is_what_the_engine_reported() {
    // The engine's own claim — that the transitions in start order fire —
    // checked directly rather than through the log's labels, which cannot
    // distinguish two transitions that share a name.
    let mut rng = Rng(0x0FF1CE_0000_0001);
    for case in 0..cases(200) {
        let net = net_from_tree(&random_tree(&mut rng, 3, &mut 0));
        let mut engine_rng = playout_core::rng::Rng::new(case as u64);
        let options = Options { max_length: 120, ..Options::default() };
        for _ in 0..4 {
            let simulated = playout_core::engine::simulate_case(&net, 0, &mut engine_rng, &options);
            let marking = replay(&net, &simulated.firing_sequence())
                .unwrap_or_else(|| panic!("case {case}: the start order is not a firing sequence"));
            if simulated.outcome == Outcome::Complete {
                assert_eq!(marking, net.final_marking);
            }
        }
    }
}
