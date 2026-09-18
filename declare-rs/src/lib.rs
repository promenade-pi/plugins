//! The wasm boundary for `run.promenade.declare`.
//!
//! Two kernels, both on the host's `scan-finalize/1` ABI, and the difference
//! between them is worth stating because it is not arbitrary.
//!
//! **Discovery** keeps no traces. Everything a threshold could ask is a number
//! (`declare_core::Counters`), so the scan folds each trace in and forgets it,
//! and `finalize` — which the host calls again on every slider move, against a
//! cached scan — is arithmetic over a few matrices. Dragging the support
//! threshold re-mines the model without re-reading the log.
//!
//! **Checking** keeps the traces, because it has no choice: the model arrives
//! with the parameters (`inputValues`, the host's second-input door), so there
//! is nothing to count during the scan. Traces are stored flat — one `u32` per
//! event — which is about 4 MB for a million-event log.

use declare_core::conformance::{Checker, Diagnostics, ModelSpec};
use declare_core::discover::{discover, Model, Options};
use declare_core::templates::Family;
use declare_core::{Counters, TraceIndex};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

/// Discovery is quadratic in the alphabet (every ordered pair, for eighteen
/// templates), and a model of ten thousand rules is not a model anyway.
const MAX_ACTIVITIES: usize = 128;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct DiscoverParams {
    min_support: Option<f64>,
    min_confidence: Option<f64>,
    prune: Option<bool>,
    limit: Option<usize>,
    unary: Option<bool>,
    relations: Option<bool>,
    alternating: Option<bool>,
    chain: Option<bool>,
    negative: Option<bool>,
}

impl DiscoverParams {
    fn options(&self) -> Options {
        let defaults = Options::default();
        let mut families = Vec::new();
        // Unset means on: a plugin's defaults live in its manifest, and a
        // kernel that disagreed with them would be a second set of defaults.
        for (wanted, family) in [
            (self.unary, Family::Unary),
            (self.relations, Family::Relation),
            (self.alternating, Family::Alternating),
            (self.chain, Family::Chain),
            (self.negative, Family::Negative),
        ] {
            if wanted.unwrap_or(true) {
                families.push(family);
            }
        }
        Options {
            families,
            min_support: self.min_support.unwrap_or(defaults.min_support).clamp(0.0, 1.0),
            min_confidence: self.min_confidence.unwrap_or(defaults.min_confidence).clamp(0.0, 1.0),
            prune: self.prune.unwrap_or(defaults.prune),
            limit: self.limit.unwrap_or(defaults.limit).clamp(1, 20_000),
        }
    }
}

/// `run.promenade.declare.discover`: `TraditionalEventLog` -> `DeclareModel`.
#[wasm_bindgen]
pub struct DeclareScan {
    counters: Counters,
    trace: TraceIndex,
    names: Vec<String>,
    n: usize,
    rows: u32,
    current_case: i64,
    started: bool,
}

#[wasm_bindgen]
impl DeclareScan {
    #[wasm_bindgen(constructor)]
    pub fn new(activities: usize) -> DeclareScan {
        let n = activities.min(MAX_ACTIVITIES);
        DeclareScan {
            counters: Counters::new(n),
            trace: TraceIndex::new(n),
            names: Vec::new(),
            n,
            rows: 0,
            current_case: i64::MIN,
            started: false,
        }
    }

    #[wasm_bindgen(js_name = setActivityNames)]
    pub fn set_activity_names(&mut self, names: Vec<String>) {
        self.names = names;
        self.names.truncate(self.n);
    }

