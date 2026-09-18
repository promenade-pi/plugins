//! Invariant checks for the network, run by `cargo test` before packaging.
//!
//! The backward pass is about two hundred lines of transposes written by hand,
//! and a wrong one does not crash — it trains, a little worse, and produces a
//! number that looks like a result. So the gradient is not reviewed, it is
//! measured against central differences; and the model is not assumed to learn,
//! it is given a task with a known answer and required to find it.

use crate::eval;
use crate::linalg::{Mat, Rng};
use crate::model::{backward, forward, EdgeSet, Graph, Model};
use crate::train::{self, Objective, Sampler, TrainConfig, Triplet};

fn config(epochs: usize, objective: Objective) -> TrainConfig {
    TrainConfig {
        epochs,
        batch_events: 32,
        learning_rate: 0.01,
        min_learning_rate: 1e-5,
        weight_decay: 1e-5,
        margin: 0.5,
        dropout: 0.0,
        objective,
        temperature: 0.1,
        negatives_per_positive: 8,
        same_type_negative_fraction: 0.5,
        masked_query_training: true,
    }
}

/// A graph of disjoint groups: every event connects one fixed set of objects,
/// and those objects appear together and nowhere else.
fn grouped_graph(groups: usize, per_group: usize, repeats: usize) -> Graph {
    let mut object_type = Vec::new();
    let mut event_activity = Vec::new();
    let mut e2o = Vec::new();
    let n_types = 3usize;

    for g in 0..groups {
        for k in 0..per_group {
            object_type.push(((g + k) % n_types) as u32);
        }
    }
    for g in 0..groups {
        for _ in 0..repeats {
            let e = event_activity.len() as u32;
            event_activity.push((g % 2) as u32);
            for k in 0..per_group {
                e2o.push((e, (g * per_group + k) as u32));
            }
        }
    }
    Graph {
        n_obj: groups * per_group,
        n_evt: event_activity.len(),
        n_otype: n_types,
        n_act: 2,
        object_type,
        event_activity,
        e2o,
        o2o: Vec::new(),
        gaps: Vec::new(),
    }
}

fn random_graph(rng: &mut Rng, n_obj: usize, n_evt: usize) -> Graph {
    let n_types = 3usize;
    let object_type: Vec<u32> = (0..n_obj).map(|_| rng.below(n_types) as u32).collect();
    let event_activity: Vec<u32> = (0..n_evt).map(|_| rng.below(2) as u32).collect();
    let mut e2o = Vec::new();
    for e in 0..n_evt {
        for _ in 0..(1 + rng.below(3)) {
            e2o.push((e as u32, rng.below(n_obj) as u32));
        }
    }
    e2o.sort_unstable();
    e2o.dedup();
    let mut o2o = Vec::new();
    for _ in 0..(n_obj / 2) {
        let (a, b) = (rng.below(n_obj) as u32, rng.below(n_obj) as u32);
        if a != b {
            o2o.push((a, b));
        }
    }
    o2o.sort_unstable();
    o2o.dedup();
    Graph {
        n_obj,
        n_evt,
        n_otype: n_types,
        n_act: 2,
        object_type,
        event_activity,
        e2o,
        o2o,
        gaps: Vec::new(),
    }
}

fn names_for(graph: &Graph) -> (Vec<String>, Vec<String>, Vec<String>, Vec<String>) {
    (
        (0..graph.n_obj).map(|i| format!("o{i}")).collect(),
        (0..graph.n_otype).map(|i| format!("t{i}")).collect(),
        (0..graph.n_evt).map(|i| format!("e{i}")).collect(),
        (0..graph.n_act).map(|i| format!("a{i}")).collect(),
    )
}

fn score(graph: &Graph, model: &Model, top_k: usize, max_examples: usize) -> eval::Outcome {
    let (z_evt, z_obj) = train::embed(model, graph, false);
    let sampler = Sampler::new(graph);
    let (object_ids, type_names, event_ids, activity_names) = names_for(graph);
    let names = eval::Names {
        object_ids: &object_ids,
        object_type_names: &type_names,
        event_ids: &event_ids,
        activity_names: &activity_names,
    };
    eval::evaluate(
        graph,
        &names,
        &z_evt,
        &z_obj,
        &sampler.by_event,
        None,
        &eval::EvalConfig { top_k, max_examples },
    )
}

