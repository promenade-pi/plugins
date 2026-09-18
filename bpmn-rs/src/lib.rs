//! Promenade WASM kernels for BPMN 2.0: conversions to/from Petri nets and
//! process trees, and BPMN XML import.
//!
//! Everything algorithmic lives in `bpmn-core`; this file is only the
//! boundary — the host's generic `value-finalize/1` ABI on one side (see
//! `plugins/ocim-rs/src/lib.rs`'s `OcimConvert` for the template this
//! follows), typed Rust values on the other.

use bpmn_core::petri_net::RawAcceptingPetriNet;
use bpmn_core::process_tree::ProcessTreePayload;
use bpmn_core::Bpmn;
use serde::Deserialize;
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
struct ConvertParams<T> {
    #[serde(rename = "inputValue")]
    input_value: T,
}

fn to_js<T: serde::Serialize>(v: &T) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(v).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// `run.promenade.bpmn.from-process-tree`: `ProcessTree` -> `Bpmn`.
#[wasm_bindgen]
pub struct FromProcessTree;

#[wasm_bindgen]
impl FromProcessTree {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self
    }

    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: ConvertParams<ProcessTreePayload> = serde_wasm_bindgen::from_value(params)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let bpmn: Bpmn = bpmn_core::from_process_tree::from_process_tree(&p.input_value)
            .map_err(|e| JsValue::from_str(&e))?;
        to_js(&bpmn)
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

#[derive(Deserialize)]
struct ImportParams {
    xml: String,
}

/// `run.promenade.bpmn.import`: raw BPMN 2.0 XML text -> `Bpmn`. A
/// manufacturing action (`inputs: []`) -- its params carry everything, read
/// directly rather than through the `inputValue` wrapper the conversion
/// kernels use, since there is no artifact input to have supplied one.
#[wasm_bindgen]
pub struct ImportXml;

#[wasm_bindgen]
impl ImportXml {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self
    }

    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: ImportParams = serde_wasm_bindgen::from_value(params).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let bpmn: Bpmn = bpmn_core::import_xml::import_bpmn_xml(&p.xml).map_err(|e| JsValue::from_str(&e))?;
        to_js(&bpmn)
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

/// `run.promenade.bpmn.to-petrinet`: `Bpmn` -> `AcceptingPetriNet`.
#[wasm_bindgen]
pub struct ToPetriNet;

#[wasm_bindgen]
impl ToPetriNet {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self
    }

    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: ConvertParams<Bpmn> = serde_wasm_bindgen::from_value(params).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let net = bpmn_core::to_petri_net::to_petri_net(&p.input_value).map_err(|e| JsValue::from_str(&e))?;
        to_js(&net)
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

/// `run.promenade.bpmn.replace-or-joins`: `Bpmn` -> `Bpmn`.
///
/// Rewrites every inclusive join that can be proven equivalent to a
/// combination of exclusive and parallel gateways, which is what a Petri-net
/// based tool needs before it can read the model at all. What it did, and what
/// it could not do, comes back in the diagram's own `metadata.warnings` — an
/// inclusive gateway left in place is a fact about the model, not a failure of
/// the action, so this returns a diagram rather than an error.
#[wasm_bindgen]
pub struct ReplaceOrJoins;

#[wasm_bindgen]
impl ReplaceOrJoins {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self
    }

    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: ConvertParams<Bpmn> =
            serde_wasm_bindgen::from_value(params).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let out = bpmn_core::or_join::replace(&p.input_value).map_err(|e| JsValue::from_str(&e))?;
        to_js(&ReplacedBpmn {
            nodes: out.bpmn.nodes,
            flows: out.bpmn.flows,
            metadata: out.bpmn.metadata,
            stats: ReplacementStats {
                replaced: out.replaced.len(),
                kept: out.kept.len(),
                complete: out.kept.is_empty(),
            },
        })
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

/// The `Bpmn` payload plus the counts the host lifts into the artifact's meta.
/// Written out field by field rather than with `#[serde(flatten)]`:
/// serde-wasm-bindgen drops an enum tag out of a flattened struct, and every
/// node in here carries a `kind`.
#[derive(serde::Serialize)]
struct ReplacedBpmn {
    nodes: Vec<bpmn_core::Node>,
    flows: Vec<bpmn_core::Flow>,
    metadata: bpmn_core::Metadata,
    stats: ReplacementStats,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplacementStats {
    /// Inclusive joins rewritten.
    replaced: usize,
    /// Inclusive gateways still in the diagram.
    kept: usize,
    /// Whether the diagram now converts to a Petri net.
    complete: bool,
}

/// `run.promenade.bpmn.to-process-tree`: `Bpmn` -> `ProcessTree`.
#[wasm_bindgen]
pub struct ToProcessTree;

#[wasm_bindgen]
impl ToProcessTree {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self
    }

    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: ConvertParams<Bpmn> = serde_wasm_bindgen::from_value(params).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let tree = bpmn_core::to_process_tree::to_process_tree(&p.input_value).map_err(|e| JsValue::from_str(&e))?;
        to_js(&tree)
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

#[derive(serde::Serialize)]
struct ExportResult {
    text: String,
    /// The host composes the actual filename from the artifact's own name
    /// plus this extension (matching how every other export in this
    /// codebase names its download) -- a kernel has no artifact metadata,
    /// only the bare payload `inputValue` gave it.
    extension: String,
    mime: String,
}

/// `run.promenade.bpmn.export-xml`: `Bpmn` -> a downloadable BPMN 2.0 XML
/// file (no diagram-interchange layout -- see `export_xml.rs`).
#[wasm_bindgen]
pub struct ExportXml;

#[wasm_bindgen]
impl ExportXml {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self
    }

    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: ConvertParams<Bpmn> = serde_wasm_bindgen::from_value(params).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let text = bpmn_core::export_xml::export_bpmn_xml(&p.input_value, "Process_1");
        to_js(&ExportResult { text, extension: ".bpmn".into(), mime: "application/xml".into() })
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

/// `run.promenade.bpmn.from-petrinet`: `AcceptingPetriNet` -> `Bpmn`.
#[wasm_bindgen]
pub struct FromPetriNet;

#[wasm_bindgen]
impl FromPetriNet {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self
    }

    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: ConvertParams<RawAcceptingPetriNet> = serde_wasm_bindgen::from_value(params)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let bpmn: Bpmn = bpmn_core::from_petri_net::from_petri_net(p.input_value)
            .map_err(|e| JsValue::from_str(&e))?;
        to_js(&bpmn)
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
