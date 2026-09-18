//! Heuristics Miner — event log to a causal net.
//!
//! Weijters, van der Aalst & de Medeiros' Flexible Heuristics Miner:
//! noise-tolerant discovery via a *dependency measure* over the
//! directly-follows matrix, rather than Alpha Miner's exact footprint
//! relations (which one contradicting trace can throw off entirely). The
//! scan stage is the same shape as Alpha Miner's and dfg-rs's: one ordered
//! pass building an n×n directly-follows matrix.
//!
//!   scan (push_chunk/finish)   one pass over the event stream, builds the
//!                              directly-follows matrix and start/end sets.
//!                              Expensive, parameter-independent, cached.
//!   mine(threshold, minFreq)   derives the dependency graph and AND/XOR
//!                              grouping. Runs on an n×n matrix, so it is
//!                              cheap enough to drive from a slider.
//!
//! The primary action returns a **causal net**, the representation Heuristics
//! Miner derives directly. A companion action converts those AND/XOR groups
//! into an accepting Petri net with explicit silent routing transitions, so
//! the discovered model can also feed alignment and Petri-net tooling.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use wasm_bindgen::prelude::*;

/// Not a correctness bound like Alpha Miner's 64 (no bitmask here) — just a
/// sanity cap so a pathological log can't make the O(n²) relation pass hang
/// the worker. The host filters to the most frequent activities first.
pub const MAX_ACTIVITIES: usize = 1000;

#[derive(Serialize)]
pub struct CausalEdge {
    pub s: u32,
    pub d: u32,
    pub freq: u32,
    pub dependency: f64,
    /// Group index among `s`'s outgoing edges. Edges sharing a group are
    /// alternatives to one another (XOR); edges in different groups fire
    /// together whenever `s` does (AND) — see `docs/algorithm.md`.
    pub split_group: u32,
    /// Same idea for `d`'s incoming edges: shared group = any one predecessor
    /// enables `d` (XOR-join); different groups = `d` needs all of them (AND-join).
    pub join_group: u32,
}

#[derive(Serialize)]
pub struct CausalNet {
    pub activities: Vec<u32>,
    pub edges: Vec<CausalEdge>,
    pub start_activities: Vec<u32>,
    pub end_activities: Vec<u32>,
    pub activity_counts: Vec<u32>,
    pub stats: Stats,
}

#[derive(Serialize)]
pub struct Stats {
    pub activities: usize,
    pub edges: usize,
    pub and_splits: usize,
    pub and_joins: usize,
    pub dependency_threshold: f64,
    pub min_frequency: u32,
    pub truncated: bool,
}

/// A place in Promenade's standard AcceptingPetriNet interchange shape.
#[derive(Serialize)]
pub struct PetriPlace {
    pub id: String,
    pub inputs: Vec<u32>,
    pub outputs: Vec<u32>,
    pub kind: &'static str,
}

/// Causal-net-to-Petri-net conversion result. `labels[t] == None` denotes a
/// silent transition, matching the shape produced by Inductive Miner and the
/// PNML importer.
#[derive(Serialize)]
pub struct PetriNet {
    pub activities: Vec<u32>,
    pub labels: Vec<Option<String>>,
    pub places: Vec<PetriPlace>,
    pub place_to_transition: Vec<(u32, u32)>,
    pub transition_to_place: Vec<(u32, u32)>,
    pub initial_marking: Vec<u32>,
    pub final_marking: Vec<u32>,
    pub start_activities: Vec<u32>,
    pub end_activities: Vec<u32>,
    pub activity_counts: Vec<u32>,
    pub stats: PetriStats,
}

#[derive(Serialize)]
pub struct PetriStats {
    pub activities: usize,
    pub transitions: usize,
    pub places: usize,
    pub arcs: usize,
    pub silent_transitions: usize,
    pub and_splits: usize,
    pub and_joins: usize,
    pub dependency_threshold: f64,
    pub min_frequency: u32,
    pub truncated: bool,
}

/// One pass over the ordered event stream, accumulating what the miner needs.
/// Identical shape to Alpha Miner's `AlphaScan` — same ABI, same data.
#[wasm_bindgen]
pub struct HeuristicsScan {
    n: usize,
    /// df[a * n + b] = how often a is directly followed by b
    df: Vec<u32>,
    starts: Vec<u32>,
    ends: Vec<u32>,
    counts: Vec<u32>,
    names: Vec<String>,

