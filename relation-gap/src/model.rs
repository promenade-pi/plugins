//! Heterogeneous GraphSAGE over an object-centric event log, §4.2 of the paper.
//!
//! Three relation channels over two node types:
//!
//! ```text
//!   has      event  -> object    an object participates in an event
//!   in       object -> event     the same association, read the other way
//!   related  object -> object    a structural link the log records directly
//! ```
//!
//! `has` and `in` are the same association as separate directed channels on
//! purpose, and it is not redundancy: message passing only ever moves state
//! from source to destination, so without both directions an event node could
//! never see the objects it touches *and* an object could never see the events
//! it took part in. One layer of each is what makes an event's representation
//! a function of its objects' histories.
//!
//! One layer of one channel is
//!
//! ```text
//!   pre_r[v] = ( Σ_{u ∈ N_r(v)} h[u] ) · Wneigh_rᵀ  +  h[v] · Wself_rᵀ  +  b_r
//! ```
//!
//! summed over the channels that target `v`'s node type — so object nodes add
//! `has` and `related`, event nodes get `in` alone — then ReLU, then dropout on
//! all but the last layer. Aggregation is a plain sum rather than a mean, which
//! §5.3 argues for on the grounds that an event touching ten items differs from
//! one touching a single item in a way a mean deliberately erases.
//!
//! The backward pass is written out by hand because there is no autodiff here.
//! Every gradient below is the transpose-rule reading of the line above it, and
//! `tests::gradient_matches_finite_differences` checks the whole chain against
//! numerical differentiation rather than against my arithmetic.

use crate::linalg::{add_row, matmul_add, matmul_at_b_add, matmul_bt_add, Mat, Rng};

pub const HAS: usize = 0;
pub const IN: usize = 1;
pub const REL: usize = 2;
pub const N_REL: usize = 3;

/// Parameter slots per relation, in the order the flat parameter list holds them.
const W_SELF: usize = 0;
const W_NEIGH: usize = 1;
const BIAS: usize = 2;
const PER_REL: usize = 3;
/// The three embedding tables come first.
const EMB_ACT: usize = 0;
const EMB_OBJ: usize = 1;
const EMB_OTYPE: usize = 2;
const N_EMB: usize = 3;

/// The edges one forward pass may use.
///
/// Message passing does not always run over the whole graph. Masked query
/// training removes the very links the batch is about, so that the network is
/// asked to score a link it cannot see — which is the condition the evaluation
/// puts it in, and the thing the notebook never did. The edge lists are
/// therefore a parameter of the pass rather than a property of the graph.
pub struct EdgeSet<'a> {
    pub e2o: &'a [(u32, u32)],
    pub o2o: &'a [(u32, u32)],
}

pub struct Graph {
    pub n_obj: usize,
    pub n_evt: usize,
    pub n_otype: usize,
    pub n_act: usize,
    pub object_type: Vec<u32>,
    pub event_activity: Vec<u32>,
    /// `(event, object)`, carrying both the `has` and the `in` channel.
    pub e2o: Vec<(u32, u32)>,
    /// `(source object, target object)`, the `related` channel.
    pub o2o: Vec<(u32, u32)>,
    /// `(event, object)` links held out of the gapped log: the ground truth.
    /// Never used for message passing or for training — only for scoring.
    pub gaps: Vec<(u32, u32)>,
}

impl Graph {
    /// Every edge: the ordinary, unmasked pass.
    pub fn all_edges(&self) -> EdgeSet<'_> {
        EdgeSet { e2o: &self.e2o, o2o: &self.o2o }
    }
}

/// Every learnable tensor in one flat list, so the optimiser needs no knowledge
/// of what any of them mean. Biases are 1 × d matrices for the same reason.
pub struct Model {
    pub d: usize,
    pub n_layers: usize,
    pub params: Vec<Mat>,
}

#[inline]
fn slot(n_layers_before: usize, relation: usize, which: usize) -> usize {
    N_EMB + (n_layers_before * N_REL + relation) * PER_REL + which
}

