//! Scores one candidate `LpmTree` against the log's trace variants — the
//! port of `LocalProcessModelEvaluator`'s metric suite (support, confidence,
//! determinism, language fit, coverage, average firings) and
//! `LocalProcessModel.getWeightedScore()`'s linear combination.

use std::collections::{HashMap, HashSet};

use crate::align::{enabled_count, shortest_alignment, AlignedModel, MoveKind};
use crate::net::{augment_with_backloop, compile};
use crate::params::{LpmParams, Weights};
use crate::tree::LpmTree;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scores {
    pub support: f64,
    pub confidence: f64,
    pub determinism: f64,
    pub language_fit: f64,
    pub coverage: f64,
    pub avg_num_firings: f64,
    /// `leaf_count / params.num_transitions` — stored (not just used inline)
    /// so `reweight` can recombine every metric under new weights without
    /// needing the tree back.
    pub num_transitions_score: f64,
    pub weighted_score: f64,
    /// Case-weighted total occurrence count across the whole log (raw
    /// backloop-firing count) — what `support` is a squashed function of.
    pub frequency: u64,
    /// Case-weighted mean alignment fitness, `1 - cost/maxCost` — carried for
    /// display only; excluded from `weighted_score`, matching ProM's own
    /// `LocalProcessModel` (its `alignmentCost` field is likewise commented
    /// out of the combined score).
    pub avg_fitness: f64,
}

/// Recombines an already-scored candidate's individual metrics under a new
/// set of weights, without touching the log or re-running alignment at all —
/// this is what makes the weight sliders in the discovery view "cheap": a
/// full search only has to happen when a threshold or a structural param
/// (`numTransitions`, an operator toggle, ...) changes, never when only the
/// relative importance of already-known metrics does.
pub fn reweight(scores: &Scores, weights: &Weights) -> f64 {
    weighted_score(
        weights,
        scores.support,
        scores.confidence,
        scores.determinism,
        scores.coverage,
        scores.language_fit,
        scores.avg_num_firings / (scores.avg_num_firings + 1.0),
        scores.num_transitions_score,
    )
}

/// Everything the search loop needs to know about the log once, independent
/// of which candidate fragment is being scored.
pub struct LogStats<'a> {
    /// Deduplicated trace variants and how many cases share each one.
    pub variants: &'a [(Vec<u32>, u64)],
    /// Global per-activity occurrence count across the *whole* log (not
    /// projected) — the denominator for confidence.
    pub activity_counts: &'a [u64],
    /// Total event count across the whole log — the denominator for coverage.
    pub total_events: u64,
}

