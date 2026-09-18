//! Wasm-bindgen glue over `lpm-core`. Two kernels:
//!
//!   `LpmScan`   scan-finalize/1 — the discovery action (also reused,
//!               unmodified, by the object-centric `discover-oc` action,
//!               which just scans a different, internally-projected log).
//!   `LpmToNet`  value-finalize/1 — recompiles one ranked entry's tree back
//!               into a plain `AcceptingPetriNet`-shaped net (no backloop,
//!               activity names instead of ids) so the existing
//!               `petrinet-layered` view (or any other `AcceptingPetriNet`
//!               viewer already in the app) can render a single fragment
//!               without this plugin drawing its own Petri-net diagram.

use std::collections::HashMap;

use lpm_core::evaluator::LogStats;
use lpm_core::net::{compile, RawNet};
use lpm_core::tree::LpmTree;
use lpm_core::{LpmParams, Scores};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

fn now_ms() -> f64 {
    js_sys::Date::now()
}

// ------------------------------------------------------------- discovery ---

/// The full evaluated candidate pool from the last *structural* search —
/// everything above `frequencyMinimum`/`determinismMinimum`/etc under
/// whatever `numTransitions`/operator toggles were last used, kept
/// unsorted-by-weight (each entry's own `Scores.weighted_score` is stale the
/// moment weights change, but every other metric on it is not). Re-scored by
/// `LpmScan::finalize` whenever only the weight/topK params changed, so a
/// slider drag never re-runs the search or re-touches the log at all.
struct Cache {
    fingerprint: String,
    candidates: Vec<lpm_core::Candidate>,
    candidates_scored: u64,
    truncated_by_budget: bool,
}

#[wasm_bindgen]
pub struct LpmScan {
    n: usize,
    names: Vec<String>,
    traces: Vec<Vec<u32>>,
    cur: Vec<u32>,
    last_case: i64,
    have_last: bool,
    rows: u32,
    cases: u32,
    cache: Option<Cache>,
}

/// Everything that changes *which* candidates exist and pass their
/// thresholds — weights and `topK` are deliberately excluded (see `Cache`).
fn structural_fingerprint(p: &LpmParams) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        p.num_transitions, p.frequency_minimum, p.determinism_minimum, p.language_fit_minimum,
        p.confidence_minimum, p.coverage_minimum, p.duplicate_transitions, p.use_seq, p.use_xor,
        p.use_and, p.use_or, p.use_xor_loop, p.max_align_states, p.max_loop, p.max_search_millis,
    )
}

#[wasm_bindgen]
impl LpmScan {
    #[wasm_bindgen(constructor)]
    pub fn new(n_activities: usize) -> LpmScan {
        LpmScan {
            n: n_activities,
            names: Vec::new(),
            traces: Vec::new(),
            cur: Vec::new(),
            last_case: i64::MIN,
            have_last: false,
            rows: 0,
            cases: 0,
            cache: None,
        }
    }

