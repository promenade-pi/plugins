//! The candidate-generation loop — a port of `LPMRecursiveAction`'s
//! expansion/pruning, restructured as a level-by-level worklist instead of a
//! `ForkJoinPool` recursion (Wasm has no threads here), which also makes the
//! wall-clock budget (`should_stop`) a check between *trees*, not something
//! bolted onto a recursive call stack.
//!
//! Differences from ProM's search, each noted where it matters:
//! - Duplicate isomorphic candidates are caught by `LpmTree::canonical_key`'s
//!   `HashSet` memoization rather than ProM's insertion-position symmetry
//!   rule (`exp_1`) — functionally equivalent, a few more candidates
//!   generated before being deduped away, much simpler to get right.
//! - The "is the alphabet too big to search exhaustively" answer is the
//!   host's own `maxActivities` scan parameter (shared with every miner in
//!   this repo), not ProM's Markov/MRIG/Entropy clustering — see
//!   `docs/algorithm.md`.
//! - A wall-clock budget (`max_search_millis`, checked via the injected
//!   `should_stop` closure) replaces ForkJoinPool parallelism as the thing
//!   that keeps this responsive in a single-threaded Wasm worker.

use std::collections::HashSet;

use crate::evaluator::{self, LogStats, Scores};
use crate::params::LpmParams;
use crate::tree::LpmTree;

#[derive(Clone)]
pub struct Candidate {
    pub tree: LpmTree,
    pub scores: Scores,
}

pub struct SearchOutput {
    /// Sorted descending by `scores.weighted_score`.
    pub top: Vec<Candidate>,
    pub candidates_scored: u64,
    pub truncated_by_budget: bool,
}

struct TopK {
    capacity: usize,
    items: Vec<Candidate>,
}

impl TopK {
    fn new(capacity: usize) -> Self {
        TopK { capacity: capacity.max(1), items: Vec::new() }
    }

    fn worst_score(&self) -> f64 {
        if self.items.len() < self.capacity { f64::NEG_INFINITY } else { self.items.last().map(|c| c.scores.weighted_score).unwrap_or(f64::NEG_INFINITY) }
    }

    fn insert(&mut self, candidate: Candidate) {
        if self.items.len() >= self.capacity && candidate.scores.weighted_score <= self.worst_score() {
            return;
        }
        let pos = self.items.partition_point(|c| c.scores.weighted_score > candidate.scores.weighted_score);
        self.items.insert(pos, candidate);
        if self.items.len() > self.capacity {
            self.items.truncate(self.capacity);
        }
    }

    fn into_sorted(self) -> Vec<Candidate> {
        self.items
    }
}

/// Upper bound on `support(Seq(a,b))`/`support(And(a,b))`: the number of
/// cases (case-weighted) in which both activities occur at all. Support can
/// only ever be lower once both are required in one fragment, so a pair
/// below `frequency_minimum` here can be skipped without ever building or
/// scoring the candidate — mirrors `LogUtils.getLpmCountUpperBoundsMap`.
fn build_co_occurrence(n_activities: usize, log: &LogStats) -> Vec<u64> {
    let mut matrix = vec![0u64; n_activities * n_activities];
    let mut present = vec![false; n_activities];
    for (trace, count) in log.variants {
        for &a in trace.iter() {
            if (a as usize) < n_activities {
                present[a as usize] = true;
            }
        }
        for a in 0..n_activities {
            if !present[a] {
                continue;
            }
            for b in 0..n_activities {
                if present[b] {
                    matrix[a * n_activities + b] += count;
                }
            }
        }
        for a in 0..n_activities {
            present[a] = false;
        }
    }
    matrix
}

