//! Metric learning for the link task, §5.3 and its successor.
//!
//! The network is not asked to classify anything, so there is no softmax over
//! classes. It is trained to place an event's representation nearer the objects
//! that took part in it than the ones that did not, and the ranking the
//! evaluation reads is then just that geometry, queried.
//!
//! Two things here are not in the paper, and both come from the refactored
//! reference implementation (`PappAron/ocel_repair`), which identified the same
//! evaluation defect this port did and answered it more directly.
//!
//! **Masked query training.** Every step removes the batch's own positive links
//! from the message-passing graph before the forward pass. Without it the
//! network can satisfy the objective by reading the answer off the adjacency it
//! is given — an event is trivially close to the objects it is connected to —
//! and learns nothing that transfers to a link it cannot see. With it, the
//! training condition is the evaluation condition. This is the single change
//! that decides whether the model does anything useful at all.
//!
//! **Sampled softmax instead of a triplet margin.** One positive against N
//! sampled negatives, as cross-entropy over the temperature-scaled scores.
//! A hinge stops caring once the margin is met, which is exactly the point at
//! which a ranking task still has all its work left to do: being *ahead* of a
//! negative is worth nothing if a hundred other candidates are ahead too.

use crate::linalg::{normalize_row, Mat, Rng};
use crate::model::{backward, forward, EdgeSet, Graph, Model};
use std::collections::HashSet;

#[derive(Clone, Copy, PartialEq)]
pub enum Objective {
    /// Cross-entropy over one positive and N negatives, temperature-scaled.
    SampledSoftmax,
    /// The paper's `max(0, γ − (s_pos − s_neg))`.
    TripletMargin,
}

pub struct TrainConfig {
    pub epochs: usize,
    pub batch_events: usize,
    pub learning_rate: f32,
    pub min_learning_rate: f32,
    pub weight_decay: f32,
    pub margin: f32,
    pub dropout: f32,
    pub objective: Objective,
    pub temperature: f32,
    pub negatives_per_positive: usize,
    /// Share of negatives drawn from the positive's own object type.
    pub same_type_negative_fraction: f32,
    /// Hide the batch's own links from message passing for that step.
    pub masked_query_training: bool,
}

#[derive(Clone, Copy)]
pub struct EpochStat {
    pub loss: f32,
    pub pos: f32,
    pub neg: f32,
}

pub(crate) struct LossOut {
    pub d_evt: Mat,
    pub d_obj: Mat,
    pub loss: f32,
    pub pos: f32,
    pub neg: f32,
}

/// One training example: an event, the object that belongs to it, and the
/// objects that do not.
pub struct Triplet {
    pub event: u32,
    pub positive: u32,
    pub negatives: Vec<u32>,
}

/// Gradient of `cos(a, b)` with respect to `a`, accumulated into `out`.
///
/// `d/da = (b̂ − s·â) / |a|`. The subtracted term is what keeps the gradient
/// tangent to the sphere; dropping it still trains, just worse, which is why
/// this is checked numerically rather than by reading.
#[inline]
fn cosine_grad(out: &mut [f32], other_unit: &[f32], self_unit: &[f32], score: f32, norm: f32, scale: f32) {
    for j in 0..out.len() {
        out[j] += scale * (other_unit[j] - score * self_unit[j]) / norm;
    }
}