impl Model {
    pub fn new(graph: &Graph, d: usize, n_layers: usize, rng: &mut Rng) -> Self {
        let mut params = Vec::with_capacity(N_EMB + n_layers * N_REL * PER_REL);

        // `nn.Embedding`'s own initialisation is a unit normal, and the model
        // is transductive through `emb_obj` — one learned vector per object —
        // so this table is also the largest parameter in the network.
        let mut embedding = |rows: usize| {
            let mut m = Mat::zeros(rows, d);
            for v in m.data.iter_mut() {
                *v = rng.normal();
            }
            m
        };
        params.push(embedding(graph.n_act.max(1)));
        params.push(embedding(graph.n_obj.max(1)));
        params.push(embedding(graph.n_otype.max(1)));

        // Glorot uniform, ±sqrt(6/(fan_in+fan_out)), which is what PyG's
        // `Linear` (and therefore `SAGEConv`) initialises with — not
        // `torch.nn.Linear`'s ±1/sqrt(fan_in). Both matrices here are square,
        // so this is ±sqrt(3/d): about 1.7× wider than the other rule, and the
        // reference implementation's results are measured under it.
        let bound = (3.0 / d as f32).sqrt();
        for _ in 0..n_layers {
            for _ in 0..N_REL {
                for _ in 0..2 {
                    let mut m = Mat::zeros(d, d);
                    for v in m.data.iter_mut() {
                        *v = (rng.next_f32() * 2.0 - 1.0) * bound;
                    }
                    params.push(m);
                }
                params.push(Mat::zeros(1, d));
            }
        }
        Model { d, n_layers, params }
    }

    #[inline]
    pub fn w_self(&self, layer: usize, relation: usize) -> &Mat {
        &self.params[slot(layer, relation, W_SELF)]
    }
    #[inline]
    pub fn w_neigh(&self, layer: usize, relation: usize) -> &Mat {
        &self.params[slot(layer, relation, W_NEIGH)]
    }
    #[inline]
    pub fn bias(&self, layer: usize, relation: usize) -> &[f32] {
        &self.params[slot(layer, relation, BIAS)].data
    }

    pub fn zeros_like(&self) -> Vec<Mat> {
        self.params.iter().map(|m| Mat::zeros(m.rows, m.cols)).collect()
    }
}

/// Everything the backward pass needs to read back from the forward pass.
pub struct Activations {
    /// `n_layers + 1` entries; index 0 is the input embedding layer.
    pub h_evt: Vec<Mat>,
    pub h_obj: Vec<Mat>,
    /// Aggregated messages per layer and relation, indexed by destination node.
    pub agg: Vec<Vec<Mat>>,
    pub pre_evt: Vec<Mat>,
    pub pre_obj: Vec<Mat>,
    /// Per-layer dropout multipliers, empty on a deterministic (evaluation) pass.
    pub drop_evt: Vec<Vec<f32>>,
    pub drop_obj: Vec<Vec<f32>>,
}

