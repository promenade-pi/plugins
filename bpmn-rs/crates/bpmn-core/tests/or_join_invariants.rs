//! The one property that matters for an OR-join replacement: **it has to mean
//! the same thing**.
//!
//! A replacement that merely produces a diagram with no inclusive gateways left
//! is trivial to write and worthless — relabelling every OR-join as XOR would
//! do it, and would silently turn a synchronising model into a racing one. So
//! what is asserted here is behavioural equivalence, checked by running both
//! diagrams.
//!
//! On an acyclic workflow graph an execution is fully determined by which way
//! each exclusive split goes, and the replacement adds no new splits — it only
//! adds joins. So the two diagrams have exactly the same decision space, and
//! equivalence can be decided outright: for every combination of decisions,
//! propagate tokens through both and compare which nodes fired. Under that
//! whole-execution view an inclusive join fires when at least one of its
//! incoming flows is active, which is precisely its semantics once "a token may
//! still arrive" is settled by looking at the finished execution.
//!
//! Models are random block-structured processes — sequences, choices and
//! parallel blocks — with every join made inclusive, and then, for the cases
//! the paper is actually about, extra shortcut edges that make the graph
//! genuinely non-block-structured while keeping it acyclic.

use bpmn_core::{or_join, Bpmn, Flow, Metadata, Node, NodeKind};
use std::collections::{BTreeMap, BTreeSet, HashMap};

