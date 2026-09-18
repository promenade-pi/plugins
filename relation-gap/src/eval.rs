//! Ranking and scoring, producing the same payload the co-occurrence arm emits.
//!
//! Identical on purpose: one artifact type, one view, and two numbers a reader
//! can put side by side without wondering whether the difference is the model
//! or the measurement. The one field that differs is `method`, which says which
//! model produced it and over what candidate pool.

use crate::linalg::Mat;
use crate::model::Graph;
use serde::Serialize;
use std::collections::HashMap;

pub const BUCKETS: [(&str, usize, usize); 6] = [
    ("1", 1, 1),
    ("2-5", 2, 5),
    ("6-10", 6, 10),
    ("11-50", 11, 50),
    ("51-100", 51, 100),
    ("101+", 101, usize::MAX),
];

#[derive(Serialize)]
pub struct Bucket {
    pub bucket: String,
    pub n: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeRow {
    pub object_type: String,
    pub evaluated: usize,
    pub unreachable: usize,
    #[serde(rename = "hitsAt1")]
    pub hits_at_1: f64,
    pub mrr: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRef {
    pub object_id: String,
    pub object_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingRef {
    pub object_id: String,
    pub object_type: String,
    pub rank: Option<f64>,
    pub in_pool: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prediction {
    pub object_id: String,
    pub object_type: String,
    pub score: f64,
    pub correct: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Example {
    pub event_id: String,
    pub activity: String,
    pub observed: Vec<ObjectRef>,
    pub missing: Vec<MissingRef>,
    pub predictions: Vec<Prediction>,
    pub correct: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub evaluated: usize,
    pub gapped_events: usize,
    pub unreachable: usize,
    pub hits_at: HashMap<String, f64>,
    pub mrr: f64,
    #[serde(rename = "precisionAtK")]
    pub precision_at_k: f64,
    #[serde(rename = "recallAtK")]
    pub recall_at_k: f64,
    #[serde(rename = "f1AtK")]
    pub f1_at_k: f64,
}

pub struct Names<'a> {
    pub object_ids: &'a [String],
    pub object_type_names: &'a [String],
    pub event_ids: &'a [String],
    pub activity_names: &'a [String],
}

pub struct Outcome {
    pub metrics: Metrics,
    pub rank_distribution: Vec<Bucket>,
    pub by_object_type: Vec<TypeRow>,
    pub examples: Vec<Example>,
}

fn bucket_of(rank: usize) -> &'static str {
    for (label, low, high) in BUCKETS {
        if rank >= low && rank <= high {
            return label;
        }
    }
    "101+"
}

/// A deterministic spread across the gapped events, not the first `limit`.
fn spread<T>(items: Vec<T>, limit: usize) -> Vec<T> {
    if limit == 0 || items.is_empty() {
        return Vec::new();
    }
    if items.len() <= limit {
        return items;
    }
    let step = items.len() as f64 / limit as f64;
    let mut picked: Vec<usize> = (0..limit)
        .map(|i| ((i as f64 * step) as usize).min(items.len() - 1))
        .collect();
    picked.dedup();
    let mut out = Vec::with_capacity(picked.len());
    for (index, item) in items.into_iter().enumerate() {
        if picked.binary_search(&index).is_ok() {
            out.push(item);
        }
    }
    out
}

/// Scores every object for every gapped event and collects the metrics.
///
/// The network places all 9,543 objects on one sphere, so unlike the
/// co-occurrence arm there is no such thing as a candidate outside the pool:
/// every gap gets a finite rank, and `unreachable` is always zero. That is also
/// why the two arms are only comparable when the co-occurrence one is run with
/// its `all` pool — stated in `method` so a reader of the artifact alone can
/// see it.
pub struct EvalConfig {
    pub top_k: usize,
    pub max_examples: usize,
}

/// Scores the candidate pool for every gapped event and collects the metrics.
///
/// With no candidate restriction the network ranks every object, so nothing can
/// fall outside the pool and `unreachable` is zero. With the restriction on, a
/// held-out object the pool never contained is counted as unreachable and takes
/// the expected rank of the unscored group — the same treatment, and the same
/// arithmetic, the co-occurrence arm gives it. Anything else would let a pool
/// that excluded the answer look better than one that ranked it last.
pub fn evaluate(
    graph: &Graph,
    names: &Names,
    z_evt: &Mat,
    z_obj: &Mat,
    observed_by_event: &[Vec<u32>],
    cooccurrence: Option<&[Vec<u32>]>,
    config: &EvalConfig,
) -> Outcome {
    let top_k = config.top_k;
    let max_examples = config.max_examples;

    let mut missing_by_event: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(e, o) in &graph.gaps {
        missing_by_event.entry(e).or_default().push(o);
    }
    let mut gapped_events: Vec<u32> = missing_by_event.keys().copied().collect();
    gapped_events.sort_unstable();

    let hit_ks = [1usize, 3, 5, 10];
    let mut hits = [0usize; 4];
    let mut reciprocal = 0.0f64;
    let mut evaluated = 0usize;
    let mut unreachable = 0usize;
    let mut set_correct = 0usize;
    let mut set_predicted = 0usize;
    let mut histogram: HashMap<&'static str, usize> = HashMap::new();
    let mut per_type: HashMap<usize, (usize, usize, f64, usize)> = HashMap::new();
    let mut walkthrough: Vec<Example> = Vec::new();

    let d = z_obj.cols;
    let mut in_pool = vec![false; graph.n_obj];

    for &e in &gapped_events {
        let missing = {
            let mut m = missing_by_event[&e].clone();
            m.sort_unstable();
            m.dedup();
            m
        };
        let observed = &observed_by_event[e as usize];

        // The candidate pool: every object, or the co-occurrence neighbourhood
        // of what the event still shows. An event whose observed objects have no
        // recorded neighbours at all keeps the full pool — an empty restriction
        // is no information, not a verdict.
        in_pool.iter_mut().for_each(|v| *v = false);
        let mut pool_size = 0usize;
        let mut restricted = false;
        if let Some(neighbours) = cooccurrence {
            for &o in observed {
                for &candidate in &neighbours[o as usize] {
                    if !in_pool[candidate as usize] {
                        in_pool[candidate as usize] = true;
                        pool_size += 1;
                    }
                }
            }
            restricted = pool_size > 0;
        }
        if !restricted {
            in_pool.iter_mut().for_each(|v| *v = true);
            pool_size = graph.n_obj;
        }
        // An object already visible in the event is a true link, not a gap.
        for &o in observed {
            if in_pool[o as usize] {
                in_pool[o as usize] = false;
                pool_size -= 1;
            }
        }

        let ze = z_evt.row(e as usize);
        let mut scored: Vec<(f32, u32)> = Vec::with_capacity(pool_size);
        for o in 0..graph.n_obj {
            if !in_pool[o] {
                continue;
            }
            let zo = &z_obj.data[o * d..(o + 1) * d];
            let mut acc = 0.0f32;
            for j in 0..d {
                acc += ze[j] * zo[j];
            }
            scored.push((acc, o as u32));
        }
        // Ties broken by object index, so a rerun cannot reorder two objects the
        // network scored identically.
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));

        let mut rank_of: HashMap<u32, usize> = HashMap::with_capacity(scored.len());
        for (index, &(_, o)) in scored.iter().enumerate() {
            rank_of.insert(o, index + 1);
        }
        let predicted: Vec<(f32, u32)> = scored.iter().copied().take(top_k).collect();
        set_predicted += predicted.len();
        let predicted_ids: Vec<u32> = predicted.iter().map(|&(_, o)| o).collect();

        // Objects the pool never contained share the position after the last
        // scored candidate, at that group's expected rank under random ties.
        let outside = graph.n_obj.saturating_sub(observed.len()).saturating_sub(scored.len());
        let tied_rank = if outside > 0 {
            Some(scored.len() as f64 + (outside as f64 + 1.0) / 2.0)
        } else {
            None
        };

        for &m in &missing {
            evaluated += 1;
            let entry = per_type
                .entry(graph.object_type[m as usize] as usize)
                .or_insert((0, 0, 0.0, 0));
            entry.0 += 1;

            let rank = match rank_of.get(&m) {
                Some(&r) => Some(r as f64),
                None => {
                    unreachable += 1;
                    entry.3 += 1;
                    tied_rank
                }
            };
            match rank {
                Some(r) => {
                    reciprocal += 1.0 / r;
                    entry.2 += 1.0 / r;
                    *histogram.entry(bucket_of(r.ceil() as usize)).or_insert(0) += 1;
                    for (slot, &limit) in hit_ks.iter().enumerate() {
                        if r <= limit as f64 {
                            hits[slot] += 1;
                        }
                    }
                    if r <= 1.0 {
                        entry.1 += 1;
                    }
                }
                None => {
                    *histogram.entry("unranked").or_insert(0) += 1;
                }
            }
            if predicted_ids.contains(&m) {
                set_correct += 1;
            }
        }

        if max_examples > 0 {
            let object_ref = |o: u32| ObjectRef {
                object_id: names.object_ids[o as usize].clone(),
                object_type: names.object_type_names[graph.object_type[o as usize] as usize].clone(),
            };
            walkthrough.push(Example {
                event_id: names.event_ids[e as usize].clone(),
                activity: names.activity_names[graph.event_activity[e as usize] as usize].clone(),
                observed: observed.iter().map(|&o| object_ref(o)).collect(),
                missing: missing
                    .iter()
                    .map(|&m| MissingRef {
                        object_id: names.object_ids[m as usize].clone(),
                        object_type: names.object_type_names[graph.object_type[m as usize] as usize]
                            .clone(),
                        rank: rank_of.get(&m).map(|&r| r as f64).or(tied_rank),
                        in_pool: rank_of.contains_key(&m),
                    })
                    .collect(),
                predictions: predicted
                    .iter()
                    .map(|&(score, o)| Prediction {
                        object_id: names.object_ids[o as usize].clone(),
                        object_type: names.object_type_names[graph.object_type[o as usize] as usize]
                            .clone(),
                        score: score as f64,
                        correct: missing.contains(&o),
                    })
                    .collect(),
                correct: predicted_ids.first().map(|o| missing.contains(o)).unwrap_or(false),
            });
        }
    }

    let denominator = evaluated.max(1) as f64;
    let mut hits_at = HashMap::new();
    for (slot, &limit) in hit_ks.iter().enumerate() {
        hits_at.insert(limit.to_string(), hits[slot] as f64 / denominator);
    }
    let precision = if set_predicted > 0 {
        set_correct as f64 / set_predicted as f64
    } else {
        0.0
    };
    let recall = set_correct as f64 / denominator;
    let metrics = Metrics {
        evaluated,
        gapped_events: gapped_events.len(),
        unreachable,
        hits_at,
        mrr: reciprocal / denominator,
        precision_at_k: precision,
        recall_at_k: recall,
        f1_at_k: if precision + recall > 0.0 {
            2.0 * precision * recall / (precision + recall)
        } else {
            0.0
        },
    };

    let mut rank_distribution: Vec<Bucket> = BUCKETS
        .iter()
        .map(|(label, _, _)| Bucket {
            bucket: label.to_string(),
            n: histogram.get(label).copied().unwrap_or(0),
        })
        .collect();
    rank_distribution.push(Bucket {
        bucket: "unranked".to_string(),
        n: histogram.get("unranked").copied().unwrap_or(0),
    });

    let mut by_object_type: Vec<TypeRow> = per_type
        .into_iter()
        .map(|(t, (count, hit1, rr, missed))| TypeRow {
            object_type: names.object_type_names[t].clone(),
            evaluated: count,
            unreachable: missed,
            hits_at_1: hit1 as f64 / count.max(1) as f64,
            mrr: rr / count.max(1) as f64,
        })
        .collect();
    by_object_type.sort_by(|a, b| {
        b.evaluated.cmp(&a.evaluated).then(a.object_type.cmp(&b.object_type))
    });

    Outcome {
        metrics,
        rank_distribution,
        by_object_type,
        examples: spread(walkthrough, max_examples),
    }
}
