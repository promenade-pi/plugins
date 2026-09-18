//! The wasm boundary for `run.promenade.tree-generator.generate`.
//!
//! Everything algorithmic lives in `tree-gen-core`; this file is only the edge.
//!
//! The action has no input artifact at all — it makes a model out of its own
//! parameters, which is what the manifest's `"standalone": true` declares. The
//! host's `value-finalize/1` ABI covers that case unchanged: the kernel is
//! handed the params and nothing else.

use serde::{Deserialize, Serialize};
use tree_gen_core::{generate, tree::ProcessTreePayload, Options, Stats};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateParams {
    #[serde(default = "default_mode")]
    activity_mode: usize,
    #[serde(default = "default_min")]
    activity_min: usize,
    #[serde(default = "default_max")]
    activity_max: usize,
    #[serde(default = "default_quarter")]
    sequence: f64,
    #[serde(default = "default_quarter")]
    choice: f64,
    #[serde(default = "default_quarter")]
    parallel: f64,
    #[serde(default = "default_quarter", rename = "loop")]
    loop_: f64,
    #[serde(default)]
    inclusive: f64,
    #[serde(default = "default_silent")]
    silent: f64,
    #[serde(default)]
    duplicate: f64,
    #[serde(default = "default_seed")]
    seed: u64,
}

fn default_mode() -> usize { Options::default().activity_mode }
fn default_min() -> usize { Options::default().activity_min }
fn default_max() -> usize { Options::default().activity_max }
fn default_quarter() -> f64 { Options::default().sequence }
fn default_silent() -> f64 { Options::default().silent }
fn default_seed() -> u64 { Options::default().seed }

/// The artifact's `meta`, written flat.
///
/// The first five fields are the `ProcessTree` statistics every consumer of
/// that type already reads (the tree view's caption, for one), spelled exactly
/// as the Inductive Miner spells them — a generated tree should not need
/// special handling anywhere. The rest is what only a generator knows.
///
/// Not `#[serde(flatten)]` over `Stats`: `serde-wasm-bindgen` renders a
/// flattened struct as a JS `Map`, and the host spreads this into `meta`,
/// where a `Map` would contribute nothing at all and report no error.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutStats {
    nodes: usize,
    leaves: usize,
    silent: usize,
    operators: usize,
    activities: usize,
    activity_leaves: usize,
    depth: usize,
    sequences: usize,
    choices: usize,
    parallels: usize,
    loops: usize,
    inclusive_choices: usize,
    seed: f64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    generator_warnings: Vec<String>,
}

impl OutStats {
    fn new(stats: Stats, warnings: Vec<String>) -> Self {
        Self {
            nodes: stats.nodes,
            leaves: stats.leaves,
            silent: stats.silent,
            operators: stats.operators,
            activities: stats.activities,
            activity_leaves: stats.activity_leaves,
            depth: stats.depth,
            sequences: stats.sequences,
            choices: stats.choices,
            parallels: stats.parallels,
            loops: stats.loops,
            inclusive_choices: stats.inclusive_choices,
            // JS has no 64-bit integer; the seed is only ever echoed back to
            // the person who typed it.
            seed: stats.seed as f64,
            generator_warnings: warnings,
        }
    }
}

/// The payload the host stores, which *is* the `ProcessTree` contract plus the
/// `stats` every artifact carries.
#[derive(Serialize)]
struct TreeArtifact {
    root: u32,
    nodes: Vec<tree_gen_core::tree::TreeNode>,
    activities: Vec<String>,
    stats: OutStats,
}

impl TreeArtifact {
    fn new(payload: ProcessTreePayload, stats: OutStats) -> Self {
        Self { root: payload.root, nodes: payload.nodes, activities: payload.activities, stats }
    }
}

/// `run.promenade.tree-generator.generate`: nothing -> `ProcessTree`.
#[wasm_bindgen]
pub struct GenerateTree;

#[wasm_bindgen]
impl GenerateTree {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self
    }

    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: GenerateParams =
            serde_wasm_bindgen::from_value(params).map_err(|e| JsValue::from_str(&e.to_string()))?;

        let options = Options {
            activity_mode: p.activity_mode.clamp(1, 2_000),
            activity_min: p.activity_min.clamp(1, 2_000),
            activity_max: p.activity_max.clamp(1, 2_000),
            sequence: p.sequence.max(0.0),
            choice: p.choice.max(0.0),
            parallel: p.parallel.max(0.0),
            loop_: p.loop_.max(0.0),
            inclusive: p.inclusive.max(0.0),
            silent: p.silent.clamp(0.0, 1.0),
            duplicate: p.duplicate.clamp(0.0, 1.0),
            seed: p.seed,
        };

        let generated = generate(&options);
        let artifact = TreeArtifact::new(
            generated.payload,
            OutStats::new(generated.stats, generated.warnings),
        );
        serde_wasm_bindgen::to_value(&artifact).map_err(|e| JsValue::from_str(&e.to_string()))
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

impl Default for GenerateTree {
    fn default() -> Self {
        Self::new()
    }
}