/// `None` when the fragment never fires at all (every variant either has no
/// events in its alphabet or is unreachable) — such a candidate cannot pass
/// any of the frequency/determinism/languageFit/confidence thresholds, so the
/// caller should simply drop it rather than rank a fragment with no evidence.
pub fn evaluate(tree: &LpmTree, log: &LogStats, params: &LpmParams) -> Option<Scores> {
    let raw = compile(tree);
    let augmented = augment_with_backloop(&raw);
    let model = AlignedModel::from_augmented(&augmented).ok()?;
    let backloop_t = augmented.backloop_transition;

    let mut in_fragment = vec![false; log.activity_counts.len().max(1)];
    let mut acts = Vec::new();
    tree.activities(&mut acts);
    let alphabet: HashSet<u32> = acts.iter().copied().collect();
    for &a in &alphabet {
        if (a as usize) < in_fragment.len() {
            in_fragment[a as usize] = true;
        }
    }
    let in_alphabet = |a: u32| (a as usize) < in_fragment.len() && in_fragment[a as usize];

    let mut fire_counts: HashMap<usize, u64> = HashMap::new();
    let mut frequency: u64 = 0;
    let mut weighted_fitness = 0f64;
    let mut fitness_weight = 0f64;
    let mut enabled_sum = 0f64;
    let mut enabled_weight = 0f64;
    let mut avg_firings_sum = 0f64;
    let mut avg_firings_variants = 0f64;
    let mut language_seen: HashSet<Vec<u32>> = HashSet::new();
    let mut covered_events: u64 = 0;

    // Cheapest model-only path (empty trace), the other half of the fitness
    // denominator — the same for every variant, computed once.
    let model_only = shortest_alignment(&model, &[], params.max_align_states, 1);
    let model_only_cost = if model_only.reached { model_only.cost } else { 0 };

    for (trace, count) in log.variants {
        covered_events += trace.iter().filter(|&&a| in_alphabet(a)).count() as u64 * count;

        let projected: Vec<u32> = trace.iter().copied().filter(|&a| in_alphabet(a)).collect();
        if projected.is_empty() {
            continue;
        }
        let visible_model_cost = projected.len() as u32 + 1;
        let r = shortest_alignment(&model, &projected, params.max_align_states, visible_model_cost);
        if !r.reached {
            continue;
        }

        // Fitness, normalised against the cheapest model-only path exactly
        // as `alignment-rs` does.
        let max_cost = projected.len() as u32 + model_only_cost;
        let fitness = if max_cost == 0 { 1.0 } else { 1.0 - (r.cost as f64 / max_cost as f64) };
        weighted_fitness += fitness * (*count as f64);
        fitness_weight += *count as f64;

        let mut backloop_fires_this_variant: u64 = 0;
        let mut visible_fires_this_variant: u64 = 0;
        let mut marking = model.initial();
        let mut current_segment: Vec<u32> = Vec::new();

        for mv in &r.moves {
            let pre_marking = marking;
            if let Some(t) = mv.transition {
                let is_visible = model.activity_of(t).is_some();
                if matches!(mv.kind, MoveKind::Sync | MoveKind::Model) {
                    enabled_sum += enabled_count(&model, pre_marking) as f64 * (*count as f64);
                    enabled_weight += *count as f64;
                }
                if is_visible {
                    visible_fires_this_variant += 1;
                }
                if matches!(mv.kind, MoveKind::Sync) {
                    if let Some(a) = model.activity_of(t) {
                        // Confidence's numerator is "how many *observed* log
                        // occurrences of this activity does the fragment
                        // account for" — only a sync move corresponds to a
                        // real log event; a (heavily discouraged, but not
                        // impossible) visible model move would otherwise
                        // inflate this past the activity's own true log-wide
                        // total.
                        *fire_counts.entry(t).or_insert(0) += *count;
                        current_segment.push(a);
                    }
                }
                if t == backloop_t {
                    backloop_fires_this_variant += 1;
                    // One completed occurrence's own sync sequence — reset
                    // after recording it. `language()` below enumerates the
                    // *un-augmented* fragment's language (one pass from its
                    // own entry to its own exit place, not the repeated-
                    // forever backloop net), so what belongs on this side of
                    // the ratio is one occurrence at a time too, not a
                    // multi-occurrence concatenation.
                    language_seen.insert(std::mem::take(&mut current_segment));
                }
            }
            marking = mv.after;
        }

        frequency += backloop_fires_this_variant * count;
        if backloop_fires_this_variant > 0 {
            avg_firings_sum += visible_fires_this_variant as f64 / backloop_fires_this_variant as f64;
            avg_firings_variants += 1.0;
        }
    }

    if frequency == 0 {
        return None;
    }

    let support = (frequency as f64).log10() / ((frequency as f64).log10() + 1.0);

    let confidence = {
        let ratios: Vec<f64> = fire_counts
            .iter()
            .filter_map(|(&t, &fires)| {
                let a = model.activity_of(t)? as usize;
                let global = *log.activity_counts.get(a)?;
                if global == 0 { None } else { Some(fires as f64 / global as f64) }
            })
            .collect();
        harmonic_mean(&ratios)
    };

    let determinism = if enabled_weight > 0.0 {
        let avg_enabled = enabled_sum / enabled_weight;
        if avg_enabled > 0.0 { 1.0 / avg_enabled } else { 0.0 }
    } else {
        0.0
    };

    let avg_num_firings = if avg_firings_variants > 0.0 { avg_firings_sum / avg_firings_variants } else { 0.0 };
    let norm_avg_firings = avg_num_firings / (avg_num_firings + 1.0);

    let coverage = if log.total_events > 0 { covered_events as f64 / log.total_events as f64 } else { 0.0 };

    let full_language = language(&raw, params.max_loop);
    let language_fit = if full_language.is_empty() {
        0.0
    } else {
        let seen_in_language = language_seen.intersection(&full_language).count();
        seen_in_language as f64 / full_language.len() as f64
    };

    let avg_fitness = if fitness_weight > 0.0 { weighted_fitness / fitness_weight } else { 0.0 };

    let num_transitions_score = if params.num_transitions > 0 {
        tree.leaf_count() as f64 / params.num_transitions as f64
    } else {
        0.0
    };
    let weighted_score = weighted_score(
        &params.weights,
        support,
        confidence,
        determinism,
        coverage,
        language_fit,
        norm_avg_firings,
        num_transitions_score,
    );

    Some(Scores { support, confidence, determinism, language_fit, coverage, avg_num_firings, num_transitions_score, weighted_score, frequency, avg_fitness })
}

fn weighted_score(
    w: &Weights,
    support: f64,
    confidence: f64,
    determinism: f64,
    coverage: f64,
    language_fit: f64,
    norm_avg_firings: f64,
    num_transitions_score: f64,
) -> f64 {
    let sum = w.support_weight * support
        + w.confidence_weight * confidence
        + w.determinism_weight * determinism
        + w.coverage_weight * coverage
        + w.language_fit_weight * language_fit
        + w.avg_num_firings_weight * norm_avg_firings
        + w.num_transitions_weight * num_transitions_score;
    sum / w.total()
}

fn harmonic_mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sum = 0.0;
    for &v in values {
        if v <= 0.0 {
            return 0.0; // a transition with zero observed share drags confidence to zero, same as ProM's harmonic mean
        }
        sum += 1.0 / v;
    }
    values.len() as f64 / sum
}

