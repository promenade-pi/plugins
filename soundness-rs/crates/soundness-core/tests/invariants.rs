//! The executable invariants. Randomised inputs, an independent reference,
//! and witnesses that have to survive being replayed.
//!
//! A soundness verdict is not something to eyeball on a picture of a net: it is
//! a claim about every reachable marking, and the only honest way to defend it
//! is to state properties that must hold for *any* net and then throw nets at
//! them. Five hold here:
//!
//! 1. **A block-structured net is never accused.** Random process trees are
//!    converted to nets by the textbook construction, so every one of them is
//!    sound; not one may come back `Unsound`, and each whose state space fits
//!    in the budget must come back `Sound`. This is the end-to-end invariant —
//!    it exercises the structural checks, the state search and the verdict at
//!    once, it is the property the Inductive Miner's own soundness guarantee
//!    rests on, and a false accusation is the one failure that would make the
//!    whole plugin worse than not having it.
//! 2. **A complete search agrees with an independent reference.** For random
//!    (mostly ill-formed) nets, a second, deliberately naive reachability
//!    implementation must find exactly the same state count.
//! 3. **Every witness replays.** A reported firing sequence must actually fire
//!    from the initial marking, land in the marking the report states, and have
//!    the property it was reported for — a deadlock witness must genuinely
//!    deadlock, an improper one must genuinely cover the final marking.
//! 4. **An unboundedness proof pumps.** Replaying `prefix` then `pump` k times
//!    must stay firable and strictly gain tokens every round.
//! 5. **A dead transition is dead in the reference too.**
//!
//! `SOUNDNESS_CHECK_CASES` raises the case count for a longer run; the default
//! is what `package.sh` gates on.

use soundness_core::net::{Arcs, Marking, Net};
use soundness_core::report::{Outcome, Report, Verdict};
use soundness_core::{analyse, Options};
use std::collections::HashSet;