fn loss_of(model: &Model, graph: &Graph, batch: &[Triplet], settings: &TrainConfig) -> f32 {
    let act = forward(model, graph, &graph.all_edges(), 0.0, None);
    let last = model.n_layers;
    train::loss_and_grad(&act.h_evt[last], &act.h_obj[last], batch, settings, model.d).loss
}

/// Central differences on every coordinate of a small model, compared as a
/// whole vector — for both objectives.
///
/// Per-coordinate comparison is the obvious form and the wrong one here: the
/// loss is evaluated in f32, so a central difference carries roughly 1e-4 of
/// noise, and a true gradient of 2e-3 then "disagrees" by 6% while being
/// exactly right. Comparing the assembled gradient by direction and by relative
/// L2 norm averages that out while still failing loudly if any single transpose
/// is wrong — a flipped or dropped term moves the whole vector, not one entry.
fn gradient_check(objective: Objective, label: &str) {
    let mut rng = Rng::new(7);
    let graph = random_graph(&mut rng, 14, 11);
    let mut settings = config(1, objective);
    // A margin no initial model satisfies, so every hinge is active. At a margin
    // already met the true gradient is zero and the comparison would be between
    // two kinds of nothing. (The softmax has no such dead zone.)
    settings.margin = 4.0;
    // Temperature 1, not the shipped 0.1. At 0.1 the softmax is so peaked that
    // a central difference cannot resolve it: the analytic norm stays put at
    // 9.198 while the numerical one wanders between 8.85 and 8.93 as the step
    // size changes, and the agreement degrades monotonically with both a
    // smaller temperature and a larger step — the signature of truncation
    // error, not of a wrong derivative. The temperature path is checked
    // exactly instead, in `softmax_loss_matches_its_definition`.
    settings.temperature = 1.0;

    let batch: Vec<Triplet> = (0..5)
        .map(|_| Triplet {
            event: rng.below(graph.n_evt) as u32,
            positive: rng.below(graph.n_obj) as u32,
            negatives: (0..3).map(|_| rng.below(graph.n_obj) as u32).collect(),
        })
        .filter(|t| !t.negatives.contains(&t.positive))
        .collect();
    assert!(!batch.is_empty());

    let mut model = Model::new(&graph, 4, 2, &mut rng);
    let act = forward(&model, &graph, &graph.all_edges(), 0.0, None);
    let last = model.n_layers;
    let out = train::loss_and_grad(&act.h_evt[last], &act.h_obj[last], &batch, &settings, model.d);
    assert!(out.loss > 0.0, "{label}: the loss is zero, nothing to check");
    let mut grads = model.zeros_like();
    backward(&model, &graph, &graph.all_edges(), &act, out.d_evt, out.d_obj, &mut grads);

    let h = 4e-3f32;
    let (mut analytic, mut numeric) = (Vec::new(), Vec::new());
    for p in 0..model.params.len() {
        for i in 0..model.params[p].data.len() {
            let original = model.params[p].data[i];
            model.params[p].data[i] = original + h;
            let up = loss_of(&model, &graph, &batch, &settings);
            model.params[p].data[i] = original - h;
            let down = loss_of(&model, &graph, &batch, &settings);
            model.params[p].data[i] = original;
            numeric.push(((up - down) / (2.0 * h)) as f64);
            analytic.push(grads[p].data[i] as f64);
        }
    }
    assert!(numeric.len() > 200, "{label}: only {} coordinates", numeric.len());

    let dot: f64 = analytic.iter().zip(&numeric).map(|(a, n)| a * n).sum();
    let na: f64 = analytic.iter().map(|v| v * v).sum::<f64>().sqrt();
    let nn: f64 = numeric.iter().map(|v| v * v).sum::<f64>().sqrt();
    assert!(na > 1e-6 && nn > 1e-6, "{label}: degenerate gradient");
    let cosine = dot / (na * nn);
    let residual: f64 = analytic
        .iter()
        .zip(&numeric)
        .map(|(a, n)| (a - n) * (a - n))
        .sum::<f64>()
        .sqrt()
        / nn;
    assert!(cosine > 0.999, "{label}: direction off, cosine {cosine:.6}");
    assert!(residual < 0.05, "{label}: magnitude off, relative L2 {residual:.4}");

    let mut offset = 0usize;
    for p in 0..model.params.len() {
        let len = model.params[p].data.len();
        let (a, n) = (&analytic[offset..offset + len], &numeric[offset..offset + len]);
        let na: f64 = a.iter().map(|v| v * v).sum::<f64>().sqrt();
        let nn: f64 = n.iter().map(|v| v * v).sum::<f64>().sqrt();
        if nn > 1e-4 {
            let dot: f64 = a.iter().zip(n).map(|(x, y)| x * y).sum();
            assert!(
                dot / (na * nn) > 0.99,
                "{label}: parameter {p} direction off, cosine {:.5}",
                dot / (na * nn)
            );
        }
        offset += len;
    }
}