fn cases(default: usize) -> usize {
    std::env::var("OR_JOIN_CHECK_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

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
    fn chance(&mut self, one_in: usize) -> bool {
        self.below(one_in) == 0
    }
}

// --- a random block-structured diagram ----------------------------------

#[derive(Default)]
struct Builder {
    nodes: Vec<Node>,
    flows: Vec<Flow>,
    next: usize,
}

impl Builder {
    fn node(&mut self, kind: NodeKind, label: Option<String>) -> String {
        self.next += 1;
        let id = format!("n{}", self.next);
        self.nodes.push(Node { id: id.clone(), kind, label });
        id
    }
    fn flow(&mut self, source: &str, target: &str) {
        let id = format!("f{}", self.flows.len());
        self.flows.push(Flow { id, source: source.into(), target: target.into(), label: None });
    }

    /// A fragment with one entry node and one exit node.
    fn fragment(&mut self, rng: &mut Rng, depth: usize, tasks: &mut usize) -> (String, String) {
        if depth == 0 || rng.chance(3) {
            *tasks += 1;
            let id = self.node(NodeKind::Task, Some(format!("t{tasks}")));
            return (id.clone(), id);
        }
        let parallel = rng.chance(2);
        let split_kind = if parallel { NodeKind::ParallelGateway } else { NodeKind::ExclusiveGateway };
        let children = 2 + rng.below(2);
        let split = self.node(split_kind, None);
        // Every join is inclusive — the point of the exercise is whether the
        // replacement can work out what each of them actually meant.
        let join = self.node(NodeKind::InclusiveGateway, None);
        for _ in 0..children {
            let (entry, exit) = self.fragment(rng, depth - 1, tasks);
            self.flow(&split, &entry);
            self.flow(&exit, &join);
        }
        (split, join)
    }
}

fn random_diagram(rng: &mut Rng, shortcuts: usize) -> Bpmn {
    let mut builder = Builder::default();
    let mut tasks = 0;
    let (entry, exit) = builder.fragment(rng, 3, &mut tasks);
    let start = builder.node(NodeKind::StartEvent, None);
    let end = builder.node(NodeKind::EndEvent, None);
    builder.flow(&start, &entry);
    builder.flow(&exit, &end);

    let mut bpmn = Bpmn {
        nodes: builder.nodes,
        flows: builder.flows,
        metadata: Metadata { source_type: None, structured: false, warnings: Vec::new() },
    };

    // Shortcut edges break the block structure while keeping the graph
    // acyclic: a gateway earlier in topological order gains a branch into a
    // gateway later in it, which becomes an inclusive join.
    //
    // Both ends must be gateways. A task with two outgoing flows, or two
    // incoming, is ambiguous in BPMN — the notation leaves it to the engine —
    // so a generator that produced one would be testing the conversion's
    // refusal of a malformed diagram rather than anything about OR-joins.
    for _ in 0..shortcuts {
        let Some(order) = topological(&bpmn) else { break };
        let gateways: Vec<usize> = order
            .iter()
            .enumerate()
            .filter(|(_, id)| bpmn.node(id).is_some_and(|n| n.kind.is_gateway()))
            .map(|(at, _)| at)
            .collect();
        if gateways.len() < 2 {
            break;
        }
        let from = gateways[rng.below(gateways.len())];
        let later: Vec<usize> = gateways.iter().copied().filter(|&at| at > from + 1).collect();
        if later.is_empty() {
            continue;
        }
        let to = later[rng.below(later.len())];
        let (source, target) = (order[from].clone(), order[to].clone());
        if bpmn.flows.iter().any(|f| f.source == source && f.target == target) {
            continue;
        }
        let id = format!("f{}", bpmn.flows.len());
        bpmn.flows.push(Flow { id, source, target: target.clone(), label: None });
        if let Some(node) = bpmn.nodes.iter_mut().find(|n| n.id == target) {
            node.kind = NodeKind::InclusiveGateway;
        }
    }
    bpmn
}

fn topological(bpmn: &Bpmn) -> Option<Vec<String>> {
    let mut indegree: HashMap<&str, usize> = bpmn.nodes.iter().map(|n| (n.id.as_str(), 0)).collect();
    for flow in &bpmn.flows {
        *indegree.get_mut(flow.target.as_str())? += 1;
    }
    let mut ready: Vec<&str> = indegree.iter().filter(|(_, &d)| d == 0).map(|(&n, _)| n).collect();
    ready.sort_unstable();
    let mut order = Vec::new();
    while let Some(node) = ready.pop() {
        order.push(node.to_string());
        for flow in bpmn.flows.iter().filter(|f| f.source == node) {
            let slot = indegree.get_mut(flow.target.as_str())?;
            *slot -= 1;
            if *slot == 0 {
                ready.push(flow.target.as_str());
            }
        }
    }
    (order.len() == bpmn.nodes.len()).then_some(order)
}

// --- running a diagram ---------------------------------------------------

/// Which nodes fire, for one assignment of the exclusive splits' decisions.
///
/// Whole-execution semantics on an acyclic graph: a flow is active when its
/// source fired and, for an exclusive split, when it is the branch that
/// decision took. A node fires when its incoming flows say so — all of them for
/// a parallel join, any of them for an exclusive or inclusive one. That last
/// clause *is* the inclusive join's semantics here: "no token may still arrive"
/// is decided by looking at the whole finished execution rather than by
/// guessing mid-run.
fn fire(bpmn: &Bpmn, order: &[String], decisions: &BTreeMap<String, String>) -> BTreeSet<String> {
    let mut fired: BTreeSet<String> = BTreeSet::new();
    let mut active: BTreeSet<String> = BTreeSet::new();
    for id in order {
        let node = bpmn.node(id).unwrap();
        let incoming: Vec<&Flow> = bpmn.incoming(id).collect();
        let enters = if incoming.is_empty() {
            node.kind == NodeKind::StartEvent
        } else if node.kind == NodeKind::ParallelGateway && incoming.len() > 1 {
            incoming.iter().all(|f| active.contains(&f.id))
        } else {
            incoming.iter().any(|f| active.contains(&f.id))
        };
        if !enters {
            continue;
        }
        fired.insert(id.clone());
        let outgoing: Vec<&Flow> = bpmn.outgoing(id).collect();
        let decides = node.kind == NodeKind::ExclusiveGateway && outgoing.len() > 1;
        for flow in outgoing {
            let taken = !decides || decisions.get(id) == Some(&flow.id);
            if taken {
                active.insert(flow.id.clone());
            }
        }
    }
    fired
}

/// Every combination of exclusive-split decisions, capped.
fn decision_space(bpmn: &Bpmn, cap: usize) -> Option<Vec<BTreeMap<String, String>>> {
    let splits: Vec<(String, Vec<String>)> = bpmn
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::ExclusiveGateway)
        .filter_map(|n| {
            let out: Vec<String> = bpmn.outgoing(&n.id).map(|f| f.id.clone()).collect();
            (out.len() > 1).then(|| (n.id.clone(), out))
        })
        .collect();
    let total: usize = splits.iter().try_fold(1usize, |acc, (_, o)| acc.checked_mul(o.len()))?;
    if total > cap {
        return None;
    }
    let mut all = vec![BTreeMap::new()];
    for (gateway, branches) in splits {
        let mut grown = Vec::new();
        for base in all {
            for branch in &branches {
                let mut next = base.clone();
                next.insert(gateway.clone(), branch.clone());
                grown.push(next);
            }
        }
        all = grown;
    }
    Some(all)
}

