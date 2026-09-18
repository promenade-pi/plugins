//! Differential-testing harness.
//!
//! Reads one JSON request per line on stdin, writes one JSON response per line
//! on stdout — the same contract as the Java oracle in `tools/oracle`, so the
//! two can be diffed line for line:
//!
//! ```text
//! {"id":"x","traces":[["a","b"],[]],"variant":"IMf","noiseThreshold":0.2}
//! {"id":"x","canonical":"seq('a','b')","raw":"seq('a','b')"}
//! ```

use inductive_miner_core::{discover, EventLog, Parameters, TraceVariant, Variant};
use serde_json::{json, Value};
use std::collections::HashMap;
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
        let response = handle(&line);
        let _ = writeln!(out, "{response}");
    }
}

fn handle(line: &str) -> Value {
    let req: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return json!({"id": "?", "error": format!("bad request: {e}")}),
    };
    let id = req.get("id").and_then(Value::as_str).unwrap_or("?").to_string();

    let traces = match req.get("traces").and_then(Value::as_array) {
        Some(t) => t,
        None => return json!({"id": id, "error": "no traces"}),
    };

    // Activity ids follow first appearance, the same rule ProM uses, so that
    // any tie-break that falls back on id order lines up between the two.
    let mut ids: HashMap<&str, u32> = HashMap::new();
    let mut names: Vec<String> = Vec::new();
    let mut log = EventLog::new();
    for t in traces {
        let events: Vec<u32> = t
            .as_array()
            .map(|evs| {
                evs.iter()
                    .filter_map(Value::as_str)
                    .map(|name| {
                        *ids.entry(name).or_insert_with(|| {
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

    let variant = match req.get("variant").and_then(Value::as_str) {
        Some("IM") => Variant::IM,
        _ => Variant::IMf,
    };
    let params = Parameters {
        variant,
        noise_threshold: req
            .get("noiseThreshold")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        ..Parameters::default()
    };

    match discover(&log, &params) {
        Ok(d) => json!({
            "id": id,
            "raw": d.tree.render(&names, false),
            "canonical": d.tree.render(&names, true),
        }),
        Err(e) => json!({"id": id, "error": e.to_string()}),
    }
}
