//! Random process trees, for when the model has to be known before the log is.
//!
//! > Jouck, T. & Depaire, B. (2019). *Generating artificial data for empirical
//! > analysis of control-flow discovery algorithms: a process tree and log
//! > generator.* Business & Information Systems Engineering 61(6), 695–712.
//!
//! Every evaluation of a discovery algorithm needs models whose properties are
//! controlled rather than observed: how many activities, how much concurrency,
//! how many loops, whether there are duplicate labels or silent steps. Real
//! logs cannot supply that — their generating model is exactly the unknown —
//! and a handful of hand-drawn models is a sample of the author's imagination.
//! PTandLogGenerator's answer is to draw the model from a parameterised
//! distribution, so an experiment can state its population instead of its
//! examples.
//!
//! This implements the *tree* half of that generator. The log half is
//! `plugins/playout-rs`: a generated tree converts to BPMN, then to an
//! accepting Petri net, and play-out simulates it into a log — so the pair
//! covers the same ground as PTandLogGenerator with the intermediate model
//! visible and inspectable at every step.
//!
//! Written from the paper's description of the construction; no
//! implementation was consulted, and pm4py's port is GPL, so none could be.
//! Every decision the paper leaves to an implementation is marked below and
//! documented in `docs/algorithm.md` rather than silently chosen.
//!
//! ```
//! use tree_gen_core::{generate, Options};
//! let tree = generate(&Options { activity_min: 5, activity_mode: 5, activity_max: 5, ..Options::default() });
//! assert_eq!(tree.stats.activities, 5);
//! ```

pub mod rng;
pub mod tree;

use rng::Rng;
use serde::Serialize;
use tree::{activity_name, to_payload, Node, Operator, ProcessTreePayload};

#[derive(Clone, Debug)]
pub struct Options {
    /// The most frequent number of activity leaves; the peak of the triangular
    /// distribution the size is drawn from.
    pub activity_mode: usize,
    pub activity_min: usize,
    pub activity_max: usize,
    /// Relative weights of the operators. Normalised, so they need not sum to
    /// anything in particular.
    pub sequence: f64,
    pub choice: f64,
    pub parallel: f64,
    pub loop_: f64,
    pub inclusive: f64,
    /// Probability that a choice gets a silent branch (making the rest of it
    /// optional) or that a loop's redo part is silent (making it a plain
    /// repetition). See `docs/algorithm.md`.
    pub silent: f64,
    /// Probability that a leaf reuses a label already in the tree instead of a
    /// fresh one.
    pub duplicate: f64,
    pub seed: u64,
}

impl Default for Options {
    fn default() -> Self {
        // PTandLogGenerator's own defaults, which is what makes two papers'
        // "generated with the default parameters" comparable.
        Self {
            activity_mode: 20,
            activity_min: 10,
            activity_max: 30,
            sequence: 0.25,
            choice: 0.25,
            parallel: 0.25,
            loop_: 0.25,
            inclusive: 0.0,
            silent: 0.2,
            duplicate: 0.0,
            seed: 42,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub nodes: usize,
    pub leaves: usize,
    pub silent: usize,
    pub operators: usize,
    /// Distinct activity names.
    pub activities: usize,
    /// Activity leaves, which exceeds `activities` when labels are duplicated.
    pub activity_leaves: usize,
    pub depth: usize,
    pub sequences: usize,
    pub choices: usize,
    pub parallels: usize,
    pub loops: usize,
    pub inclusive_choices: usize,
    pub seed: u64,
}

#[derive(Clone, Debug)]
pub struct Generated {
    pub payload: ProcessTreePayload,
    pub stats: Stats,
    pub warnings: Vec<String>,
}

/// The operator weights, normalised, with the degenerate case handled once.
struct Weights {
    cumulative: Vec<(f64, Operator)>,
    total: f64,
}

impl Weights {
    fn new(options: &Options) -> Self {
        let mut cumulative = Vec::new();
        let mut total = 0.0;
        for (weight, operator) in [
            (options.sequence, Operator::Sequence),
            (options.choice, Operator::Xor),
            (options.parallel, Operator::Parallel),
            (options.loop_, Operator::Loop),
            (options.inclusive, Operator::Or),
        ] {
            if weight > 0.0 {
                total += weight;
                cumulative.push((total, operator));
            }
        }
        Self { cumulative, total }
    }

    fn pick(&self, rng: &mut Rng) -> Operator {
        // Every weight zero: a tree still has to have *some* operator, and a
        // sequence is the one that adds no behaviour of its own.
        if self.cumulative.is_empty() {
            return Operator::Sequence;
        }
        let point = rng.unit() * self.total;
        for &(bound, operator) in &self.cumulative {
            if point < bound {
                return operator;
            }
        }
        self.cumulative[self.cumulative.len() - 1].1
    }
}

struct Builder<'a> {
    options: &'a Options,
    weights: Weights,
    rng: Rng,
    /// Labels already placed, for `duplicate` to draw from.
    used: Vec<String>,
}

impl Builder<'_> {
    fn leaf(&mut self) -> Node {
        if !self.used.is_empty() && self.rng.unit() < self.options.duplicate {
            let index = self.rng.below(self.used.len());
            return Node::Activity(self.used[index].clone());
        }
        let name = activity_name(self.used.len());
        self.used.push(name.clone());
        Node::Activity(name)
    }

