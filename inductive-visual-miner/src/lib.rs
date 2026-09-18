//! Browser-native, exact Petri-net alignment replay.
//!
//! This kernel deliberately shares the semantic core of Promenade's Rust
//! alignment plugin: Dijkstra over the synchronous product of a 1-safe
//! accepting Petri net and a trace.  It is an exact optimal alignment (not
//! an approximate token replay), cached once per distinct trace variant.  The
//! difference is the output: this crate retains representative case timing
//! and transition ids to drive the Inductive Visual Miner animation.

use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use wasm_bindgen::prelude::*;

const MAX_PLACES: usize = 128;
const MAX_STATES: usize = 300_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransitionIn { activity_id: Option<u32> }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelIn {
    place_count: usize,
    transitions: Vec<TransitionIn>,
    place_to_transition: Vec<(usize, usize)>,
    transition_to_place: Vec<(usize, usize)>,
    initial_marking: Vec<usize>,
    final_marking: Vec<usize>,
    /// A compact-id copy of the net carried alongside the alignment contract.
    /// It is the rendering fallback when a historical artifact's raw payload
    /// is no longer available after reload.
    visual_model: Option<VisualModelIn>,
}

/** Do not use `serde_json::Value` at this JS/WASM boundary: arbitrary JS
 * objects deserialize as `{}` in serde-wasm-bindgen. The replay needs a real,
 * explicitly typed model value to hand to its React Flow renderer. */
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VisualModelIn {
    places: Vec<VisualPlaceIn>,
    activities: Vec<u32>,
    labels: Vec<Option<String>>,
    place_to_transition: Vec<(usize, usize)>,
    transition_to_place: Vec<(usize, usize)>,
    initial_marking: Vec<usize>,
    final_marking: Vec<usize>,
}

#[derive(Clone, Deserialize, Serialize)]
struct VisualPlaceIn { id: String }

struct Model {
    activity_of: Vec<Option<u32>>,
    inputs: Vec<u128>, outputs: Vec<u128>, initial: u128, final_marking: u128,
}

