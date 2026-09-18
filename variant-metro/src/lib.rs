//! Promenade wasm boundary for "Discover variant metro" — stage 2 of two.
//!
//! Stage 1 (`variants.py`, an internal pyodide action the host runs through
//! `scans`/`scanAction`) turns the OCEL into a *variant-attributed* OC-DFG:
//! an ordinary object-centric directly-follows graph in which every node and
//! every arc additionally records `minVariant`, the rank of the most frequent
//! variant it first appears in, plus its per-variant counts (`byVariant`).
//!
//! This stage lays that graph out. The layout is not reimplemented here: it
//! is `metro-map-core`'s, called exactly the way `plugins/metro-map`'s own
//! OC-DFG action calls it (`RankTiebreak::Frequency` by default, as the metro
//! map's own OC-DFG basis does) on the *complete* graph — every variant. The
//! only work this module does on top is to carry the variant attribution
//! across onto the laid-out nodes and edges, so the view's slider can filter
//! by "the k most frequent variants" against a layout that never moves.
//!
//! Attribution rides across by *reconstructing the ids* `metro-map-core`
//! mints (`station:{activity}`, `source:{ot}`, `sink:{ot}`,
//! `edge:{ot}:{from}:{to}`) rather than by patching the layout crate to
//! understand variants — that keeps the shared crate free of this plugin's
//! own concern, and is checked by `attribution_reaches_every_node_and_edge`
//! below rather than assumed.

use std::collections::{BTreeMap, HashMap};

use metro_map_core::{
    build_metro_map_from_ocdfg_with_rank_tiebreak, OcdfgEdge, OcdfgNode, OcdfgPayload, RankTiebreak,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use wasm_bindgen::prelude::*;

/// One `(object type, activity)` node of the variant-attributed OC-DFG.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VariantNode {
    object_type: String,
    activity: String,
    #[serde(default)]
    count: f64,
    #[serde(default)]
    starts: f64,
    #[serde(default)]
    ends: f64,
    /// Rank (1 = most frequent) of the first variant this node appears in.
    #[serde(default = "one")]
    min_variant: i64,
    /// `[rank, count, starts, ends]` per variant this node appears in,
    /// ascending by rank and sparse — a node absent from a variant has no
    /// entry for it, which is what makes the payload's size scale with the
    /// graph rather than with (variants × nodes).
    #[serde(default)]
    by_variant: Vec<Vec<f64>>,
}

/// One `(object type, src → dst)` arc of the variant-attributed OC-DFG.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VariantEdge {
    object_type: String,
    src: String,
    dst: String,
    #[serde(default)]
    freq: f64,
    #[serde(default)]
    avg_secs: Option<f64>,
    #[serde(default = "one")]
    min_variant: i64,
    /// `[rank, freq, secondsSum]` per variant, ascending and sparse. The sum
    /// (not the mean) is carried so the view can divide by the frequency of
    /// exactly the variants it is showing and get the true mean wait for
    /// *that* subset, which a stored mean could not give it.
    #[serde(default)]
    by_variant: Vec<Vec<f64>>,
}

fn one() -> i64 {
    1
}

/// Stage 1's whole output. `stats` and anything else is ignored by serde.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VariantDfgPayload {
    #[serde(default)]
    object_types: Vec<String>,
    #[serde(default)]
    nodes: Vec<VariantNode>,
    #[serde(default)]
    edges: Vec<VariantEdge>,
    /// One entry per slider position, most frequent variant first. Passed
    /// through to the view untouched — it is the slider's own scale.
    #[serde(default)]
    variants: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct ConvertParams {
    #[serde(rename = "inputValue")]
    input_value: VariantDfgPayload,
    #[serde(rename = "rankTiebreak", default = "frequency_tiebreak")]
    rank_tiebreak: RankTiebreak,
}

/// This plugin's whole point is the frequency reading of the process, so the
/// frequency tie-break is the default here even though `RankTiebreak`'s own
/// `Default` (kept for the metro map's older Petri-net basis) is structural.
fn frequency_tiebreak() -> RankTiebreak {
    RankTiebreak::Frequency
}