/// The two diagrams fire the same original nodes under every decision.
fn equivalent(original: &Bpmn, replaced: &Bpmn, seed: u64) -> bool {
    let (Some(order_a), Some(order_b)) = (topological(original), topological(replaced)) else {
        return true; // a cyclic diagram is out of scope for this check
    };
    let Some(space) = decision_space(original, 4096) else { return true };
    let original_ids: BTreeSet<String> = original.nodes.iter().map(|n| n.id.clone()).collect();
    for decisions in space {
        let before = fire(original, &order_a, &decisions);
        let after: BTreeSet<String> =
            fire(replaced, &order_b, &decisions).into_iter().filter(|n| original_ids.contains(n)).collect();
        assert_eq!(before, after, "seed {seed}: the replacement fires differently under {decisions:?}");
    }
    true
}

// --- the invariants ------------------------------------------------------

#[test]
fn a_block_structured_model_is_fully_replaceable_and_unchanged_in_meaning() {
    let total = cases(500);
    let mut joins = 0;
    for seed in 0..total as u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        let bpmn = random_diagram(&mut rng, 0);
        assert_eq!(bpmn.validate(), Ok(()), "seed {seed}: generator produced an invalid diagram");

        let out = or_join::replace(&bpmn).unwrap();
        assert_eq!(out.bpmn.validate(), Ok(()), "seed {seed}");
        assert!(
            out.is_complete(),
            "seed {seed}: a block-structured model is locally replaceable, but {:?} was kept",
            out.kept
        );
        assert!(
            or_join::inclusive_gateways(&out.bpmn).is_empty(),
            "seed {seed}: an inclusive gateway survived a complete replacement"
        );
        joins += out.replaced.len();
        equivalent(&bpmn, &out.bpmn, seed);
    }
    assert!(joins > total, "the corpus should contain inclusive joins to replace ({joins})");
}

#[test]
fn a_non_block_structured_model_keeps_its_meaning_too() {
    let total = cases(500);
    let mut replaced = 0;
    let mut kept = 0;
    for seed in 0..total as u64 {
        let mut rng = Rng(seed.wrapping_mul(0xD1B5_4A32_D192_ED03) | 1);
        let shortcuts = 1 + rng.below(3);
        let bpmn = random_diagram(&mut rng, shortcuts);
        if bpmn.validate().is_err() || topological(&bpmn).is_none() {
            continue;
        }
        let out = or_join::replace(&bpmn).unwrap();
        assert_eq!(out.bpmn.validate(), Ok(()), "seed {seed}");
        replaced += out.replaced.len();
        kept += out.kept.len();
        // Completeness is *not* asserted: the paper's whole point is that some
        // inclusive joins have no local replacement. What is asserted is that
        // whatever was replaced still means what it did.
        equivalent(&bpmn, &out.bpmn, seed);
    }
    assert!(replaced > total / 2, "too little was replaced to be testing anything ({replaced})");
    assert!(
        kept > 0,
        "the corpus should also contain joins that cannot be replaced ({kept}); \
         otherwise the refusal path is never exercised"
    );
}

#[test]
fn replacing_twice_changes_nothing_the_second_time() {
    for seed in 0..200u64 {
        let mut rng = Rng(seed.wrapping_mul(0xA24B_AED4_963E_E407) | 1);
        let shortcuts = rng.below(3);
        let bpmn = random_diagram(&mut rng, shortcuts);
        if topological(&bpmn).is_none() {
            continue;
        }
        let once = or_join::replace(&bpmn).unwrap();
        let twice = or_join::replace(&once.bpmn).unwrap();
        assert_eq!(once.bpmn.nodes, twice.bpmn.nodes, "seed {seed}");
        assert_eq!(once.bpmn.flows, twice.bpmn.flows, "seed {seed}");
    }
}