impl Model {
    fn build(input: &ModelIn) -> Result<Self, String> {
        if input.place_count > MAX_PLACES { return Err(format!("model has {} places; alignment is bounded to {MAX_PLACES}", input.place_count)); }
        let n = input.transitions.len();
        let mut inputs = vec![0u128; n]; let mut outputs = vec![0u128; n];
        for &(p, t) in &input.place_to_transition { if p < MAX_PLACES && t < n { inputs[t] |= 1u128 << p; } }
        for &(t, p) in &input.transition_to_place { if p < MAX_PLACES && t < n { outputs[t] |= 1u128 << p; } }
        let initial = input.initial_marking.iter().filter(|&&p| p < MAX_PLACES).fold(0u128, |m, &p| m | (1u128 << p));
        let final_marking = input.final_marking.iter().filter(|&&p| p < MAX_PLACES).fold(0u128, |m, &p| m | (1u128 << p));
        Ok(Self { activity_of: input.transitions.iter().map(|t| t.activity_id).collect(), inputs, outputs, initial, final_marking })
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct State { marking: u128, pos: u32 }

#[derive(Clone)]
struct Move { kind: &'static str, transition: Option<u32> }

struct Alignment { reached: bool, cost: u32, moves: Vec<Move> }

fn shortest(model: &Model, trace: &[u32]) -> Alignment {
    let start = State { marking: model.initial, pos: 0 };
    let mut dist: HashMap<State, u32> = HashMap::new();
    let mut prev: HashMap<State, (State, Move)> = HashMap::new();
    let mut heap: BinaryHeap<Reverse<(u32, State)>> = BinaryHeap::new();
    dist.insert(start, 0); heap.push(Reverse((0, start)));
    while let Some(Reverse((cost, state))) = heap.pop() {
        if dist.get(&state).copied().unwrap_or(u32::MAX) != cost { continue; }
        if state.marking == model.final_marking && state.pos == trace.len() as u32 {
            let mut moves = Vec::new(); let mut at = state;
            while let Some((from, mv)) = prev.get(&at) { moves.push(mv.clone()); at = *from; }
            moves.reverse(); return Alignment { reached: true, cost, moves };
        }
        if dist.len() > MAX_STATES { break; }
        let mut relax = |next: State, next_cost: u32, mv: Move| {
            if next_cost < dist.get(&next).copied().unwrap_or(u32::MAX) {
                dist.insert(next, next_cost); prev.insert(next, (state, mv)); heap.push(Reverse((next_cost, next)));
            }
        };
        if state.pos < trace.len() as u32 {
            relax(State { marking: state.marking, pos: state.pos + 1 }, cost + 1, Move { kind: "log", transition: None });
        }
        for transition in 0..model.activity_of.len() {
            if model.inputs[transition] & state.marking != model.inputs[transition] { continue; }
            let fired = (state.marking & !model.inputs[transition]) | model.outputs[transition];
            let activity = model.activity_of[transition];
            if state.pos < trace.len() as u32 && activity == Some(trace[state.pos as usize]) {
                relax(State { marking: fired, pos: state.pos + 1 }, cost, Move { kind: "sync", transition: Some(transition as u32) });
            } else {
                let silent = activity.is_none();
                relax(State { marking: fired, pos: state.pos }, cost + if silent { 0 } else { 1 }, Move { kind: if silent { "silent" } else { "model" }, transition: Some(transition as u32) });
            }
        }
    }
    Alignment { reached: false, cost: u32::MAX, moves: Vec::new() }
}

#[derive(Default)]
struct Trace { case_id: i32, activities: Vec<u32>, times: Vec<f64> }

#[wasm_bindgen]
pub struct IvmAlignmentScan { n: usize, traces: Vec<Trace>, current: Trace, last_case: Option<i32>, rows: u32 }

#[wasm_bindgen]
impl IvmAlignmentScan {
    #[wasm_bindgen(constructor)]
    pub fn new(n_activities: usize) -> Self { Self { n: n_activities, traces: Vec::new(), current: Trace::default(), last_case: None, rows: 0 } }

    /// `times` is epoch milliseconds or -1. Older generic kernels receive
    /// this third argument too and harmlessly ignore it.
    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, cases: &[i32], activities: &[i32], times: &[f64]) {
        let len = cases.len().min(activities.len());
        for i in 0..len {
            let case = cases[i]; let activity = activities[i];
            if activity < 0 || activity as usize >= self.n { continue; }
            if self.last_case != Some(case) {
                if self.last_case.is_some() { self.traces.push(std::mem::take(&mut self.current)); }
                self.current.case_id = case; self.last_case = Some(case);
            }
            self.current.activities.push(activity as u32);
            self.current.times.push(times.get(i).copied().filter(|v| *v >= 0.0).unwrap_or(-1.0));
        }
        self.rows += len as u32;
    }

    pub fn finish(&mut self) { if self.last_case.take().is_some() && !self.current.activities.is_empty() { self.traces.push(std::mem::take(&mut self.current)); } }
    #[wasm_bindgen(js_name = rowCount)] pub fn row_count(&self) -> u32 { self.rows }
    #[wasm_bindgen(js_name = caseCount)] pub fn case_count(&self) -> u32 { self.traces.len() as u32 }

    #[wasm_bindgen(js_name = finalize)]
    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let params: Params = serde_wasm_bindgen::from_value(params).map_err(|e| JsValue::from_str(&format!("bad params: {e}")))?;
        let input = params.model.as_ref().ok_or_else(|| JsValue::from_str("no model selected"))?;
        let model = Model::build(input).map_err(|e| JsValue::from_str(&e))?;
        // The compact visual net is carried in the typed alignment contract,
        // not in an untyped JSON blob. That keeps the renderer reliable after
        // browser persistence and across the wasm-bindgen boundary.
        let visual = input.visual_model.clone().unwrap_or_else(|| fallback_visual(input));
        let raw_transition_ids = transition_ids(&visual, model.activity_of.len());
        let value = self.replay(&model, raw_transition_ids, visual, params.case_limit.unwrap_or(400).clamp(10, 5000) as usize, params.variant_limit.unwrap_or(1000).max(1) as usize);
        serde_wasm_bindgen::to_value(&value).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

// -------------------------------------------------------------------------
// Directly-follows visual miner
//
// This deliberately is not an alignment approximation. A DFG is not an
// accepting Petri net, so inventing silent places/transitions merely to run a
// Petri-net alignment would give the graph behaviour it never claimed. The
// kernel therefore keeps each recorded case sequence and projects it directly
// onto its observed directly-follows edges. That makes the direct Log → DFG
// Visual Miner route exact with respect to the selected event log.

#[wasm_bindgen]
#[derive(Default)]
struct DfgVisualScan {
    n: usize,
    activity_names: Vec<String>,
    traces: Vec<Trace>,
    current: Trace,
    last_case: Option<i32>,
    rows: u32,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct DfgParams { case_limit: Option<u32> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DfgNode { id: u32, label: String, count: u32, starts: u32, ends: u32 }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DfgEdge { source: u32, target: u32, count: u32 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DfgReplayEvent { case_id: String, activity_id: u32, previous: Option<u32>, timestamp: Option<f64>, sequence: usize }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DfgReplayStats { cases: usize, events: usize, nodes: usize, edges: usize, case_limit_reached: bool }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DfgReplayOut { activities: Vec<String>, nodes: Vec<DfgNode>, edges: Vec<DfgEdge>, events: Vec<DfgReplayEvent>, timeline: Timeline, stats: DfgReplayStats, method: Method }

#[wasm_bindgen]
impl DfgVisualScan {
    #[wasm_bindgen(constructor)]
    pub fn new(n_activities: usize) -> Self {
        Self { n: n_activities, ..Self::default() }
    }

    #[wasm_bindgen(js_name = setActivityNames)]
    pub fn set_activity_names(&mut self, names: Vec<String>) { self.activity_names = names; }

    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, cases: &[i32], activities: &[i32], times: &[f64]) {
        let len = cases.len().min(activities.len());
        for i in 0..len {
            let case = cases[i]; let activity = activities[i];
            if activity < 0 || activity as usize >= self.n { continue; }
            if self.last_case != Some(case) {
                if self.last_case.is_some() && !self.current.activities.is_empty() { self.traces.push(std::mem::take(&mut self.current)); }
                self.current.case_id = case; self.last_case = Some(case);
            }
            self.current.activities.push(activity as u32);
            self.current.times.push(times.get(i).copied().filter(|v| *v >= 0.0).unwrap_or(-1.0));
        }
        self.rows += len as u32;
    }

    pub fn finish(&mut self) {
        if self.last_case.take().is_some() && !self.current.activities.is_empty() { self.traces.push(std::mem::take(&mut self.current)); }
    }
    #[wasm_bindgen(js_name = rowCount)] pub fn row_count(&self) -> u32 { self.rows }
    #[wasm_bindgen(js_name = caseCount)] pub fn case_count(&self) -> u32 { self.traces.len() as u32 }

    #[wasm_bindgen(js_name = finalize)]
    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let params: DfgParams = serde_wasm_bindgen::from_value(params).unwrap_or_default();
        let cap = params.case_limit.unwrap_or(400).clamp(10, 5000) as usize;
        let mut counts = vec![0u32; self.n]; let mut starts = vec![0u32; self.n]; let mut ends = vec![0u32; self.n];
        let mut edge_counts: HashMap<(u32, u32), u32> = HashMap::new();
        for trace in &self.traces {
            for &activity in &trace.activities { counts[activity as usize] += 1; }
            if let Some(&first) = trace.activities.first() { starts[first as usize] += 1; }
            if let Some(&last) = trace.activities.last() { ends[last as usize] += 1; }
            for pair in trace.activities.windows(2) { *edge_counts.entry((pair[0], pair[1])).or_insert(0) += 1; }
        }
        let names = (0..self.n).map(|i| self.activity_names.get(i).cloned().unwrap_or_else(|| format!("#{i}"))).collect::<Vec<_>>();
        let nodes = (0..self.n).filter(|&i| counts[i] > 0).map(|i| DfgNode { id: i as u32, label: names[i].clone(), count: counts[i], starts: starts[i], ends: ends[i] }).collect();
        let mut edges = edge_counts.into_iter().map(|((source, target), count)| DfgEdge { source, target, count }).collect::<Vec<_>>();
        edges.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.source.cmp(&b.source)).then_with(|| a.target.cmp(&b.target)));
        let mut events = Vec::new();
        for trace in self.traces.iter().take(cap) {
            for (sequence, &activity) in trace.activities.iter().enumerate() {
                events.push(DfgReplayEvent { case_id: trace.case_id.to_string(), activity_id: activity, previous: sequence.checked_sub(1).map(|i| trace.activities[i]), timestamp: trace.times.get(sequence).copied().filter(|v| *v >= 0.0), sequence });
            }
        }
        let times = events.iter().filter_map(|event| event.timestamp).collect::<Vec<_>>();
        let (has_timing, start, end) = if times.len() > 1 { let lo = times.iter().copied().fold(f64::INFINITY, f64::min); let hi = times.iter().copied().fold(f64::NEG_INFINITY, f64::max); (hi > lo, lo, hi) } else { (false, 0.0, events.len().max(1) as f64) };
        let span = (end - start).max(1.0);
        let output = DfgReplayOut {
            activities: names, nodes, edges: edges.clone(), events,
            timeline: Timeline { start, end, source_span_ms: span, duration_ms: span.clamp(18_000.0, 75_000.0), has_timing },
            stats: DfgReplayStats { cases: self.traces.len().min(cap), events: self.rows as usize, nodes: counts.iter().filter(|&&count| count > 0).count(), edges: edges.len(), case_limit_reached: self.traces.len() > cap },
            method: Method { name: "directly-follows replay", exact: true, note: "Every animated route is an observed directly-follows relation from the selected log; no Petri-net alignment is invented for this DFG model." },
        };
        serde_wasm_bindgen::to_value(&output).map_err(|error| JsValue::from_str(&error.to_string()))
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Params { model: Option<ModelIn>, case_limit: Option<u32>, variant_limit: Option<u32> }

fn fallback_visual(input: &ModelIn) -> VisualModelIn {
    VisualModelIn {
        places: (0..input.place_count).map(|id| VisualPlaceIn { id: id.to_string() }).collect(),
        activities: (0..input.transitions.len() as u32).collect(),
        labels: input.transitions.iter().map(|t| t.activity_id.map(|id| format!("#{id}"))).collect(),
        place_to_transition: input.place_to_transition.clone(),
        transition_to_place: input.transition_to_place.clone(),
        initial_marking: input.initial_marking.clone(),
        final_marking: input.final_marking.clone(),
    }
}

fn transition_ids(visual: &VisualModelIn, count: usize) -> Vec<u32> {
    (0..count).map(|i| visual.activities.get(i).copied().unwrap_or(i as u32)).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplayEvent { case_id: String, transition_id: u32, timestamp: Option<f64>, sequence: usize, silent: bool, deviation: bool }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Timeline { start: f64, end: f64, source_span_ms: f64, duration_ms: f64, has_timing: bool }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats { cases: usize, events: usize, aligned_events: usize, deviations: usize, mean_fitness: f64, unreachable_cases: usize, variant_limit_reached: bool, alignment: &'static str }
#[derive(Serialize)]
struct Method { name: &'static str, exact: bool, note: &'static str }
#[derive(Serialize)]
struct ReplayOut { model: VisualModelIn, events: Vec<ReplayEvent>, timeline: Timeline, stats: Stats, method: Method }

impl IvmAlignmentScan {
    fn replay(&self, model: &Model, raw_ids: Vec<u32>, visual: VisualModelIn, case_limit: usize, variant_limit: usize) -> ReplayOut {
        let mut groups: HashMap<&Vec<u32>, usize> = HashMap::new();
        for trace in &self.traces { *groups.entry(&trace.activities).or_insert(0) += 1; }
        let mut variants: Vec<(&Vec<u32>, usize)> = groups.into_iter().collect();
        variants.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        let limited = variants.len() > variant_limit; variants.truncate(variant_limit);
        let mut by_variant: HashMap<Vec<u32>, Alignment> = HashMap::new();
        let empty = shortest(model, &[]); let model_cost = if empty.reached { empty.cost } else { 0 };
        let mut fitness_sum = 0.0; let mut fitness_cases = 0usize; let mut unreachable = 0usize;
        for (sequence, count) in variants {
            let aligned = shortest(model, sequence);
            if !aligned.reached { unreachable += count; continue; }
            let bound = sequence.len() as u32 + model_cost;
            let fitness = if bound == 0 { 1.0 } else { 1.0 - aligned.cost as f64 / bound as f64 };
            fitness_sum += fitness * count as f64; fitness_cases += count;
            by_variant.insert((*sequence).clone(), aligned);
        }
        let mut events = Vec::new(); let mut deviations = 0usize; let mut aligned_events = 0usize; let mut source_events = 0usize;
        for trace in self.traces.iter().take(case_limit) {
            source_events += trace.activities.len();
            let Some(alignment) = by_variant.get(&trace.activities) else { continue; };
            let mut log_pos = 0usize; let mut last_time = None;
            for (sequence, mv) in alignment.moves.iter().enumerate() {
                let consumes = mv.kind == "sync" || mv.kind == "log";
                let time = if consumes { let t = trace.times.get(log_pos).copied().filter(|v| *v >= 0.0); log_pos += 1; t } else { last_time };
                if time.is_some() { last_time = time; }
                if mv.kind == "log" { deviations += 1; continue; }
                let Some(compact) = mv.transition else { continue; };
                let visible_model_move = mv.kind == "model";
                if visible_model_move { deviations += 1; }
                if mv.kind == "sync" { aligned_events += 1; }
                events.push(ReplayEvent { case_id: trace.case_id.to_string(), transition_id: raw_ids.get(compact as usize).copied().unwrap_or(compact), timestamp: time, sequence, silent: mv.kind == "silent", deviation: visible_model_move });
            }
        }
        let times: Vec<f64> = events.iter().filter(|e| !e.silent).filter_map(|e| e.timestamp).collect();
        let (has_timing, start, end) = if times.len() > 1 { let lo = times.iter().copied().fold(f64::INFINITY, f64::min); let hi = times.iter().copied().fold(f64::NEG_INFINITY, f64::max); (hi > lo, lo, hi) } else { (false, 0.0, events.len().max(1) as f64) };
        let span = (end - start).max(1.0); let duration = span.clamp(18_000.0, 75_000.0);
        ReplayOut {
            model: visual, events,
            timeline: Timeline { start, end, source_span_ms: span, duration_ms: duration, has_timing },
            stats: Stats { cases: self.traces.len().min(case_limit), events: source_events, aligned_events, deviations, mean_fitness: if fitness_cases > 0 { fitness_sum / fitness_cases as f64 } else { 0.0 }, unreachable_cases: unreachable, variant_limit_reached: limited, alignment: "exact Rust/WASM Dijkstra alignment" },
            method: Method { name: "exact Dijkstra alignment replay (Rust/WASM)", exact: true, note: "Each distinct trace variant is aligned once in WebAssembly. The animation keeps a bounded, representative particle pool; reported replay counts are exact for the selected sample." },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn synchronous_path_is_free() {
        let model = Model { activity_of: vec![Some(0), Some(1)], inputs: vec![1, 2], outputs: vec![2, 4], initial: 1, final_marking: 4 };
        let result = shortest(&model, &[0, 1]); assert!(result.reached); assert_eq!(result.cost, 0); assert_eq!(result.moves.len(), 2);
    }
    #[test]
    fn silent_step_is_free() {
        let model = Model { activity_of: vec![Some(0), None, Some(1)], inputs: vec![1, 2, 4], outputs: vec![2, 4, 8], initial: 1, final_marking: 8 };
        let result = shortest(&model, &[0, 1]); assert!(result.reached); assert_eq!(result.cost, 0); assert_eq!(result.moves.iter().filter(|m| m.kind == "silent").count(), 1);
    }
}
