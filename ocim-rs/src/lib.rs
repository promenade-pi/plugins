//! Promenade boundary for the Object-Centric Inductive Miner.
//!
//! The host projects the OCEL to one ordered trace per object and supplies the
//! interaction predicates calculated before that projection collapsed event
//! identity.  This module only handles the scan ABI and JSON/WASM bridge; the
//! miner and OCPT-to-OCPN converter live in the pure-Rust `ocim-core` crate.

use ocim_core::{discover, payload, to_ocpn, Interaction, ObjectTrace, OcptPayload};
use serde::Deserialize;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

const CASE_OFFSET: i32 = 8_000_000;
pub const MAX_ACTIVITIES: usize = 10_000;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DiscoverParams {
    #[serde(default)]
    object_types: Vec<String>,
    /// Rows from `project.sql`: activity, object type, related, divergent,
    /// convergent, deficient.  Tuple deserialization matches the host's
    /// generic auxiliary-query metadata representation exactly.
    #[serde(default)]
    interaction_patterns: Vec<(String, String, bool, bool, bool, bool)>,
}

#[wasm_bindgen]
pub struct OcimScan {
    n_activities: usize,
    over_limit: usize,
    names: Vec<String>,
    open_case: i32,
    open_trace: Vec<u32>,
    variants: HashMap<i32, HashMap<Vec<u32>, u64>>,
    rows: u32,
    cases: u32,
    started: bool,
}

#[wasm_bindgen]
impl OcimScan {
    #[wasm_bindgen(constructor)]
    pub fn new(n_activities: usize) -> Self {
        Self {
            n_activities: n_activities.min(MAX_ACTIVITIES),
            over_limit: n_activities.saturating_sub(MAX_ACTIVITIES),
            names: Vec::new(),
            open_case: -1,
            open_trace: Vec::new(),
            variants: HashMap::new(),
            rows: 0,
            cases: 0,
            started: false,
        }
    }
    #[wasm_bindgen(js_name = setActivityNames)]
    pub fn set_activity_names(&mut self, names: Vec<String>) {
        self.names = names;
    }
    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, cases: &[i32], activities: &[i32]) {
        for (&case, &activity) in cases.iter().zip(activities) {
            if !self.started || case != self.open_case {
                if self.started {
                    self.close_case();
                }
                self.started = true;
                self.open_case = case;
                self.cases += 1;
            }
            if activity >= 0 && (activity as usize) < self.n_activities {
                self.open_trace.push(activity as u32);
                self.rows += 1;
            }
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
    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: DiscoverParams = serde_wasm_bindgen::from_value(params).unwrap_or_default();
        let by_name: HashMap<&str, u32> = self
            .names
            .iter()
            .enumerate()
            .map(|(i, n)| (n.as_str(), i as u32))
            .collect();
        let mut interaction = Interaction::default();
        for (activity, typ, related, divergent, convergent, deficient) in p.interaction_patterns {
            if let Some(&id) = by_name.get(activity.as_str()) {
                interaction.add(id, typ, related, divergent, convergent, deficient);
            }
        }
        let mut traces = Vec::new();
        for (type_index, typ) in p.object_types.iter().enumerate() {
            let Some(variants) = self.variants.get(&(type_index as i32)) else {
                continue;
            };
            let mut ordered: Vec<_> = variants.iter().collect();
            ordered.sort_by(|a, b| a.0.cmp(b.0));
            for (events, count) in ordered {
                for _ in 0..*count {
                    traces.push(ObjectTrace {
                        object_type: typ.clone(),
                        events: events.clone(),
                    });
                }
            }
        }
        let tree = discover(traces, interaction.clone());
        serde_wasm_bindgen::to_value(&payload(&tree, &self.names, &interaction, self.over_limit))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}
impl OcimScan {
    fn close_case(&mut self) {
        let events = std::mem::take(&mut self.open_trace);
        let type_index = self.open_case.div_euclid(CASE_OFFSET);
        *self
            .variants
            .entry(type_index)
            .or_default()
            .entry(events)
            .or_insert(0) += 1;
    }
}

#[derive(Deserialize)]
struct ConvertParams {
    #[serde(rename = "inputValue")]
    input_value: OcptPayload,
}

/// A no-scan kernel used by the generic `value-finalize/1` host ABI.  Keeping
/// it in the same wasm module makes the public Tree -> OCPN action entirely
/// Rust, rather than delegating a model conversion to a scripting runtime.
#[wasm_bindgen]
pub struct OcimConvert;
#[wasm_bindgen]
impl OcimConvert {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self
    }
    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: ConvertParams = serde_wasm_bindgen::from_value(params)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let net = to_ocpn(&p.input_value).map_err(|e| JsValue::from_str(&e))?;
        serde_wasm_bindgen::to_value(&net).map_err(|e| JsValue::from_str(&e.to_string()))
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packed_case_identifies_type() {
        assert_eq!((2 * CASE_OFFSET + 9).div_euclid(CASE_OFFSET), 2)
    }
}
