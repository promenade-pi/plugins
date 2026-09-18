//! Promenade wasm boundary for "Discover station map".
//!
//! The layout lives in the pure-Rust `station-map-core` crate; this module
//! only implements the generic `value-finalize/1` host ABI, the same shape
//! `plugins/metro-map/src/lib.rs` uses for a model-to-model conversion with no
//! SQL and no scan of its own.

use serde::Deserialize;
use station_map_core::{build_station_map, OcdfgPayload, Params};
use wasm_bindgen::prelude::*;

/// `objectTypes` reaches the kernel from two directions: this action's own
/// picker (a `string[]`) and the host's "an upstream fact overrides a param"
/// merge, which for a `core.discover.ocdfg` scan fills it from that artifact's
/// `meta.objectTypes` — a *count*, not a list. Accept the list, ignore the
/// rest, exactly as the metro-map kernel does.
#[derive(Deserialize)]
#[serde(untagged)]
enum ObjectTypesParam {
    List(Vec<String>),
    Other(serde::de::IgnoredAny),
}

impl Default for ObjectTypesParam {
    fn default() -> Self {
        ObjectTypesParam::List(Vec::new())
    }
}

impl ObjectTypesParam {
    fn into_list(self) -> Vec<String> {
        match self {
            ObjectTypesParam::List(v) => v,
            ObjectTypesParam::Other(_) => Vec::new(),
        }
    }
}

#[derive(Deserialize)]
struct ConvertParams {
    #[serde(rename = "inputValue")]
    input_value: OcdfgPayload,
    #[serde(rename = "objectTypes", default)]
    object_types: ObjectTypesParam,
    #[serde(rename = "maxActivities", default = "default_max_activities")]
    max_activities: f64,
    #[serde(rename = "edgeCoverage", default = "default_edge_coverage")]
    edge_coverage: f64,
    #[serde(rename = "showRework", default = "default_true")]
    show_rework: bool,
}

fn default_max_activities() -> f64 {
    14.0
}
fn default_edge_coverage() -> f64 {
    90.0
}
fn default_true() -> bool {
    true
}

#[wasm_bindgen]
pub struct StationMapConvert;

#[wasm_bindgen]
impl StationMapConvert {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self
    }

    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: ConvertParams =
            serde_wasm_bindgen::from_value(params).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let map = build_station_map(
            &p.input_value,
            &Params {
                object_types: p.object_types.into_list(),
                max_activities: p.max_activities.max(2.0) as usize,
                edge_coverage: p.edge_coverage,
                show_rework: p.show_rework,
            },
        );
        serde_wasm_bindgen::to_value(&map).map_err(|e| JsValue::from_str(&e.to_string()))
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

impl Default for StationMapConvert {
    fn default() -> Self {
        Self::new()
    }
}