    /// Builds a subtree containing exactly `n` activity leaves.
    ///
    /// The split is uniform over the ways to divide the leaves between two
    /// children — the paper fixes the operator distribution and the size
    /// distribution, and leaves this open. Uniform is the choice that adds no
    /// further bias of its own; a 50/50 split would make every tree balanced
    /// and a geometric one would make every tree a staircase.
    fn build(&mut self, n: usize) -> Node {
        if n <= 1 {
            return self.leaf();
        }
        let operator = self.weights.pick(&mut self.rng);
        let silent = self.rng.unit() < self.options.silent;

        // A silent child is placed only where it changes what the model does:
        // as a branch of a choice (everything else becomes optional) or as a
        // loop's redo part (the body simply repeats). Under a sequence or a
        // parallel it would be a node with no effect whatsoever — noise in the
        // model that no miner could ever discover and no log could show.
        match operator {
            Operator::Xor | Operator::Or if silent => {
                let child = self.build(n);
                Node::Op(operator, vec![child, Node::Tau])
            }
            Operator::Loop if silent => {
                let body = self.build(n);
                Node::Op(Operator::Loop, vec![body, Node::Tau])
            }
            _ => {
                let first = 1 + self.rng.below(n - 1);
                let left = self.build(first);
                let right = self.build(n - first);
                Node::Op(operator, vec![left, right])
            }
        }
    }
}