/// Per-node attribution, keyed by the node id `metro-map-core` will mint.
#[derive(Debug, Default, Clone, Serialize)]
struct NodeAttribution {
    #[serde(rename = "minVariant")]
    min_variant: i64,
    /// `rank -> count` for whichever count this node kind draws: occurrences
    /// for a station, starts for a ▶ source, ends for a ■ sink.
    #[serde(skip)]
    by_variant: BTreeMap<i64, f64>,
}

/// Per-edge attribution, keyed by the edge id `metro-map-core` will mint.
#[derive(Debug, Default, Clone)]
struct EdgeAttribution {
    min_variant: i64,
    /// `rank -> (frequency, seconds summed)`.
    by_variant: BTreeMap<i64, (f64, f64)>,
}

fn station_id(activity: &str) -> String {
    format!("station:{activity}")
}
fn source_id(object_type: &str) -> String {
    format!("source:{object_type}")
}
fn sink_id(object_type: &str) -> String {
    format!("sink:{object_type}")
}
/// Mirrors `metro-map-core`'s own `OutEdge.id` format.
fn edge_id(object_type: &str, from: &str, to: &str) -> String {
    format!("edge:{object_type}:{from}:{to}")
}

/// A ▶/■ marker that several activities start or end at gets a synthetic XOR
/// gateway spliced between the marker and those activities, and the arcs are
/// rewritten to run through it (`metro-map-core`'s "boundary split"). The
/// gateway is therefore an *alias* of its own boundary as far as variants are
/// concerned — it appears exactly when the boundary does — so attribution
/// looks up the boundary it stands for rather than needing a rule of its own.
/// Without this, every rewritten terminus arc came out unattributed and so
/// (by the always-visible fallback) showed at slider position 1 regardless of
/// which variant its activity actually first starts or ends in.
fn boundary_of(id: &str) -> &str {
    id.strip_prefix("gateway:boundary-split:").unwrap_or(id)
}

fn merge_min(slot: &mut NodeAttribution, rank: i64) {
    if slot.min_variant == 0 || rank < slot.min_variant {
        slot.min_variant = rank;
    }
}

/// Builds the id-keyed attribution tables for one payload.
///
/// A station is shared across object types, so its attribution is the *union*
/// over every `(object type, activity)` row for that activity: the earliest
/// variant any type reaches it in, and the summed per-variant counts. The ▶/■
/// termini and the arcs into and out of them are attributed from the same
/// rows' `starts`/`ends` columns, since that is exactly what the layout crate
/// synthesises them from.
fn attribution(
    payload: &VariantDfgPayload,
) -> (HashMap<String, NodeAttribution>, HashMap<String, EdgeAttribution>) {
    let mut nodes: HashMap<String, NodeAttribution> = HashMap::new();
    let mut edges: HashMap<String, EdgeAttribution> = HashMap::new();

    for n in &payload.nodes {
        let station = nodes.entry(station_id(&n.activity)).or_default();
        merge_min(station, n.min_variant);
        for row in &n.by_variant {
            let (rank, count) = (row.first().copied().unwrap_or(1.0) as i64, row.get(1).copied().unwrap_or(0.0));
            if count > 0.0 {
                *station.by_variant.entry(rank).or_default() += count;
            }
        }

        // ▶ / ■ termini and their arcs, from the starts/ends columns only.
        for (is_start, total) in [(true, n.starts), (false, n.ends)] {
            if total <= 0.0 {
                continue;
            }
            let boundary = if is_start { source_id(&n.object_type) } else { sink_id(&n.object_type) };
            let arc = if is_start {
                edge_id(&n.object_type, &boundary, &station_id(&n.activity))
            } else {
                edge_id(&n.object_type, &station_id(&n.activity), &boundary)
            };
            let column = if is_start { 2 } else { 3 };
            let mut first_rank = i64::MAX;
            let arc_slot = edges.entry(arc).or_default();
            let boundary_slot = nodes.entry(boundary).or_default();
            for row in &n.by_variant {
                let rank = row.first().copied().unwrap_or(1.0) as i64;
                let value = row.get(column).copied().unwrap_or(0.0);
                if value <= 0.0 {
                    continue;
                }
                first_rank = first_rank.min(rank);
                let entry = arc_slot.by_variant.entry(rank).or_default();
                entry.0 += value;
                *boundary_slot.by_variant.entry(rank).or_default() += value;
            }
            // A payload written before `byVariant` existed (or one whose
            // counts all landed outside it) still gets an honest floor from
            // the node's own `minVariant` rather than silently vanishing.
            let rank = if first_rank == i64::MAX { n.min_variant } else { first_rank };
            if arc_slot.min_variant == 0 || rank < arc_slot.min_variant {
                arc_slot.min_variant = rank;
            }
            merge_min(boundary_slot, rank);
        }
    }

    for e in &payload.edges {
        let slot = edges
            .entry(edge_id(&e.object_type, &station_id(&e.src), &station_id(&e.dst)))
            .or_default();
        if slot.min_variant == 0 || e.min_variant < slot.min_variant {
            slot.min_variant = e.min_variant;
        }
        for row in &e.by_variant {
            let rank = row.first().copied().unwrap_or(1.0) as i64;
            let entry = slot.by_variant.entry(rank).or_default();
            entry.0 += row.get(1).copied().unwrap_or(0.0);
            entry.1 += row.get(2).copied().unwrap_or(0.0);
        }
    }

    (nodes, edges)
}

