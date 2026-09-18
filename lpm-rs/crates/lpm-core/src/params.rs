//! Tunable knobs, mirroring `LocalProcessModelParameters`'s defaults where a
//! ProM default translates sensibly to an interactive Wasm context; see
//! `docs/algorithm.md` for the ones that don't (there is no
//! `projectionMethod`/Markov-clustering scalability knob here — the host's
//! generic `maxActivities` scan parameter, shared with every other miner in
//! this repo, is this port's answer to "the alphabet is too big to search
//! exhaustively": it simply narrows the alphabet before this crate ever sees
//! it, rather than clustering it into independently-searched partitions).

use serde::Deserialize;

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Weights {
    pub support_weight: f64,
    pub confidence_weight: f64,
    pub determinism_weight: f64,
    pub coverage_weight: f64,
    pub language_fit_weight: f64,
    pub avg_num_firings_weight: f64,
    pub num_transitions_weight: f64,
}

impl Default for Weights {
    fn default() -> Self {
        // ProM's own defaults (`LocalProcessModelParameters`'s constructor):
        // confidence and determinism dominate the ranking out of the box.
        Weights {
            support_weight: 0.1,
            confidence_weight: 0.4,
            determinism_weight: 0.3,
            coverage_weight: 0.0,
            language_fit_weight: 0.1,
            avg_num_firings_weight: 0.1,
            num_transitions_weight: 0.0,
        }
    }
}

impl Weights {
    /// The weighted-score formula normalises by the sum of every weight, not
    /// a fixed 1.0 — so weights express *relative* importance, not a
    /// probability distribution. A total of zero (every weight zeroed out)
    /// would divide by zero; treated as 1 so the result is simply 0 instead.
    pub fn total(&self) -> f64 {
        let t = self.support_weight
            + self.confidence_weight
            + self.determinism_weight
            + self.coverage_weight
            + self.language_fit_weight
            + self.avg_num_firings_weight
            + self.num_transitions_weight;
        if t == 0.0 { 1.0 } else { t }
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct LpmParams {
    pub num_transitions: usize,
    pub top_k: usize,
    pub frequency_minimum: u64,
    pub determinism_minimum: f64,
    pub language_fit_minimum: f64,
    pub confidence_minimum: f64,
    pub coverage_minimum: f64,
    pub duplicate_transitions: bool,
    pub use_seq: bool,
    pub use_xor: bool,
    pub use_and: bool,
    pub use_or: bool,
    pub use_xor_loop: bool,
    #[serde(flatten)]
    pub weights: Weights,
    /// Wall-clock budget for the whole search. Wasm has no ForkJoinPool-style
    /// parallelism, so this — not a smaller search space — is what keeps an
    /// interactive browser tab responsive on a log with a wide alphabet;
    /// the search returns the best top-k found so far once the budget is
    /// spent, flagged honestly in the result rather than silently truncated.
    pub max_search_millis: u64,
    pub max_align_states: usize,
    /// Bounds the language-enumeration DFS (`evaluator::language`): each
    /// transition may fire at most this many times within one enumerated
    /// path. Mirrors ProM's own `calculateLanguage(apn, maxLoop=3, ...)`.
    pub max_loop: u32,
    /// Set only by `run.promenade.lpm.discover-oc` (the object-centric
    /// action), to the object type its own `project-oc` stage flattened the
    /// log by. Echoed back into the result's stats so the artifact ends up
    /// tagged `meta.objectType` — the marker `combine-oc` groups sibling
    /// per-type `LocalProcessModelSet` artifacts by. Always absent for the
    /// plain `discover` action.
    pub object_type: Option<String>,
}

impl Default for LpmParams {
    fn default() -> Self {
        LpmParams {
            num_transitions: 4,
            top_k: 25,
            frequency_minimum: 10,
            determinism_minimum: 0.49,
            language_fit_minimum: 0.49,
            confidence_minimum: 0.0,
            coverage_minimum: 0.0,
            duplicate_transitions: false,
            use_seq: true,
            use_xor: true,
            use_and: true,
            use_or: false,
            use_xor_loop: true,
            weights: Weights::default(),
            max_search_millis: 15_000,
            max_align_states: 20_000,
            max_loop: 3,
            object_type: None,
        }
    }
}
