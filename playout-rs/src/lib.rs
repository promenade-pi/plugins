//! The wasm boundary for `run.promenade.playout.simulate`.
//!
//! Everything algorithmic lives in `playout-core`; this file is only the edge —
//! the host's generic `value-finalize/1` ABI on one side (see
//! `plugins/soundness-rs/src/lib.rs` for the template this follows), typed Rust
//! values on the other.
//!
//! The one thing that is genuinely different here is what goes *back*: an
//! action whose declared output type is a log returns the log's columns, and
//! the host validates them against its own logical schema and writes the
//! storage (`app/src/host/artifact/log-rows.ts`). A plugin therefore produces
//! a real, queryable event log without ever seeing a file, a table or a row of
//! anyone else's data.

use playout_core::log::LogColumns;
use playout_core::{play_out, Incomplete, Lifecycle, Mode, Options, Stats};
use serde::{Deserialize, Serialize};
use soundness_core::{normalize, RawNet};
use wasm_bindgen::prelude::*;

/// What the host records *about* the input artifact, as opposed to in it.
///
/// The Alpha Miner's `AcceptingPetriNet` payload carries bare activity ids and
/// keeps the names in the artifact's `meta.activityNames`. Without them a
/// simulated log's activities are called `#3`, which is useless as a log even
/// though every count in it is right.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct InputMeta {
    #[serde(default)]
    activity_names: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlayoutParams {
    /// The `AcceptingPetriNet` payload the host resolved from the input slot.
    input_value: RawNet,
    #[serde(default)]
    input_meta: InputMeta,
    #[serde(default = "default_mode")]
    mode: Mode,
    // `caseCount`/`traceLimit`, not `traces`/`variants`: the host substitutes
    // the *input artifact's* `meta` for any param of the same name (see
    // `wasmActionRuntime`), and a discovered net's meta records how many
    // traces and variants the log it came from had. A param called `traces`
    // would be silently overwritten with the source log's trace count, and
    // the control would still show what the user chose.
    #[serde(default = "default_traces")]
    case_count: usize,
    #[serde(default = "default_variants")]
    trace_limit: usize,
    #[serde(default = "default_max_length")]
    max_length: usize,
    #[serde(default = "default_seed")]
    seed: u64,
    #[serde(default = "default_lifecycle")]
    lifecycle: Lifecycle,
    #[serde(default = "default_incomplete")]
    incomplete: Incomplete,
    #[serde(default = "default_arrival")]
    arrival_minutes: f64,
    #[serde(default = "default_duration")]
    duration_minutes: f64,
    #[serde(default)]
    resources: usize,
}

fn default_mode() -> Mode { Options::default().mode }
fn default_traces() -> usize { Options::default().traces }
fn default_variants() -> usize { Options::default().variants }
fn default_max_length() -> usize { Options::default().max_length }
fn default_seed() -> u64 { Options::default().seed }
fn default_lifecycle() -> Lifecycle { Options::default().lifecycle }
fn default_incomplete() -> Incomplete { Options::default().incomplete }
fn default_arrival() -> f64 { Options::default().arrival_minutes }
fn default_duration() -> f64 { Options::default().duration_minutes }

/// The artifact's `meta`, written flat.
///
/// Deliberately not `#[serde(flatten)]` over `Stats`: `serde-wasm-bindgen`
/// serialises a flattened struct as a JS `Map` rather than an object, and the
/// host spreads this into `meta` — a `Map` would spread to nothing at all and
/// the artifact would simply have no statistics, with no error anywhere.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutStats {
    mode: String,
    simulated_cases: usize,
    simulated_events: usize,
    variants: usize,
    activities: usize,
    deadlocked_cases: usize,
    truncated_cases: usize,
    discarded_cases: usize,
    seed: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    language_exhausted: Option<bool>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    playout_warnings: Vec<String>,
}

impl OutStats {
    fn new(stats: Stats, warnings: Vec<String>) -> Self {
        Self {
            mode: stats.mode,
            simulated_cases: stats.cases,
            simulated_events: stats.events,
            variants: stats.variants,
            activities: stats.activities,
            deadlocked_cases: stats.deadlocked,
            truncated_cases: stats.truncated,
            discarded_cases: stats.discarded,
            // A seed is a 64-bit value and JS has no integer that wide; it is
            // only ever echoed back to the person who typed it, so the lossy
            // half of the round trip is the one nobody reads.
            seed: stats.seed as f64,
            language_exhausted: stats.language_exhausted,
            playout_warnings: warnings,
        }
    }
}

#[derive(Serialize)]
struct Output {
    /// The log itself, in the host's logical-schema vocabulary.
    log: LogColumns,
    stats: OutStats,
    name: String,
}

/// `run.promenade.playout.simulate`: `AcceptingPetriNet` -> `TraditionalEventLog`.
#[wasm_bindgen]
pub struct Playout;

#[wasm_bindgen]
impl Playout {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self
    }

    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: PlayoutParams =
            serde_wasm_bindgen::from_value(params).map_err(|e| JsValue::from_str(&e.to_string()))?;

        let mut raw = p.input_value;
        // The names, if the host had them and the payload did not. Done before
        // `normalize`, because that is where the `#<id>` fallback happens.
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
        if net.transition_count() == 0 {
            return Err(JsValue::from_str(
                "this net has no transitions, so there is nothing to play out",
            ));
        }

        let options = Options {
            mode: p.mode,
            traces: p.case_count.clamp(1, 1_000_000),
            variants: p.trace_limit.clamp(1, 1_000_000),
            max_length: p.max_length.clamp(1, 100_000),
            seed: p.seed,
            lifecycle: p.lifecycle,
            incomplete: p.incomplete,
            arrival_minutes: p.arrival_minutes.max(0.0),
            duration_minutes: p.duration_minutes.max(0.0),
            resources: p.resources.min(10_000),
            ..Options::default()
        };
        let result = play_out(&net, &options);

        // An empty log is not an artifact the host can write — every reader of
        // a log starts from its event table — so the run fails here, with the
        // reason the simulation already worked out, rather than deeper down
        // as a schema complaint about a missing relation.
        if result.stats.cases == 0 || result.stats.events == 0 {
            return Err(JsValue::from_str(&format!(
                "there is no log to write: {}",
                result.warnings.join(" ")
            )));
        }

        let output = Output {
            log: result.columns,
            stats: OutStats::new(result.stats, result.warnings),
            name: "Simulated Event Log".into(),
        };
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

impl Default for Playout {
    fn default() -> Self {
        Self::new()
    }
}