fn to_ocdfg(payload: &VariantDfgPayload) -> OcdfgPayload {
    OcdfgPayload {
        object_types: payload.object_types.clone(),
        nodes: payload
            .nodes
            .iter()
            .map(|n| OcdfgNode {
                object_type: n.object_type.clone(),
                activity: n.activity.clone(),
                count: n.count,
                starts: n.starts,
                ends: n.ends,
            })
            .collect(),
        edges: payload
            .edges
            .iter()
            .map(|e| OcdfgEdge {
                object_type: e.object_type.clone(),
                src: e.src.clone(),
                dst: e.dst.clone(),
                freq: e.freq,
                avg_secs: e.avg_secs,
            })
            .collect(),
    }
}

/// The whole conversion: lay the complete graph out, then write the variant
/// attribution onto it. Returns the JSON value the view reads.
///
/// Kept as a plain `Value`-returning function (rather than a typed mirror of
/// `MetroMapPayload` with two extra fields) on purpose: every field
/// `metro-map-core` adds to its own payload from now on reaches the view
/// without this plugin having to grow a copy of it first.
fn build(payload: &VariantDfgPayload, rank_tiebreak: RankTiebreak) -> Value {
    let dfg = to_ocdfg(payload);
    let map = build_metro_map_from_ocdfg_with_rank_tiebreak(&dfg, &[], rank_tiebreak);
    let mut value = serde_json::to_value(&map).unwrap_or_else(|_| json!({}));
    let (node_attribution, edge_attribution) = attribution(payload);

    let positions = payload.variants.len() as i64;

    if let Some(nodes) = value.get_mut("nodes").and_then(Value::as_array_mut) {
        for node in nodes.iter_mut() {
            let id = node.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            // Unattributed (a node the layout synthesised from something this
            // payload cannot see) stays visible at every slider position
            // rather than disappearing at all of them.
            let found = node_attribution.get(boundary_of(&id));
            let min_variant = found.map(|a| a.min_variant.max(1)).unwrap_or(1);
            let object = match node.as_object_mut() {
                Some(o) => o,
                None => continue,
            };
            let meta = object
                .entry("meta".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if !meta.is_object() {
                *meta = Value::Object(Map::new());
            }
            let meta = meta.as_object_mut().expect("meta was just made an object");
            meta.insert("minVariant".to_string(), json!(min_variant));
            if let Some(a) = found {
                meta.insert(
                    "variantCounts".to_string(),
                    Value::Array(
                        a.by_variant
                            .iter()
                            .map(|(rank, count)| json!([rank, count]))
                            .collect(),
                    ),
                );
            }
        }
    }

    if let Some(edges) = value.get_mut("edges").and_then(Value::as_array_mut) {
        for edge in edges.iter_mut() {
            // Keyed off the endpoints rather than the id, so a boundary-split
            // rewrite resolves: an arc that now runs to the gateway is the
            // same arc that ran to the boundary, and the one stub arc between
            // the two (both ends alias to the same boundary) simply appears
            // when that boundary does.
            let object_type = edge.get("objectType").and_then(Value::as_str).unwrap_or("");
            let source = boundary_of(edge.get("source").and_then(Value::as_str).unwrap_or("")).to_string();
            let target = boundary_of(edge.get("target").and_then(Value::as_str).unwrap_or("")).to_string();
            let stub = source == target;
            let found = if stub {
                None
            } else {
                edge_attribution.get(&edge_id(object_type, &source, &target))
            };
            let boundary_stub = if stub { node_attribution.get(&source) } else { None };
            let found_min = found
                .map(|a| a.min_variant)
                .or_else(|| boundary_stub.map(|a| a.min_variant));
            let min_variant = found_min.map(|m| m.max(1)).unwrap_or(1);
            let object = match edge.as_object_mut() {
                Some(o) => o,
                None => continue,
            };
            object.insert("minVariant".to_string(), json!(min_variant));
            if let Some(a) = found {
                object.insert(
                    "variantFreq".to_string(),
                    Value::Array(
                        a.by_variant
                            .iter()
                            .map(|(rank, (freq, secs))| json!([rank, freq, secs]))
                            .collect(),
                    ),
                );
            } else if let Some(a) = boundary_stub {
                // The stub carries the whole boundary's traffic; it has no
                // wait time of its own (it is not an observed relation).
                object.insert(
                    "variantFreq".to_string(),
                    Value::Array(
                        a.by_variant
                            .iter()
                            .map(|(rank, count)| json!([rank, count, 0.0]))
                            .collect(),
                    ),
                );
            }
        }
    }

    if let Some(object) = value.as_object_mut() {
        object.insert("variantBasis".to_string(), json!(true));
        object.insert("variants".to_string(), Value::Array(payload.variants.clone()));
        object.insert("sliderPositions".to_string(), json!(positions));
        // `stats` rides into the artifact's `meta`, which is what the
        // Statistics panel shows and what a `showWhen` condition can read.
        if let Some(stats) = object.get_mut("stats").and_then(Value::as_object_mut) {
            stats.insert("sliderPositions".to_string(), json!(positions));
        }
    }

    value
}

/// The same conversion the wasm kernel performs, JSON in and JSON out.
///
/// Exists so the conversion can be driven without a browser: `cargo run
/// --example build_map` uses it to produce a real payload for the view's own
/// offline harness, which is the only way to exercise a *sandboxed* view's
/// rendering (a sandboxed frame is cross-origin to the page, so nothing can
/// reach into it from outside).
pub fn convert_json(payload: &str, rank_tiebreak: RankTiebreak) -> Result<String, serde_json::Error> {
    let parsed: VariantDfgPayload = serde_json::from_str(payload)?;
    serde_json::to_string(&build(&parsed, rank_tiebreak))
}

#[wasm_bindgen]
pub struct VariantMetroConvert;

#[wasm_bindgen]
impl VariantMetroConvert {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self
    }

    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: ConvertParams =
            serde_wasm_bindgen::from_value(params).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let value = build(&p.input_value, p.rank_tiebreak);
        // NOT `serde_wasm_bindgen::to_value`: its default serializer turns any
        // serde *map* into a JS `Map`, and a `serde_json::Value::Object` is a
        // map. The payload then crosses the boundary as a `Map` — which
        // structured-clones fine, so nothing fails loudly, but every consumer
        // reads plain properties: the host found no `stats` to copy into the
        // artifact's meta, and `JSON.stringify` of a `Map` is `{}`, so the
        // inline value would have persisted as an empty object. A payload
        // built from a struct (which is what `metro-map`'s own kernel
        // serializes) never hits this, which is exactly why it is easy to
        // walk into here.
        let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
        value
            .serialize(&serializer)
            .map_err(|e| JsValue::from_str(&e.to_string()))
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

impl Default for VariantMetroConvert {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> VariantDfgPayload {
        serde_json::from_value(json!({
            "objectTypes": ["item", "order"],
            "nodes": [
                { "objectType": "order", "activity": "place order", "count": 11.0, "starts": 11.0, "ends": 0.0,
                  "minVariant": 1, "byVariant": [[1, 6, 6, 0], [2, 3, 3, 0], [3, 2, 2, 0]] },
                { "objectType": "order", "activity": "pick item", "count": 11.0, "starts": 0.0, "ends": 0.0,
                  "minVariant": 1, "byVariant": [[1, 6, 0, 0], [2, 3, 0, 0], [3, 2, 0, 0]] },
                { "objectType": "order", "activity": "express check", "count": 3.0, "starts": 0.0, "ends": 0.0,
                  "minVariant": 2, "byVariant": [[2, 3, 0, 0]] },
                { "objectType": "order", "activity": "ship order", "count": 9.0, "starts": 0.0, "ends": 9.0,
                  "minVariant": 1, "byVariant": [[1, 6, 0, 6], [2, 3, 0, 3]] },
                // A second activity the same object type ends at, so the ■
                // marker really does get a boundary-split gateway spliced in
                // front of it (see `boundary_of`) — the case that produced
                // 31 unattributed arcs on a real log before it was handled.
                { "objectType": "order", "activity": "cancel order", "count": 2.0, "starts": 0.0, "ends": 2.0,
                  "minVariant": 3, "byVariant": [[3, 2, 0, 2]] },
                { "objectType": "item", "activity": "pick item", "count": 22.0, "starts": 22.0, "ends": 0.0,
                  "minVariant": 1, "byVariant": [[1, 12, 12, 0], [2, 6, 6, 0], [3, 4, 4, 0]] },
                { "objectType": "item", "activity": "ship order", "count": 18.0, "starts": 0.0, "ends": 18.0,
                  "minVariant": 1, "byVariant": [[1, 12, 0, 12], [2, 6, 0, 6]] }
            ],
            "edges": [
                { "objectType": "order", "src": "place order", "dst": "pick item", "freq": 11.0, "avgSecs": 1.0,
                  "minVariant": 1, "byVariant": [[1, 6, 6], [2, 3, 3], [3, 2, 2]] },
                { "objectType": "order", "src": "pick item", "dst": "express check", "freq": 3.0, "avgSecs": 2.0,
                  "minVariant": 2, "byVariant": [[2, 3, 6]] },
                { "objectType": "order", "src": "express check", "dst": "ship order", "freq": 3.0, "avgSecs": 1.0,
                  "minVariant": 2, "byVariant": [[2, 3, 3]] },
                { "objectType": "order", "src": "pick item", "dst": "ship order", "freq": 6.0, "avgSecs": 1.0,
                  "minVariant": 1, "byVariant": [[1, 6, 6]] },
                { "objectType": "item", "src": "pick item", "dst": "ship order", "freq": 18.0, "avgSecs": 3.0,
                  "minVariant": 1, "byVariant": [[1, 12, 36], [2, 6, 18]] },
                { "objectType": "order", "src": "pick item", "dst": "cancel order", "freq": 2.0, "avgSecs": 1.0,
                  "minVariant": 3, "byVariant": [[3, 2, 2]] }
            ],
            "variants": [
                { "rank": 1, "executions": 6, "share": 0.55 },
                { "rank": 2, "executions": 3, "share": 0.82 },
                { "rank": 3, "executions": 2, "share": 1.0 }
            ]
        }))
        .expect("fixture deserializes")
    }

    /// The one thing that could silently rot: `metro-map-core` changing how it
    /// mints an id would leave every node/edge unattributed — and, because an
    /// unattributed element defaults to "always visible", the slider would
    /// quietly stop filtering instead of failing. So assert coverage, not just
    /// that a couple of ids happen to match.
    #[test]
    fn attribution_reaches_every_node_and_edge() {
        let value = build(&payload(), RankTiebreak::Frequency);
        let nodes = value["nodes"].as_array().expect("nodes");
        let edges = value["edges"].as_array().expect("edges");
        assert!(!nodes.is_empty() && !edges.is_empty());
        // The fixture must keep exercising the boundary-split rewrite, or
        // this test stops covering the case it was written for.
        assert!(
            nodes.iter().any(|n| n["id"].as_str().unwrap_or("").starts_with("gateway:boundary-split:")),
            "fixture no longer produces a boundary-split gateway",
        );
        for node in nodes {
            assert!(
                node["meta"]["variantCounts"].is_array(),
                "node {} carries no variant counts — id format drifted?",
                node["id"]
            );
        }
        for edge in edges {
            assert!(
                edge["variantFreq"].is_array(),
                "edge {} carries no variant frequencies — id format drifted?",
                edge["id"]
            );
        }
    }

    /// The invariant the whole slider rests on: an element's first variant is
    /// never earlier than that of the elements it hangs off, so the filtered
    /// graph can only ever grow as the slider goes up, and never shows an arc
    /// whose endpoints are hidden.
    #[test]
    fn min_variant_is_monotone_along_every_edge() {
        let value = build(&payload(), RankTiebreak::Frequency);
        let min_of: HashMap<&str, i64> = value["nodes"]
            .as_array()
            .expect("nodes")
            .iter()
            .map(|n| {
                (
                    n["id"].as_str().expect("id"),
                    n["meta"]["minVariant"].as_i64().expect("minVariant"),
                )
            })
            .collect();
        for edge in value["edges"].as_array().expect("edges") {
            let rank = edge["minVariant"].as_i64().expect("minVariant");
            for end in ["source", "target"] {
                let id = edge[end].as_str().expect("endpoint");
                let node_rank = *min_of.get(id).expect("endpoint node exists");
                assert!(
                    node_rank <= rank,
                    "edge {} appears at variant {rank} but its {end} {id} only at {node_rank}",
                    edge["id"],
                );
            }
        }
    }

    /// Filtering at position k must reproduce the k most frequent variants —
    /// in particular k = 1 keeps only what the single most frequent variant
    /// contains, and the top position keeps everything.
    #[test]
    fn slider_positions_bracket_the_model() {
        let value = build(&payload(), RankTiebreak::Frequency);
        let visible_at = |k: i64| -> (usize, usize) {
            let nodes = value["nodes"]
                .as_array()
                .expect("nodes")
                .iter()
                .filter(|n| n["meta"]["minVariant"].as_i64().unwrap_or(1) <= k)
                .count();
            let edges = value["edges"]
                .as_array()
                .expect("edges")
                .iter()
                .filter(|e| e["minVariant"].as_i64().unwrap_or(1) <= k)
                .count();
            (nodes, edges)
        };
        let total = (
            value["nodes"].as_array().expect("nodes").len(),
            value["edges"].as_array().expect("edges").len(),
        );
        let (n1, e1) = visible_at(1);
        let (n2, e2) = visible_at(2);
        let (n3, e3) = visible_at(3);
        assert!(n1 < n2 && e1 < e2, "position 2 must reveal more than position 1");
        assert!(n2 <= n3 && e2 <= e3);
        assert_eq!((n3, e3), total, "the top position must show the whole model");
        // "express check" only exists in variant 2.
        let stations_at_1: Vec<&str> = value["nodes"]
            .as_array()
            .expect("nodes")
            .iter()
            .filter(|n| n["meta"]["minVariant"].as_i64().unwrap_or(1) <= 1)
            .filter_map(|n| n["activity"].as_str())
            .collect();
        assert!(!stations_at_1.contains(&"express check"));
        assert!(stations_at_1.contains(&"place order"));
    }

    /// The per-variant counts must add back up to the whole-model numbers the
    /// layout crate itself computed — otherwise the arc labels lie at the top
    /// of the slider, where they are most obviously checkable.
    #[test]
    fn per_variant_counts_sum_to_the_full_model() {
        let value = build(&payload(), RankTiebreak::Frequency);
        for edge in value["edges"].as_array().expect("edges") {
            let Some(total) = edge["frequency"].as_f64() else { continue };
            let summed: f64 = edge["variantFreq"]
                .as_array()
                .expect("variantFreq")
                .iter()
                .map(|row| row[1].as_f64().unwrap_or(0.0))
                .sum();
            assert!(
                (summed - total).abs() < 1e-6,
                "edge {} sums to {summed} but the model says {total}",
                edge["id"],
            );
        }
    }

    #[test]
    fn an_empty_payload_lays_out_without_panicking() {
        let empty: VariantDfgPayload = serde_json::from_value(json!({})).expect("defaults");
        let value = build(&empty, RankTiebreak::Frequency);
        assert_eq!(value["nodes"].as_array().map(Vec::len), Some(0));
        assert_eq!(value["sliderPositions"], json!(0));
    }
}