#[test]
fn sampled_softmax_gradient_matches_finite_differences() {
    gradient_check(Objective::SampledSoftmax, "sampled softmax");
}

#[test]
fn triplet_margin_gradient_matches_finite_differences() {
    gradient_check(Objective::TripletMargin, "triplet margin");
}

#[test]
fn masking_hides_exactly_the_batch_links() {
    // The whole point of masked query training: the link under supervision must
    // be absent from the pass that computes its score. If this regresses, the
    // model trains beautifully and learns nothing that transfers, which is the
    // defect the reference implementation was written to fix.
    let mut rng = Rng::new(4);
    let graph = random_graph(&mut rng, 20, 16);
    let model = Model::new(&graph, 6, 2, &mut rng);
    let settings = config(1, Objective::SampledSoftmax);
    let sampler = Sampler::new(&graph);
    let batch = sampler.batch(&graph, &settings, &mut rng);
    assert!(!batch.is_empty());

    let masked = train::masked_edges_for_test(&graph, &batch);
    for item in &batch {
        assert!(
            !masked.0.contains(&(item.event, item.positive)),
            "a supervised link survived the mask"
        );
        // An object whose link is masked keeps no object-object relation either:
        // otherwise the answer is still reachable in two hops.
        assert!(
            !masked.1.iter().any(|&(a, b)| a == item.positive || b == item.positive),
            "a masked object kept its related edges"
        );
    }
    let hidden: std::collections::HashSet<(u32, u32)> =
        batch.iter().map(|t| (t.event, t.positive)).collect();
    let kept = graph.e2o.iter().filter(|p| !hidden.contains(p)).count();
    assert_eq!(masked.0.len(), kept, "the mask removed more than the batch");

    // And the masked pass really produces different embeddings.
    let a = forward(&model, &graph, &graph.all_edges(), 0.0, None);
    let b = forward(&model, &graph, &EdgeSet { e2o: &masked.0, o2o: &masked.1 }, 0.0, None);
    assert_ne!(a.h_evt[2].data, b.h_evt[2].data);
}

#[test]
fn training_positives_never_come_from_a_gapped_event() {
    // The other half of the split. A gapped event's surviving links stay in the
    // graph as evidence, but using them as positives would leak the split in
    // the opposite direction.
    let mut rng = Rng::new(8);
    let mut graph = random_graph(&mut rng, 30, 25);
    let held: Vec<(u32, u32)> = graph.e2o.iter().copied().step_by(4).collect();
    graph.e2o.retain(|pair| !held.contains(pair));
    graph.gaps = held.clone();

    let sampler = Sampler::new(&graph);
    let gapped: std::collections::HashSet<u32> = held.iter().map(|&(e, _)| e).collect();
    assert!(!sampler.trainable.is_empty());
    for &e in &sampler.trainable {
        assert!(!gapped.contains(&e), "event {e} is gapped but trainable");
    }
    for &(e, _) in &sampler.positives {
        assert!(!gapped.contains(&e), "a positive came from a gapped event");
    }
    // The graph still carries those events' surviving links.
    assert!(graph.e2o.iter().any(|&(e, _)| gapped.contains(&e)));
}

#[test]
fn negatives_are_never_objects_the_event_already_shows() {
    let mut rng = Rng::new(12);
    let graph = random_graph(&mut rng, 40, 30);
    let settings = config(1, Objective::SampledSoftmax);
    let sampler = Sampler::new(&graph);
    let batch = sampler.batch(&graph, &settings, &mut rng);
    assert!(!batch.is_empty());
    for item in &batch {
        let observed = &sampler.by_event[item.event as usize];
        for n in &item.negatives {
            assert!(!observed.contains(n), "a negative is an observed object");
            assert_ne!(*n, item.positive);
        }
        let unique: std::collections::HashSet<_> = item.negatives.iter().collect();
        assert_eq!(unique.len(), item.negatives.len(), "duplicate negatives");
    }
}