/// Runs the network over the whole graph.
///
/// Full-batch, like the notebook: every node's representation is recomputed
/// each step, and the loss then reads a sampled handful of them. Sampling the
/// *graph* instead (GraphSAGE's own neighbour sampling) would be cheaper per
/// step but is a different estimator, and the point here is to reproduce the
/// paper's model rather than to improve on it.
pub fn forward(
    model: &Model,
    graph: &Graph,
    edges: &EdgeSet,
    dropout: f32,
    rng: Option<&mut Rng>,
) -> Activations {
    let d = model.d;
    let l = model.n_layers;

    let mut h_evt = Vec::with_capacity(l + 1);
    let mut h_obj = Vec::with_capacity(l + 1);

    let mut h0_evt = Mat::zeros(graph.n_evt, d);
    for e in 0..graph.n_evt {
        let a = graph.event_activity[e] as usize;
        h0_evt.row_mut(e).copy_from_slice(model.params[EMB_ACT].row(a));
    }
    let mut h0_obj = Mat::zeros(graph.n_obj, d);
    for o in 0..graph.n_obj {
        let t = graph.object_type[o] as usize;
        let (emb_o, emb_t) = (model.params[EMB_OBJ].row(o), model.params[EMB_OTYPE].row(t));
        let row = h0_obj.row_mut(o);
        for j in 0..d {
            row[j] = emb_o[j] + emb_t[j];
        }
    }
    h_evt.push(h0_evt);
    h_obj.push(h0_obj);

    let mut agg_all = Vec::with_capacity(l);
    let mut pre_evt_all = Vec::with_capacity(l);
    let mut pre_obj_all = Vec::with_capacity(l);
    let mut drop_evt_all = Vec::with_capacity(l);
    let mut drop_obj_all = Vec::with_capacity(l);
    let mut rng = rng;

    for layer in 0..l {
        let mut agg = vec![
            Mat::zeros(graph.n_obj, d),
            Mat::zeros(graph.n_evt, d),
            Mat::zeros(graph.n_obj, d),
        ];
        for &(e, o) in edges.e2o {
            add_row(&mut agg[HAS], o as usize, &h_evt[layer], e as usize);
            add_row(&mut agg[IN], e as usize, &h_obj[layer], o as usize);
        }
        for &(a, b) in edges.o2o {
            add_row(&mut agg[REL], b as usize, &h_obj[layer], a as usize);
        }

        let mut pre_obj = Mat::zeros(graph.n_obj, d);
        for relation in [HAS, REL] {
            matmul_bt_add(&mut pre_obj, &agg[relation], model.w_neigh(layer, relation));
            matmul_bt_add(&mut pre_obj, &h_obj[layer], model.w_self(layer, relation));
            let b = model.bias(layer, relation);
            for row in 0..graph.n_obj {
                let r = pre_obj.row_mut(row);
                for j in 0..d {
                    r[j] += b[j];
                }
            }
        }

        let mut pre_evt = Mat::zeros(graph.n_evt, d);
        matmul_bt_add(&mut pre_evt, &agg[IN], model.w_neigh(layer, IN));
        matmul_bt_add(&mut pre_evt, &h_evt[layer], model.w_self(layer, IN));
        {
            let b = model.bias(layer, IN);
            for row in 0..graph.n_evt {
                let r = pre_evt.row_mut(row);
                for j in 0..d {
                    r[j] += b[j];
                }
            }
        }

        let mut next_obj = pre_obj.clone();
        let mut next_evt = pre_evt.clone();
        for v in next_obj.data.iter_mut() {
            *v = v.max(0.0);
        }
        for v in next_evt.data.iter_mut() {
            *v = v.max(0.0);
        }

        // Dropout on all layers but the last, matching the notebook's
        // `conv -> relu -> dropout` twice and a bare `conv -> relu` third.
        let (mut mask_obj, mut mask_evt) = (Vec::new(), Vec::new());
        if layer + 1 < l && dropout > 0.0 {
            if let Some(r) = rng.as_deref_mut() {
                let keep = 1.0 - dropout;
                let scale = 1.0 / keep;
                mask_obj = vec![0.0; next_obj.data.len()];
                for (m, v) in mask_obj.iter_mut().zip(next_obj.data.iter_mut()) {
                    *m = if r.next_f32() < keep { scale } else { 0.0 };
                    *v *= *m;
                }
                mask_evt = vec![0.0; next_evt.data.len()];
                for (m, v) in mask_evt.iter_mut().zip(next_evt.data.iter_mut()) {
                    *m = if r.next_f32() < keep { scale } else { 0.0 };
                    *v *= *m;
                }
            }
        }

        agg_all.push(agg);
        pre_obj_all.push(pre_obj);
        pre_evt_all.push(pre_evt);
        drop_obj_all.push(mask_obj);
        drop_evt_all.push(mask_evt);
        h_obj.push(next_obj);
        h_evt.push(next_evt);
    }

    Activations {
        h_evt,
        h_obj,
        agg: agg_all,
        pre_evt: pre_evt_all,
        pre_obj: pre_obj_all,
        drop_evt: drop_evt_all,
        drop_obj: drop_obj_all,
    }
}

