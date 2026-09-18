//! The executable invariants: randomised logs, properties that must hold for
//! any of them, and one cross-check against an independent implementation of
//! the property the paper actually claims.
//!
//! Split Miner's selling point is not an output that looks plausible — it is
//! that the output is *structurally guaranteed*:
//!
//! > "Split Miner ... is guaranteed to produce deadlock-free process models
//! > with concurrency, while not being restricted to producing
//! > block-structured process models."
//!
//! So these are the properties, not a gallery of expected diagrams:
//!
//! 1. **Every discovery is a valid BPMN diagram** — the boundary check the
//!    artifact would be rejected by.
//! 2. **Gateway discipline** — every task has exactly one way in and one way
//!    out; branching happens only at gateways. This is what makes the diagram
//!    mean what it draws, and it is the property the split and join steps
//!    exist to establish.
//! 3. **No dead activity, and the end is always reachable** — every node lies
//!    on a path from the start event to the end event. This is the paper's own
//!    property (1) of the filtering step, and the basis of its soundness
//!    argument.
//! 4. **Determinism** — one log, one diagram.
//! 5. **Soundness, checked by something else.** Where the model converts to an
//!    accepting Petri net, `soundness-core` — this repository's independent
//!    implementation of the van der Aalst soundness criteria, written against
//!    a different paper and sharing no code with this crate — must find it
//!    sound. That is the paper's headline claim, verified rather than
//!    restated.
//!
//! Logs are generated from random block-structured processes, so they contain
//! genuine sequences, choices, concurrency and loops rather than noise, and in
//! two flavours: plain completions, and full life-cycles whose parallel
//! branches really do overlap, which is the only kind Split Miner 2.0 can say
//! anything about.

use split_miner_core::observe::{Observations, Phase};
use split_miner_core::testing::{scan, scan_complete};
use split_miner_core::{discover, Params, Variant};
use bpmn_core::{Bpmn, NodeKind};
use std::collections::BTreeSet;

