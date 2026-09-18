//! The wasm boundary for `run.promenade.soundness.check`.
//!
//! Everything algorithmic lives in `soundness-core`; this file is only the
//! edge — the host's generic `value-finalize/1` ABI on one side (see
//! `plugins/bpmn-rs/src/lib.rs` for the template this follows), typed Rust
//! values on the other.

use serde::Deserialize;
use soundness_core::{analyse, normalize, Options, RawNet};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckParams {
    /// The `AcceptingPetriNet` payload the host resolved from the input slot.
    input_value: RawNet,
    #[serde(default = "default_max_states")]
    max_states: usize,
}

fn default_max_states() -> usize {
    Options::default().max_states
}

/// `run.promenade.soundness.check`: `AcceptingPetriNet` -> `SoundnessReport`.
#[wasm_bindgen]
pub struct SoundnessCheck;

#[wasm_bindgen]
impl SoundnessCheck {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self
    }

    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: CheckParams =
            serde_wasm_bindgen::from_value(params).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let net = normalize(p.input_value);
        let report = analyse(&net, &Options { max_states: p.max_states.max(1) });
        serde_wasm_bindgen::to_value(&report).map_err(|e| JsValue::from_str(&e.to_string()))
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

impl Default for SoundnessCheck {
    fn default() -> Self {
        Self::new()
    }
}