pub(crate) fn loss_and_grad(
    h_evt: &Mat,
    h_obj: &Mat,
    batch: &[Triplet],
    config: &TrainConfig,
    d: usize,
) -> LossOut {
    let mut out = LossOut {
        d_evt: Mat::zeros(h_evt.rows, d),
        d_obj: Mat::zeros(h_obj.rows, d),
        loss: 0.0,
        pos: 0.0,
        neg: 0.0,
    };
    if batch.is_empty() {
        return out;
    }
    let scale = 1.0 / batch.len() as f32;
    let mut ze = vec![0.0f32; d];
    let mut zp = vec![0.0f32; d];
    let mut zn = vec![0.0f32; d];
    let mut neg_units: Vec<Vec<f32>> = Vec::new();
    let mut neg_norms: Vec<f32> = Vec::new();
    let mut neg_scores: Vec<f32> = Vec::new();

    for item in batch {
        let e = item.event as usize;
        let p = item.positive as usize;
        let ne = normalize_row(&mut ze, h_evt.row(e));
        let np = normalize_row(&mut zp, h_obj.row(p));
        let s_pos: f32 = ze.iter().zip(&zp).map(|(a, b)| a * b).sum();
        out.pos += s_pos * scale;

        neg_units.clear();
        neg_norms.clear();
        neg_scores.clear();
        for &n in &item.negatives {
            let nn = normalize_row(&mut zn, h_obj.row(n as usize));
            let s_neg: f32 = ze.iter().zip(&zn).map(|(a, b)| a * b).sum();
            neg_units.push(zn.clone());
            neg_norms.push(nn);
            neg_scores.push(s_neg);
        }
        if neg_scores.is_empty() {
            continue;
        }
        let mean_neg = neg_scores.iter().sum::<f32>() / neg_scores.len() as f32;
        out.neg += mean_neg * scale;

        match config.objective {
            Objective::SampledSoftmax => {
                // Cross-entropy with the positive at index 0. Softmax is
                // computed against the shifted maximum so a temperature of 0.1
                // cannot overflow the exponential.
                let t = config.temperature.max(1e-4);
                let logit_pos = s_pos / t;
                let mut max_logit = logit_pos;
                for s in &neg_scores {
                    max_logit = max_logit.max(s / t);
                }
                let exp_pos = (logit_pos - max_logit).exp();
                let mut sum_exp = exp_pos;
                let mut exp_neg = Vec::with_capacity(neg_scores.len());
                for s in &neg_scores {
                    let value = (s / t - max_logit).exp();
                    exp_neg.push(value);
                    sum_exp += value;
                }
                out.loss += -(exp_pos / sum_exp).ln() * scale;

                // d(loss)/d(logit_i) is softmax_i − 1{i = positive}.
                let g_pos = (exp_pos / sum_exp - 1.0) * scale / t;
                cosine_grad(out.d_evt.row_mut(e), &zp, &ze, s_pos, ne, g_pos);
                cosine_grad(out.d_obj.row_mut(p), &ze, &zp, s_pos, np, g_pos);
                for (index, &n) in item.negatives.iter().enumerate() {
                    let g_neg = (exp_neg[index] / sum_exp) * scale / t;
                    let unit = &neg_units[index];
                    cosine_grad(out.d_evt.row_mut(e), unit, &ze, neg_scores[index], ne, g_neg);
                    cosine_grad(
                        out.d_obj.row_mut(n as usize),
                        &ze,
                        unit,
                        neg_scores[index],
                        neg_norms[index],
                        g_neg,
                    );
                }
            }
            Objective::TripletMargin => {
                // One hinge per negative, averaged, so the two objectives are
                // comparable at the same `negatives_per_positive`.
                let per = scale / neg_scores.len() as f32;
                for (index, &n) in item.negatives.iter().enumerate() {
                    let violation = config.margin - (s_pos - neg_scores[index]);
                    if violation <= 0.0 {
                        continue;
                    }
                    out.loss += violation * per;
                    let unit = &neg_units[index];
                    cosine_grad(out.d_evt.row_mut(e), &zp, &ze, s_pos, ne, -per);
                    cosine_grad(out.d_obj.row_mut(p), &ze, &zp, s_pos, np, -per);
                    cosine_grad(out.d_evt.row_mut(e), unit, &ze, neg_scores[index], ne, per);
                    cosine_grad(
                        out.d_obj.row_mut(n as usize),
                        &ze,
                        unit,
                        neg_scores[index],
                        neg_norms[index],
                        per,
                    );
                }
            }
        }
    }
    out
}

