//! The wasm boundary for `run.promenade.log-skeleton`.
//!
//! Two kernels on the host's `scan-finalize/1` ABI, split the same way the
//! DECLARE plugin's are and for the same reason: discovery keeps counters, so
//! the noise slider re-derives the skeleton from a cached scan; checking keeps
//! the traces, because the skeleton it is checking against only arrives with
//! the parameters.

use log_skeleton_core::conformance::{Checker, Diagnostics, SkeletonSpec};
use log_skeleton_core::counters::Counters;
use log_skeleton_core::relations::{Relation, ALL};
use log_skeleton_core::{discover, Options, Skeleton, TraceIndex};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

/// Every ordered pair of activities is a candidate for five relations, so the
/// work — and the skeleton — grow with the square of this.
const MAX_ACTIVITIES: usize = 128;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct DiscoverParams {
    noise: Option<f64>,
    equivalence: Option<bool>,
    always_before: Option<bool>,
    always_after: Option<bool>,
    never_together: Option<bool>,
    directly_follows: Option<bool>,
    counts: Option<bool>,
    limit: Option<usize>,
}

impl DiscoverParams {
    fn options(&self) -> Options {
        let defaults = Options::default();
        let wanted = |flag: Option<bool>| flag.unwrap_or(true);
        let relations: Vec<Relation> = ALL
            .into_iter()
            .filter(|relation| match relation {
                Relation::Equivalence => wanted(self.equivalence),
                Relation::AlwaysBefore => wanted(self.always_before),
                Relation::AlwaysAfter => wanted(self.always_after),
                Relation::NeverTogether => wanted(self.never_together),
                Relation::DirectlyFollows => wanted(self.directly_follows),
            })
            .collect();
        Options {
            relations,
            counts: wanted(self.counts),
            noise: self.noise.unwrap_or(defaults.noise).clamp(0.0, 1.0),
            limit: self.limit.unwrap_or(defaults.limit).clamp(1, 50_000),
        }
    }
}

/// `run.promenade.log-skeleton.discover`: `TraditionalEventLog` -> `LogSkeleton`.
#[wasm_bindgen]
pub struct SkeletonScan {
    counters: Counters,
    trace: TraceIndex,
    names: Vec<String>,
    n: usize,
    rows: u32,
    current_case: i64,
    started: bool,
}

#[wasm_bindgen]
impl SkeletonScan {
    #[wasm_bindgen(constructor)]
    pub fn new(activities: usize) -> SkeletonScan {
        let n = activities.min(MAX_ACTIVITIES);
        SkeletonScan {
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
        let skeleton: Skeleton = discover(&self.counters, &self.names, &p.options());
        serde_wasm_bindgen::to_value(&skeleton).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct CheckParams {
    /// Every bound input's inline payload, by role — the host's generic
    /// second-input door. The skeleton is the `skeleton` slot.
    input_values: Option<InputValues>,
    max_cases: Option<usize>,
}

#[derive(Deserialize, Default)]
struct InputValues {
    #[serde(default)]
    skeleton: Vec<Option<SkeletonSpec>>,
}

/// `run.promenade.log-skeleton.check`: a log and a `LogSkeleton` -> `LogSkeletonDiagnostics`.
#[wasm_bindgen]
pub struct SkeletonCheck {
    events: Vec<u32>,
    traces: Vec<(i32, u32, u32)>,
    names: Vec<String>,
    n: usize,
    rows: u32,
    current_case: i32,
    started: bool,
    start: u32,
}

#[wasm_bindgen]
impl SkeletonCheck {
    #[wasm_bindgen(constructor)]
    pub fn new(activities: usize) -> SkeletonCheck {
        SkeletonCheck {
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
        let skeleton = p
            .input_values
            .and_then(|values| values.skeleton.into_iter().flatten().next())
            .ok_or_else(|| {
                JsValue::from_str(
                    "no log skeleton was bound to the \"skeleton\" input — select a log and a \
                     Log Skeleton together",
                )
            })?;

        let mut checker =
            Checker::new(&skeleton, &self.names, p.max_cases.unwrap_or(200).clamp(1, 5_000));
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

impl SkeletonCheck {
    fn close_trace(&mut self) {
        if self.started {
            let length = self.events.len() as u32 - self.start;
            self.traces.push((self.current_case, self.start, length));
        }
    }
}