    /// Ordered by (case, timestamp) — the host guarantees it with an ORDER BY,
    /// which is what lets a trace be folded in the moment its case changes.
    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, cases: &[i32], activities: &[i32]) {
        let len = cases.len().min(activities.len());
        for i in 0..len {
            let case = cases[i] as i64;
            if !self.started || case != self.current_case {
                if self.started {
                    self.counters.observe(&self.trace);
                }
                self.trace.reset();
                self.current_case = case;
                self.started = true;
            }
            let activity = activities[i];
            if activity >= 0 && (activity as usize) < self.n {
                self.trace.push(activity as u32);
            }
        }
        self.rows += len as u32;
    }

    pub fn finish(&mut self) {
        if self.started {
            self.counters.observe(&self.trace);
            self.started = false;
        }
    }

    #[wasm_bindgen(js_name = rowCount)]
    pub fn row_count(&self) -> u32 {
        self.rows
    }

    #[wasm_bindgen(js_name = caseCount)]
    pub fn case_count(&self) -> u32 {
        self.counters.traces
    }

    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: DiscoverParams = serde_wasm_bindgen::from_value(params)
            .map_err(|e| JsValue::from_str(&format!("bad params: {e}")))?;
        let model: Model = discover(&self.counters, &self.names, &p.options());
        serde_wasm_bindgen::to_value(&model).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct CheckParams {
    /// Every bound input's inline payload, by role — the host's generic
    /// second-input door. The model is the `model` slot; the log slot carries
    /// `null`, since a log has rows rather than a payload.
    input_values: Option<InputValues>,
    max_cases: Option<usize>,
}

#[derive(Deserialize, Default)]
struct InputValues {
    #[serde(default)]
    model: Vec<Option<ModelSpec>>,
}

/// `run.promenade.declare.check`: a log and a `DeclareModel` -> `DeclareDiagnostics`.
#[wasm_bindgen]
pub struct DeclareCheck {
    /// Every trace's events, back to back.
    events: Vec<u32>,
    /// `(case, start, length)` per trace, in scan order.
    traces: Vec<(i32, u32, u32)>,
    names: Vec<String>,
    n: usize,
    rows: u32,
    current_case: i32,
    started: bool,
    start: u32,
}

#[wasm_bindgen]
impl DeclareCheck {
    #[wasm_bindgen(constructor)]
    pub fn new(activities: usize) -> DeclareCheck {
        DeclareCheck {
            events: Vec::new(),
            traces: Vec::new(),
            names: Vec::new(),
            n: activities.min(MAX_ACTIVITIES),
            rows: 0,
            current_case: 0,
            started: false,
            start: 0,
        }
    }

    #[wasm_bindgen(js_name = setActivityNames)]
    pub fn set_activity_names(&mut self, names: Vec<String>) {
        self.names = names;
        self.names.truncate(self.n);
    }

    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, cases: &[i32], activities: &[i32]) {
        let len = cases.len().min(activities.len());
        for i in 0..len {
            let case = cases[i];
            if !self.started || case != self.current_case {
                self.close_trace();
                self.current_case = case;
                self.started = true;
                self.start = self.events.len() as u32;
            }
            let activity = activities[i];
            if activity >= 0 && (activity as usize) < self.n {
                self.events.push(activity as u32);
            }
        }
        self.rows += len as u32;
    }

    pub fn finish(&mut self) {
        self.close_trace();
        self.started = false;
    }

    #[wasm_bindgen(js_name = rowCount)]
    pub fn row_count(&self) -> u32 {
        self.rows
    }

    #[wasm_bindgen(js_name = caseCount)]
    pub fn case_count(&self) -> u32 {
        self.traces.len() as u32
    }

    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: CheckParams = serde_wasm_bindgen::from_value(params)
            .map_err(|e| JsValue::from_str(&format!("bad params: {e}")))?;
        let model = p
            .input_values
            .and_then(|values| values.model.into_iter().flatten().next())
            .ok_or_else(|| {
                JsValue::from_str(
                    "no DECLARE model was bound to the \"model\" input — select a log and a \
                     DECLARE Model together",
                )
            })?;

        let mut checker = Checker::new(&model, &self.names, p.max_cases.unwrap_or(200).clamp(1, 5_000));
        let mut index = TraceIndex::new(self.n);
        for &(case, start, length) in &self.traces {
            index.reset();
            for &activity in &self.events[start as usize..(start + length) as usize] {
                index.push(activity);
            }
            checker.observe(&index, case);
        }
        let diagnostics: Diagnostics = checker.finish();
        serde_wasm_bindgen::to_value(&diagnostics).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

impl DeclareCheck {
    fn close_trace(&mut self) {
        if self.started {
            let length = self.events.len() as u32 - self.start;
            self.traces.push((self.current_case, self.start, length));
        }
    }
}