/// Adam, with PyTorch's coupled weight decay: the penalty joins the gradient
/// before the moments see it, which is what `torch.optim.Adam` does (and is
/// not AdamW).
struct Adam {
    m: Vec<Mat>,
    v: Vec<Mat>,
    step: i32,
    beta1: f32,
    beta2: f32,
    eps: f32,
}

impl Adam {
    fn new(model: &Model) -> Self {
        Adam { m: model.zeros_like(), v: model.zeros_like(), step: 0, beta1: 0.9, beta2: 0.999, eps: 1e-8 }
    }

    fn apply(&mut self, model: &mut Model, grads: &[Mat], lr: f32, weight_decay: f32) {
        self.step += 1;
        let bias1 = 1.0 - self.beta1.powi(self.step);
        let bias2 = 1.0 - self.beta2.powi(self.step);
        for p in 0..model.params.len() {
            let param = &mut model.params[p];
            let grad = &grads[p];
            let m = &mut self.m[p];
            let v = &mut self.v[p];
            for i in 0..param.data.len() {
                let g = grad.data[i] + weight_decay * param.data[i];
                m.data[i] = self.beta1 * m.data[i] + (1.0 - self.beta1) * g;
                v.data[i] = self.beta2 * v.data[i] + (1.0 - self.beta2) * g * g;
                param.data[i] -= lr * (m.data[i] / bias1) / ((v.data[i] / bias2).sqrt() + self.eps);
            }
        }
    }
}

fn clip(grads: &mut [Mat], max_norm: f32) {
    let mut total = 0.0f64;
    for g in grads.iter() {
        for v in &g.data {
            total += (*v as f64) * (*v as f64);
        }
    }
    let norm = total.sqrt() as f32;
    if norm > max_norm && norm > 0.0 {
        let s = max_norm / norm;
        for g in grads.iter_mut() {
            for v in g.data.iter_mut() {
                *v *= s;
            }
        }
    }
}

pub struct Sampler {
    /// Observed objects per event, over the whole gapped log. This is what an
    /// event's context is at inference time.
    pub by_event: Vec<Vec<u32>>,
    /// Object indices per object type, the same-type negative pool.
    pub by_type: Vec<Vec<u32>>,
    /// Events the network may learn from: those with no held-out link.
    ///
    /// A gapped event's surviving links are legitimate evidence for message
    /// passing — and stay in the graph — but using them as training positives
    /// would let the split leak in the other direction, so the objective never
    /// sees them. The reference implementation draws the same line.
    pub trainable: Vec<u32>,
    /// Positive `(event, object)` pairs drawn from trainable events only.
    pub positives: Vec<(u32, u32)>,
}

impl Sampler {
    pub fn new(graph: &Graph) -> Self {
        let mut by_event = vec![Vec::new(); graph.n_evt];
        for &(e, o) in &graph.e2o {
            by_event[e as usize].push(o);
        }
        for list in by_event.iter_mut() {
            list.sort_unstable();
            list.dedup();
        }
        let mut by_type = vec![Vec::new(); graph.n_otype.max(1)];
        for o in 0..graph.n_obj {
            by_type[graph.object_type[o] as usize].push(o as u32);
        }
        let gapped: HashSet<u32> = graph.gaps.iter().map(|&(e, _)| e).collect();
        let trainable: Vec<u32> = (0..graph.n_evt as u32)
            .filter(|e| !gapped.contains(e) && !by_event[*e as usize].is_empty())
            .collect();
        let mut positives = Vec::new();
        for &e in &trainable {
            for &o in &by_event[e as usize] {
                positives.push((e, o));
            }
        }
        Sampler { by_event, by_type, trainable, positives }
    }