/// The loop these two pieces exist to close: a diagram full of inclusive joins
/// becomes one without them, converts to a Petri net without needing to be
/// block-structured, and comes out **sound** — judged by `soundness-core`, an
/// implementation of the van der Aalst criteria that knows nothing about BPMN
/// and shares no code with this crate.
///
/// The generated models are block-structured processes, which are sound by
/// construction, so anything else would mean one of the two steps changed what
/// the model meant.
#[test]
fn replaced_and_converted_models_are_sound() {
    let total = cases(400);
    let mut checked = 0;
    let mut direct = 0;
    for seed in 0..total as u64 {
        let mut rng = Rng(seed.wrapping_mul(0x94D0_49BB_1331_11EB) | 1);
        let bpmn = random_diagram(&mut rng, 0);
        let replaced = or_join::replace(&bpmn).unwrap();
        assert!(replaced.is_complete(), "seed {seed}: {:?}", replaced.kept);

        if bpmn_core::rpst::structure(&replaced.bpmn).is_err() {
            direct += 1;
        }
        let net = bpmn_core::to_petri_net::to_petri_net(&replaced.bpmn)
            .unwrap_or_else(|e| panic!("seed {seed}: {e}"));

        let json = serde_json::to_string(&net).unwrap();
        let raw: soundness_core::RawNet = serde_json::from_str(&json).unwrap();
        let report = soundness_core::analyse(
            &soundness_core::normalize(raw),
            &soundness_core::Options::default(),
        );
        // Nested parallel blocks multiply out, so a perfectly sound model can
        // have a state space past the checker's budget. That is an honest
        // outcome of the analysis, not a defect in the conversion: what may
        // never happen is an accusation.
        assert_ne!(
            report.summary.verdict,
            soundness_core::report::Verdict::Unsound,
            "seed {seed}: a block-structured model came out unsound after replacement ({})",
            report.findings.iter().map(|f| f.id.as_str()).collect::<Vec<_>>().join(", ")
        );
        if report.behaviour.exploration == "complete" {
            assert_eq!(
                report.summary.verdict,
                soundness_core::report::Verdict::Sound,
                "seed {seed}"
            );
            checked += 1;
        }
    }
    assert!(
        checked > total * 9 / 10,
        "most models should be decidable within the checker's budget ({checked}/{total})"
    );
    let _ = direct;
}

/// The same, for diagrams that genuinely do not nest — where the block-structured
/// synthesis refuses and the direct mapping is the only way through. Soundness
/// is not asserted (a shortcut edge can easily make a model unsound); what is
/// asserted is that the conversion happens at all, and that the net it produces
/// is the one the diagram describes.
#[test]
fn a_model_that_does_not_nest_still_converts() {
    let total = cases(400);
    let mut converted = 0;
    let mut needed_direct = 0;
    for seed in 0..total as u64 {
        let mut rng = Rng(seed.wrapping_mul(0x2545_F491_4F6C_DD1D) | 1);
        let shortcuts = 1 + rng.below(3);
        let bpmn = random_diagram(&mut rng, shortcuts);
        if bpmn.validate().is_err() || topological(&bpmn).is_none() {
            continue;
        }
        let replaced = or_join::replace(&bpmn).unwrap();
        if !replaced.is_complete() {
            continue; // an inclusive join with no local replacement; nothing to convert
        }
        if bpmn_core::rpst::structure(&replaced.bpmn).is_err() {
            needed_direct += 1;
        }
        let net = bpmn_core::to_petri_net::to_petri_net(&replaced.bpmn)
            .unwrap_or_else(|e| panic!("seed {seed}: {e}"));
        assert_eq!(net.initial_marking.len(), 1, "seed {seed}");
        assert_eq!(net.final_marking.len(), 1, "seed {seed}");
        assert!(net.stats.transitions > 0, "seed {seed}");
        converted += 1;
    }
    assert!(converted > total / 4, "too few models converted to be testing anything ({converted})");
    assert!(
        needed_direct > 0,
        "the corpus should contain models the block-structured synthesis refuses ({needed_direct}); \
         otherwise the direct mapping is never exercised"
    );
}
