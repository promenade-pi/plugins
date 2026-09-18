//! Promenade WASM kernel for the Inductive Miner.
//!
//! Everything algorithmic lives in `inductive-miner-core`; this file is the
//! boundary — the host's `scan-finalize/1` ABI on one side, activity ids and a
//! process tree on the other.
//!
//! ```text
//!   new InductiveScan(nActivities)
//!   .setActivityNames(names)                  optional; labels for the tree
//!   .pushChunk(Int32Array cases, Int32Array activities)
//!   .finish()
//!   .finalize({variant, noiseThreshold})  ->  ProcessTree payload
//! ```
//!
//! The scan is the parameter-independent stage the host caches, and it does the
//! one thing worth doing once: collapsing the event stream into trace variants.
//! Unlike the DFG or Alpha kernels, though, the **expensive** stage here is
//! `finalize` — the recursion is the algorithm. The manifest says so, and does
//! not mark the noise threshold as cheap.

use inductive_miner_core::{
    discover_with, tree::Tree, EventLog, Parameters, TraceVariant, Variant,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

/// Not a correctness bound — the recursion handles any alphabet — but a
/// pathological log should not spend minutes inside a worker.
///
/// Set from measurement, not by analogy. A *well-structured* log of 10 000
/// activities discovers in about a second and 49 MB. What actually costs is
/// how little structure the log has: once no cut applies, the fall-throughs
/// peel one activity per recursion level and each level runs a quadratic
/// parallel-cut test, so an unstructured log of 2 000 activities already takes
/// seconds — with only 1 900 events in it. Alphabet size is a crude proxy for
/// that, but it is the only one available before the log is read.
pub const MAX_ACTIVITIES: usize = 10_000;

// -------------------------------------------------------- tree payload

/// The host's `ProcessTree` contract: a flat node array with index references.
#[derive(Serialize)]
pub struct TreeNode {
    pub operator: Option<&'static str>,
    pub label: Option<String>,
    pub children: Vec<u32>,
}

#[derive(Serialize)]
pub struct ProcessTreePayload {
    pub root: u32,
    pub nodes: Vec<TreeNode>,
    pub activities: Vec<String>,
    pub stats: Stats,
}

#[derive(Serialize)]
pub struct Stats {
    pub nodes: usize,
    pub leaves: usize,
    pub silent: usize,
    pub operators: usize,
    pub variant: &'static str,
    #[serde(rename = "noiseThreshold")]
    pub noise_threshold: f64,
    pub traces: u64,
    pub events: u64,
    #[serde(rename = "traceVariants")]
    pub trace_variants: usize,
    pub activities: usize,
    #[serde(rename = "recursionNodes")]
    pub nodes_visited: u64,
    /// Set when activities had to be dropped to stay inside the kernel's
    /// bound. A truncated run is not a smaller run — a missing activity can
    /// remove a whole branch — so it is reported rather than left to look
    /// like a complete one.
    #[serde(rename = "activitiesDropped", skip_serializing_if = "is_zero")]
    pub activities_dropped: usize,
}

fn is_zero(v: &usize) -> bool {
    *v == 0
}

fn flatten(tree: &Tree, names: &[String], out: &mut Vec<TreeNode>) -> u32 {
    let me = out.len() as u32;
    let (operator, label) = match tree {
        Tree::Tau => (None, None),
        Tree::Activity(a) => (
            None,
            Some(
                names
                    .get(*a as usize)
                    .cloned()
                    .unwrap_or_else(|| format!("activity {a}")),
            ),
        ),
        Tree::Xor(_) => (Some("xor"), None),
        Tree::Sequence(_) => (Some("sequence"), None),
        Tree::Parallel(_) => (Some("parallel"), None),
        Tree::Loop(_) => (Some("loop"), None),
    };
    out.push(TreeNode {
        operator,
        label,
        children: Vec::new(),
    });

    let children = tree.children();
    // ↺(B, R, τ) ≡ ↺(B, R): the exit child is always tau for IM/IMf, and the
    // artifact carries the standard process-tree loop — body first, redo
    // branches after.
    let children = match tree {
        Tree::Loop(c) if c.len() == 3 && c[2].is_tau() => &children[..2],
        _ => children,
    };

    let kids: Vec<u32> = children.iter().map(|c| flatten(c, names, out)).collect();
    out[me as usize].children = kids;
    me
}

fn payload(tree: &Tree, names: &[String], stats_seed: StatsSeed) -> ProcessTreePayload {
    let mut nodes = Vec::new();
    let root = flatten(tree, names, &mut nodes);

    let mut used: Vec<String> = nodes.iter().filter_map(|n| n.label.clone()).collect();
    used.sort();
    used.dedup();

    let leaves = nodes.iter().filter(|n| n.operator.is_none()).count();
    let silent = nodes
        .iter()
        .filter(|n| n.operator.is_none() && n.label.is_none())
        .count();

    ProcessTreePayload {
        root,
        stats: Stats {
            nodes: nodes.len(),
            leaves,
            silent,
            operators: nodes.len() - leaves,
            variant: stats_seed.variant,
            noise_threshold: stats_seed.noise_threshold,
            traces: stats_seed.traces,
            events: stats_seed.events,
            trace_variants: stats_seed.trace_variants,
            activities: used.len(),
            nodes_visited: stats_seed.nodes_visited,
            activities_dropped: stats_seed.activities_dropped,
        },
        nodes,
        activities: used,
    }
}

struct StatsSeed {
    variant: &'static str,
    noise_threshold: f64,
    traces: u64,
    events: u64,
    trace_variants: usize,
    nodes_visited: u64,
    activities_dropped: usize,
}

// -------------------------------------------------------------- kernel

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Params {
    #[serde(default)]
    variant: Option<String>,
    #[serde(default)]
    noise_threshold: Option<f64>,
}

#[wasm_bindgen]
pub struct InductiveScan {
    n_activities: usize,
    /// How many activities the host offered beyond what this kernel accepts.
    over_limit: usize,
    names: Vec<String>,
    /// Trace under construction; the host chunks the event stream, so a case
    /// can straddle a chunk boundary.
    open_case: i32,
    open_trace: Vec<u32>,
    variants: HashMap<Vec<u32>, u64>,
    rows: u32,
    cases: u32,
    started: bool,
}

#[wasm_bindgen]
impl InductiveScan {
    /// The host filters to the most frequent activities before the scan, so
    /// receiving more than the bound means the two disagree about the limit.
    /// That is recorded and reported rather than absorbed: quietly dropping
    /// activities produces a model that is wrong in a way nothing downstream
    /// can detect.
    #[wasm_bindgen(constructor)]
    pub fn new(n_activities: usize) -> InductiveScan {
        InductiveScan {
            over_limit: n_activities.saturating_sub(MAX_ACTIVITIES),
            n_activities: n_activities.min(MAX_ACTIVITIES),
            names: Vec::new(),
            open_case: -1,
            open_trace: Vec::new(),
            variants: HashMap::new(),
            rows: 0,
            cases: 0,
            started: false,
        }
    }

    /// Activity labels, in activity-id order. Optional: without them the tree
    /// still comes out, with placeholder labels.
    #[wasm_bindgen(js_name = setActivityNames)]
    pub fn set_activity_names(&mut self, names: Vec<String>) {
        self.names = names;
    }

    /// One ordered chunk of `(case, activity)` pairs.
    ///
    /// Rows must arrive grouped by case and in log order within a case — the
    /// host's SQL guarantees both.
    ///
    /// A negative activity id marks a case with no events. The case boundary is
    /// therefore handled *before* the id is checked: skipping the row outright
    /// would lose the empty trace, and an empty trace is the evidence that a
    /// block is optional.
    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, cases: &[i32], activities: &[i32]) {
        let n = cases.len().min(activities.len());
        for i in 0..n {
            let (case, activity) = (cases[i], activities[i]);
            if !self.started || case != self.open_case {
                if self.started {
                    self.close_case();
                }
                self.started = true;
                self.open_case = case;
                self.cases += 1;
            }
            if activity < 0 || activity as usize >= self.n_activities {
                continue;
            }
            self.open_trace.push(activity as u32);
            self.rows += 1;
        }
    }

    pub fn finish(&mut self) {
        if self.started {
            self.close_case();
            self.started = false;
        }
    }

    #[wasm_bindgen(js_name = rowCount)]
    pub fn row_count(&self) -> u32 {
        self.rows
    }

    #[wasm_bindgen(js_name = caseCount)]
    pub fn case_count(&self) -> u32 {
        self.cases
    }

    /// The parameter-dependent stage: the whole recursion.
    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: Params = serde_wasm_bindgen::from_value(params).unwrap_or_default();
        let variant = match p.variant.as_deref() {
            Some("IM") => Variant::IM,
            _ => Variant::IMf,
        };
        let noise = p.noise_threshold.unwrap_or(0.0);

        let log = EventLog {
            variants: self
                .sorted_variants()
                .into_iter()
                .map(|(events, count)| TraceVariant { events, count })
                .collect(),
        };

        let parameters = Parameters {
            variant,
            noise_threshold: noise,
            ..Parameters::default()
        };

        let discovery = discover_with(&log, &parameters, &|| false, &|_| {})
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        let seed = StatsSeed {
            variant: match variant {
                Variant::IM => "IM",
                Variant::IMf => "IMf",
            },
            noise_threshold: match variant {
                Variant::IM => 0.0,
                Variant::IMf => noise,
            },
            traces: log.trace_count(),
            events: log.event_count(),
            trace_variants: log.variants.len(),
            nodes_visited: discovery.nodes_visited,
            activities_dropped: self.over_limit,
        };

        serde_wasm_bindgen::to_value(&payload(&discovery.tree, &self.names, seed))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

impl InductiveScan {
    fn close_case(&mut self) {
        let trace = std::mem::take(&mut self.open_trace);
        *self.variants.entry(trace).or_insert(0) += 1;
    }

    /// Variants in a fixed order, so that a re-run produces byte-identical
    /// output. A `HashMap` iterates unpredictably, and the recursion is not
    /// entirely order-blind at the boundaries where ties are broken.
    fn sorted_variants(&self) -> Vec<(Vec<u32>, u64)> {
        let mut v: Vec<(Vec<u32>, u64)> = self
            .variants
            .iter()
            .map(|(k, &c)| (k.clone(), c))
            .collect();
        v.sort_unstable();
        v
    }
}