fn cases(default: usize) -> usize {
    std::env::var("SOUNDNESS_CHECK_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(default)
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

// --- an independent reference ------------------------------------------

/// Deliberately the dumbest possible reachability search: a worklist, a set,
/// no parent pointers, no covering test, no early exit. It shares no code with
/// `explore` beyond `Net::enabled`/`Net::fire`, which is the point — if both
/// agree on a state count, the agreement means something.
///
/// `None` when a place exceeded `ceiling` (so the net is, at minimum, larger
/// than this reference can characterise) or the state cap was hit.
fn reference_states(net: &Net, ceiling: u32, cap: usize) -> Option<HashSet<Marking>> {
    let mut seen = HashSet::from([net.initial.clone()]);
    let mut work = vec![net.initial.clone()];
    while let Some(marking) = work.pop() {
        for transition in 0..net.transition_count() {
            if !net.enabled(&marking, transition) {
                continue;
            }
            let next = net.fire(&marking, transition);
            if next.iter().any(|&tokens| tokens > ceiling) || seen.len() >= cap {
                return None;
            }
            if seen.insert(next.clone()) {
                work.push(next);
            }
        }
    }
    Some(seen)
}

/// Fires a sequence from the initial marking. `None` if a step is not enabled.
fn replay(net: &Net, trace: &[usize]) -> Option<Marking> {
    let mut marking = net.initial.clone();
    for &transition in trace {
        if transition >= net.transition_count() || !net.enabled(&marking, transition) {
            return None;
        }
        marking = net.fire(&marking, transition);
    }
    Some(marking)
}

fn as_tokens(marking: &Marking) -> Vec<(usize, u32)> {
    marking.iter().enumerate().filter(|(_, &n)| n > 0).map(|(p, &n)| (p, n)).collect()
}

// --- random nets --------------------------------------------------------

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

// --- random process trees ----------------------------------------------

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

/// Incremental net under construction. Every fragment it builds has exactly one
/// entry place and one exit place, which is what makes the assembled net a
/// workflow net by construction.
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

    /// The textbook block-structured translation: a leaf becomes one
    /// transition between two fresh places, and every operator wires its
    /// children's entry/exit places to fresh ones through silent steps.
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

// --- the invariants -----------------------------------------------------

/// Everything a report claims about a *specific* marking has to survive being
/// replayed against the net. Applied to every randomised case.
fn witnesses_replay(net: &Net, report: &Report) {
    for situation in report
        .behaviour
        .deadlocks
        .iter()
        .chain(&report.behaviour.livelocks)
        .chain(&report.behaviour.improper_completions)
    {
        let reached = replay(net, &situation.trace).expect("a reported trace must be firable");
        assert_eq!(as_tokens(&reached), situation.marking, "trace lands in the reported marking");
        assert_eq!(situation.steps.len(), situation.trace.len());
    }
    for situation in &report.behaviour.deadlocks {
        let reached = replay(net, &situation.trace).unwrap();
        assert!(
            (0..net.transition_count()).all(|t| !net.enabled(&reached, t)),
            "a deadlock witness must genuinely have no enabled transition"
        );
        assert_ne!(reached, net.final_marking);
    }
    for situation in &report.behaviour.improper_completions {
        let reached = replay(net, &situation.trace).unwrap();
        assert!(reached.iter().zip(net.final_marking.iter()).all(|(a, b)| a >= b));
        assert_ne!(reached, net.final_marking);
    }
    for situation in &report.behaviour.livelocks {
        let reached = replay(net, &situation.trace).unwrap();
        assert!(
            (0..net.transition_count()).any(|t| net.enabled(&reached, t)),
            "a livelock still has somewhere to go — that is what distinguishes it from a deadlock"
        );
    }
}

/// The unboundedness proof, checked by doing what it says: run the pump and
/// watch the tokens grow.
fn pump_grows(net: &Net, report: &Report) {
    let Some(unbounded) = &report.behaviour.unbounded else { return };
    let mut trace = unbounded.prefix.clone();
    let mut previous = replay(net, &trace).expect("the prefix must be firable");
    for round in 1..=4 {
        trace.extend(unbounded.pump.iter().copied());
        let now = replay(net, &trace).unwrap_or_else(|| panic!("pump round {round} stopped firing"));
        assert!(
            now.iter().zip(previous.iter()).all(|(a, b)| a >= b)
                && now.iter().sum::<u32>() > previous.iter().sum::<u32>(),
            "round {round} must cover the previous marking and add tokens"
        );
        for &place in &unbounded.growing_places {
            assert!(now[place] > previous[place], "place {place} was reported as growing");
        }
        previous = now;
    }
}

#[test]
fn block_structured_nets_are_never_accused() {
    let total = cases(600);
    let mut completed = 0;
    for seed in 0..total as u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        let tree = random_tree(&mut rng, 3, &mut 0);
        let net = net_from_tree(&tree);
        // Nested AND blocks multiply out, so a perfectly sound tree can have a
        // state space past any budget. That is a real outcome of the analysis,
        // not a defect: what it may never do is turn into an accusation.
        let report = analyse(&net, &Options { max_states: 50_000 });
        assert_ne!(
            report.summary.verdict,
            Verdict::Unsound,
            "seed {seed}: a net built from a process tree is sound, but it was accused ({})",
            report.findings.iter().map(|f| f.id.as_str()).collect::<Vec<_>>().join(", ")
        );
        assert!(report.summary.is_workflow_net, "seed {seed}: the construction is a WF-net");
        if report.behaviour.exploration == "complete" {
            completed += 1;
            assert_eq!(report.summary.verdict, Verdict::Sound, "seed {seed}");
            assert_eq!(report.summary.bounded, Outcome::Pass, "seed {seed}");
            assert!(report.behaviour.dead_transitions.is_empty(), "seed {seed}");
        }
    }
    // Without this, a generator that had drifted into producing only nets too
    // big to finish would satisfy every assertion above while checking nothing.
    assert!(
        completed > total * 9 / 10,
        "most tree nets should be decidable within the budget ({completed}/{total})"
    );
}

#[test]
fn random_nets_agree_with_an_independent_reference() {
    let total = cases(3000);
    let mut complete = 0;
    let mut unbounded = 0;
    for seed in 0..total as u64 {
        let mut rng = Rng(seed.wrapping_mul(0xD1B5_4A32_D192_ED03) | 1);
        let net = random_net(&mut rng);
        let report = analyse(&net, &Options { max_states: 20_000 });

        witnesses_replay(&net, &report);
        pump_grows(&net, &report);

        match report.behaviour.exploration.as_str() {
            "complete" => {
                complete += 1;
                let states = reference_states(&net, u32::MAX / 2, 100_000)
                    .unwrap_or_else(|| panic!("seed {seed}: search said complete, reference did not finish"));
                assert_eq!(states.len(), report.behaviour.states, "seed {seed}: state count");
                for &dead in &report.behaviour.dead_transitions {
                    assert!(
                        states.iter().all(|m| !net.enabled(m, dead)),
                        "seed {seed}: transition {dead} was reported dead but the reference enables it"
                    );
                }
                for transition in 0..net.transition_count() {
                    if states.iter().any(|m| net.enabled(m, transition)) {
                        assert!(
                            !report.behaviour.dead_transitions.contains(&transition),
                            "seed {seed}: transition {transition} fires in the reference"
                        );
                    }
                }
            }
            "unbounded" => {
                unbounded += 1;
                assert!(report.behaviour.unbounded.is_some(), "seed {seed}: no proof attached");
                assert_eq!(report.summary.bounded, Outcome::Fail, "seed {seed}");
                assert_eq!(report.summary.verdict, Verdict::Unsound, "seed {seed}");
                // A net the covering test rejects must genuinely defeat a
                // bounded reference search.
                assert!(
                    reference_states(&net, 64, 100_000).is_none(),
                    "seed {seed}: reported unbounded, but the reference enumerated it within 64 tokens"
                );
            }
            other => assert_eq!(other, "truncated", "seed {seed}: unexpected exploration outcome"),
        }
    }
    // Guards the generator itself: a corpus that had drifted into all-unbounded
    // or all-trivial nets would pass every assertion above and test nothing.
    assert!(complete > total / 10, "the corpus should contain bounded nets ({complete}/{total})");
    assert!(unbounded > total / 50, "the corpus should contain unbounded nets ({unbounded}/{total})");
}

#[test]
fn the_report_is_deterministic() {
    for seed in 0..200u64 {
        let mut rng = Rng(seed.wrapping_mul(0xA24B_AED4_963E_E407) | 1);
        let net = random_net(&mut rng);
        let first = serde_json::to_string(&analyse(&net, &Options::default())).unwrap();
        let second = serde_json::to_string(&analyse(&net, &Options::default())).unwrap();
        assert_eq!(first, second, "seed {seed}: two runs on one net must produce one report");
    }
}
