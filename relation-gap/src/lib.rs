//! Heterogeneous GraphSAGE reconstruction of missing event-object relations.
//!
//! The Rust half of `org.promenade.relation-gap`. A pyodide stage turns two
//! logs into the integer-indexed graph this kernel trains on (see
//! `plugin.py`'s `finalize_graph`); everything from there — initialisation,
//! message passing, the triplet objective, Adam, and the ranking the metrics
//! are read from — happens here, because there is no PyTorch in any runtime
//! Promenade has and the arithmetic is small enough to own outright.
//!
//! The kernel uses the `value-finalize/1` ABI: one JSON payload in, one JSON
//! payload out, no data-worker access. That is the whole reason the graph is
//! built upstream rather than queried here.

mod eval;
mod linalg;
mod model;
mod train;

#[cfg(test)]
mod tests;

use linalg::Rng;
use model::{Graph, Model};
use serde::{Deserialize, Serialize};
use train::{Objective, Sampler, TrainConfig};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPayload {
    pub object_ids: Vec<String>,
    pub object_types: Vec<u32>,
    pub object_type_names: Vec<String>,
    pub event_ids: Vec<String>,
    pub event_activities: Vec<u32>,
    pub activity_names: Vec<String>,
    pub e2o_src: Vec<u32>,
    pub e2o_dst: Vec<u32>,
    pub o2o_src: Vec<u32>,
    pub o2o_dst: Vec<u32>,
    pub gap_event: Vec<u32>,
    pub gap_object: Vec<u32>,
    #[serde(default)]
    pub pairing: Pairing,
}

#[derive(Deserialize, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    #[serde(default)]
    pub events_only_in_partial: u32,
    #[serde(default)]
    pub objects_only_in_partial: u32,
    #[serde(default)]
    pub relations_only_in_partial: u32,
    #[serde(default)]
    pub derived_pair: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Params {
    pub input_value: GraphPayload,
    #[serde(default = "d_hidden")]
    pub hidden_dim: usize,
    #[serde(default = "d_layers")]
    pub layers: usize,
    #[serde(default = "d_epochs")]
    pub epochs: usize,
    #[serde(default = "d_batch")]
    pub batch_events: usize,
    #[serde(default = "d_lr")]
    pub learning_rate: f32,
    #[serde(default = "d_margin")]
    pub margin: f32,
    #[serde(default = "d_dropout")]
    pub dropout: f32,
    #[serde(default = "d_seed")]
    pub seed: u32,
    #[serde(default = "d_masked")]
    pub masked_query_training: bool,
    #[serde(default = "d_objective")]
    pub objective: String,
    #[serde(default = "d_negatives")]
    pub negatives_per_positive: usize,
    #[serde(default = "d_temperature")]
    pub temperature: f32,
    #[serde(default = "d_same_type")]
    pub same_type_negative_fraction: f32,
    #[serde(default = "d_cooccurrence")]
    pub cooccurrence_candidates: bool,
    #[serde(default = "d_topk")]
    pub top_k: usize,
    #[serde(default = "d_examples")]
    pub max_examples: usize,
}