    last_case: i64,
    last_act: u32,
    have_last: bool,
    rows: u32,
    cases: u32,
    truncated: bool,
}

#[wasm_bindgen]
impl HeuristicsScan {
    #[wasm_bindgen(constructor)]
    pub fn new(n_activities: usize) -> HeuristicsScan {
        let truncated = n_activities > MAX_ACTIVITIES;
        let n = n_activities.min(MAX_ACTIVITIES);
        HeuristicsScan {
            n,
            df: vec![0; n * n],
            starts: vec![0; n],
            ends: vec![0; n],
            counts: vec![0; n],
            names: Vec::new(),
            last_case: i64::MIN,
            last_act: 0,
            have_last: false,
            rows: 0,
            cases: 0,
            truncated,
        }
    }

    /// Optional labels in the activity-id order assigned by the host.
    #[wasm_bindgen(js_name = setActivityNames)]
    pub fn set_activity_names(&mut self, names: Vec<String>) {
        self.names = names;
    }

    /// Ordered by (case, timestamp). The host guarantees that with an ORDER BY.
    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, cases: &[i32], activities: &[i32]) {
        let len = cases.len().min(activities.len());
        for i in 0..len {
            let case = cases[i] as i64;
            let act = activities[i];
            if act < 0 || act as usize >= self.n {
                continue; // filtered out by the host's activity selection
            }
            let act = act as u32;
            self.counts[act as usize] += 1;

            if self.have_last && self.last_case == case {
                self.df[self.last_act as usize * self.n + act as usize] += 1;
            } else {
                if self.have_last {
                    self.ends[self.last_act as usize] += 1;
                }
                self.starts[act as usize] += 1;
                self.cases += 1;
            }
            self.last_case = case;
            self.last_act = act;
            self.have_last = true;
        }
        self.rows += len as u32;
    }

    pub fn finish(&mut self) {
        if self.have_last {
            self.ends[self.last_act as usize] += 1;
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

    /// The cheap stage: dependency graph, AND/XOR grouping, causal net.
    ///
    /// The host's WASM kernel ABI:
    ///
    ///   new Kernel(nActivities)
    ///   .pushChunk(Int32Array cases, Int32Array activities)
    ///   .finish()
    ///   .finalize(params) -> result
    ///   .free()
    #[wasm_bindgen(js_name = finalize)]
    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: Params = serde_wasm_bindgen::from_value(params)
            .map_err(|e| JsValue::from_str(&format!("bad params: {e}")))?;
        serde_wasm_bindgen::to_value(&self.mine_net(
            p.min_frequency.unwrap_or(1),
            p.dependency_threshold.unwrap_or(0.9),
            p.relative_to_best.unwrap_or(0.05),
        ))
        .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Params {
    min_frequency: Option<u32>,
    dependency_threshold: Option<f64>,
    relative_to_best: Option<f64>,
}

impl HeuristicsScan {
    /// The algorithm proper, free of wasm-bindgen types so it can be tested.
    pub fn mine_net(
        &self,
        min_frequency: u32,
        dependency_threshold: f64,
        relative_to_best: f64,
    ) -> CausalNet {
        let n = self.n;

        // The dependency measure (Weijters et al.): close to 1 means "a is
        // consistently, almost always, directly followed by b and (almost)
        // never the other way round". The self-loop variant has no b→a term
        // since a→a and a→a mean the same direction.
        let dep = |a: usize, b: usize| -> f64 {
            let ab = self.df[a * n + b] as f64;
            if a == b {
                return ab / (ab + 1.0);
            }
            let ba = self.df[b * n + a] as f64;
            (ab - ba) / (ab + ba + 1.0)
        };

        let mut edges: Vec<(usize, usize, f64)> = Vec::new();
        for a in 0..n {
            for b in 0..n {
                if self.df[a * n + b] == 0 {
                    continue;
                }
                edges.push((a, b, dep(a, b)));
            }
        }

        let mut kept = vec![false; edges.len()];
        for (i, &(a, b, d)) in edges.iter().enumerate() {
            if self.df[a * n + b] >= min_frequency && d >= dependency_threshold {
                kept[i] = true;
            }
        }

        // "All activities connected": an activity threshold would otherwise
        // strand — no surviving outgoing edge and it isn't an end activity,
        // or no surviving incoming edge and it isn't a start activity — keeps
        // its single strongest candidate anyway, within `relative_to_best` of
        // the threshold. An isolated node is a worse failure than one
        // under-strength edge; ProM's Flexible Heuristics Miner applies the
        // same heuristic for the same reason.
        let best_for = |edges: &[(usize, usize, f64)],
                        pick: fn(&(usize, usize, f64)) -> usize,
                        node: usize| {
            edges
                .iter()
                .enumerate()
                .filter(|(_, e)| pick(e) == node)
                .max_by(|(_, a), (_, b)| a.2.partial_cmp(&b.2).unwrap())
                .map(|(i, _)| i)
        };
        for a in 0..n {
            if self.ends[a] > 0 {
                continue;
            }
            if (0..edges.len()).any(|i| kept[i] && edges[i].0 == a) {
                continue;
            }
            if let Some(i) = best_for(&edges, |e| e.0, a) {
                if edges[i].2 >= dependency_threshold - relative_to_best {
                    kept[i] = true;
                }
            }
        }
        for b in 0..n {
            if self.starts[b] > 0 {
                continue;
            }
            if (0..edges.len()).any(|i| kept[i] && edges[i].1 == b) {
                continue;
            }
            if let Some(i) = best_for(&edges, |e| e.1, b) {
                if edges[i].2 >= dependency_threshold - relative_to_best {
                    kept[i] = true;
                }
            }
        }

        let kept_edges: Vec<(usize, usize, f64)> = edges
            .iter()
            .zip(kept.iter())
            .filter(|(_, &k)| k)
            .map(|(&e, _)| e)
            .collect();

        // AND-clustering: two of a node's neighbours are concurrent branches
        // exactly when the log sees traffic *in both directions* between
        // them — real concurrency gets serialised arbitrarily by whatever
        // timestamp granularity the log has, so a truly parallel b and c
        // show up as b→c in some cases and c→b in others. That is Alpha
        // Miner's `∥` relation, not its `#`: two activities that never
        // appear adjacent *at all* are not concurrent, they are simply two
        // alternatives that happen never to have been observed back to
        // back — those, like any one-directional (causally related) pair,
        // belong in the same XOR group, the conservative reading whenever
        // block structure is unclear.
        let concurrent = |a: usize, b: usize| self.df[a * n + b] > 0 && self.df[b * n + a] > 0;
        let group_of = |members: &[usize]| -> Vec<u32> {
            let m = members.len();
            let mut group = vec![u32::MAX; m];
            let mut next = 0u32;
            for i in 0..m {
                if group[i] != u32::MAX {
                    continue;
                }
                let mut stack = vec![i];
                group[i] = next;
                while let Some(x) = stack.pop() {
                    for y in 0..m {
                        if group[y] != u32::MAX {
                            continue;
                        }
                        if !concurrent(members[x], members[y]) {
                            group[y] = next;
                            stack.push(y);
                        }
                    }
                }
                next += 1;
            }
            group
        };

        let mut and_splits = 0usize;
        let mut and_joins = 0usize;
        let mut split_group: HashMap<(usize, usize), u32> = HashMap::new();
        for a in 0..n {
            let succs: Vec<usize> = kept_edges
                .iter()
                .filter(|e| e.0 == a)
                .map(|e| e.1)
                .collect();
            if succs.len() < 2 {
                for &b in &succs {
                    split_group.insert((a, b), 0);
                }
                continue;
            }
            let g = group_of(&succs);
            let distinct: HashSet<u32> = g.iter().copied().collect();
            if distinct.len() > 1 {
                and_splits += 1;
            }
            for (b, gi) in succs.iter().zip(g.iter()) {
                split_group.insert((a, *b), *gi);
            }
        }
        let mut join_group: HashMap<(usize, usize), u32> = HashMap::new();
        for b in 0..n {
            let preds: Vec<usize> = kept_edges
                .iter()
                .filter(|e| e.1 == b)
                .map(|e| e.0)
                .collect();
            if preds.len() < 2 {
                for &a in &preds {
                    join_group.insert((a, b), 0);
                }
                continue;
            }
            let g = group_of(&preds);
            let distinct: HashSet<u32> = g.iter().copied().collect();
            if distinct.len() > 1 {
                and_joins += 1;
            }
            for (a, gi) in preds.iter().zip(g.iter()) {
                join_group.insert((*a, b), *gi);
            }
        }

        let edges_out: Vec<CausalEdge> = kept_edges
            .iter()
            .map(|&(a, b, d)| CausalEdge {
                s: a as u32,
                d: b as u32,
                freq: self.df[a * n + b],
                dependency: d,
                split_group: *split_group.get(&(a, b)).unwrap_or(&0),
                join_group: *join_group.get(&(a, b)).unwrap_or(&0),
            })
            .collect();

        let activities: Vec<u32> = (0..n as u32)
            .filter(|&a| self.counts[a as usize] > 0)
            .collect();
        let start_activities: Vec<u32> = (0..n as u32)
            .filter(|&a| self.starts[a as usize] > 0)
            .collect();
        let end_activities: Vec<u32> = (0..n as u32)
            .filter(|&a| self.ends[a as usize] > 0)
            .collect();

        CausalNet {
            stats: Stats {
                activities: activities.len(),
                edges: edges_out.len(),
                and_splits,
                and_joins,
                dependency_threshold,
                min_frequency,
                truncated: self.truncated,
            },
            activities,
            start_activities,
            end_activities,
            activity_counts: self.counts.clone(),
            edges: edges_out,
        }
    }
}

impl CausalNet {
    /// Turns each causal edge into a silent router between its source's split
    /// place and its target's join place. One split place per `(activity,
    /// split_group)` makes different groups fire together (AND) while several
    /// routers from one place compete for its one token (XOR). Join places are
    /// dual: the visible transition needs a token from every join group, but
    /// any router in one group may supply that token.
    fn to_petri_net(&self, names: &[String]) -> PetriNet {
        let visible_slots = self.activity_counts.len();
        let silent_base = visible_slots as u32;
        let mut labels = vec![None; visible_slots + self.edges.len()];
        for &activity in &self.activities {
            let id = activity as usize;
            labels[id] = Some(
                names
                    .get(id)
                    .cloned()
                    .unwrap_or_else(|| format!("#{activity}")),
            );
        }

        let mut activities = self.activities.clone();
        activities.extend((0..self.edges.len()).map(|i| silent_base + i as u32));

        let mut places = Vec::new();
        let mut place_to_transition = Vec::new();
        let mut transition_to_place = Vec::new();

        // One initial token chooses among observed start activities.
        places.push(PetriPlace {
            id: "i".into(),
            inputs: vec![],
            outputs: self.start_activities.clone(),
            kind: "initial",
        });
        for &activity in &self.start_activities {
            place_to_transition.push((0, activity));
        }

        let mut splits: BTreeMap<(u32, u32), Vec<usize>> = BTreeMap::new();
        let mut joins: BTreeMap<(u32, u32), Vec<usize>> = BTreeMap::new();
        for (edge_index, edge) in self.edges.iter().enumerate() {
            splits
                .entry((edge.s, edge.split_group))
                .or_default()
                .push(edge_index);
            joins
                .entry((edge.d, edge.join_group))
                .or_default()
                .push(edge_index);
        }

        for ((source, group), edge_indices) in splits {
            let index = places.len() as u32;
            let silent_outputs = edge_indices
                .iter()
                .map(|&i| silent_base + i as u32)
                .collect();
            places.push(PetriPlace {
                id: format!("split_{source}_{group}"),
                inputs: vec![source],
                outputs: silent_outputs,
                kind: "derived",
            });
            transition_to_place.push((source, index));
            for edge_index in edge_indices {
                place_to_transition.push((index, silent_base + edge_index as u32));
            }
        }

        for ((target, group), edge_indices) in joins {
            let index = places.len() as u32;
            let silent_inputs = edge_indices
                .iter()
                .map(|&i| silent_base + i as u32)
                .collect();
            places.push(PetriPlace {
                id: format!("join_{target}_{group}"),
                inputs: silent_inputs,
                outputs: vec![target],
                kind: "derived",
            });
            for edge_index in edge_indices {
                transition_to_place.push((silent_base + edge_index as u32, index));
            }
            place_to_transition.push((index, target));
        }

        // The source causal net has no separate end grouping, so distinct
        // observed terminal activities are alternatives at this boundary.
        let final_index = places.len() as u32;
        places.push(PetriPlace {
            id: "o".into(),
            inputs: self.end_activities.clone(),
            outputs: vec![],
            kind: "final",
        });
        for &activity in &self.end_activities {
            transition_to_place.push((activity, final_index));
        }

        let mut activity_counts = self.activity_counts.clone();
        activity_counts.extend(std::iter::repeat_n(0, self.edges.len()));
        let arcs = place_to_transition.len() + transition_to_place.len();
        PetriNet {
            activities,
            labels,
            places,
            place_to_transition,
            transition_to_place,
            initial_marking: vec![0],
            final_marking: vec![final_index],
            start_activities: self.start_activities.clone(),
            end_activities: self.end_activities.clone(),
            activity_counts,
            stats: PetriStats {
                activities: self.activities.len(),
                transitions: visible_slots + self.edges.len(),
                places: final_index as usize + 1,
                arcs,
                silent_transitions: self.edges.len(),
                and_splits: self.stats.and_splits,
                and_joins: self.stats.and_joins,
                dependency_threshold: self.stats.dependency_threshold,
                min_frequency: self.stats.min_frequency,
                truncated: self.stats.truncated,
            },
        }
    }
}

/// Same scan as `HeuristicsScan`, with the Petri-net conversion as its cheap
/// final stage. Keeping it as a second WASM class lets the package expose two
/// independently selectable actions without teaching the generic host runtime
/// about a Heuristics-Miner-specific result switch.
#[wasm_bindgen]
pub struct HeuristicsPetriScan {
    inner: HeuristicsScan,
}

#[wasm_bindgen]
impl HeuristicsPetriScan {
    #[wasm_bindgen(constructor)]
    pub fn new(n_activities: usize) -> HeuristicsPetriScan {
        HeuristicsPetriScan {
            inner: HeuristicsScan::new(n_activities),
        }
    }

    #[wasm_bindgen(js_name = setActivityNames)]
    pub fn set_activity_names(&mut self, names: Vec<String>) {
        self.inner.set_activity_names(names);
    }

    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, cases: &[i32], activities: &[i32]) {
        self.inner.push_chunk(cases, activities);
    }

    pub fn finish(&mut self) {
        self.inner.finish();
    }

    #[wasm_bindgen(js_name = rowCount)]
    pub fn row_count(&self) -> u32 {
        self.inner.row_count()
    }

    #[wasm_bindgen(js_name = caseCount)]
    pub fn case_count(&self) -> u32 {
        self.inner.case_count()
    }

    #[wasm_bindgen(js_name = finalize)]
    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: Params = serde_wasm_bindgen::from_value(params)
            .map_err(|e| JsValue::from_str(&format!("bad params: {e}")))?;
        let causal = self.inner.mine_net(
            p.min_frequency.unwrap_or(1),
            p.dependency_threshold.unwrap_or(0.9),
            p.relative_to_best.unwrap_or(0.05),
        );
        serde_wasm_bindgen::to_value(&causal.to_petri_net(&self.inner.names))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(traces: &[Vec<usize>], n: usize) -> HeuristicsScan {
        let mut s = HeuristicsScan::new(n);
        for (case, tr) in traces.iter().enumerate() {
            let cases: Vec<i32> = vec![case as i32; tr.len()];
            let acts: Vec<i32> = tr.iter().map(|&a| a as i32).collect();
            s.push_chunk(&cases, &acts);
        }
        s.finish();
        s
    }

    fn has_edge(net: &CausalNet, s: u32, d: u32) -> bool {
        net.edges.iter().any(|e| e.s == s && e.d == d)
    }

    /// A strict sequence must yield exactly the chain a→b→c, no AND/XOR.
    #[test]
    fn simple_sequence() {
        let net = scan(&vec![vec![0, 1, 2]; 10], 3).mine_net(1, 0.9, 0.05);
        assert_eq!(net.edges.len(), 2);
        assert!(has_edge(&net, 0, 1));
        assert!(has_edge(&net, 1, 2));
        assert_eq!(net.stats.and_splits, 0);
        assert_eq!(net.stats.and_joins, 0);
    }

    #[test]
    fn converts_causal_edges_to_silent_routing_transitions() {
        let mut scanner = scan(&vec![vec![0, 1, 2]; 10], 3);
        scanner.set_activity_names(vec!["A".into(), "B".into(), "C".into()]);
        let net = scanner.mine_net(1, 0.9, 0.05).to_petri_net(&scanner.names);
        assert_eq!(
            net.labels,
            vec![
                Some("A".into()),
                Some("B".into()),
                Some("C".into()),
                None,
                None
            ]
        );
        assert_eq!(net.stats.silent_transitions, 2);
        assert!(net.places.iter().any(|p| p.id == "split_0_0"));
        assert!(net.places.iter().any(|p| p.id == "join_1_0"));
        assert!(net.transition_to_place.contains(&(0, 1)));
        assert!(net.place_to_transition.contains(&(1, 3)));
    }

    #[test]
    fn conversion_keeps_and_split_as_separate_token_places() {
        let mut traces = vec![vec![0, 1, 2, 3]; 5];
        traces.extend(vec![vec![0, 2, 1, 3]; 5]);
        let causal = scan(&traces, 4).mine_net(1, 0.8, 0.05);
        let net = causal.to_petri_net(&[]);
        assert_eq!(
            net.places
                .iter()
                .filter(|p| p.id.starts_with("split_0_"))
                .count(),
            2
        );
        assert_eq!(net.stats.and_splits, 1);
    }

    /// a always followed by both b and c (any order), never b→c or c→b:
    /// a genuine AND-split. b and c never following each other is exactly
    /// the concurrency signal.
    #[test]
    fn detects_and_split() {
        let mut traces = vec![vec![0, 1, 2, 3]; 5]; // a b c d
        traces.extend(vec![vec![0, 2, 1, 3]; 5]); // a c b d
                                                  // dep(0,1) and dep(0,2) are both 5/6 ≈ 0.833 — a's split is a genuine
                                                  // 50/50 either-order tie, which no dependency measure reports as 1.0,
                                                  // so the threshold has to admit that to test the grouping itself
                                                  // rather than the "keep the graph connected" fallback.
        let net = scan(&traces, 4).mine_net(1, 0.8, 0.05);
        assert!(has_edge(&net, 0, 1) && has_edge(&net, 0, 2));
        let g1 = net
            .edges
            .iter()
            .find(|e| e.s == 0 && e.d == 1)
            .unwrap()
            .split_group;
        let g2 = net
            .edges
            .iter()
            .find(|e| e.s == 0 && e.d == 2)
            .unwrap()
            .split_group;
        assert_ne!(g1, g2, "b and c should be different (AND) groups from a");
        assert_eq!(net.stats.and_splits, 1);
    }

    /// a followed by either b or c (never both in one case): XOR, one group.
    #[test]
    fn detects_xor_choice() {
        let mut traces = vec![vec![0, 1, 3]; 5]; // a b d
        traces.extend(vec![vec![0, 2, 3]; 5]); // a c d
        let net = scan(&traces, 4).mine_net(1, 0.8, 0.05);
        let g1 = net
            .edges
            .iter()
            .find(|e| e.s == 0 && e.d == 1)
            .unwrap()
            .split_group;
        let g2 = net
            .edges
            .iter()
            .find(|e| e.s == 0 && e.d == 2)
            .unwrap()
            .split_group;
        assert_eq!(
            g1, g2,
            "b and c never co-occur but never order either — same XOR group"
        );
        assert_eq!(net.stats.and_splits, 0);
    }

    /// One contradicting trace must not remove a clearly dominant edge —
    /// the whole point of a dependency measure over Alpha Miner's exact
    /// footprint relation.
    #[test]
    fn noise_tolerant() {
        let mut traces = vec![vec![0, 1, 2]; 20];
        traces.push(vec![0, 2, 1]); // one contradicting case
        let net = scan(&traces, 3).mine_net(1, 0.7, 0.05);
        assert!(has_edge(&net, 0, 1));
        assert!(has_edge(&net, 1, 2));
    }

    /// Below min_frequency, an edge is dropped outright regardless of how
    /// one-directional it is.
    #[test]
    fn min_frequency_filters() {
        let net = scan(&vec![vec![0, 1]; 3], 2).mine_net(5, 0.9, 0.05);
        assert!(net.edges.is_empty());
    }

    /// The all-activities-connected fallback keeps a below-threshold node
    /// from ending up with no outgoing edge at all.
    #[test]
    fn keeps_graph_connected() {
        // b appears 100 times after a and once after c; from a's side the
        // dependency to b is decisive, so this only exercises that a node
        // that isn't a true dead end never loses every outgoing edge.
        let mut traces = vec![vec![0, 1, 2]; 30];
        traces.push(vec![0, 1, 1, 2]); // one noisy repeat
        let net = scan(&traces, 3).mine_net(1, 0.95, 0.2);
        assert!(
            net.edges.iter().any(|e| e.s == 0),
            "0 must keep at least one outgoing edge"
        );
        assert!(
            net.edges.iter().any(|e| e.d == 2),
            "2 must keep at least one incoming edge"
        );
    }
}
