//! Promenade wasm boundary for "Discover metro map".
//!
//! The whole algorithm lives in the pure-Rust `metro-map-core` crate; this
//! module only implements the generic `value-finalize/1` host ABI (see
//! `plugins/ocim-rs/src/lib.rs`'s `OcimConvert`, the existing precedent for a
//! model-to-model conversion action with no SQL/scan involved at all).

use metro_map_core::{
    build_metro_map, build_metro_map_from_ocdfg_with_rank_tiebreak, OcdfgPayload, OcpnPayload, RankTiebreak,
};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
struct ConvertParams {
    #[serde(rename = "inputValue")]
    input_value: OcpnPayload,
}

/// `objectTypes` reaches the kernel from two directions: the action's own
/// picker (a `string[]`) and the host's "upstream fact overrides a param"
/// merge (`runtimeAdapters.ts`), which for a `core.discover.ocdfg` scan
/// fills it from that artifact's `meta.objectTypes` — a *count* (integer),
/// not a list. Accept the list, ignore anything else.
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
struct DfgConvertParams {
    #[serde(rename = "inputValue")]
    input_value: OcdfgPayload,
    #[serde(rename = "objectTypes", default)]
    object_types: ObjectTypesParam,
    #[serde(rename = "rankTiebreak", default)]
    rank_tiebreak: RankTiebreak,
}

#[wasm_bindgen]
pub struct MetroMapConvert;

#[wasm_bindgen]
impl MetroMapConvert {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self
    }

    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: ConvertParams =
            serde_wasm_bindgen::from_value(params).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let map = build_metro_map(&p.input_value);
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

impl Default for MetroMapConvert {
    fn default() -> Self {
        Self::new()
    }
}

/// Second kernel class: same `value-finalize/1` model-to-model shape as
/// `MetroMapConvert`, but its inline input is an `OCDFG` payload (scanned
/// via `core.discover.ocdfg`) instead of an `ObjectCentricPetriNet`.
#[wasm_bindgen]
pub struct MetroMapDfgConvert;

#[wasm_bindgen]
impl MetroMapDfgConvert {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self
    }

    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: DfgConvertParams =
            serde_wasm_bindgen::from_value(params).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let map = build_metro_map_from_ocdfg_with_rank_tiebreak(&p.input_value, &p.object_types.into_list(), p.rank_tiebreak);
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

impl Default for MetroMapDfgConvert {
    fn default() -> Self {
        Self::new()
    }
}