    /// One batch of positives with their sampled negatives.
    ///
    /// Negatives mix the positive's own object type with other types. An
    /// all-cross-type draw makes the problem trivial — telling a payment from a
    /// material needs no graph — while an all-same-type draw is the hardest
    /// possible and trains slowly; the reference implementation splits them
    /// evenly and this follows it. Objects already visible in the event are
    /// never negatives: they are true links, just not this one.
    pub fn batch(&self, graph: &Graph, config: &TrainConfig, rng: &mut Rng) -> Vec<Triplet> {
        let mut batch = Vec::with_capacity(config.batch_events);
        if self.positives.is_empty() {
            return batch;
        }
        let same_count = ((config.negatives_per_positive as f32)
            * config.same_type_negative_fraction)
            .round() as usize;
        let cross_count = config.negatives_per_positive.saturating_sub(same_count);

        for _ in 0..config.batch_events {
            let (event, positive) = self.positives[rng.below(self.positives.len())];
            let observed = &self.by_event[event as usize];
            let positive_type = graph.object_type[positive as usize];
            let mut negatives = Vec::with_capacity(config.negatives_per_positive);

            let excluded = |candidate: u32| candidate == positive || observed.contains(&candidate);

            let pool = &self.by_type[positive_type as usize];
            let mut tries = 0;
            while negatives.len() < same_count && tries < same_count * 30 + 30 {
                tries += 1;
                if pool.is_empty() {
                    break;
                }
                let candidate = pool[rng.below(pool.len())];
                if !excluded(candidate) && !negatives.contains(&candidate) {
                    negatives.push(candidate);
                }
            }
            let target = negatives.len() + cross_count;
            tries = 0;
            while negatives.len() < target && tries < cross_count * 30 + 30 {
                tries += 1;
                let candidate = rng.below(graph.n_obj) as u32;
                if graph.object_type[candidate as usize] == positive_type {
                    continue;
                }
                if !excluded(candidate) && !negatives.contains(&candidate) {
                    negatives.push(candidate);
                }
            }
            // A log with one object type, or a tiny one, can exhaust both pools;
            // fall back to any object rather than emitting an empty example.
            tries = 0;
            while negatives.len() < config.negatives_per_positive.min(graph.n_obj.saturating_sub(1))
                && tries < 200
            {
                tries += 1;
                let candidate = rng.below(graph.n_obj) as u32;
                if !excluded(candidate) && !negatives.contains(&candidate) {
                    negatives.push(candidate);
                }
            }
            if !negatives.is_empty() {
                batch.push(Triplet { event, positive, negatives });
            }
        }
        batch
    }
}

/// The message-passing edges for one step, with the batch's own links hidden.
///
/// An object whose link is masked also loses its object-object relations for
/// that pass. Otherwise the answer is still reachable in two hops — an observed
/// object related to the hidden one hands it straight back — and the mask would
/// close the front door while leaving the side one open. The reference
/// implementation masks both, and so does this.
fn masked_edges(graph: &Graph, batch: &[Triplet]) -> (Vec<(u32, u32)>, Vec<(u32, u32)>) {
    let hidden: HashSet<(u32, u32)> = batch.iter().map(|t| (t.event, t.positive)).collect();
    let hidden_objects: HashSet<u32> = batch.iter().map(|t| t.positive).collect();
    let e2o = graph.e2o.iter().copied().filter(|pair| !hidden.contains(pair)).collect();
    let o2o = graph
        .o2o
        .iter()
        .copied()
        .filter(|(a, b)| !hidden_objects.contains(a) && !hidden_objects.contains(b))
        .collect();
    (e2o, o2o)
}

/// Test hook: the masking rule is the single most important thing in this file
/// and deserves a test of its own rather than only being exercised indirectly.
#[cfg(test)]
pub fn masked_edges_for_test(graph: &Graph, batch: &[Triplet]) -> (Vec<(u32, u32)>, Vec<(u32, u32)>) {
    masked_edges(graph, batch)
}

pub struct Trained {
    pub history: Vec<EpochStat>,
    pub best_epoch: usize,
    pub best_loss: f32,
}