fn cases(default: usize) -> usize {
    std::env::var("SPLIT_MINER_CHECK_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(default)
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
    fn chance(&mut self, one_in: usize) -> bool {
        self.below(one_in) == 0
    }
}

// --- a random process, and logs drawn from it ---------------------------

enum Process {
    Task(usize),
    Seq(Vec<Process>),
    Choice(Vec<Process>),
    Parallel(Vec<Process>),
    Loop(Box<Process>),
}

fn random_process(rng: &mut Rng, depth: usize, next: &mut usize) -> Process {
    if depth == 0 || rng.chance(3) {
        let id = *next;
        *next += 1;
        return Process::Task(id);
    }
    fn children(rng: &mut Rng, depth: usize, next: &mut usize) -> Vec<Process> {
        let count = rng.between(2, 3);
        (0..count).map(|_| random_process(rng, depth - 1, next)).collect()
    }
    match rng.below(4) {
        0 => Process::Seq(children(rng, depth, next)),
        1 => Process::Choice(children(rng, depth, next)),
        2 => Process::Parallel(children(rng, depth, next)),
        _ => Process::Loop(Box::new(random_process(rng, depth - 1, next))),
    }
}

/// One execution, as a sequence of `(activity, phase)` events. Parallel
/// branches are interleaved event by event, so their life-cycles genuinely
/// overlap — without that Split Miner 2.0 has nothing to measure and the
/// second variant would be tested against a log it cannot be right about.
fn run(process: &Process, rng: &mut Rng, out: &mut Vec<(usize, Phase)>) {
    match process {
        Process::Task(a) => {
            out.push((*a, Phase::Start));
            out.push((*a, Phase::Complete));
        }
        Process::Seq(children) => {
            for child in children {
                run(child, rng, out);
            }
        }
        Process::Choice(children) => {
            run(&children[rng.below(children.len())], rng, out);
        }
        Process::Parallel(children) => {
            let mut branches: Vec<Vec<(usize, Phase)>> = children
                .iter()
                .map(|child| {
                    let mut events = Vec::new();
                    run(child, rng, &mut events);
                    events.reverse(); // so `pop` yields them in order
                    events
                })
                .collect();
            while branches.iter().any(|b| !b.is_empty()) {
                let live: Vec<usize> =
                    (0..branches.len()).filter(|&i| !branches[i].is_empty()).collect();
                let pick = live[rng.below(live.len())];
                out.push(branches[pick].pop().unwrap());
            }
        }
        Process::Loop(body) => {
            run(body, rng, out);
            let mut rounds = 0;
            while rounds < 3 && rng.chance(3) {
                run(body, rng, out);
                rounds += 1;
            }
        }
    }
}

fn log_of(process: &Process, rng: &mut Rng, traces: usize) -> Vec<Vec<(usize, Phase)>> {
    (0..traces)
        .map(|_| {
            let mut events = Vec::new();
            run(process, rng, &mut events);
            events
        })
        .collect()
}

/// The same log with the start events dropped — what a log with no
/// `lifecycle:transition` attribute looks like.
fn completions(traces: &[Vec<(usize, Phase)>]) -> Vec<Vec<usize>> {
    traces
        .iter()
        .map(|t| t.iter().filter(|(_, p)| *p == Phase::Complete).map(|(a, _)| *a).collect())
        .collect()
}

fn observe(rng: &mut Rng, lifecycle: bool) -> (Observations, usize) {
    let mut activities = 0;
    let process = random_process(rng, 3, &mut activities);
    let activities = activities.max(1);
    let trace_count = rng.between(5, 40);
    let traces = log_of(&process, rng, trace_count);
    if lifecycle {
        let refs: Vec<&[(usize, Phase)]> = traces.iter().map(Vec::as_slice).collect();
        (scan(&refs, activities), activities)
    } else {
        let plain = completions(&traces);
        let refs: Vec<&[usize]> = plain.iter().map(Vec::as_slice).collect();
        (scan_complete(&refs, activities), activities)
    }
}

// --- the properties -----------------------------------------------------

fn nodes_reachable(bpmn: &Bpmn, from: &str, forward: bool) -> BTreeSet<String> {
    let mut seen = BTreeSet::from([from.to_string()]);
    let mut queue = vec![from.to_string()];
    while let Some(node) = queue.pop() {
        let next: Vec<String> = if forward {
            bpmn.outgoing(&node).map(|f| f.target.clone()).collect()
        } else {
            bpmn.incoming(&node).map(|f| f.source.clone()).collect()
        };
        for other in next {
            if seen.insert(other.clone()) {
                queue.push(other);
            }
        }
    }
    seen
}

fn check_structure(bpmn: &Bpmn, seed: u64, label: &str) {
    assert_eq!(bpmn.validate(), Ok(()), "{label} seed {seed}: invalid diagram");

    let start = bpmn.nodes.iter().find(|n| n.kind == NodeKind::StartEvent).unwrap();
    let end = bpmn.nodes.iter().find(|n| n.kind == NodeKind::EndEvent).unwrap();
    assert_eq!(bpmn.nodes.iter().filter(|n| n.kind == NodeKind::StartEvent).count(), 1);
    assert_eq!(bpmn.nodes.iter().filter(|n| n.kind == NodeKind::EndEvent).count(), 1);

    for node in &bpmn.nodes {
        let outgoing = bpmn.outgoing(&node.id).count();
        let incoming = bpmn.incoming(&node.id).count();
        match node.kind {
            NodeKind::StartEvent => {
                assert_eq!(incoming, 0, "{label} seed {seed}: the start event is a target");
            }
            NodeKind::EndEvent => {
                assert_eq!(outgoing, 0, "{label} seed {seed}: the end event is a source");
            }
            NodeKind::Task => {
                // The whole point of the split and join steps: a task never
                // branches, so every branch in the diagram is a gateway that
                // says what kind of branch it is.
                assert_eq!(outgoing, 1, "{label} seed {seed}: task {} branches without a gateway", node.id);
                assert_eq!(incoming, 1, "{label} seed {seed}: task {} merges without a gateway", node.id);
            }
            _ => {
                assert!(outgoing >= 1 && incoming >= 1, "{label} seed {seed}: gateway {} is dangling", node.id);
            }
        }
    }

    // The paper's property (1): every node on a path from start to end. No
    // dead activities, and nothing that can be reached but never finished.
    let forward = nodes_reachable(bpmn, &start.id, true);
    let backward = nodes_reachable(bpmn, &end.id, false);
    for node in &bpmn.nodes {
        assert!(forward.contains(&node.id), "{label} seed {seed}: {} is unreachable from the start", node.id);
        assert!(backward.contains(&node.id), "{label} seed {seed}: {} cannot reach the end", node.id);
    }
}

/// Whether the diagram has a cycle. The paper guarantees soundness for acyclic
/// models and only deadlock-freedom for cyclic ones, so the soundness
/// cross-check has to know the difference.
fn is_cyclic(bpmn: &Bpmn) -> bool {
    // A node is on a cycle when it is reachable from one of its *successors* —
    // asking whether it is reachable from itself always says yes, because the
    // walk starts there.
    bpmn.nodes
        .iter()
        .any(|n| bpmn.outgoing(&n.id).any(|f| nodes_reachable(bpmn, &f.target, true).contains(&n.id)))
}

#[test]
fn every_discovery_is_a_well_formed_diagram() {
    let total = cases(400);
    let mut with_gateways = 0;
    for seed in 0..total as u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        let (obs, _) = observe(&mut rng, false);
        for eta in [0.0, 0.4, 1.0] {
            let found = discover(&obs, &Params { eta, ..Params::default() });
            check_structure(&found.bpmn, seed, "sm1");
            if found.stats.xor_gateways + found.stats.and_gateways + found.stats.or_gateways > 0 {
                with_gateways += 1;
            }
        }
    }
    // A corpus that had drifted into nothing but flat sequences would satisfy
    // every assertion above while testing none of the split or join logic.
    assert!(with_gateways > total, "the corpus should exercise gateways ({with_gateways})");
}