    #[wasm_bindgen(js_name = setActivityNames)]
    pub fn set_activity_names(&mut self, names: Vec<String>) {
        self.names = names;
    }

    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, cases: &[i32], activities: &[i32]) {
        let len = cases.len().min(activities.len());
        for i in 0..len {
            let case = cases[i] as i64;
            let act = activities[i];
            if act < 0 || act as usize >= self.n {
                continue;
            }
            if self.have_last && self.last_case == case {
                self.cur.push(act as u32);
            } else {
                if self.have_last {
                    self.traces.push(std::mem::take(&mut self.cur));
                }
                self.cur.push(act as u32);
                self.cases += 1;
            }
            self.last_case = case;
            self.have_last = true;
        }
        self.rows += len as u32;
    }

    pub fn finish(&mut self) {
        if self.have_last {
            self.traces.push(std::mem::take(&mut self.cur));
            self.have_last = false;
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

    #[wasm_bindgen(js_name = finalize)]
    pub fn finalize(&mut self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: LpmParams = serde_wasm_bindgen::from_value(params)
            .map_err(|e| JsValue::from_str(&format!("bad params: {e}")))?;
        serde_wasm_bindgen::to_value(&self.discover(&p)).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultEntry {
    rank: usize,
    tree: lpm_core::LpmTreeJson,
    pretty: String,
    activities: Vec<String>,
    scores: Scores,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoverResult {
    entries: Vec<ResultEntry>,
    stats: DiscoverStats,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoverStats {
    total_cases: u32,
    total_events: u32,
    distinct_activities: usize,
    candidates_scored: u64,
    truncated_by_search_budget: bool,
    /// Set only when this is a `discover-oc` run — rides into the produced
    /// artifact's `meta.objectType`, which is how `combine-oc` later finds
    /// and groups the sibling per-type sets it merges. `None` (and so absent
    /// from `meta`) for the plain `discover` action.
    #[serde(skip_serializing_if = "Option::is_none")]
    object_type: Option<String>,
}

impl LpmScan {
    fn discover(&mut self, params: &LpmParams) -> DiscoverResult {
        let fingerprint = structural_fingerprint(params);
        let need_full_search = match &self.cache {
            Some(c) => c.fingerprint != fingerprint,
            None => true,
        };

        if need_full_search {
            // Group into variants — deterministically ordered (frequency,
            // then the sequence itself), same convention as `alignment-rs`.
            let mut groups: HashMap<&Vec<u32>, u64> = HashMap::new();
            for t in &self.traces {
                *groups.entry(t).or_insert(0) += 1;
            }
            let mut variants: Vec<(Vec<u32>, u64)> = groups.into_iter().map(|(t, c)| (t.clone(), c)).collect();
            variants.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

            let mut activity_counts = vec![0u64; self.n];
            let mut total_events = 0u64;
            for (trace, count) in &variants {
                total_events += trace.len() as u64 * count;
                for &a in trace {
                    activity_counts[a as usize] += count;
                }
            }

            let log = LogStats { variants: &variants, activity_counts: &activity_counts, total_events };

            let deadline_ms = now_ms() + params.max_search_millis as f64;
            let should_stop = || now_ms() >= deadline_ms;
            let out = lpm_core::search(self.n, &log, params, &should_stop);
            self.cache = Some(Cache {
                fingerprint,
                candidates: out.top,
                candidates_scored: out.candidates_scored,
                truncated_by_budget: out.truncated_by_budget,
            });
        }

        let cache = self.cache.as_ref().expect("populated just above when missing");
        let mut ranked: Vec<(&lpm_core::Candidate, f64)> = cache
            .candidates
            .iter()
            .map(|c| (c, lpm_core::reweight(&c.scores, &params.weights)))
            .collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        ranked.truncate(params.top_k.max(1));

        let entries = ranked
            .into_iter()
            .enumerate()
            .map(|(i, (c, weighted_score))| {
                let mut acts = Vec::new();
                c.tree.activities(&mut acts);
                acts.sort_unstable();
                acts.dedup();
                let names: Vec<String> = acts.iter().map(|&a| self.label(a)).collect();
                let mut scores = c.scores.clone();
                scores.weighted_score = weighted_score;
                ResultEntry {
                    rank: i,
                    pretty: c.tree.pretty(&self.names),
                    tree: c.tree.to_json(&self.names),
                    activities: names,
                    scores,
                }
            })
            .collect();

        DiscoverResult {
            entries,
            stats: DiscoverStats {
                total_cases: self.cases,
                total_events: self.rows,
                distinct_activities: self.n,
                candidates_scored: cache.candidates_scored,
                truncated_by_search_budget: cache.truncated_by_budget,
                object_type: params.object_type.clone(),
            },
        }
    }

    fn label(&self, a: u32) -> String {
        self.names.get(a as usize).cloned().unwrap_or_else(|| format!("activity {a}"))
    }
}

// -------------------------------------------------- convert one fragment ---

/// Mirrors the `AcceptingPetriNet` wire contract `plugins/petrinet-layered`
/// (and `heuristics-miner-rs`'s `PetriNet`) actually reads — snake_case
/// field names, **not** this crate's own camelCase convention:
/// `activities` is every transition index (`labelOf`/`buildElkGraph` in
/// `petrinet-layered/src/layout.ts` iterate it to place transition nodes at
/// all, sorted numerically), `labels[t] == None` is a silent transition,
/// `place_to_transition`/`transition_to_place` are `(place index, transition
/// index)` pairs. `places` only needs the right *length* (its own elements
/// are read as `unknown[]`) but carries real ids here for readability.
#[derive(Serialize)]
struct AcceptingNet {
    activities: Vec<u32>,
    labels: Vec<Option<String>>,
    places: Vec<NetPlace>,
    place_to_transition: Vec<(u32, u32)>,
    transition_to_place: Vec<(u32, u32)>,
    initial_marking: Vec<u32>,
    final_marking: Vec<u32>,
    start_activities: Vec<String>,
    end_activities: Vec<String>,
    stats: NetStats,
}

#[derive(Serialize)]
struct NetPlace {
    id: String,
    inputs: Vec<u32>,
    outputs: Vec<u32>,
    kind: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NetStats {
    transitions: usize,
    places: usize,
    arcs: usize,
    silent_transitions: usize,
}

/// The `LocalProcessModelSet` shape `LpmScan::discover` produced, just enough
/// of it for `LpmToNet`/`LpmToOcpn` to recompile one entry's tree. The two OC
/// fields are only ever present on an entry `run.promenade.lpm.combine-oc`
/// produced — see that action's `plugin.py`.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct SetEntry {
    tree: TreeJsonIn,
    object_types: Vec<String>,
    /// `(activity, objectType)` pairs the merge step flagged as variable —
    /// see `ObjectCentricLPMs`' statistical heuristic in `combine-oc`.
    variable_arcs: Vec<VariableArcIn>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VariableArcIn {
    activity: String,
    object_type: String,
}

impl Default for TreeJsonIn {
    fn default() -> Self {
        TreeJsonIn::Task { activity: String::new() }
    }
}

#[derive(Deserialize)]
struct SetIn {
    entries: Vec<SetEntry>,
}

/// Mirrors `lpm_core::tree::LpmTreeJson`'s wire shape (activity *names*, not
/// ids) for the round trip back into an `LpmTree` — see `to_lpm_tree`.
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum TreeJsonIn {
    Task { activity: String },
    Seq { children: Vec<TreeJsonIn> },
    Xor { children: Vec<TreeJsonIn> },
    And { children: Vec<TreeJsonIn> },
    Or { children: Vec<TreeJsonIn> },
    XorLoop { body: Box<TreeJsonIn> },
}

fn to_lpm_tree(json: &TreeJsonIn, ids: &mut Vec<String>) -> LpmTree {
    fn id_for(name: &str, ids: &mut Vec<String>) -> u32 {
        if let Some(i) = ids.iter().position(|n| n == name) {
            return i as u32;
        }
        ids.push(name.to_string());
        (ids.len() - 1) as u32
    }
    fn pair(children: &[TreeJsonIn], ids: &mut Vec<String>) -> (LpmTree, LpmTree) {
        // Every operator here is binary by construction (see `tree.rs`); a
        // manifest that somehow carried more children would only ever come
        // from this same plugin's own output, so taking the first two is a
        // defensive fallback, not a real code path.
        let l = to_lpm_tree(&children[0], ids);
        let r = to_lpm_tree(children.get(1).unwrap_or(&children[0]), ids);
        (l, r)
    }
    match json {
        TreeJsonIn::Task { activity } => LpmTree::Task(id_for(activity, ids)),
        TreeJsonIn::Seq { children } => { let (l, r) = pair(children, ids); LpmTree::Seq(Box::new(l), Box::new(r)) }
        TreeJsonIn::Xor { children } => { let (l, r) = pair(children, ids); LpmTree::Xor(Box::new(l), Box::new(r)) }
        TreeJsonIn::And { children } => { let (l, r) = pair(children, ids); LpmTree::And(Box::new(l), Box::new(r)) }
        TreeJsonIn::Or { children } => { let (l, r) = pair(children, ids); LpmTree::Or(Box::new(l), Box::new(r)) }
        TreeJsonIn::XorLoop { body } => LpmTree::XorLoop(Box::new(to_lpm_tree(body, ids))),
    }
}

fn raw_to_accepting_net(raw: &RawNet, names: &[String]) -> AcceptingNet {
    let mut inputs_by_place: Vec<Vec<u32>> = vec![Vec::new(); raw.place_count];
    let mut outputs_by_place: Vec<Vec<u32>> = vec![Vec::new(); raw.place_count];
    for &(p, t) in &raw.place_to_transition {
        outputs_by_place[p].push(t as u32); // this place feeds transition t
    }
    for &(t, p) in &raw.transition_to_place {
        inputs_by_place[p].push(t as u32); // this place is fed by transition t
    }
    let places = (0..raw.place_count)
        .map(|p| NetPlace {
            id: format!("p{p}"),
            inputs: inputs_by_place[p].clone(),
            outputs: outputs_by_place[p].clone(),
            kind: if p == raw.in_place { "initial" } else if p == raw.out_place { "final" } else { "derived" },
        })
        .collect();
    let labels: Vec<Option<String>> = raw.transitions.iter().map(|t| t.map(|a| names.get(a as usize).cloned().unwrap_or_else(|| format!("activity {a}")))).collect();
    let silent_transitions = labels.iter().filter(|l| l.is_none()).count();

    let start_activities = reachable_visible_from(raw, raw.in_place, true);
    let end_activities = reachable_visible_from(raw, raw.out_place, false);

    AcceptingNet {
        activities: (0..raw.transitions.len() as u32).collect(),
        place_to_transition: raw.place_to_transition.iter().map(|&(p, t)| (p as u32, t as u32)).collect(),
        transition_to_place: raw.transition_to_place.iter().map(|&(t, p)| (t as u32, p as u32)).collect(),
        initial_marking: vec![raw.in_place as u32],
        final_marking: vec![raw.out_place as u32],
        stats: NetStats { transitions: raw.transitions.len(), places: raw.place_count, arcs: raw.place_to_transition.len() + raw.transition_to_place.len(), silent_transitions },
        start_activities: start_activities.into_iter().map(|a| names.get(a as usize).cloned().unwrap_or_default()).collect(),
        end_activities: end_activities.into_iter().map(|a| names.get(a as usize).cloned().unwrap_or_default()).collect(),
        places,
        labels,
    }
}

/// BFS from `place` following (place -> transition) or (transition -> place)
/// edges in the given direction, through silent transitions only, collecting
/// the first visible activity reached on each branch.
fn reachable_visible_from(raw: &RawNet, place: usize, forward: bool) -> Vec<u32> {
    use std::collections::{HashSet, VecDeque};
    let mut seen_places = HashSet::new();
    let mut out = Vec::new();
    let mut queue = VecDeque::new();
    queue.push_back(place);
    seen_places.insert(place);
    while let Some(p) = queue.pop_front() {
        let edges: Vec<usize> = if forward {
            raw.place_to_transition.iter().filter(|&&(pp, _)| pp == p).map(|&(_, t)| t).collect()
        } else {
            raw.transition_to_place.iter().filter(|&&(_, pp)| pp == p).map(|&(t, _)| t).collect()
        };
        for t in edges {
            match raw.transitions[t] {
                Some(a) => out.push(a),
                None => {
                    let next_places: Vec<usize> = if forward {
                        raw.transition_to_place.iter().filter(|&&(tt, _)| tt == t).map(|&(_, p)| p).collect()
                    } else {
                        raw.place_to_transition.iter().filter(|&&(_, tt)| tt == t).map(|&(p, _)| p).collect()
                    };
                    for np in next_places {
                        if seen_places.insert(np) {
                            queue.push_back(np);
                        }
                    }
                }
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

#[wasm_bindgen]
pub struct LpmToNet;

#[wasm_bindgen]
impl LpmToNet {
    #[wasm_bindgen(constructor)]
    pub fn new() -> LpmToNet {
        LpmToNet
    }

    #[wasm_bindgen(js_name = finalize)]
    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        #[derive(Deserialize, Default)]
        #[serde(rename_all = "camelCase", default)]
        struct Params {
            input_value: Option<SetIn>,
            index: Option<usize>,
        }
        let p: Params = serde_wasm_bindgen::from_value(params).map_err(|e| JsValue::from_str(&format!("bad params: {e}")))?;
        let set = p.input_value.ok_or_else(|| JsValue::from_str("no local process model set selected"))?;
        let index = p.index.unwrap_or(0);
        let entry = set.entries.get(index).ok_or_else(|| JsValue::from_str(&format!("no entry at index {index}")))?;
        let mut names = Vec::new();
        let tree = to_lpm_tree(&entry.tree, &mut names);
        let raw = compile(&tree);
        let net = raw_to_accepting_net(&raw, &names);
        serde_wasm_bindgen::to_value(&net).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

// --------------------------------------- convert one object-centric entry ---

/// Every object type gets its own copy of the same fragment (places, and
/// silent transitions, namespaced per type via `ocpn_core::internal_place_id`
/// / `silent_transition_id`); every *visible* transition is shared across all
/// of them (`transition_id_for_activity`) — this plugin only ever merges
/// entries that are structurally identical across the types they were found
/// in (see `combine-oc/plugin.py`), so "each type's own copy of the fragment"
/// is exactly what a merged entry means, not an approximation of it.
fn raw_to_ocpn(raw: &RawNet, names: &[String], object_types: &[String], variable: &std::collections::HashSet<(String, String)>) -> ocpn_core::ObjectCentricPetriNet {
    use ocpn_core::{internal_place_id, silent_transition_id, sink_place_id, source_place_id, transition_id_for_activity};
    use ocpn_core::{Arc as OcpnArc, NodeRef, Place, PlaceKind, Transition};
    use std::collections::BTreeMap;

    let mut transitions: BTreeMap<String, Transition> = BTreeMap::new();
    for t in &raw.transitions {
        if let Some(a) = t {
            let label = names.get(*a as usize).cloned().unwrap_or_else(|| format!("activity {a}"));
            let id = transition_id_for_activity(&label);
            transitions.entry(id.clone()).or_insert_with(|| Transition { id, activity: Some(label), object_types: object_types.to_vec() });
        }
    }

    let mut places = Vec::new();
    let mut arcs = Vec::new();
    let mut arc_ordinal = 0usize;

    for ot in object_types {
        // Per-type silent transition ids, keyed by this raw net's transition
        // index so every arc referencing it agrees on the same id.
        let mut silent_id_of: std::collections::HashMap<usize, String> = std::collections::HashMap::new();
        let mut silent_ordinal = 0usize;
        for (ti, t) in raw.transitions.iter().enumerate() {
            if t.is_none() {
                let id = silent_transition_id(ot, silent_ordinal);
                silent_ordinal += 1;
                transitions.entry(id.clone()).or_insert_with(|| Transition { id: id.clone(), activity: None, object_types: vec![ot.clone()] });
                silent_id_of.insert(ti, id);
            }
        }
        let transition_id_of = |ti: usize| -> String {
            match raw.transitions[ti] {
                Some(a) => transition_id_for_activity(&names.get(a as usize).cloned().unwrap_or_else(|| format!("activity {a}"))),
                None => silent_id_of[&ti].clone(),
            }
        };
        let activity_of = |ti: usize| -> Option<String> {
            raw.transitions[ti].map(|a| names.get(a as usize).cloned().unwrap_or_else(|| format!("activity {a}")))
        };

        for p in 0..raw.place_count {
            let id = if p == raw.in_place { source_place_id(ot) } else if p == raw.out_place { sink_place_id(ot) } else { internal_place_id(ot, p) };
            places.push(Place { id, object_type: ot.clone(), kind: if p == raw.in_place { PlaceKind::Source } else if p == raw.out_place { PlaceKind::Sink } else { PlaceKind::Normal } });
        }
        for &(p, ti) in &raw.place_to_transition {
            let place_id = if p == raw.in_place { source_place_id(ot) } else if p == raw.out_place { sink_place_id(ot) } else { internal_place_id(ot, p) };
            let is_variable = activity_of(ti).map(|a| variable.contains(&(a, ot.clone()))).unwrap_or(false);
            arcs.push(OcpnArc { id: format!("a:{ot}:{arc_ordinal}"), source: NodeRef::Place { id: place_id }, target: NodeRef::Transition { id: transition_id_of(ti) }, object_type: ot.clone(), variable: is_variable });
            arc_ordinal += 1;
        }
        for &(ti, p) in &raw.transition_to_place {
            let place_id = if p == raw.in_place { source_place_id(ot) } else if p == raw.out_place { sink_place_id(ot) } else { internal_place_id(ot, p) };
            let is_variable = activity_of(ti).map(|a| variable.contains(&(a, ot.clone()))).unwrap_or(false);
            arcs.push(OcpnArc { id: format!("a:{ot}:{arc_ordinal}"), source: NodeRef::Transition { id: transition_id_of(ti) }, target: NodeRef::Place { id: place_id }, object_type: ot.clone(), variable: is_variable });
            arc_ordinal += 1;
        }
    }

    ocpn_core::ObjectCentricPetriNet {
        object_types: object_types.to_vec(),
        places,
        transitions: transitions.into_values().collect(),
        arcs,
        metadata: ocpn_core::Metadata {
            per_object_type: BTreeMap::new(),
            skipped_object_types: Vec::new(),
            parameters: ocpn_core::DiscoveryParametersEcho { variant: "LPM", noise_threshold: 0.0, object_types: object_types.to_vec() },
            activities_dropped: 0,
        },
    }
}

#[wasm_bindgen]
pub struct LpmToOcpn;

#[wasm_bindgen]
impl LpmToOcpn {
    #[wasm_bindgen(constructor)]
    pub fn new() -> LpmToOcpn {
        LpmToOcpn
    }

    #[wasm_bindgen(js_name = finalize)]
    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        #[derive(Deserialize, Default)]
        #[serde(rename_all = "camelCase", default)]
        struct Params {
            input_value: Option<SetIn>,
            index: Option<usize>,
        }
        let p: Params = serde_wasm_bindgen::from_value(params).map_err(|e| JsValue::from_str(&format!("bad params: {e}")))?;
        let set = p.input_value.ok_or_else(|| JsValue::from_str("no local process model set selected"))?;
        let index = p.index.unwrap_or(0);
        let entry = set.entries.get(index).ok_or_else(|| JsValue::from_str(&format!("no entry at index {index}")))?;
        if entry.object_types.is_empty() {
            return Err(JsValue::from_str("this entry is not an object-centric fragment — run \"Local Process Models: combine across object types\" first"));
        }
        let mut names = Vec::new();
        let tree = to_lpm_tree(&entry.tree, &mut names);
        let raw = compile(&tree);
        let variable: std::collections::HashSet<(String, String)> =
            entry.variable_arcs.iter().map(|v| (v.activity.clone(), v.object_type.clone())).collect();
        let net = raw_to_ocpn(&raw, &names, &entry.object_types, &variable);
        serde_wasm_bindgen::to_value(&net).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}
