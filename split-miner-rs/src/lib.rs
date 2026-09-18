//! The wasm boundary for `run.promenade.split-miner.discover`.
//!
//! Everything algorithmic lives in `split-miner-core`; this file is only the
//! edge — the host's `scan-finalize/1` ABI on one side, typed Rust values on
//! the other.
//!
//! The action declares `kernel.scan.classifier: activityLifecycle`, so the
//! classifier values the host hands over are not activities but
//! *activity-and-life-cycle-state* pairs, encoded `name U+001F state`. That is
//! the only way a wasm kernel gets to see life-cycles at all, and Split Miner
//! 2.0 is entirely about them. [`decode`] splits them back apart into the
//! activity numbering the model uses and the phase the scanner needs.
//!
//! A log with no `lifecycle:transition` attribute arrives with every value
//! mapped to `complete`, so the same decoding covers it with no special case —
//! and `has_lifecycle` records the difference, because "no concurrency found"
//! and "nothing to look at" are different answers.

use serde::{Deserialize, Serialize};
use split_miner_core::observe::{Phase, Scanner};
use split_miner_core::{discover, Params, Stats, Variant};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

/// The separator the host puts between an activity and its life-cycle state.
const UNIT_SEPARATOR: char = '\u{1f}';

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoverParams {
    #[serde(default)]
    variant: String,
    #[serde(default = "default_epsilon")]
    epsilon: f64,
    #[serde(default = "default_eta")]
    eta: f64,
    /// Only read when `variant` is `sm2` — the manifest shows one slider or
    /// the other, because the two are not the same quantity.
    #[serde(default = "default_overlap")]
    overlap: f64,
}