#[test]
fn dropout_is_off_without_an_rng() {
    let mut rng = Rng::new(3);
    let graph = random_graph(&mut rng, 20, 15);
    let model = Model::new(&graph, 8, 3, &mut rng);
    let a = forward(&model, &graph, &graph.all_edges(), 0.5, None);
    let b = forward(&model, &graph, &graph.all_edges(), 0.5, None);
    assert_eq!(a.h_obj[3].data, b.h_obj[3].data);
    assert!(a.drop_obj.iter().all(|m| m.is_empty()));
}

#[test]
fn dropout_applies_only_before_the_last_layer() {
    let mut rng = Rng::new(11);
    let graph = random_graph(&mut rng, 20, 15);
    let model = Model::new(&graph, 8, 3, &mut rng);
    let mut rng2 = Rng::new(5);
    let act = forward(&model, &graph, &graph.all_edges(), 0.5, Some(&mut rng2));
    assert!(!act.drop_obj[0].is_empty());
    assert!(!act.drop_obj[1].is_empty());
    assert!(act.drop_obj[2].is_empty(), "the last layer must not drop");
}

#[test]
fn training_drives_the_loss_down() {
    let mut rng = Rng::new(21);
    let graph = grouped_graph(12, 3, 3);
    let mut model = Model::new(&graph, 16, 3, &mut rng);
    let trained = train::train(
        &mut model,
        &graph,
        &config(150, Objective::SampledSoftmax),
        &mut rng,
        |_, _| {},
    );
    assert!(trained.history.len() >= 100);
    let first = trained.history[0].loss;
    let last = trained.history[trained.history.len() - 1].loss;
    assert!(last < first * 0.6, "loss did not fall: {first:.4} -> {last:.4}");
    assert!(trained.best_loss <= last, "the kept checkpoint is not the best one");
}

#[test]
fn recovers_a_link_the_structure_determines() {
    // The end-to-end claim. Every event is one whole group, so an object held
    // out of an event is uniquely identified by the objects that remain — and a
    // working network puts it first. Masked query training is what makes this
    // reachable: without it the model is never asked to score a link it cannot
    // already see.
    let mut rng = Rng::new(33);
    let mut graph = grouped_graph(16, 4, 4);
    let held: Vec<(u32, u32)> = (0..16u32).map(|g| (g * 4, g * 4)).collect();
    graph.e2o.retain(|pair| !held.contains(pair));
    graph.gaps = held;

    let mut model = Model::new(&graph, 24, 3, &mut rng);
    train::train(&mut model, &graph, &config(400, Objective::SampledSoftmax), &mut rng, |_, _| {});
    let outcome = score(&graph, &model, 10, 5);

    let hits1 = outcome.metrics.hits_at["1"];
    assert_eq!(outcome.metrics.evaluated, 16);
    assert!(
        hits1 >= 0.95 && outcome.metrics.mrr >= 0.95,
        "a determined link must be found first: Hits@1 = {hits1:.3}, MRR = {:.3}",
        outcome.metrics.mrr
    );
}

#[test]
fn metrics_account_for_every_gap() {
    let mut rng = Rng::new(44);
    let mut graph = random_graph(&mut rng, 40, 30);
    let held: Vec<(u32, u32)> = graph.e2o.iter().copied().step_by(4).collect();
    graph.e2o.retain(|pair| !held.contains(pair));
    graph.gaps = held.clone();

    let mut model = Model::new(&graph, 12, 2, &mut rng);
    let mut settings = config(40, Objective::SampledSoftmax);
    settings.dropout = 0.3;
    train::train(&mut model, &graph, &settings, &mut rng, |_, _| {});
    let outcome = score(&graph, &model, 10, 5);

    let m = &outcome.metrics;
    let unique: std::collections::BTreeSet<(u32, u32)> = held.into_iter().collect();
    assert_eq!(m.evaluated, unique.len());
    assert_eq!(
        outcome.rank_distribution.iter().map(|b| b.n).sum::<usize>(),
        m.evaluated
    );
    assert_eq!(
        outcome.by_object_type.iter().map(|r| r.evaluated).sum::<usize>(),
        m.evaluated
    );
    assert!(m.hits_at["1"] <= m.hits_at["3"]);
    assert!(m.hits_at["3"] <= m.hits_at["5"] && m.hits_at["5"] <= m.hits_at["10"]);
    assert!(m.hits_at["1"] <= m.mrr && m.mrr <= 1.0);
    // With no candidate restriction the network scores every object.
    assert_eq!(m.unreachable, 0);
    assert_eq!(outcome.rank_distribution.last().map(|b| b.n), Some(0));
    assert!(outcome.examples.len() <= 5);
}

