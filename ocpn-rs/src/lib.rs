//! Promenade WASM kernel for OCPN discovery.
//!
//! Everything algorithmic lives in `ocpn-discovery` (which in turn reuses
//! `inductive-miner-core` unmodified); this file is the boundary — the
//! host's `scan-finalize/1`-shaped ABI on one side, an `ObjectCentricPetriNet`
//! payload on the other:
//!
//! ```text
//!   new OcpnScan(nActivities)
//!   .setActivityNames(names)
//!   .pushChunk(Int32Array cases, Int32Array activities)
//!   .finish()
//!   .finalize({objectTypes, variant, noiseThreshold, variableMultiplicity})
//!     -> ObjectCentricPetriNet payload
//! ```
//!
//! # One kernel session for every selected object type
//!
//! The generic host runner (`app/src/worker/wasm-plugin-worker.ts`) drives
//! every wasm plugin through exactly one scan of one table and a 2-column
//! `pushChunk(cases, activities)` — extending that shared ABI to carry a
//! third "which object type" column would touch every installed miner
//! plugin, not just this one. Instead, the *host* compiles one combined view
//! spanning every selected object type, encoding which object type a case
//! belongs to directly into the case id it assigns:
//!
//! ```text
//! case = type_idx * CASE_OFFSET + local_object_ordinal
//! ```
//!
//! `type_idx` is this case's position in the `objectTypes` parameter's fixed
//! order, and this kernel recovers it with one integer division per closed
//! case — no schema change to the shared ABI, no second table, one scan pass.
//! The activity dictionary is global across every object type in the same
//! pass, which is what makes the later merge-by-activity-label step in
//! `ocpn-discovery` exact rather than approximate: "Ship" gets the same
//! activity id whether it came from `Order`'s rows or `Package`'s.
//!
//! # Variable-arc input
//!
//! Per-event object cardinality (did this occurrence of "Pack" touch more
//! than one `Item`?) cannot be recovered from the per-object-type projection
//! this kernel scans — that projection is one-object-at-a-time by
//! construction. The host computes it separately, with one small aggregate
//! query over the *original* event-object relation, and passes the result as
//! `variableMultiplicity: [[objectType, activity], ...]` in `finalize`'s
//! params — cheap to compute, cheap to transfer, and it never needs to cross
//! the boundary more than once per run.

use ocpn_discovery::{discover, EventLog, Miner, ObjectTypeInput, Parameters};
use serde::Deserialize;
use std::collections::{BTreeSet, HashMap};
use wasm_bindgen::prelude::*;

/// See the module docs: `type_idx = case_id / CASE_OFFSET`. Eight million
/// objects of headroom per object type keeps every packed id inside `i32` for
/// 268 selected types — importantly, logs with hundreds of types must not
/// fail before discovery even starts.
const CASE_OFFSET: i32 = 8_000_000;

/// Not a correctness bound (the algorithm handles any alphabet) — a
/// pathological log should not spend minutes inside a worker. Same figure
/// and same rationale as `inductive-miner-rs`'s kernel, since the expensive
/// part per object type is the same recursion.
pub const MAX_ACTIVITIES: usize = 10_000;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Params {
    #[serde(default)]
    object_types: Vec<String>,
    #[serde(default)]
    variant: Option<String>,
    #[serde(default)]
    noise_threshold: Option<f64>,
    #[serde(default)]
    variable_multiplicity: Vec<(String, String)>,
}

#[wasm_bindgen]
pub struct OcpnScan {
    n_activities: usize,
    over_limit: usize,
    names: Vec<String>,
    /// Trace under construction; the host chunks the event stream, so a case
    /// can straddle a chunk boundary.
    open_case: i32,
    open_trace: Vec<u32>,
    /// `type_idx -> (trace -> count)`. One inner variant map per object
    /// type, recovered from the case id at case-close time.
    variants: HashMap<i32, HashMap<Vec<u32>, u64>>,
    rows: u32,
    cases: u32,
    started: bool,
}

#[wasm_bindgen]
impl OcpnScan {
    #[wasm_bindgen(constructor)]
    pub fn new(n_activities: usize) -> OcpnScan {
        OcpnScan {
            over_limit: n_activities.saturating_sub(MAX_ACTIVITIES),
            n_activities: n_activities.min(MAX_ACTIVITIES),
            names: Vec::new(),
            open_case: -1,
            open_trace: Vec::new(),
            variants: HashMap::new(),
            rows: 0,
            cases: 0,
            started: false,
        }
    }

