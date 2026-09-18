//! Debug harness for `ocpn-discovery`.
//!
//! Reads one JSON request per line on stdin, writes one JSON response per
//! line on stdout — mirrors `inductive-miner-cli`'s contract so the same
//! tooling conventions (line-oriented, diffable, no shared process state
//! between lines) apply here too.
//!
//! ```text
//! {"id":"x","objectTypes":{"Order":[["Create","Ship"]],"Package":[["Pack","Ship"]]},
//!  "variant":"IMf","noiseThreshold":0.2,"variable":[["Item","Pack"]]}
//! {"id":"x","net": { ... ObjectCentricPetriNet ... }}
//! ```
//!
//! There is no external oracle to diff against here (unlike Inductive Miner's
//! ProM reference) — this exists for inspecting discovery output on a
//! hand-written fixture without going through wasm, not for differential
//! testing against a trusted implementation. See `docs/testing.md`.

use inductive_miner_core::TraceVariant;
use ocpn_discovery::{discover, EventLog, Miner, ObjectTypeInput, Parameters};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::io::{self, BufRead, Write};

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                let _ = writeln!(out, "{}", json!({"error": e.to_string()}));
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let _ = writeln!(out, "{}", handle(&line));
    }
}

fn handle(line: &str) -> Value {
    let req: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return json!({"id": "?", "error": format!("bad request: {e}")}),
    };
    let id = req.get("id").and_then(Value::as_str).unwrap_or("?").to_string();

    let Some(object_types) = req.get("objectTypes").and_then(Value::as_object) else {
        return json!({"id": id, "error": "no objectTypes"});
    };

    // One global activity dictionary, first-appearance order across every
    // object type in the request — the same rule the real wasm boundary's
    // combined scan uses, so a fixture written here behaves the way a real
    // run would.
    let mut ids: HashMap<String, u32> = HashMap::new();
    let mut names: Vec<String> = Vec::new();
    let mut inputs = Vec::new();

    // BTreeMap iteration order (serde_json::Map preserves insertion order by
    // default, but the request is untrusted input from a human-written
    // fixture) — sorted so a fixture's key order never changes the result.
    let mut keys: Vec<&String> = object_types.keys().collect();
    keys.sort();

    for object_type in keys {
        let traces = object_types[object_type].as_array().cloned().unwrap_or_default();
        let mut log = EventLog::new();
        for t in &traces {
            let events: Vec<u32> = t
                .as_array()
                .map(|evs| {
                    evs.iter()
                        .filter_map(Value::as_str)
                        .map(|name| {
                            *ids.entry(name.to_string()).or_insert_with(|| {
                                names.push(name.to_string());
                                names.len() as u32 - 1
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            log.variants.push(TraceVariant { events, count: 1 });
        }
        log.collapse();
        inputs.push(ObjectTypeInput { object_type: object_type.clone(), log });
    }

    let mut variable = BTreeSet::new();
    if let Some(pairs) = req.get("variable").and_then(Value::as_array) {
        for pair in pairs {
            let Some(arr) = pair.as_array() else { continue };
            let (Some(ot), Some(activity)) = (arr.first().and_then(Value::as_str), arr.get(1).and_then(Value::as_str)) else { continue };
            if let Some(&aid) = ids.get(activity) {
                variable.insert((ot.to_string(), aid));
            }
        }
    }

    let params = Parameters {
        miner: match req.get("variant").and_then(Value::as_str) {
            Some("IM") => Miner::IM,
            _ => Miner::IMf,
        },
        noise_threshold: req.get("noiseThreshold").and_then(Value::as_f64).unwrap_or(0.2),
    };

    let net = discover(&inputs, &names, &variable, &params);
    match ocpn_core::validate(&net) {
        Ok(()) => json!({"id": id, "net": net}),
        Err(e) => json!({"id": id, "error": format!("discovered an invalid net: {e}"), "net": net}),
    }
}
