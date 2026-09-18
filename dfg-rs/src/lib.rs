//! Directly-follows discovery kernel — browser (wasm-bindgen) build.
//!
//! Exemplary compute plugin: it receives dictionary-encoded event columns from
//! the host and produces a directly-follows graph. It never reads a file, never
//! sees OPFS, and never parses a log — the host does the relational work in SQL
//! and hands over primitive buffers.
//!
//! The algorithm itself lives in `core.rs`, with no `wasm_bindgen` in it at
//! all — this file is a thin JS-facing wrapper around it. `wasi.rs` wraps the
//! same `DfgCore` for the engine build (Promenade Compute); see
//! `manifest.json`'s `compute` block and `package.sh`.
//!
//! Two ABIs are exposed side by side, deliberately:
//!
//!   - the original two-stage one (`pushChunk`/`finish`/`filter`/
//!     `startActivities`/`endActivities`/`activityCounts`), which is what the
//!     built-in `core.discover.dfg` action (`app/src/worker/plugin-worker.ts`)
//!     has always driven directly, unchanged;
//!   - the generic `scan-finalize/1` ABI (`finalize`/`setActivityNames`),
//!     which is what lets this same crate also be packaged as an ordinary
//!     installed plugin (`run.promenade.dfg-rs`) driven by the host's generic
//!     `wasm-plugin-worker.ts` — the same driver every other Rust plugin uses,
//!     and the one `computeActionRuntime` mirrors for the engine.

mod dfg_core;

#[cfg(target_os = "wasi")]
mod wasi;

#[cfg(not(target_os = "wasi"))]
pub use browser::DfgBuilder;

/// Everything below only makes sense compiled to `wasm32-unknown-unknown`
/// with wasm-bindgen's JS glue; the WASI/engine build (`wasi.rs`) has none of
/// this and talks to `dfg_core` directly.
#[cfg(not(target_os = "wasi"))]
mod browser {

use crate::dfg_core::DfgCore;
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct DfgBuilder {
    inner: DfgCore,
}

#[wasm_bindgen]
impl DfgBuilder {
    #[wasm_bindgen(constructor)]
    pub fn new(n_activities: usize) -> DfgBuilder {
        DfgBuilder { inner: DfgCore::new(n_activities) }
    }

    /// Optional labels in the activity-id order assigned by the host. Only
    /// `finalize` (the generic ABI) uses these.
    #[wasm_bindgen(js_name = setActivityNames)]
    pub fn set_activity_names(&mut self, names: Vec<String>) {
        self.inner.set_activity_names(names);
    }

    /// Consumes one ordered chunk. `cases` and `activities` are parallel arrays.
    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, cases: &[i32], activities: &[i32]) {
        self.inner.push_chunk(cases, activities);
    }

    /// Closes the final case. Must be called before `filter`/`finalize`.
    pub fn finish(&mut self) {
        self.inner.finish();
    }

    #[wasm_bindgen(js_name = edgeCount)]
    pub fn edge_count(&self) -> usize {
        self.inner.edge_count()
    }

    #[wasm_bindgen(js_name = rowCount)]
    pub fn row_count(&self) -> u32 {
        self.inner.row_count()
    }

    #[wasm_bindgen(js_name = caseCount)]
    pub fn case_count(&self) -> u32 {
        self.inner.case_count()
    }

    /// The cheap, parameter-dependent stage (original ABI). Returns flat
    /// triples [src, dst, freq, ...] so the boundary stays a single typed
    /// array rather than a serialised object graph.
    pub fn filter(&self, min_frequency: u32) -> Vec<u32> {
        self.inner.filter(min_frequency)
    }

    /// Start activities above the threshold, as [activity, freq, ...].
    #[wasm_bindgen(js_name = startActivities)]
    pub fn start_activities(&self, min_frequency: u32) -> Vec<u32> {
        self.inner.start_activities(min_frequency)
    }

    /// End activities above the threshold, as [activity, freq, ...].
    #[wasm_bindgen(js_name = endActivities)]
    pub fn end_activities(&self, min_frequency: u32) -> Vec<u32> {
        self.inner.end_activities(min_frequency)
    }

    /// Per-activity occurrence counts, indexed by activity id.
    #[wasm_bindgen(js_name = activityCounts)]
    pub fn activity_counts(&self) -> Vec<u32> {
        self.inner.activity_counts()
    }

    /// Approximate retained size, so the host can enforce a memory budget.
    #[wasm_bindgen(js_name = heapEstimate)]
    pub fn heap_estimate(&self) -> u32 {
        self.inner.heap_estimate()
    }

    /// Generic `scan-finalize/1` ABI: everything `DfgView` needs in one
    /// value, shaped exactly like `DfgResultPayload`
    /// (`app/src/host/relational/reference-actions/discover-dfg/build.ts`) so
    /// a WASM, WASI/engine, or relational run of the same log render in the
    /// same view.
    #[wasm_bindgen(js_name = finalize)]
    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: Params = serde_wasm_bindgen::from_value(params)
            .map_err(|e| JsValue::from_str(&format!("bad params: {e}")))?;
        let out = self.inner.finalize(p.min_frequency.unwrap_or(1));
        serde_wasm_bindgen::to_value(&JsResult {
            activities: out.activities,
            edges: out.edges,
            starts: out.starts,
            ends: out.ends,
            counts: out.counts,
            stats: JsStats {
                rows: out.stats.rows,
                cases: out.stats.cases,
                total_edges: out.stats.total_edges,
                shown_edges: out.stats.shown_edges,
                heap_estimate: out.stats.heap_estimate,
            },
        })
        .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Params {
    min_frequency: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsStats {
    rows: u32,
    cases: u32,
    total_edges: u32,
    shown_edges: u32,
    heap_estimate: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsResult {
    activities: Vec<String>,
    edges: Vec<u32>,
    starts: Vec<u32>,
    ends: Vec<u32>,
    counts: Vec<u32>,
    stats: JsStats,
}

} // mod browser

#[cfg(all(test, not(target_os = "wasi")))]
mod tests {
    use super::browser::DfgBuilder;

    #[test]
    fn retains_immediate_self_loops() {
        // case 0: A → A → B; case 1: B → B
        let mut dfg = DfgBuilder::new(2);
        dfg.push_chunk(&[0, 0, 0, 1, 1], &[0, 0, 1, 1, 1]);
        dfg.finish();

        let triples = dfg.filter(1);
        let edges: std::collections::HashMap<_, _> = triples.chunks_exact(3)
            .map(|chunk| ((chunk[0], chunk[1]), chunk[2]))
            .collect();
        assert_eq!(edges.get(&(0, 0)), Some(&1));
        assert_eq!(edges.get(&(1, 1)), Some(&1));
        assert_eq!(edges.get(&(0, 1)), Some(&1));
    }
}