#[test]
fn restricting_candidates_reports_what_the_pool_could_not_hold() {
    // A pool that excludes the answer must be counted as a miss, not quietly
    // scored as if the object had been ranked last. Otherwise a narrower pool
    // always looks better than a wider one.
    let mut rng = Rng::new(55);
    let mut graph = random_graph(&mut rng, 40, 30);
    let held: Vec<(u32, u32)> = graph.e2o.iter().copied().step_by(3).collect();
    graph.e2o.retain(|pair| !held.contains(pair));
    graph.gaps = held;

    let mut model = Model::new(&graph, 12, 2, &mut rng);
    train::train(&mut model, &graph, &config(30, Objective::SampledSoftmax), &mut rng, |_, _| {});
    let (z_evt, z_obj) = train::embed(&model, &graph, false);
    let sampler = Sampler::new(&graph);
    let (object_ids, type_names, event_ids, activity_names) = names_for(&graph);
    let names = eval::Names {
        object_ids: &object_ids,
        object_type_names: &type_names,
        event_ids: &event_ids,
        activity_names: &activity_names,
    };
    // Every object gets a non-empty but wrong neighbourhood. An *empty* pool
    // falls back to the full object set by design — an empty restriction is no
    // information, not a verdict — so a pool of nothing would prove nothing.
    let neighbours: Vec<Vec<u32>> = (0..graph.n_obj)
        .map(|o| vec![((o + 1) % graph.n_obj) as u32])
        .collect();
    let restricted = eval::evaluate(
        &graph, &names, &z_evt, &z_obj, &sampler.by_event, Some(&neighbours),
        &eval::EvalConfig { top_k: 10, max_examples: 0 },
    );
    let open = eval::evaluate(
        &graph, &names, &z_evt, &z_obj, &sampler.by_event, None,
        &eval::EvalConfig { top_k: 10, max_examples: 0 },
    );
    assert_eq!(restricted.metrics.evaluated, open.metrics.evaluated);
    assert!(
        restricted.metrics.unreachable > 0,
        "a pool this narrow must leave gaps outside it"
    );
    assert_eq!(open.metrics.unreachable, 0);
    assert_eq!(
        restricted.rank_distribution.iter().map(|b| b.n).sum::<usize>(),
        restricted.metrics.evaluated
    );
}

#[test]
fn the_same_seed_gives_the_same_answer() {
    let run = || {
        let mut rng = Rng::new(99);
        let mut graph = random_graph(&mut rng, 30, 24);
        let held: Vec<(u32, u32)> = graph.e2o.iter().copied().step_by(5).collect();
        graph.e2o.retain(|pair| !held.contains(pair));
        graph.gaps = held;
        let mut model = Model::new(&graph, 12, 3, &mut rng);
        let mut settings = config(30, Objective::SampledSoftmax);
        settings.dropout = 0.3;
        train::train(&mut model, &graph, &settings, &mut rng, |_, _| {});
        let outcome = score(&graph, &model, 10, 5);
        (outcome.metrics.mrr, outcome.metrics.hits_at["1"])
    };
    assert_eq!(run(), run());
}

#[test]
fn an_isolated_node_does_not_poison_the_weights() {
    // Three ReLUs can zero every unit of a node nothing points at, and
    // normalising that row would divide by zero. One NaN reaches every weight
    // on the next backward pass and training never returns, so the floor in
    // `normalize_row` is load-bearing.
    let mut rng = Rng::new(5);
    let mut graph = random_graph(&mut rng, 12, 10);
    graph.n_obj += 1;
    graph.object_type.push(0);
    graph.gaps = vec![(0, graph.n_obj as u32 - 1)];

    let mut model = Model::new(&graph, 8, 3, &mut rng);
    for relation in 0..crate::model::N_REL {
        let slot_self = model.params.len() - (crate::model::N_REL - relation) * 3;
        model.params[slot_self].data.iter_mut().for_each(|v| *v = 0.0);
        model.params[slot_self + 1].data.iter_mut().for_each(|v| *v = 0.0);
        model.params[slot_self + 2].data.iter_mut().for_each(|v| *v = -1.0);
    }
    let (z_evt, z_obj) = train::embed(&model, &graph, false);
    assert!(z_evt.data.iter().all(|v| v.is_finite()));
    assert!(z_obj.data.iter().all(|v| v.is_finite()));

    train::train(&mut model, &graph, &config(5, Objective::SampledSoftmax), &mut rng, |_, _| {});
    assert!(
        model.params.iter().all(|m| m.data.iter().all(|v| v.is_finite())),
        "training produced a non-finite parameter"
    );
}

