//! Split Miner — an event log to a BPMN process model, in five steps.
//!
//! ```text
//!   Event log -> DFG and loops -> Concurrency -> Filtering -> Splits -> Joins -> BPMN
//! ```
//!
//! - Augusto, A., Conforti, R., Dumas, M., La Rosa, M. (2017). *Split Miner:
//!   Discovering Accurate and Simple Business Process Models from Event Logs.*
//!   ICDM 2017, 1–10. The algorithms and their numbering follow this paper.
//! - Augusto, A., Conforti, R., Dumas, M., La Rosa, M., Polyvyanyy, A. (2019).
//!   *Split miner: automated discovery of accurate and simple business process
//!   models from event logs.* KAIS 59(2), 251–284.
//! - Augusto, A., Dumas, M., La Rosa, M. (2021). *Automated Discovery of
//!   Process Models with True Concurrency and Inclusive Choices.* ICPM
//!   Workshops, LNBIP 406, 43–56 — the [`Variant::TrueConcurrency`] variant.
//!
//! This is an independent implementation from the papers. The authors' own
//! implementation (`github.com/nemo-91/bpmtk`) is GPL and was deliberately not
//! read or translated; see `docs/licensing.md`.
//!
//! Pure Rust: no wasm, no host types, no JSON boundary. `../../src/lib.rs` is
//! the thin kernel that feeds this crate a chunked event stream and serializes
//! the [`Discovery`] back.
//!
//! ```
//! use split_miner_core::{discover, Params, testing::scan_complete};
//! let log = scan_complete(&[&[0, 1, 2], &[0, 2, 1]], 3);
//! let found = discover(&log, &Params::default());
//! assert_eq!(found.bpmn.validate(), Ok(()));
//! ```

pub mod assemble;
pub mod concurrency;
pub mod dfg;
pub mod filter;
pub mod flow;
pub mod heuristics;
pub mod joins;
pub mod model;
pub mod observe;
pub mod splits;
pub mod testing;

use crate::model::{Gate, Model};
use crate::observe::Observations;
use bpmn_core::Bpmn;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Variant {
    /// Split Miner, as published in 2017/2019.
    Interleaving,
    /// Split Miner 2.0 — the refined directly-follows relation, the overlap
    /// oracle, and the two repair heuristics. Needs a log that records when
    /// activities start as well as when they finish.
    TrueConcurrency,
}

#[derive(Clone, Copy, Debug)]
pub struct Params {
    pub variant: Variant,
    /// ε. In [`Variant::Interleaving`] the largest frequency imbalance two
    /// directions may still show and count as concurrency; in
    /// [`Variant::TrueConcurrency`] the smallest share of executions that must
    /// overlap. Both are in [0, 1], and they are not the same number — the
    /// manifest shows one or the other, never both.
    pub epsilon: f64,
    /// η, the filter percentile.
    pub eta: f64,
}

impl Default for Params {
    fn default() -> Self {
        // The values the paper's own hyper-parameter optimisation settled on
        // across twelve real-life logs: "which turned out to be eps = 0.1,
        // eta = 0.4".
        Self { variant: Variant::Interleaving, epsilon: 0.1, eta: 0.4 }
    }
}

#[derive(Default, Clone, Debug)]
pub struct Stats {
    pub activities: usize,
    pub tasks: usize,
    pub xor_gateways: usize,
    pub and_gateways: usize,
    pub or_gateways: usize,
    pub flows: usize,
    pub concurrent_pairs: usize,
    pub self_loops: usize,
    pub short_loops: usize,
    pub arcs_before_filter: usize,
    pub arcs_after_filter: usize,
    pub filter_threshold: f64,
    pub dropped_activities: usize,
    pub or_joins: usize,
    pub loop_edges_repaired: usize,
    pub inclusive_splits: usize,
    pub cases: u32,
    pub events: u32,
}

pub struct Discovery {
    pub bpmn: Bpmn,
    pub stats: Stats,
    pub warnings: Vec<String>,
}

/// Whether the end event is reachable from the start event.
fn reaches_sink(model: &Model) -> bool {
    let mut seen = std::collections::BTreeSet::from([model.source()]);
    let mut queue = vec![model.source()];
    while let Some(node) = queue.pop() {
        if node == model.sink() {
            return true;
        }
        for next in model.successors(node) {
            if seen.insert(next) {
                queue.push(next);
            }
        }
    }
    false
}