/// Propagates `d_h_*` at the output layer back to every parameter gradient.
pub fn backward(
    model: &Model,
    graph: &Graph,
    edges: &EdgeSet,
    act: &Activations,
    mut d_h_evt: Mat,
    mut d_h_obj: Mat,
    grads: &mut [Mat],
) {
    let d = model.d;

    for layer in (0..model.n_layers).rev() {
        // ReLU and dropout are elementwise and commute with each other here,
        // so one pass applies both: the mask this layer actually used, then
        // the gate of the pre-activation sign.
        let mut d_pre_obj = d_h_obj;
        if !act.drop_obj[layer].is_empty() {
            for (g, m) in d_pre_obj.data.iter_mut().zip(&act.drop_obj[layer]) {
                *g *= m;
            }
        }
        for (g, p) in d_pre_obj.data.iter_mut().zip(&act.pre_obj[layer].data) {
            if *p <= 0.0 {
                *g = 0.0;
            }
        }
        let mut d_pre_evt = d_h_evt;
        if !act.drop_evt[layer].is_empty() {
            for (g, m) in d_pre_evt.data.iter_mut().zip(&act.drop_evt[layer]) {
                *g *= m;
            }
        }
        for (g, p) in d_pre_evt.data.iter_mut().zip(&act.pre_evt[layer].data) {
            if *p <= 0.0 {
                *g = 0.0;
            }
        }

        let mut d_prev_obj = Mat::zeros(graph.n_obj, d);
        let mut d_prev_evt = Mat::zeros(graph.n_evt, d);
        let mut d_agg = vec![
            Mat::zeros(graph.n_obj, d),
            Mat::zeros(graph.n_evt, d),
            Mat::zeros(graph.n_obj, d),
        ];

        for relation in 0..N_REL {
            let (d_pre, h_prev, d_prev) = if relation == IN {
                (&d_pre_evt, &act.h_evt[layer], &mut d_prev_evt)
            } else {
                (&d_pre_obj, &act.h_obj[layer], &mut d_prev_obj)
            };

            // y = agg · Wneighᵀ + h · Wselfᵀ + b
            matmul_add(&mut d_agg[relation], d_pre, model.w_neigh(layer, relation));
            matmul_add(d_prev, d_pre, model.w_self(layer, relation));
            matmul_at_b_add(
                &mut grads[slot(layer, relation, W_NEIGH)],
                d_pre,
                &act.agg[layer][relation],
            );
            matmul_at_b_add(&mut grads[slot(layer, relation, W_SELF)], d_pre, h_prev);
            let gb = &mut grads[slot(layer, relation, BIAS)].data;
            for row in 0..d_pre.rows {
                let r = d_pre.row(row);
                for j in 0..d {
                    gb[j] += r[j];
                }
            }
        }

        // The message each source contributed is its own state, so the
        // aggregate's gradient lands unchanged on every source that fed it.
        for &(e, o) in edges.e2o {
            add_row(&mut d_prev_evt, e as usize, &d_agg[HAS], o as usize);
            add_row(&mut d_prev_obj, o as usize, &d_agg[IN], e as usize);
        }
        for &(a, b) in edges.o2o {
            add_row(&mut d_prev_obj, a as usize, &d_agg[REL], b as usize);
        }

        d_h_obj = d_prev_obj;
        d_h_evt = d_prev_evt;
    }

    for e in 0..graph.n_evt {
        let a = graph.event_activity[e] as usize;
        let src = d_h_evt.row(e);
        let dst = grads[EMB_ACT].row_mut(a);
        for j in 0..d {
            dst[j] += src[j];
        }
    }
    for o in 0..graph.n_obj {
        let t = graph.object_type[o] as usize;
        let src: Vec<f32> = d_h_obj.row(o).to_vec();
        let dst = grads[EMB_OBJ].row_mut(o);
        for j in 0..d {
            dst[j] += src[j];
        }
        let dst = grads[EMB_OTYPE].row_mut(t);
        for j in 0..d {
            dst[j] += src[j];
        }
    }
}