fn default_epsilon() -> f64 {
    Params::default().epsilon
}
fn default_eta() -> f64 {
    Params::default().eta
}
fn default_overlap() -> f64 {
    0.5
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatsOut {
    activities: usize,
    tasks: usize,
    gateways: usize,
    xor_gateways: usize,
    and_gateways: usize,
    or_gateways: usize,
    or_joins: usize,
    flows: usize,
    concurrent_pairs: usize,
    self_loops: usize,
    short_loops: usize,
    arcs_before_filter: usize,
    arcs_after_filter: usize,
    filter_threshold: f64,
    dropped_activities: usize,
    loop_edges_repaired: usize,
    inclusive_splits: usize,
    variant: String,
    epsilon: f64,
    eta: f64,
    traces: u32,
    events: u32,
}

impl StatsOut {
    fn from(stats: &Stats, params: &Params) -> Self {
        Self {
            activities: stats.activities,
            tasks: stats.tasks,
            gateways: stats.xor_gateways + stats.and_gateways + stats.or_gateways,
            xor_gateways: stats.xor_gateways,
            and_gateways: stats.and_gateways,
            or_gateways: stats.or_gateways,
            or_joins: stats.or_joins,
            flows: stats.flows,
            concurrent_pairs: stats.concurrent_pairs,
            self_loops: stats.self_loops,
            short_loops: stats.short_loops,
            arcs_before_filter: stats.arcs_before_filter,
            arcs_after_filter: stats.arcs_after_filter,
            filter_threshold: stats.filter_threshold,
            dropped_activities: stats.dropped_activities,
            loop_edges_repaired: stats.loop_edges_repaired,
            inclusive_splits: stats.inclusive_splits,
            variant: match params.variant {
                Variant::Interleaving => "sm1".into(),
                Variant::TrueConcurrency => "sm2".into(),
            },
            epsilon: params.epsilon,
            eta: params.eta,
            traces: stats.cases,
            events: stats.events,
        }
    }
}

/// The `Bpmn` artifact payload plus the kernel's own `stats`, which the host
/// lifts into the artifact's `meta`.
///
/// Written out field by field rather than with `#[serde(flatten)]` on
/// `bpmn_core::Bpmn`: serde-wasm-bindgen drops an enum tag out of a flattened
/// struct, and every node in here carries a `kind`.
#[derive(Serialize)]
struct Payload {
    nodes: Vec<bpmn_core::Node>,
    flows: Vec<bpmn_core::Flow>,
    metadata: bpmn_core::Metadata,
    stats: StatsOut,
}

/// `name U+001F state` -> `(name, phase)`. A value with no separator is an
/// activity with no recorded life-cycle, which is a completion.
fn decode(value: &str) -> (&str, Phase) {
    match value.split_once(UNIT_SEPARATOR) {
        Some((name, "start")) => (name, Phase::Start),
        Some((name, "enqueue")) => (name, Phase::Enqueue),
        Some((name, _)) => (name, Phase::Complete),
        None => (value, Phase::Complete),
    }
}

/// One pass over the ordered event stream, building everything both variants
/// need. Cached by the host per (log, activity limit).
#[wasm_bindgen]
pub struct SplitMinerScan {
    /// Classifier value id -> (activity id, phase). Empty until the host has
    /// delivered the names.
    mapping: Vec<(usize, Phase)>,
    names: Vec<String>,
    scanner: Option<Scanner>,
    values: usize,
    last_case: i32,
    started: bool,
    has_lifecycle: bool,
}

#[wasm_bindgen]
impl SplitMinerScan {
    #[wasm_bindgen(constructor)]
    pub fn new(n_values: usize) -> SplitMinerScan {
        SplitMinerScan {
            mapping: Vec::new(),
            names: Vec::new(),
            scanner: None,
            values: n_values,
            last_case: i32::MIN,
            started: false,
            has_lifecycle: false,
        }
    }

    /// Classifier values, in id order. Called by the host before any chunk.
    #[wasm_bindgen(js_name = setActivityNames)]
    pub fn set_activity_names(&mut self, values: Vec<String>) {
        let mut ids: HashMap<String, usize> = HashMap::new();
        let mut mapping = Vec::with_capacity(values.len());
        let mut names = Vec::new();
        let mut has_lifecycle = false;
        for value in &values {
            let (name, phase) = decode(value);
            if phase != Phase::Complete {
                has_lifecycle = true;
            }
            let next = ids.len();
            let id = *ids.entry(name.to_string()).or_insert_with(|| {
                names.push(name.to_string());
                next
            });
            mapping.push((id, phase));
        }
        self.mapping = mapping;
        self.names = names;
        self.has_lifecycle = has_lifecycle;
    }

    fn scanner_mut(&mut self) -> &mut Scanner {
        if self.scanner.is_none() {
            // No names delivered: every classifier value is its own activity,
            // every event a completion. That is exactly a log with no
            // life-cycle attribute, so nothing below needs a second path.
            if self.mapping.is_empty() {
                self.mapping = (0..self.values).map(|i| (i, Phase::Complete)).collect();
                self.names = (0..self.values).map(|i| format!("activity {i}")).collect();
            }
            let mut scanner = Scanner::new(self.names.len());
            scanner.set_names(self.names.clone());
            scanner.set_has_lifecycle(self.has_lifecycle);
            self.scanner = Some(scanner);
        }
        self.scanner.as_mut().unwrap()
    }

    /// One ordered chunk of `(case, classifier value)` pairs. A negative value
    /// marks a case with no events; the case boundary still counts.
    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, cases: &[i32], values: &[i32]) {
        let len = cases.len().min(values.len());
        for i in 0..len {
            let (case, value) = (cases[i], values[i]);
            if !self.started || case != self.last_case {
                self.scanner_mut().begin_case();
                self.last_case = case;
                self.started = true;
            }
            if value < 0 {
                continue;
            }
            if let Some(&(activity, phase)) = self.mapping.get(value as usize) {
                self.scanner_mut().push(activity, phase);
            }
        }
    }

    pub fn finish(&mut self) {}

    #[wasm_bindgen(js_name = rowCount)]
    pub fn row_count(&self) -> u32 {
        self.scanner.as_ref().map_or(0, Scanner::event_count)
    }

    #[wasm_bindgen(js_name = caseCount)]
    pub fn case_count(&self) -> u32 {
        self.scanner.as_ref().map_or(0, Scanner::case_count)
    }

    /// Runs the five steps on the scan. Cheap enough to drive from a slider —
    /// it never touches the events again.
    pub fn finalize(&mut self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: DiscoverParams =
            serde_wasm_bindgen::from_value(params).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let true_concurrency = p.variant == "sm2";
        let settings = Params {
            variant: if true_concurrency { Variant::TrueConcurrency } else { Variant::Interleaving },
            epsilon: if true_concurrency { p.overlap } else { p.epsilon }.clamp(0.0, 1.0),
            eta: p.eta.clamp(0.0, 1.0),
        };

        // `finalize` can be called more than once for one scan — that is the
        // point of the two stages — so the observations are cloned out rather
        // than consumed.
        let scanner = self.scanner_mut();
        scanner.end_case();
        let observations = scanner.observations();

        let found = discover(&observations, &settings);
        let payload = Payload {
            nodes: found.bpmn.nodes,
            flows: found.bpmn.flows,
            metadata: found.bpmn.metadata,
            stats: StatsOut::from(&found.stats, &settings),
        };
        serde_wasm_bindgen::to_value(&payload).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifier_values_split_into_activity_and_phase() {
        assert_eq!(decode("Pay\u{1f}start"), ("Pay", Phase::Start));
        assert_eq!(decode("Pay\u{1f}complete"), ("Pay", Phase::Complete));
        assert_eq!(decode("Pay\u{1f}enqueue"), ("Pay", Phase::Enqueue));
        assert_eq!(decode("Pay\u{1f}suspend"), ("Pay", Phase::Complete), "unknown states complete");
        assert_eq!(decode("Pay"), ("Pay", Phase::Complete));
    }

    #[test]
    fn two_lifecycle_values_of_one_activity_share_an_id() {
        let mut scan = SplitMinerScan::new(3);
        scan.set_activity_names(vec![
            "Pay\u{1f}start".into(),
            "Pay\u{1f}complete".into(),
            "Ship\u{1f}complete".into(),
        ]);
        assert_eq!(scan.mapping, vec![(0, Phase::Start), (0, Phase::Complete), (1, Phase::Complete)]);
        assert_eq!(scan.names, vec!["Pay".to_string(), "Ship".to_string()]);
        assert!(scan.has_lifecycle);
    }

    #[test]
    fn a_log_without_lifecycles_says_so() {
        let mut scan = SplitMinerScan::new(2);
        scan.set_activity_names(vec!["a\u{1f}complete".into(), "b\u{1f}complete".into()]);
        assert!(!scan.has_lifecycle);
    }
}