fn d_hidden() -> usize { 128 }
fn d_layers() -> usize { 3 }
fn d_epochs() -> usize { 400 }
fn d_batch() -> usize { 1024 }
fn d_lr() -> f32 { 0.001 }
fn d_margin() -> f32 { 0.5 }
fn d_dropout() -> f32 { 0.3 }
fn d_seed() -> u32 { 42 }
fn d_topk() -> usize { 10 }
fn d_examples() -> usize { 25 }
fn d_masked() -> bool { true }
fn d_objective() -> String { "sampledSoftmax".to_string() }
fn d_negatives() -> usize { 10 }
fn d_temperature() -> f32 { 0.1 }
fn d_same_type() -> f32 { 0.5 }
fn d_cooccurrence() -> bool { true }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Method {
    model: String,
    reference: String,
    score: String,
    estimated_from: String,
    candidate_pool: String,
    top_k: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    object_count: usize,
    observed_relations: usize,
    missing_relations: usize,
    observed_events: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EpochRow {
    epoch: usize,
    loss: f64,
    pos: f64,
    neg: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Training {
    hidden_dim: usize,
    layers: usize,
    epochs: usize,
    batch_events: usize,
    margin: f64,
    dropout: f64,
    learning_rate: f64,
    seed: u32,
    objective: String,
    masked_query_training: bool,
    negatives_per_positive: usize,
    temperature: f64,
    same_type_negative_fraction: f64,
    best_epoch: usize,
    best_loss: f64,
    final_loss: f64,
    final_gap: f64,
    converged: bool,
    history: Vec<EpochRow>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    method: Method,
    pairing: Pairing,
    meta: Meta,
    metrics: eval::Metrics,
    rank_distribution: Vec<eval::Bucket>,
    by_object_type: Vec<eval::TypeRow>,
    examples: Vec<eval::Example>,
    training: Training,
}

/// Posts a `{type:"progress"}` message straight to the host.
///
/// `wasm-plugin-worker.ts` only reports progress for its own chunked scan, and
/// a `value-finalize` kernel gets no callback at all — which is fine for a
/// conversion that takes milliseconds and useless for training that takes
/// minutes. The host's runner forwards any progress message the worker's scope
/// posts, so this reaches the same progress bar the scan path uses.
fn progress(fraction: f64, message: &str) {
    let global = js_sys::global();
    if let Ok(post) = js_sys::Reflect::get(&global, &JsValue::from_str("postMessage")) {
        if let Some(post) = post.dyn_ref::<js_sys::Function>() {
            let payload = js_sys::Object::new();
            let _ = js_sys::Reflect::set(&payload, &"type".into(), &"progress".into());
            let _ = js_sys::Reflect::set(&payload, &"fraction".into(), &fraction.into());
            let _ = js_sys::Reflect::set(&payload, &"message".into(), &message.into());
            let _ = post.call1(&global, &payload);
        }
    }
}

/// Objects that co-occurred with each object, counted over the training
/// partition only.
///
/// `Sampler::positives` is already restricted to events with no held-out link,
/// so walking it gives exactly the neighbourhood the co-occurrence arm fits on.
/// Building it from the gapped log instead would let the network's candidate
/// pool see a gapped event's surviving context that the baseline's statistics
/// never counted, and the comparison would stop being like-for-like.
fn cooccurrence_neighbours(graph: &Graph, sampler: &Sampler) -> Vec<Vec<u32>> {
    let mut neighbours: Vec<Vec<u32>> = vec![Vec::new(); graph.n_obj];
    for &e in &sampler.trainable {
        let members = &sampler.by_event[e as usize];
        for &a in members {
            for &b in members {
                if a != b {
                    neighbours[a as usize].push(b);
                }
            }
        }
    }
    for list in neighbours.iter_mut() {
        list.sort_unstable();
        list.dedup();
    }
    neighbours
}

fn run(params: Params) -> Result<Payload, String> {
    let p = params;
    let payload = p.input_value;

    let n_obj = payload.object_ids.len();
    let n_evt = payload.event_ids.len();
    if n_obj == 0 || n_evt == 0 {
        return Err("the graph has no objects or no events".into());
    }
    if payload.object_types.len() != n_obj {
        return Err("objectTypes does not match objectIds".into());
    }
    if payload.event_activities.len() != n_evt {
        return Err("eventActivities does not match eventIds".into());
    }
    if payload.e2o_src.len() != payload.e2o_dst.len()
        || payload.o2o_src.len() != payload.o2o_dst.len()
        || payload.gap_event.len() != payload.gap_object.len()
    {
        return Err("an edge list has mismatched endpoint arrays".into());
    }

    let e2o: Vec<(u32, u32)> = payload
        .e2o_src
        .iter()
        .zip(&payload.e2o_dst)
        .map(|(&a, &b)| (a, b))
        .collect();
    let o2o: Vec<(u32, u32)> = payload
        .o2o_src
        .iter()
        .zip(&payload.o2o_dst)
        .map(|(&a, &b)| (a, b))
        .collect();
    let gaps: Vec<(u32, u32)> = payload
        .gap_event
        .iter()
        .zip(&payload.gap_object)
        .map(|(&a, &b)| (a, b))
        .collect();

    let graph = Graph {
        n_obj,
        n_evt,
        n_otype: payload.object_type_names.len().max(1),
        n_act: payload.activity_names.len().max(1),
        object_type: payload.object_types,
        event_activity: payload.event_activities,
        e2o,
        o2o,
        gaps,
    };

    let hidden = p.hidden_dim.clamp(8, 512);
    let layers = p.layers.clamp(1, 5);
    let mut rng = Rng::new(p.seed as u64);
    let mut net = Model::new(&graph, hidden, layers, &mut rng);

    let objective = if p.objective == "tripletMargin" {
        Objective::TripletMargin
    } else {
        Objective::SampledSoftmax
    };
    let config = TrainConfig {
        epochs: p.epochs.clamp(1, 5000),
        batch_events: p.batch_events.clamp(1, 100_000),
        learning_rate: p.learning_rate,
        min_learning_rate: 1e-5,
        weight_decay: 1e-5,
        margin: p.margin,
        dropout: p.dropout.clamp(0.0, 0.95),
        objective,
        temperature: p.temperature.clamp(0.001, 10.0),
        negatives_per_positive: p.negatives_per_positive.clamp(1, 200),
        same_type_negative_fraction: p.same_type_negative_fraction.clamp(0.0, 1.0),
        masked_query_training: p.masked_query_training,
    };

    let total = config.epochs as f64;
    let trained = train::train(&mut net, &graph, &config, &mut rng, |epoch, stat| {
        // Every 5% of the schedule, not every epoch: each post is a structured
        // clone across the worker boundary, and at 250 epochs the difference
        // between 20 messages and 250 is not information the reader gains.
        let every = (config.epochs / 20).max(1);
        if epoch % every == 0 {
            progress(
                0.05 + 0.85 * (epoch as f64 / total),
                &format!(
                    "epoch {}/{} · loss {:.4} · gap {:.3}",
                    epoch + 1,
                    config.epochs,
                    stat.loss,
                    stat.pos - stat.neg
                ),
            );
        }
    });

    progress(0.92, "ranking candidates");
    let history = trained.history;
    let (z_evt, z_obj) = train::embed(&net, &graph, config.masked_query_training);
    let sampler = Sampler::new(&graph);
    // The co-occurrence neighbourhood, counted over the training partition only
    // — the same evidence the other arm is allowed, so that restricting to it
    // does not quietly hand the network something the baseline never had.
    let cooccurrence = if p.cooccurrence_candidates {
        Some(cooccurrence_neighbours(&graph, &sampler))
    } else {
        None
    };
    let names = eval::Names {
        object_ids: &payload.object_ids,
        object_type_names: &payload.object_type_names,
        event_ids: &payload.event_ids,
        activity_names: &payload.activity_names,
    };
    let outcome = eval::evaluate(
        &graph,
        &names,
        &z_evt,
        &z_obj,
        &sampler.by_event,
        cooccurrence.as_deref(),
        &eval::EvalConfig {
            top_k: p.top_k.clamp(1, 200),
            max_examples: p.max_examples.min(500),
        },
    );

    let last = history.last().copied();
    let final_loss = last.map(|s| s.loss as f64).unwrap_or(0.0);
    let final_gap = last.map(|s| (s.pos - s.neg) as f64).unwrap_or(0.0);
    // Under the hinge, §5.3's criterion is exact: the separation reaching the
    // margin is precisely when the loss reaches zero. A sampled softmax has no
    // such point — it keeps rewarding a wider gap forever — so "converged"
    // there means the loss stopped improving over the last tenth of the run.
    let converged = match config.objective {
        Objective::TripletMargin => final_gap >= config.margin as f64,
        Objective::SampledSoftmax => {
            let tail = (history.len() / 10).max(1);
            history.len() > tail && trained.best_epoch + tail < history.len()
        }
    };

    // The curve is thinned to at most 200 points. A chart in a side panel is a
    // few hundred pixels wide, so more points is payload rather than detail.
    let stride = (history.len() / 200).max(1);
    let curve: Vec<EpochRow> = history
        .iter()
        .enumerate()
        .filter(|(i, _)| i % stride == 0 || *i + 1 == history.len())
        .map(|(i, s)| EpochRow {
            epoch: i,
            loss: s.loss as f64,
            pos: s.pos as f64,
            neg: s.neg as f64,
        })
        .collect();

    let observed_events = sampler.trainable.len();
    Ok(Payload {
        method: Method {
            model: format!(
                "heterogeneous GraphSAGE (has / in / related), {}{}",
                match config.objective {
                    Objective::SampledSoftmax => "sampled softmax over one positive and N negatives",
                    Objective::TripletMargin => "triplet margin on cosine similarity",
                },
                if config.masked_query_training { ", masked query training" } else { "" },
            ),
            reference: "Papp, §4.2 / §5.3, with the masked-query training and sampled-softmax objective of PappAron/ocel_repair".into(),
            score: "s(e, o) = cos( h_e^(L), h_o^(L) )".into(),
            estimated_from: if config.masked_query_training {
                "the gapped log, with each step's own links hidden from message passing; positives come from ungapped events only".into()
            } else {
                "the gapped log only — the reference log supplies the ground truth and never reaches the graph".to_string()
            },
            candidate_pool: if p.cooccurrence_candidates { "cooccurring".into() } else { "all".to_string() },
            top_k: p.top_k.clamp(1, 200),
        },
        pairing: payload.pairing,
        meta: Meta {
            object_count: n_obj,
            observed_relations: graph.e2o.len(),
            missing_relations: graph.gaps.len(),
            observed_events,
        },
        metrics: outcome.metrics,
        rank_distribution: outcome.rank_distribution,
        by_object_type: outcome.by_object_type,
        examples: outcome.examples,
        training: Training {
            hidden_dim: hidden,
            layers,
            epochs: history.len(),
            batch_events: config.batch_events,
            margin: config.margin as f64,
            dropout: config.dropout as f64,
            learning_rate: config.learning_rate as f64,
            seed: p.seed,
            objective: match config.objective {
                Objective::SampledSoftmax => "sampled softmax".to_string(),
                Objective::TripletMargin => "triplet margin".to_string(),
            },
            masked_query_training: config.masked_query_training,
            negatives_per_positive: config.negatives_per_positive,
            temperature: config.temperature as f64,
            same_type_negative_fraction: config.same_type_negative_fraction as f64,
            best_epoch: trained.best_epoch,
            best_loss: trained.best_loss as f64,
            final_loss,
            final_gap,
            converged,
            history: curve,
        },
    })
}

#[wasm_bindgen]
pub struct GapGnn;

#[wasm_bindgen]
impl GapGnn {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        GapGnn
    }

    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let parsed: Params = serde_wasm_bindgen::from_value(params)
            .map_err(|e| JsValue::from_str(&format!("relation-gap: bad params: {e}")))?;
        progress(0.02, "building the graph");
        let payload = run(parsed).map_err(|e| JsValue::from_str(&e))?;
        // `serialize_maps_as_objects` matters: a serde map (here `hitsAt`)
        // otherwise crosses as a JS `Map`, which structured-clones without
        // complaint and then reads as `{}` through `JSON.stringify` — so the
        // artifact would persist with its metrics silently empty.
        let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
        payload
            .serialize(&serializer)
            .map_err(|e| JsValue::from_str(&e.to_string()))
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

impl Default for GapGnn {
    fn default() -> Self {
        Self::new()
    }
}