/// Enumerates every distinct sequence of *visible* activities produced by a
/// firing sequence from the fragment's own entry place to its own exit place
/// — one occurrence of the pattern, not the repeated-forever backloop net
/// (that augmentation exists for alignment/replay, not for this). Bounding
/// how many times any single transition may fire within one enumerated path
/// mirrors ProM's `calculateLanguage(apn, maxLoop, onlyAccepting=true)`; here
/// it mainly matters for an `XorLoop` node's own internal `redo` cycle — a
/// loop-free fragment's raw net is already a DAG from entry to exit, so the
/// bound is a safety cap rather than the thing making enumeration finite.
/// Fragments are tiny, so a plain bounded DFS is cheap.
fn language(raw: &crate::net::RawNet, max_loop: u32) -> HashSet<Vec<u32>> {
    let n = raw.transitions.len();
    let mut inputs = vec![0u128; n];
    let mut outputs = vec![0u128; n];
    for &(p, t) in &raw.place_to_transition {
        inputs[t] |= 1u128 << p;
    }
    for &(t, p) in &raw.transition_to_place {
        outputs[t] |= 1u128 << p;
    }
    let start = 1u128 << raw.in_place;
    let goal = 1u128 << raw.out_place;
    let mut out = HashSet::new();
    let mut fire_counts = vec![0u32; n];
    let hard_step_cap = 200usize;

    #[allow(clippy::too_many_arguments)]
    fn walk(
        inputs: &[u128],
        outputs: &[u128],
        acts: &[Option<u32>],
        marking: u128,
        goal: u128,
        seq: &mut Vec<u32>,
        fire_counts: &mut [u32],
        max_loop: u32,
        steps_left: usize,
        out: &mut HashSet<Vec<u32>>,
    ) {
        if marking == goal {
            // The exit place is a true sink in every gadget this crate
            // builds — nothing ever consumes it — so reaching it ends this
            // path rather than merely being a state worth recording.
            out.insert(seq.clone());
            return;
        }
        if steps_left == 0 {
            return;
        }
        for t in 0..acts.len() {
            if fire_counts[t] >= max_loop || inputs[t] & marking != inputs[t] {
                continue;
            }
            let next = (marking & !inputs[t]) | outputs[t];
            fire_counts[t] += 1;
            if let Some(a) = acts[t] {
                seq.push(a);
            }
            walk(inputs, outputs, acts, next, goal, seq, fire_counts, max_loop, steps_left - 1, out);
            if acts[t].is_some() {
                seq.pop();
            }
            fire_counts[t] -= 1;
        }
    }

    let mut seq = Vec::new();
    walk(&inputs, &outputs, &raw.transitions, start, goal, &mut seq, &mut fire_counts, max_loop, hard_step_cap, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_params() -> LpmParams {
        LpmParams { frequency_minimum: 1, determinism_minimum: 0.0, language_fit_minimum: 0.0, ..LpmParams::default() }
    }

    /// Regression test for a real bug: a visible model move used to cost the
    /// same as a log move, so the aligner would sometimes invent extra
    /// (unobserved) firings of a transition to shorten the trace-position
    /// walk elsewhere, pushing that transition's fire count above its own
    /// true log-wide occurrence count — confidence (a ratio of the two) came
    /// out above 1. Every score is a proportion; none of them may leave
    /// [0, 1] regardless of how a log is shaped.
    #[test]
    fn every_score_stays_within_zero_and_one_even_with_within_trace_repetition() {
        // 'b' repeats a varying number of times per trace around a fixed
        // 'a'/'c' pair — exactly the shape that triggered the bug.
        let variants: Vec<(Vec<u32>, u64)> = vec![
            (vec![0, 1, 2], 5),
            (vec![0, 1, 1, 2], 4),
            (vec![0, 1, 1, 1, 2], 3),
            (vec![9, 0, 1, 2, 9, 9], 2), // noise activity co-occurring, unrelated
        ];
        let mut activity_counts = vec![0u64; 10];
        let mut total_events = 0u64;
        for (t, c) in &variants {
            total_events += t.len() as u64 * c;
            for &a in t {
                activity_counts[a as usize] += c;
            }
        }
        let log = LogStats { variants: &variants, activity_counts: &activity_counts, total_events };
        let params = default_params();

        let candidates = [
            LpmTree::Seq(Box::new(LpmTree::Task(0)), Box::new(LpmTree::Task(1))),
            LpmTree::Seq(Box::new(LpmTree::Task(1)), Box::new(LpmTree::Task(2))),
            LpmTree::Seq(Box::new(LpmTree::Seq(Box::new(LpmTree::Task(0)), Box::new(LpmTree::Task(1)))), Box::new(LpmTree::Task(2))),
            LpmTree::XorLoop(Box::new(LpmTree::Task(1))),
        ];
        for tree in &candidates {
            if let Some(scores) = evaluate(tree, &log, &params) {
                for (name, value) in [
                    ("support", scores.support), ("confidence", scores.confidence),
                    ("determinism", scores.determinism), ("languageFit", scores.language_fit),
                    ("coverage", scores.coverage),
                ] {
                    assert!(
                        (0.0..=1.0 + 1e-9).contains(&value),
                        "{} out of [0,1] for {}: {value}", name, tree.canonical_key()
                    );
                }
            }
        }
    }
}