/// Draws one random process tree.
pub fn generate(options: &Options) -> Generated {
    let mut warnings = Vec::new();

    // The bounds are three numbers a person types independently, so they can
    // contradict each other. Repaired in the one order that keeps a run
    // possible, and said out loud rather than silently obeyed.
    let mut min = options.activity_min.max(1);
    let mut max = options.activity_max.max(1);
    if min > max {
        warnings.push(format!(
            "the smallest size ({min}) was larger than the largest ({max}); they have been swapped"
        ));
        std::mem::swap(&mut min, &mut max);
    }
    let mode = options.activity_mode.clamp(min, max);
    if mode != options.activity_mode {
        warnings.push(format!(
            "the most frequent size ({}) is outside the {min}–{max} range and was taken as {mode}",
            options.activity_mode
        ));
    }
    let weights = Weights::new(options);
    if weights.cumulative.is_empty() {
        warnings.push(
            "every operator was given a weight of zero, so the tree is built from sequences alone."
                .into(),
        );
    }
    if options.inclusive > 0.0 {
        warnings.push(
            "this tree may contain an inclusive choice (∨). It converts to BPMN as an inclusive \
             gateway, but a Petri net needs \"Replace OR-joins\" run on that BPMN first."
                .into(),
        );
    }

    let mut builder = Builder { options, weights, rng: Rng::new(options.seed), used: Vec::new() };
    let size = builder.rng.triangular(min as f64, mode as f64, max as f64).round() as usize;
    let size = size.clamp(min, max);

    let root = builder.build(size).fold();
    let payload = to_payload(&root);

    let operators_of = |operator: Operator| root.count(|n| matches!(n, Node::Op(o, _) if *o == operator));
    let leaves = root.count(|n| !matches!(n, Node::Op(_, _)));
    let stats = Stats {
        nodes: root.count(|_| true),
        leaves,
        silent: root.count(|n| matches!(n, Node::Tau)),
        operators: root.count(|n| matches!(n, Node::Op(_, _))),
        activities: payload.activities.len(),
        activity_leaves: root.count(|n| matches!(n, Node::Activity(_))),
        depth: root.depth(),
        sequences: operators_of(Operator::Sequence),
        choices: operators_of(Operator::Xor),
        parallels: operators_of(Operator::Parallel),
        loops: operators_of(Operator::Loop),
        inclusive_choices: operators_of(Operator::Or),
        seed: options.seed,
    };

    Generated { payload, stats, warnings }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed(n: usize) -> Options {
        Options { activity_min: n, activity_mode: n, activity_max: n, ..Options::default() }
    }

    #[test]
    fn a_single_activity_is_a_tree_of_one_node() {
        let t = generate(&fixed(1));
        assert_eq!(t.stats.nodes, 1);
        assert_eq!(t.stats.operators, 0);
        assert_eq!(t.payload.nodes[0].label.as_deref(), Some("a"));
        assert_eq!(t.payload.activities, vec!["a".to_string()]);
    }

    #[test]
    fn the_requested_number_of_activities_is_what_it_places() {
        for n in [2usize, 5, 17, 40] {
            let t = generate(&fixed(n));
            assert_eq!(t.stats.activity_leaves, n, "{n} activities requested");
            assert_eq!(t.stats.activities, n, "with no duplication they are all distinct");
        }
    }

    #[test]
    fn the_same_seed_gives_the_same_tree() {
        let options = Options { seed: 5, ..Options::default() };
        assert_eq!(generate(&options).payload, generate(&options).payload);
        assert_ne!(
            generate(&options).payload,
            generate(&Options { seed: 6, ..options.clone() }).payload
        );
    }

    #[test]
    fn an_operator_with_no_weight_never_appears() {
        let options = Options {
            sequence: 1.0, choice: 0.0, parallel: 0.0, loop_: 0.0, inclusive: 0.0,
            silent: 0.0, ..fixed(20)
        };
        let t = generate(&options);
        assert_eq!(t.stats.choices + t.stats.parallels + t.stats.loops + t.stats.inclusive_choices, 0);
        assert_eq!(t.stats.silent, 0);
        // Folding leaves one flat sequence of twenty activities, not nineteen
        // nested pairs of two.
        assert_eq!(t.stats.sequences, 1);
        assert_eq!(t.payload.nodes[t.payload.root as usize].children.len(), 20);
    }

    #[test]
    fn silent_branches_only_appear_under_a_choice_or_a_loop() {
        let options = Options { silent: 1.0, ..fixed(12) };
        for seed in 0..20u64 {
            let t = generate(&Options { seed, ..options.clone() });
            let mut parent_of = vec![None; t.payload.nodes.len()];
            for (index, node) in t.payload.nodes.iter().enumerate() {
                for &child in &node.children {
                    parent_of[child as usize] = Some(index);
                }
            }
            for (index, node) in t.payload.nodes.iter().enumerate() {
                if node.operator.is_some() || node.label.is_some() {
                    continue; // an operator or a labelled activity, not a tau
                }
                let parent = parent_of[index].expect("a tau is never the root here");
                assert!(
                    matches!(t.payload.nodes[parent].operator, Some("xor") | Some("or") | Some("loop")),
                    "seed {seed}: a tau under {:?}", t.payload.nodes[parent].operator
                );
            }
        }
    }

    #[test]
    fn duplicates_reduce_the_distinct_labels_without_changing_the_leaf_count() {
        let options = Options { duplicate: 0.9, silent: 0.0, ..fixed(30) };
        let t = generate(&options);
        assert_eq!(t.stats.activity_leaves, 30);
        assert!(t.stats.activities < 30, "{} distinct labels", t.stats.activities);
        assert!(t.stats.activities >= 1);
    }

    #[test]
    fn contradictory_bounds_are_repaired_and_reported() {
        let t = generate(&Options { activity_min: 30, activity_mode: 5, activity_max: 10, ..Options::default() });
        assert!((10..=30).contains(&t.stats.activity_leaves));
        assert!(t.warnings.iter().any(|w| w.contains("swapped")));
        assert!(t.warnings.iter().any(|w| w.contains("most frequent size")));
    }

    #[test]
    fn a_zero_weight_everywhere_still_produces_a_tree() {
        let options = Options {
            sequence: 0.0, choice: 0.0, parallel: 0.0, loop_: 0.0, inclusive: 0.0, ..fixed(6)
        };
        let t = generate(&options);
        assert_eq!(t.stats.activity_leaves, 6);
        assert!(t.warnings.iter().any(|w| w.contains("weight of zero")));
    }

    #[test]
    fn an_inclusive_choice_is_produced_when_asked_for_and_flagged() {
        let options = Options {
            sequence: 0.0, choice: 0.0, parallel: 0.0, loop_: 0.0, inclusive: 1.0,
            silent: 0.0, ..fixed(8)
        };
        let t = generate(&options);
        assert!(t.stats.inclusive_choices > 0);
        assert!(t.warnings.iter().any(|w| w.contains("Replace OR-joins")));
    }
}