pub fn discover(obs: &Observations, params: &Params) -> Discovery {
    let mut warnings = Vec::new();
    let true_concurrency = params.variant == Variant::TrueConcurrency;
    if true_concurrency {
        // Split Miner 2.0 needs a start *and* an end for every activity: its
        // directly-follows relation is "started after the other ended", so an
        // activity that is only ever recorded as a completion can never be the
        // target of one, and drops out of the graph entirely. The 2021 paper
        // requires exactly this of its own logs. Half-annotated logs are
        // common enough (BPI Challenge 2012 records a life-cycle for its `W_`
        // activities and nothing else) that saying so is the difference
        // between a puzzling empty model and a clear answer.
        let unstarted: Vec<&str> = (0..obs.activity_count)
            .filter(|&a| obs.counts[a] > 0 && obs.complete_lifecycles[a] == 0)
            .map(|a| obs.name(a))
            .collect();
        let recorded = (0..obs.activity_count).filter(|&a| obs.counts[a] > 0).count();
        if !obs.has_lifecycle {
            warnings.push(
                "Split Miner 2.0 reads concurrency from activities whose executions overlap in time, and this log records only one event per activity \u{2014} there are no start events to overlap. The result is what the 2.0 pipeline makes of a log it cannot measure, not a fallback to the original algorithm; pick Split Miner for that."
                    .into(),
            );
        } else if !unstarted.is_empty() {
            let shown: Vec<&str> = unstarted.iter().take(6).copied().collect();
            warnings.push(format!(
                "{} of {} activities are recorded only as completions, with no start event: {}{}. Split Miner 2.0 needs both for every activity \u{2014} an activity that never starts can never follow anything under its directly-follows relation, so these drop out of the graph. Use Split Miner on this log, or a log with complete life-cycles.",
                unstarted.len(),
                recorded,
                shown.join(", "),
                if unstarted.len() > shown.len() { ", \u{2026}" } else { "" },
            ));
        }
    }

    // 1. DFG and loops.
    let relation = if true_concurrency { dfg::Relation::Refined } else { dfg::Relation::Classic };
    let mut graph = dfg::build(obs, relation);
    let self_loops: Vec<usize> = graph.self_loops.keys().copied().collect();
    let short_loops: Vec<(usize, usize)> = graph.short_loops.keys().copied().collect();
    let arcs_before_filter = graph.edges.len();

    // 2. Concurrency.
    let conc = if true_concurrency {
        concurrency::discover_true(obs, params.epsilon)
    } else {
        concurrency::discover_classic(obs, &graph, params.epsilon)
    };
    concurrency::prune(&mut graph, &conc);

    // 3. Filtering.
    let filtered = filter::filter(&graph, params.eta);
    if !filtered.dropped.is_empty() {
        let names: Vec<&str> = filtered.dropped.iter().map(|&a| obs.name(a)).collect();
        warnings.push(format!(
            "{} activit{} left with no path from start to end after filtering and {} dropped: {}. Lower the filter percentile to keep {}.",
            filtered.dropped.len(),
            if filtered.dropped.len() == 1 { "y was" } else { "ies were" },
            if filtered.dropped.len() == 1 { "was" } else { "were" },
            names.join(", "),
            if filtered.dropped.len() == 1 { "it" } else { "them" },
        ));
    }

    // The model starts as the filtered graph with the loops put back, so the
    // split and join steps give them gateways. The paper says loops are
    // "restored in the output BPMN model at the end"; restoring them after
    // join discovery would leave every loop without the routing that makes it
    // a loop, so "the end" is read here as the end of the *graph* pipeline.
    let mut model = Model::new(graph.n);
    model.edges = filtered.dfg.edges.keys().copied().collect();
    let surviving = model.nodes();
    for &a in &self_loops {
        if surviving.contains(&a) {
            model.edges.insert((a, a));
            model.self_loops.insert(a);
        }
    }
    for &(a, b) in &short_loops {
        if surviving.contains(&a) && surviving.contains(&b) {
            model.edges.insert((a, b));
        }
    }

    // Filtering can leave the graph with no path from start to end at all —
    // an empty log, or a log whose only arcs form a component the sink is not
    // in. Property (1) then holds vacuously and the remaining steps produce a
    // start event, an end event and nothing joining them, which is not a
    // process model. An empty process is: it says "no behaviour could be
    // retained", which is the truth, and it is still a diagram every consumer
    // downstream can read.
    if !reaches_sink(&model) {
        let (source, sink) = (model.source(), model.sink());
        model.edges.retain(|&(a, b)| a != source && b != sink);
        model.edges.insert((source, sink));
        warnings.push(
            "no path from the first activity to the last survived filtering, so the diagram is an empty process. Lower the filter percentile."
                .into(),
        );
    }

    // 4. Splits.
    for node in model.nodes() {
        let successors = model.successors(node);
        if successors.len() > 1 {
            if let Some(warning) = splits::discover(&mut model, node, &successors, &conc) {
                warnings.push(warning);
            }
        }
    }

    // 5. Joins.
    let discovered_joins = joins::discover(&mut model);

    let mut loop_edges_repaired = 0;
    let mut inclusive_splits = 0;
    if true_concurrency {
        loop_edges_repaired = heuristics::repair_loop_edges(&mut model);
        inclusive_splits = heuristics::promote_inclusive_splits(&mut model, obs);
    }
    // Always, not only after the heuristics: a gateway that routes nothing is
    // never wanted, and running the pass unconditionally means one guarantee
    // holds for both variants instead of one each.
    heuristics::tidy(&mut model);

    let gate_counts = |kind: Gate| {
        model.nodes().into_iter().filter(|&n| model.gate(n) == Some(kind)).count()
    };
    let stats = Stats {
        activities: obs.activity_count,
        tasks: model.nodes().into_iter().filter(|&n| model.is_activity(n)).count(),
        xor_gateways: gate_counts(Gate::Xor),
        and_gateways: gate_counts(Gate::And),
        or_gateways: gate_counts(Gate::Or),
        flows: model.edges.len(),
        concurrent_pairs: conc.count(),
        self_loops: self_loops.len(),
        short_loops: short_loops.len(),
        arcs_before_filter,
        arcs_after_filter: filtered.dfg.edges.len(),
        filter_threshold: filtered.threshold,
        dropped_activities: filtered.dropped.len(),
        or_joins: discovered_joins.or_joins,
        loop_edges_repaired,
        inclusive_splits,
        cases: obs.cases,
        events: obs.events,
    };

    let bpmn = assemble::to_bpmn(&model, obs, warnings.clone());
    Discovery { bpmn, stats, warnings }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observe::Phase::{Complete, Start};
    use crate::testing::{as_refs, scan, scan_complete};
    use bpmn_core::NodeKind;

    /// Whether `to` is reachable from `from` by following sequence flows. A
    /// one-node round trip counts, which is what makes it a loop test.
    fn reaches(bpmn: &Bpmn, from: &str, to: &str) -> bool {
        let mut seen: Vec<String> = Vec::new();
        let mut queue: Vec<String> = bpmn.outgoing(from).map(|f| f.target.clone()).collect();
        while let Some(node) = queue.pop() {
            if node == to {
                return true;
            }
            if seen.contains(&node) {
                continue;
            }
            seen.push(node.clone());
            queue.extend(bpmn.outgoing(&node).map(|f| f.target.clone()));
        }
        false
    }

    fn run(obs: &Observations, params: Params) -> Discovery {
        let found = discover(obs, &params);
        assert_eq!(found.bpmn.validate(), Ok(()), "every discovery must be a valid diagram");
        found
    }

    #[test]
    fn a_pure_sequence_has_no_gateways() {
        let found = run(&scan_complete(&[&[0, 1, 2]], 3), Params::default());
        assert_eq!(found.stats.tasks, 3);
        assert_eq!(found.stats.xor_gateways + found.stats.and_gateways + found.stats.or_gateways, 0);
        assert_eq!(found.stats.flows, 4, "start -> a -> b -> c -> end");
    }

    #[test]
    fn an_exclusive_choice_becomes_a_xor_split_and_a_xor_join() {
        // a then (b or c) then d.
        let traces = vec![vec![0, 1, 3], vec![0, 2, 3]];
        let found = run(&scan_complete(&as_refs(&traces), 4), Params { eta: 0.0, ..Params::default() });
        assert_eq!(found.stats.xor_gateways, 2);
        assert_eq!(found.stats.and_gateways, 0);
        assert_eq!(found.stats.or_gateways, 0);
    }

    #[test]
    fn interleaved_activities_become_an_and_block() {
        let traces = vec![vec![0, 1, 2, 3], vec![0, 2, 1, 3]];
        let found = run(&scan_complete(&as_refs(&traces), 4), Params { eta: 0.0, ..Params::default() });
        assert_eq!(found.stats.concurrent_pairs, 1);
        assert_eq!(found.stats.and_gateways, 2, "an AND-split and its AND-join");
        assert_eq!(found.stats.xor_gateways, 0);
    }

    #[test]
    fn a_self_loop_survives_into_the_diagram() {
        let traces = vec![vec![0, 1, 1, 2]];
        let found = run(&scan_complete(&as_refs(&traces), 3), Params { eta: 0.0, ..Params::default() });
        assert_eq!(found.stats.self_loops, 1);
        let task = found.bpmn.nodes.iter().find(|n| n.label.as_deref() == Some("activity 1")).unwrap();

        // Restored before the gateways are discovered, so the repeat is routed
        // rather than left as a second flow out of the task itself — which in
        // BPMN would read as an implicit parallel split, and would not be a
        // loop at all. The task is therefore no longer its own successor, but
        // a path from it back to itself has to exist.
        assert!(!found.bpmn.outgoing(&task.id).any(|f| f.target == task.id));
        assert!(reaches(&found.bpmn, &task.id, &task.id), "the repeat has to still be a loop");
        assert!(found.stats.xor_gateways >= 1, "taking the loop again is a choice");
        let gateways = found.stats.xor_gateways + found.stats.and_gateways + found.stats.or_gateways;
        assert!(gateways >= 2, "a loop needs both a way back in and a way out");
    }

    #[test]
    fn a_short_loop_is_not_mistaken_for_concurrency() {
        let traces = vec![vec![0, 1, 2, 1, 3], vec![0, 1, 2, 1, 2, 1, 3]];
        let found = run(&scan_complete(&as_refs(&traces), 4), Params { eta: 0.0, ..Params::default() });
        assert_eq!(found.stats.concurrent_pairs, 0);
        assert_eq!(found.stats.short_loops, 1);
        assert_eq!(found.stats.and_gateways, 0);
    }

    #[test]
    fn true_concurrency_finds_what_interleaving_cannot() {
        // b and c overlap in every case, but b almost always finishes first.
        // Interleaving therefore sees a 9-to-1 ordering and calls it a
        // sequence; the life-cycle oracle sees the overlap and calls it
        // concurrency. That gap is the whole of Split Miner 2.0.
        let usual = [
            (0, Start), (0, Complete),
            (1, Start), (2, Start), (1, Complete), (2, Complete),
            (3, Start), (3, Complete),
        ];
        let rare = [
            (0, Start), (0, Complete),
            (1, Start), (2, Start), (2, Complete), (1, Complete),
            (3, Start), (3, Complete),
        ];
        let mut traces: Vec<&[(usize, crate::observe::Phase)]> = vec![&usual; 9];
        traces.push(&rare);
        let obs = scan(&traces, 4);
        let classic = run(&obs, Params { eta: 0.0, ..Params::default() });
        assert_eq!(classic.stats.concurrent_pairs, 0, "a 9-to-1 ordering is not interleaving");

        let refined = run(
            &obs,
            Params { variant: Variant::TrueConcurrency, epsilon: 0.5, eta: 0.0 },
        );
        assert_eq!(refined.stats.concurrent_pairs, 1);
        assert!(refined.stats.and_gateways >= 1);
    }

    #[test]
    fn asking_for_true_concurrency_without_lifecycles_says_so() {
        let obs = scan_complete(&[&[0, 1]], 2);
        let found = run(&obs, Params { variant: Variant::TrueConcurrency, ..Params::default() });
        assert!(
            found.warnings.iter().any(|w| w.contains("no start events")),
            "got {:?}",
            found.warnings
        );
    }

    #[test]
    fn a_half_annotated_log_names_the_activities_that_never_start() {
        // `a` has a full life-cycle; `b` is only ever a completion — the shape
        // BPI Challenge 2012 has, and the reason Split Miner 2.0 makes nothing
        // of it.
        let trace = [(0, Start), (0, Complete), (1, Complete)];
        let obs = scan(&[&trace], 2);
        let found = run(&obs, Params { variant: Variant::TrueConcurrency, ..Params::default() });
        let warning = found
            .warnings
            .iter()
            .find(|w| w.contains("recorded only as completions"))
            .unwrap_or_else(|| panic!("got {:?}", found.warnings));
        assert!(warning.contains("1 of 2 activities"), "{warning}");
        assert!(warning.contains("activity 1"), "{warning}");
    }

    #[test]
    fn filtering_reports_the_activities_it_had_to_drop() {
        // One rare, isolated detour among many copies of the main path.
        let mut traces = crate::testing::repeat(&[0, 1, 4], 200);
        traces.push(vec![0, 2, 3, 4]);
        let found = run(&scan_complete(&as_refs(&traces), 5), Params { eta: 1.0, ..Params::default() });
        if found.stats.dropped_activities > 0 {
            assert!(found.warnings.iter().any(|w| w.contains("no path from start to end")));
        }
        // Whatever was dropped, what remains is still a usable diagram.
        assert_eq!(found.bpmn.validate(), Ok(()));
    }

    #[test]
    fn the_same_log_always_yields_the_same_diagram() {
        let traces = vec![vec![0, 1, 2, 3], vec![0, 2, 1, 3], vec![0, 1, 3]];
        let obs = scan_complete(&as_refs(&traces), 4);
        let a = discover(&obs, &Params::default());
        let b = discover(&obs, &Params::default());
        assert_eq!(a.bpmn, b.bpmn);
    }

    #[test]
    fn an_empty_log_still_produces_a_diagram() {
        let obs = scan_complete(&[], 0);
        let found = run(&obs, Params::default());
        assert_eq!(found.stats.tasks, 0);
        assert!(found.bpmn.nodes.iter().any(|n| n.kind == NodeKind::StartEvent));
    }
}