    /// Activity labels, in activity-id order. Required here (unlike the
    /// Inductive Miner kernel, where it is optional): this kernel needs the
    /// names to resolve `variableMultiplicity`'s activity strings back to
    /// ids at `finalize` time, not only to label the output.
    #[wasm_bindgen(js_name = setActivityNames)]
    pub fn set_activity_names(&mut self, names: Vec<String>) {
        self.names = names;
    }

    /// One ordered chunk of `(case, activity)` pairs, exactly the shared ABI
    /// every Promenade wasm kernel receives. Rows must arrive grouped by case
    /// and in order within a case — the host's SQL guarantees both, and here
    /// additionally guarantees rows are grouped by object type first (cases
    /// numbered by `type_idx * CASE_OFFSET + ordinal` sort that way
    /// naturally under the host's own `ORDER BY case, ...`).
    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, cases: &[i32], activities: &[i32]) {
        let n = cases.len().min(activities.len());
        for i in 0..n {
            let (case, activity) = (cases[i], activities[i]);
            if !self.started || case != self.open_case {
                if self.started {
                    self.close_case();
                }
                self.started = true;
                self.open_case = case;
                self.cases += 1;
            }
            if activity < 0 || activity as usize >= self.n_activities {
                continue;
            }
            self.open_trace.push(activity as u32);
            self.rows += 1;
        }
    }

    pub fn finish(&mut self) {
        if self.started {
            self.close_case();
            self.started = false;
        }
    }

    #[wasm_bindgen(js_name = rowCount)]
    pub fn row_count(&self) -> u32 {
        self.rows
    }

    #[wasm_bindgen(js_name = caseCount)]
    pub fn case_count(&self) -> u32 {
        self.cases
    }

    /// The parameter-dependent stage: per-object-type Inductive Miner runs,
    /// tree-to-net conversion, and the cross-type merge.
    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: Params = serde_wasm_bindgen::from_value(params).unwrap_or_default();

        let miner = match p.variant.as_deref() {
            Some("IM") => Miner::IM,
            _ => Miner::IMf,
        };
        let noise = p.noise_threshold.unwrap_or(0.2);

        let name_to_id: HashMap<&str, u32> =
            self.names.iter().enumerate().map(|(i, n)| (n.as_str(), i as u32)).collect();
        let variable: BTreeSet<(String, u32)> = p
            .variable_multiplicity
            .iter()
            .filter_map(|(ot, act)| name_to_id.get(act.as_str()).map(|&id| (ot.clone(), id)))
            .collect();

        let inputs: Vec<ObjectTypeInput> = p
            .object_types
            .iter()
            .enumerate()
            .map(|(type_idx, object_type)| {
                let log = match self.variants.get(&(type_idx as i32)) {
                    Some(v) => {
                        let mut variants: Vec<(Vec<u32>, u64)> =
                            v.iter().map(|(k, &c)| (k.clone(), c)).collect();
                        // Deterministic order: a `HashMap` iterates
                        // unpredictably, and re-running on unchanged input
                        // should produce byte-identical output.
                        variants.sort_unstable();
                        EventLog {
                            variants: variants
                                .into_iter()
                                .map(|(events, count)| inductive_miner_core::TraceVariant { events, count })
                                .collect(),
                        }
                    }
                    None => EventLog::new(),
                };
                ObjectTypeInput { object_type: object_type.clone(), log }
            })
            .collect();

        let mut net = discover(&inputs, &self.names, &variable, &Parameters { miner, noise_threshold: noise });
        net.metadata.activities_dropped = self.over_limit;

        // A bare `ObjectCentricPetriNet`, not a wrapper around one — the
        // same convention every other Promenade miner's wasm boundary
        // follows for its own primary output type.
        serde_wasm_bindgen::to_value(&net)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::CASE_OFFSET;

    #[test]
    fn packed_case_ids_cover_268_object_types_without_i32_overflow() {
        let last_type = 267_i32;
        let last_local_ordinal = CASE_OFFSET - 1;
        let case_id = last_type * CASE_OFFSET + last_local_ordinal;
        assert!(case_id <= i32::MAX);
        assert_eq!(case_id.div_euclid(CASE_OFFSET), last_type);
    }
}

impl OcpnScan {
    fn close_case(&mut self) {
        let trace = std::mem::take(&mut self.open_trace);
        let type_idx = self.open_case.div_euclid(CASE_OFFSET);
        *self.variants.entry(type_idx).or_default().entry(trace).or_insert(0) += 1;
    }
}