pub fn search(n_activities: usize, log: &LogStats, params: &LpmParams, should_stop: &dyn Fn() -> bool) -> SearchOutput {
    let co_occurs = build_co_occurrence(n_activities, log);
    let pair_ok = |a: u32, b: u32| -> bool {
        let idx = a as usize * n_activities + b as usize;
        co_occurs.get(idx).copied().unwrap_or(0) >= params.frequency_minimum
    };

    // Kept generously larger than the caller's requested `top_k`: the wasm
    // layer caches this full set and re-sorts it under new weights without
    // re-running the search at all (see `LpmScan::finalize` in the wasm
    // glue) — that only stays correct if candidates that would rank outside
    // today's weights but inside tomorrow's are still in here to find.
    let cache_capacity = (params.top_k.saturating_mul(4)).clamp(100, 2000);
    let mut seen: HashSet<String> = HashSet::new();
    let mut top = TopK::new(cache_capacity);
    let mut scored = 0u64;
    let mut truncated = false;

    // Each entry pairs a candidate with how many expansion steps produced it
    // — a seed activity is depth 0. This, not `leaf_count()`, is what
    // `numTransitions` caps: `XorLoop` is one expansion step like any other
    // (it just doesn't add a new activity), so without a separate counter a
    // fragment could keep growing loops forever once its leaf count alone
    // stopped increasing. Mirrors ProM's own `recursionDepth`, which counts
    // expansion steps taken, not activities used.
    let mut frontier: Vec<(LpmTree, usize)> = (0..n_activities as u32).map(|a| (LpmTree::Task(a), 0)).collect();

    'levels: while !frontier.is_empty() {
        let mut next_frontier = Vec::new();
        for (tree, depth) in frontier {
            if should_stop() {
                truncated = true;
                break 'levels;
            }
            if !seen.insert(tree.canonical_key()) {
                continue;
            }

            let leaf_count = tree.leaf_count();
            let current_support_ok;
            let mut current_determinism = 1.0f64;
            let mut current_lang_fit_ok = true;

            if leaf_count == 1 {
                let mut acts = Vec::new();
                tree.activities(&mut acts);
                let freq = log.activity_counts.get(acts[0] as usize).copied().unwrap_or(0);
                current_support_ok = freq >= params.frequency_minimum;
            } else {
                if let Some(scores) = evaluator::evaluate(&tree, log, params) {
                    scored += 1;
                    current_support_ok = scores.frequency >= params.frequency_minimum;
                    current_determinism = scores.determinism;
                    current_lang_fit_ok = scores.language_fit >= params.language_fit_minimum;
                    let passes = current_support_ok
                        && scores.determinism >= params.determinism_minimum
                        && current_lang_fit_ok
                        && scores.confidence >= params.confidence_minimum
                        && scores.coverage >= params.coverage_minimum;
                    if passes {
                        top.insert(Candidate { tree: tree.clone(), scores });
                    }
                } else {
                    current_support_ok = false; // never fires at all — nothing built on top of it can do better
                }
            }

            if depth >= params.num_transitions {
                continue;
            }
            let next_depth = depth + 1;

            let used: HashSet<u32> = {
                let mut a = Vec::new();
                tree.activities(&mut a);
                a.into_iter().collect()
            };

            // XorLoop: wraps an existing leaf, consumes no new activity.
            // Support/determinism/languageFit can only fall or stay equal
            // under this operator too (it only restricts, never widens, the
            // set of accepted behaviours at that leaf) — same monotonicity
            // argument ProM applies, so the current node's own gate values
            // decide whether it's worth trying.
            if params.use_xor_loop && current_support_ok && current_lang_fit_ok
                && current_determinism >= params.determinism_minimum
            {
                let variants = tree.for_each_leaf_replacement(|a, under_loop| {
                    if under_loop { vec![] } else { vec![LpmTree::XorLoop(Box::new(LpmTree::Task(a)))] }
                });
                next_frontier.extend(variants.into_iter().map(|t| (t, next_depth)));
            }

            for b in 0..n_activities as u32 {
                if !params.duplicate_transitions && used.contains(&b) {
                    continue;
                }
                let global_b_freq = log.activity_counts.get(b as usize).copied().unwrap_or(0);
                let b_frequent_enough = global_b_freq >= params.frequency_minimum;

                if params.use_seq && current_support_ok && b_frequent_enough {
                    let variants = tree.for_each_leaf_replacement(|a, _| {
                        if pair_ok(a, b) {
                            vec![LpmTree::Seq(Box::new(LpmTree::Task(a)), Box::new(LpmTree::Task(b)))]
                        } else {
                            vec![]
                        }
                    });
                    next_frontier.extend(variants.into_iter().map(|t| (t, next_depth)));
                }
                if params.use_and && current_determinism >= params.determinism_minimum && b_frequent_enough {
                    let variants = tree.for_each_leaf_replacement(|a, _| {
                        if pair_ok(a, b) {
                            vec![LpmTree::And(Box::new(LpmTree::Task(a)), Box::new(LpmTree::Task(b)))]
                        } else {
                            vec![]
                        }
                    });
                    next_frontier.extend(variants.into_iter().map(|t| (t, next_depth)));
                }
                // Xor/Or can only ever *reduce* determinism relative to the
                // parent, so — unlike Seq/And — they are worth trying even
                // when the new activity `b` is rare; only the determinism
                // gate applies.
                if params.use_xor && current_determinism >= params.determinism_minimum {
                    let variants = tree.for_each_leaf_replacement(|a, _| {
                        vec![LpmTree::Xor(Box::new(LpmTree::Task(a)), Box::new(LpmTree::Task(b)))]
                    });
                    next_frontier.extend(variants.into_iter().map(|t| (t, next_depth)));
                }
                if params.use_or && current_determinism >= params.determinism_minimum {
                    let variants = tree.for_each_leaf_replacement(|a, _| {
                        vec![LpmTree::Or(Box::new(LpmTree::Task(a)), Box::new(LpmTree::Task(b)))]
                    });
                    next_frontier.extend(variants.into_iter().map(|t| (t, next_depth)));
                }
            }
        }
        frontier = next_frontier;
    }

    SearchOutput { top: top.into_sorted(), candidates_scored: scored, truncated_by_budget: truncated }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(overrides: impl FnOnce(&mut LpmParams)) -> LpmParams {
        let mut p = LpmParams::default();
        p.frequency_minimum = 1;
        overrides(&mut p);
        p
    }

    fn variants(traces: &[&[u32]]) -> Vec<(Vec<u32>, u64)> {
        traces.iter().map(|t| (t.to_vec(), 1)).collect()
    }

    fn activity_counts(n: usize, variants: &[(Vec<u32>, u64)]) -> Vec<u64> {
        let mut counts = vec![0u64; n];
        for (trace, count) in variants {
            for &a in trace {
                counts[a as usize] += count;
            }
        }
        counts
    }

    #[test]
    fn a_strict_sequence_ranks_seq_at_the_top() {
        // a, b always in that order, twice each trace.
        let vs = variants(&[&[0, 1, 0, 1], &[0, 1, 0, 1], &[0, 1]]);
        let counts = activity_counts(2, &vs);
        let total: u64 = vs.iter().map(|(t, c)| t.len() as u64 * c).sum();
        let log = LogStats { variants: &vs, activity_counts: &counts, total_events: total };
        let p = params(|p| { p.num_transitions = 2; p.top_k = 5; });
        let out = search(2, &log, &p, &|| false);
        assert!(!out.top.is_empty(), "expected at least one candidate above threshold");
        let best = &out.top[0];
        assert!(matches!(best.tree, LpmTree::Seq(_, _)), "expected Seq to win, got {}", best.tree.canonical_key());
    }

    #[test]
    fn always_co_occurring_unordered_ranks_and_at_the_top() {
        // a and b always both occur, in either order — no consistent sequence.
        let vs = variants(&[&[0, 1], &[1, 0], &[0, 1], &[1, 0]]);
        let counts = activity_counts(2, &vs);
        let total: u64 = vs.iter().map(|(t, c)| t.len() as u64 * c).sum();
        let log = LogStats { variants: &vs, activity_counts: &counts, total_events: total };
        let p = params(|p| { p.num_transitions = 2; p.top_k = 5; });
        let out = search(2, &log, &p, &|| false);
        assert!(!out.top.is_empty());
        assert!(matches!(out.top[0].tree, LpmTree::And(_, _)), "expected And to win, got {}", out.top[0].tree.canonical_key());
    }

    #[test]
    fn exclusive_branching_ranks_xor_at_the_top() {
        // a and b never co-occur — a clean exclusive choice.
        let vs = variants(&[&[0], &[1], &[0], &[1], &[0], &[1]]);
        let counts = activity_counts(2, &vs);
        let total: u64 = vs.iter().map(|(t, c)| t.len() as u64 * c).sum();
        let log = LogStats { variants: &vs, activity_counts: &counts, total_events: total };
        let p = params(|p| { p.num_transitions = 2; p.top_k = 5; p.determinism_minimum = 0.0; p.language_fit_minimum = 0.0; });
        let out = search(2, &log, &p, &|| false);
        assert!(!out.top.is_empty());
        assert!(matches!(out.top[0].tree, LpmTree::Xor(_, _)), "expected Xor to win, got {}", out.top[0].tree.canonical_key());
    }

    #[test]
    fn a_repeated_activity_favours_a_loop_combined_with_its_follower() {
        // 'a' fires a varying number of times before a single 'b' — a loop of
        // 'a' followed by 'b' explains every trace exactly; plain Seq(a, b)
        // cannot (it only ever explains one 'a').
        let vs = variants(&[&[0, 1], &[0, 0, 1], &[0, 0, 0, 1], &[0, 0, 1], &[0, 0, 0, 1]]);
        let counts = activity_counts(2, &vs);
        let total: u64 = vs.iter().map(|(t, c)| t.len() as u64 * c).sum();
        let log = LogStats { variants: &vs, activity_counts: &counts, total_events: total };
        // Depth 3: Task(0) -> XorLoop(Task(0)) -> Seq(XorLoop(Task(0)), Task(1)).
        let p = params(|p| { p.num_transitions = 3; p.top_k = 5; p.determinism_minimum = 0.0; p.language_fit_minimum = 0.0; });
        let out = search(2, &log, &p, &|| false);
        assert!(!out.top.is_empty());
        let has_loop = out.top.iter().any(|c| c.tree.canonical_key().contains('L'));
        assert!(has_loop, "expected a loop-containing fragment among the top candidates, got {:?}",
            out.top.iter().map(|c| c.tree.canonical_key()).collect::<Vec<_>>());
    }

    #[test]
    fn wall_clock_budget_stops_the_search_and_flags_truncation() {
        let vs = variants(&[&[0, 1, 2, 3], &[3, 2, 1, 0]]);
        let counts = activity_counts(4, &vs);
        let total: u64 = vs.iter().map(|(t, c)| t.len() as u64 * c).sum();
        let log = LogStats { variants: &vs, activity_counts: &counts, total_events: total };
        let p = params(|p| { p.num_transitions = 4; p.top_k = 100; });
        let calls = std::cell::Cell::new(0u32);
        let out = search(4, &log, &p, &|| { calls.set(calls.get() + 1); calls.get() > 2 });
        assert!(out.truncated_by_budget);
    }
}
