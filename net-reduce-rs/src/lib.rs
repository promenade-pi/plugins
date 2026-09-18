//! The wasm boundary for `run.promenade.net-reduce.reduce`.
//!
//! Everything algorithmic lives in `net-reduce-core`; this file is only the
//! edge — the host's generic `value-finalize/1` ABI on one side (see
//! `plugins/soundness-rs/src/lib.rs` for the template this follows), typed
//! Rust values on the other.
//!
//! A model-to-model action: an `AcceptingPetriNet` in, a smaller
//! `AcceptingPetriNet` out, with the report of what was removed carried in the
//! same payload so the artifact can say what happened to it.

use net_reduce_core::model::PetriNetPayload;
use net_reduce_core::{reduce, Options, Report};
use serde::{Deserialize, Serialize};
use soundness_core::{normalize, RawNet};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReduceParams {
    /// The `AcceptingPetriNet` payload the host resolved from the input slot.
    input_value: RawNet,
    #[serde(default)]
    input_meta: InputMeta,
    // Named for what they do rather than for the rule family, and prefixed:
    // the host substitutes an input artifact's `meta` for any param of the
    // same name, and a net's meta is full of words like `silent`.
    #[serde(default = "yes")]
    drop_silent: bool,
    #[serde(default = "yes")]
    fuse_series: bool,
    #[serde(default = "yes")]
    fuse_parallel: bool,
    #[serde(default = "yes")]
    drop_self_loops: bool,
    #[serde(default = "yes")]
    drop_implicit: bool,
}

fn yes() -> bool {
    true
}

/// What the catalog knows about the input that its payload does not.
///
/// The Alpha Miner's net carries bare activity ids and keeps the names in
/// `meta.activityNames`; without them a reduced net would be labelled `#3`,
/// and the reduction would have quietly thrown away the only copy of the
/// names by rewriting the payload into the self-sufficient shape.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct InputMeta {
    #[serde(default)]
    activity_names: Vec<String>,
}

/// The artifact payload: the reduced net in the `AcceptingPetriNet` shape,
/// plus what the reduction did to it.
///
/// Every field is spelled out rather than `#[serde(flatten)]`-ing the payload
/// in. `serde-wasm-bindgen` serialises any struct containing a flattened field
/// as a JS `Map` instead of an object, and a `Map` is not what `payloadOf`,
/// the layered renderer or the soundness checker read — they would all see an
/// artifact with no fields at all, and nothing would report an error.
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct Output {
    activities: Vec<u32>,
    labels: Vec<Option<String>>,
    places: Vec<net_reduce_core::model::PayloadPlace>,
    place_to_transition: Vec<(u32, u32)>,
    transition_to_place: Vec<(u32, u32)>,
    initial_marking: Vec<u32>,
    final_marking: Vec<u32>,
    start_activities: Vec<u32>,
    end_activities: Vec<u32>,
    /// What each rule removed, for the view and for the record.
    reduction: Report,
    stats: OutStats,
}

impl Output {
    fn new(net: PetriNetPayload, report: Report, stats: OutStats) -> Self {
        Self {
            activities: net.activities,
            labels: net.labels,
            places: net.places,
            place_to_transition: net.place_to_transition,
            transition_to_place: net.transition_to_place,
            initial_marking: net.initial_marking,
            final_marking: net.final_marking,
            start_activities: net.start_activities,
            end_activities: net.end_activities,
            reduction: report,
            stats,
        }
    }
}

/// Flat facts for the artifact's `meta`, which the host builds by spreading
/// `stats`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutStats {
    places: usize,
    transitions: usize,
    arcs: usize,
    silent_transitions: usize,
    places_before: usize,
    transitions_before: usize,
    arcs_before: usize,
    silent_before: usize,
    removed_nodes: usize,
    reduction: f64,
    rounds: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    reduction_warnings: Vec<String>,
}

/// `run.promenade.net-reduce.reduce`: `AcceptingPetriNet` -> `AcceptingPetriNet`.
#[wasm_bindgen]
pub struct ReduceNet;

#[wasm_bindgen]
impl ReduceNet {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self
    }

    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: ReduceParams =
            serde_wasm_bindgen::from_value(params).map_err(|e| JsValue::from_str(&e.to_string()))?;

        let mut raw = p.input_value;
        if raw.labels.is_none() && !p.input_meta.activity_names.is_empty() {
            let names = &p.input_meta.activity_names;
            raw.labels = Some(
                raw.activities
                    .iter()
                    .map(|&a| usize::try_from(a).ok().and_then(|i| names.get(i)).cloned())
                    .collect(),
            );
        }

        let net = normalize(raw);
        if net.transition_count() == 0 && net.place_count == 0 {
            return Err(JsValue::from_str("this net is empty; there is nothing to reduce"));
        }

        let options = Options {
            silent: p.drop_silent,
            series: p.fuse_series,
            parallel: p.fuse_parallel,
            self_loops: p.drop_self_loops,
            implicit: p.drop_implicit,
            ..Options::default()
        };
        let result = reduce(&net, &options);

        let (before, after) = (result.report.before.clone(), result.report.after.clone());
        let stats = OutStats {
            places: after.places,
            transitions: after.transitions,
            arcs: after.arcs,
            silent_transitions: after.silent_transitions,
            places_before: before.places,
            transitions_before: before.transitions,
            arcs_before: before.arcs,
            silent_before: before.silent_transitions,
            removed_nodes: (before.places + before.transitions)
                .saturating_sub(after.places + after.transitions),
            reduction: result.report.reduction,
            rounds: result.report.rounds,
            reduction_warnings: result.report.warnings.clone(),
        };
        let output = Output::new(result.payload, result.report, stats);
        serde_wasm_bindgen::to_value(&output).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(js_name = rowCount)]
    pub fn row_count(&self) -> u32 {
        0
    }
    #[wasm_bindgen(js_name = caseCount)]
    pub fn case_count(&self) -> u32 {
        0
    }
}

impl Default for ReduceNet {
    fn default() -> Self {
        Self::new()
    }
}