pub fn train(
    model: &mut Model,
    graph: &Graph,
    config: &TrainConfig,
    rng: &mut Rng,
    mut on_epoch: impl FnMut(usize, EpochStat),
) -> Trained {
    let sampler = Sampler::new(graph);
    let mut adam = Adam::new(model);
    let mut history = Vec::with_capacity(config.epochs);
    // The parameters from the lowest-loss step, not the last one. With a
    // sampled objective the final step is a sample like any other, and the
    // reference implementation keeps the best checkpoint for the same reason.
    let mut best: Option<(usize, f32, Vec<Mat>)> = None;

    for epoch in 0..config.epochs {
        let batch = sampler.batch(graph, config, rng);
        if batch.is_empty() {
            break;
        }

        let (masked_e2o, masked_o2o);
        let edges = if config.masked_query_training {
            let (a, b) = masked_edges(graph, &batch);
            masked_e2o = a;
            masked_o2o = b;
            EdgeSet { e2o: &masked_e2o, o2o: &masked_o2o }
        } else {
            graph.all_edges()
        };

        let act = forward(model, graph, &edges, config.dropout, Some(rng));
        let last = model.n_layers;
        let out = loss_and_grad(&act.h_evt[last], &act.h_obj[last], &batch, config, model.d);

        let mut grads = model.zeros_like();
        backward(model, graph, &edges, &act, out.d_evt, out.d_obj, &mut grads);
        clip(&mut grads, 1.0);

        let progress = epoch as f32 / config.epochs.max(1) as f32;
        let lr = config.min_learning_rate
            + (config.learning_rate - config.min_learning_rate)
                * (1.0 + (std::f32::consts::PI * progress).cos())
                * 0.5;
        adam.apply(model, &grads, lr, config.weight_decay);

        let stat = EpochStat { loss: out.loss, pos: out.pos, neg: out.neg };
        if best.as_ref().map(|(_, loss, _)| out.loss < *loss).unwrap_or(true) {
            best = Some((epoch, out.loss, model.params.clone()));
        }
        history.push(stat);
        on_epoch(epoch, stat);
    }

    let (best_epoch, best_loss) = match best {
        Some((epoch, loss, params)) => {
            model.params = params;
            (epoch, loss)
        }
        None => (0, 0.0),
    };
    Trained { history, best_epoch, best_loss }
}

/// Final embeddings, with dropout off.
///
/// `mask_held_out_relations` drops the object-object edges of every held-out
/// object, which is what training saw: under masked queries the answer's
/// `related` edges are hidden along with its event link. Leaving them in at
/// scoring time is a train/test mismatch — the network would meet a node shape
/// it was never optimised for — and the reference implementation masks them
/// here too. Off, the scoring graph is simply the gapped log, which is what an
/// analyst actually holds.
pub fn embed(model: &Model, graph: &Graph, mask_held_out_relations: bool) -> (Mat, Mat) {
    let held: HashSet<u32> = if mask_held_out_relations {
        graph.gaps.iter().map(|&(_, o)| o).collect()
    } else {
        HashSet::new()
    };
    let o2o: Vec<(u32, u32)> = if held.is_empty() {
        Vec::new()
    } else {
        graph.o2o.iter().copied().filter(|(a, b)| !held.contains(a) && !held.contains(b)).collect()
    };
    let edges = if held.is_empty() {
        graph.all_edges()
    } else {
        EdgeSet { e2o: &graph.e2o, o2o: &o2o }
    };
    let act = forward(model, graph, &edges, 0.0, None);
    let last = model.n_layers;
    let mut z_evt = Mat::zeros(graph.n_evt, model.d);
    let mut z_obj = Mat::zeros(graph.n_obj, model.d);
    for e in 0..graph.n_evt {
        let src: Vec<f32> = act.h_evt[last].row(e).to_vec();
        normalize_row(z_evt.row_mut(e), &src);
    }
    for o in 0..graph.n_obj {
        let src: Vec<f32> = act.h_obj[last].row(o).to_vec();
        normalize_row(z_obj.row_mut(o), &src);
    }
    (z_evt, z_obj)
}