#[test]
fn true_concurrency_discoveries_are_well_formed_too() {
    let total = cases(400);
    let mut concurrency_found = 0;
    for seed in 0..total as u64 {
        let mut rng = Rng(seed.wrapping_mul(0xD1B5_4A32_D192_ED03) | 1);
        let (obs, _) = observe(&mut rng, true);
        let found = discover(
            &obs,
            &Params { variant: Variant::TrueConcurrency, epsilon: 0.5, eta: 0.4 },
        );
        check_structure(&found.bpmn, seed, "sm2");
        if found.stats.concurrent_pairs > 0 {
            concurrency_found += 1;
        }
    }
    assert!(
        concurrency_found > total / 10,
        "the life-cycle corpus should exhibit overlap ({concurrency_found}/{total})"
    );
}

#[test]
fn tasks_are_activities_of_the_log() {
    for seed in 0..200u64 {
        let mut rng = Rng(seed.wrapping_mul(0xA24B_AED4_963E_E407) | 1);
        let (obs, activities) = observe(&mut rng, false);
        let found = discover(&obs, &Params::default());
        let names: BTreeSet<String> = (0..activities).map(|a| obs.name(a).to_string()).collect();
        for node in found.bpmn.nodes.iter().filter(|n| n.kind == NodeKind::Task) {
            let label = node.label.clone().unwrap();
            assert!(names.contains(&label), "seed {seed}: invented a task {label}");
        }
    }
}

#[test]
fn one_log_yields_one_diagram() {
    for seed in 0..200u64 {
        let mut rng = Rng(seed.wrapping_mul(0xBF58_476D_1CE4_E5B9) | 1);
        let (obs, _) = observe(&mut rng, false);
        let first = discover(&obs, &Params::default());
        let second = discover(&obs, &Params::default());
        assert_eq!(first.bpmn, second.bpmn, "seed {seed}: two runs, two diagrams");
    }
}

/// The paper's headline claim, checked against an implementation that knows
/// nothing about Split Miner: convert the diagram to an accepting Petri net
/// and ask `soundness-core` whether it is sound.
///
/// `bpmn-core`'s converter rejects OR gateways and models it cannot
/// block-structure, and Split Miner is explicitly *not* restricted to
/// block-structured output — so this can only speak for the models that do
/// convert. The floor below keeps that from quietly becoming none of them.
#[test]
fn acyclic_models_that_convert_are_sound() {
    let total = cases(400);
    let mut checked = 0;
    for seed in 0..total as u64 {
        let mut rng = Rng(seed.wrapping_mul(0x94D0_49BB_1331_11EB) | 1);
        let (obs, _) = observe(&mut rng, false);
        let found = discover(&obs, &Params { eta: 0.0, ..Params::default() });
        if is_cyclic(&found.bpmn) {
            continue;
        }
        let Ok(net) = bpmn_core::to_petri_net::to_petri_net(&found.bpmn) else { continue };
        let json = serde_json::to_string(&net).unwrap();
        let raw: soundness_core::RawNet = serde_json::from_str(&json).unwrap();
        let report = soundness_core::analyse(&soundness_core::normalize(raw), &soundness_core::Options::default());
        assert_ne!(
            report.summary.verdict,
            soundness_core::report::Verdict::Unsound,
            "seed {seed}: an acyclic Split Miner model came out unsound ({})",
            report.findings.iter().map(|f| f.id.as_str()).collect::<Vec<_>>().join(", ")
        );
        checked += 1;
    }
    assert!(
        checked > total / 20,
        "too few models reached the soundness check for it to mean anything ({checked}/{total})"
    );
}