#[test]
fn matmul_helpers_agree_with_the_naive_definition() {
    let mut rng = Rng::new(1);
    let mut fill = |rows: usize, cols: usize, rng: &mut Rng| {
        let mut m = Mat::zeros(rows, cols);
        m.data.iter_mut().for_each(|v| *v = rng.next_f32() - 0.5);
        m
    };
    let a = fill(5, 4, &mut rng);
    let b = fill(3, 4, &mut rng);
    let mut got = Mat::zeros(5, 3);
    crate::linalg::matmul_bt_add(&mut got, &a, &b);
    for i in 0..5 {
        for j in 0..3 {
            let want: f32 = (0..4).map(|t| a.row(i)[t] * b.row(j)[t]).sum();
            assert!((got.row(i)[j] - want).abs() < 1e-5);
        }
    }

    let c = fill(4, 6, &mut rng);
    let mut got = Mat::zeros(5, 6);
    crate::linalg::matmul_add(&mut got, &a, &c);
    for i in 0..5 {
        for j in 0..6 {
            let want: f32 = (0..4).map(|t| a.row(i)[t] * c.row(t)[j]).sum();
            assert!((got.row(i)[j] - want).abs() < 1e-5);
        }
    }

    let e = fill(5, 6, &mut rng);
    let mut got = Mat::zeros(4, 6);
    crate::linalg::matmul_at_b_add(&mut got, &a, &e);
    for i in 0..4 {
        for j in 0..6 {
            let want: f32 = (0..5).map(|t| a.row(t)[i] * e.row(t)[j]).sum();
            assert!((got.row(i)[j] - want).abs() < 1e-5);
        }
    }
}


#[test]
fn softmax_loss_matches_its_definition() {
    // The temperature path, checked exactly rather than numerically: build
    // embeddings whose cosines are known, and compare the loss with
    // −log softmax computed independently in f64.
    for &t in &[0.1f32, 0.5, 1.0, 2.0] {
        let d = 4;
        let mut h_evt = Mat::zeros(1, d);
        let mut h_obj = Mat::zeros(3, d);
        h_evt.row_mut(0).copy_from_slice(&[1.0, 0.0, 0.0, 0.0]);
        // cos = 1.0, 0.6, 0.0 against the event.
        h_obj.row_mut(0).copy_from_slice(&[2.0, 0.0, 0.0, 0.0]);
        h_obj.row_mut(1).copy_from_slice(&[0.6, 0.8, 0.0, 0.0]);
        h_obj.row_mut(2).copy_from_slice(&[0.0, 0.0, 1.0, 0.0]);

        let batch = vec![Triplet { event: 0, positive: 0, negatives: vec![1, 2] }];
        let mut settings = config(1, Objective::SampledSoftmax);
        settings.temperature = t;
        let out = train::loss_and_grad(&h_evt, &h_obj, &batch, &settings, d);

        let logits: Vec<f64> = [1.0f64, 0.6, 0.0].iter().map(|s| s / t as f64).collect();
        let max = logits.iter().cloned().fold(f64::MIN, f64::max);
        let sum: f64 = logits.iter().map(|l| (l - max).exp()).sum();
        let want = -((logits[0] - max).exp() / sum).ln();
        assert!(
            (out.loss as f64 - want).abs() < 2e-4,
            "t={t}: loss {} but the definition gives {want}",
            out.loss
        );
        // And the reported similarities are the cosines themselves.
        assert!((out.pos - 1.0).abs() < 1e-5);
        assert!((out.neg - 0.3).abs() < 1e-5, "mean negative cosine should be 0.3, got {}", out.neg);
    }
}
