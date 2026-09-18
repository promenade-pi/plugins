//! Test/CLI convenience: build `ObjectTypeInput`s from raw activity-label
//! traces instead of pre-encoded ids.
//!
//! The wasm boundary never uses this — the host interns activities on the SQL
//! side, the same way every other Promenade wasm kernel receives an
//! already-encoded stream. This exists for `ocpn-discovery`'s own tests and
//! for `ocpn-cli`, where writing out raw ids by hand would make every fixture
//! unreadable.

use crate::{EventLog, ObjectTypeInput};
use inductive_miner_core::TraceVariant;
use std::collections::HashMap;

/// Interns activity names in first-appearance order, shared across every
/// object type passed in (so `discover`'s merge-by-label step has a
/// consistent id space to work with, exactly as the real wasm boundary's
/// single combined scan does).
pub fn intern(traces_by_type: &[(&str, Vec<Vec<&str>>)]) -> (Vec<String>, Vec<ObjectTypeInput>) {
    let mut names: Vec<String> = Vec::new();
    let mut index: HashMap<String, u32> = HashMap::new();
    let mut inputs = Vec::new();

    for (object_type, traces) in traces_by_type {
        let mut log = EventLog::new();
        for trace in traces {
            let events: Vec<u32> = trace
                .iter()
                .map(|activity| {
                    *index.entry((*activity).to_string()).or_insert_with(|| {
                        names.push((*activity).to_string());
                        (names.len() - 1) as u32
                    })
                })
                .collect();
            log.variants.push(TraceVariant { events, count: 1 });
        }
        log.collapse();
        inputs.push(ObjectTypeInput { object_type: (*object_type).to_string(), log });
    }

    (names, inputs)
}
