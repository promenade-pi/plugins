//! Alpha Miner — event log to accepting Petri net.
//!
//! van der Aalst's original discovery algorithm. Unlike a DFG, this is not
//! expressible as an aggregation: the core step searches for maximal pairs of
//! activity sets (A, B) where every a ∈ A causes every b ∈ B and the members
//! of each set are pairwise unrelated. That is a combinatorial search over the
//! subset lattice, which is exactly the kind of work a compiled kernel earns
//! its place on — and exactly what SQL cannot express.
//!
//! The two stages map onto the host's action contract:
//!
//!   scan (push_chunk/finish)  one pass over the event stream, builds the
//!                             directly-follows matrix and the start/end sets.
//!                             Expensive, parameter-independent, cached.
//!   mine(threshold)           derives the relations and runs the search over
//!                             the small activity matrix. Cheap — it never
//!                             touches the events again.
//!
//! Activities are bounded to 64 so the relation sets fit in a u64 bitmask. The
//! host filters to the most frequent activities before scanning; Alpha Miner
//! on hundreds of activities is not meaningful anyway, and saying so is more
//! honest than degrading silently.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use wasm_bindgen::prelude::*;

pub const MAX_ACTIVITIES: usize = 64;

#[derive(Serialize)]
pub struct Place {
    pub id: String,
    /// Source activities feeding the place (empty for the initial place).
    pub inputs: Vec<u32>,
    /// Target activities fed by the place (empty for the final place).
    pub outputs: Vec<u32>,
    pub kind: &'static str, // "initial" | "final" | "derived"
}

#[derive(Serialize)]
pub struct PetriNet {
    pub activities: Vec<u32>,
    pub places: Vec<Place>,
    /// (place index, activity id)
    pub place_to_transition: Vec<(u32, u32)>,
    /// (activity id, place index)
    pub transition_to_place: Vec<(u32, u32)>,
    pub initial_marking: Vec<u32>,
    pub final_marking: Vec<u32>,
    pub start_activities: Vec<u32>,
    pub end_activities: Vec<u32>,
    /// Occurrence count per activity, so the view can weight transitions.
    /// Added in 0.2.0.
    pub activity_counts: Vec<u32>,
    pub stats: Stats,
}

#[derive(Serialize)]
pub struct Stats {
    pub activities: usize,
    pub places: usize,
    pub arcs: usize,
    pub causal_pairs: usize,
    pub parallel_pairs: usize,
    pub candidate_pairs: usize,
    pub maximal_pairs: usize,
    pub threshold: u32,
    pub truncated: bool,
}

/// One pass over the ordered event stream, accumulating what the miner needs.
#[wasm_bindgen]
pub struct AlphaScan {
    n: usize,
    /// df[a * n + b] = how often a is directly followed by b
    df: Vec<u32>,
    starts: Vec<u32>,
    ends: Vec<u32>,
    counts: Vec<u32>,

    last_case: i64,
    last_act: u32,
    have_last: bool,
    rows: u32,
    cases: u32,
    truncated: bool,
}

#[wasm_bindgen]
impl AlphaScan {
    #[wasm_bindgen(constructor)]
    pub fn new(n_activities: usize) -> AlphaScan {
        let truncated = n_activities > MAX_ACTIVITIES;
        let n = n_activities.min(MAX_ACTIVITIES);
        AlphaScan {
            n,
            df: vec![0; n * n],
            starts: vec![0; n],
            ends: vec![0; n],
            counts: vec![0; n],
            last_case: i64::MIN,
            last_act: 0,
            have_last: false,
            rows: 0,
            cases: 0,
            truncated,
        }
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
    pub fn row_count(&self) -> u32 { self.rows }

    #[wasm_bindgen(js_name = caseCount)]
    pub fn case_count(&self) -> u32 { self.cases }

    /// The cheap stage: relations, maximal pairs, net construction.
    ///
    /// `min_frequency` filters the directly-follows relation before the
    /// relations are derived — the standard noise filter. Everything here runs
    /// on an n×n matrix with n ≤ 64, so it is fast enough to drive from a
    /// slider even though it does real combinatorial work.
    /// The host's WASM kernel ABI:
    ///
    ///   new Kernel(nActivities)
    ///   .pushChunk(Int32Array cases, Int32Array activities)
    ///   .finish()
    ///   .finalize(params) -> result
    ///   .free()
    ///
    /// `finalize` takes the whole parameter object rather than a positional
    /// argument, so the host can drive any plugin through one code path
    /// instead of knowing each kernel's signature.
    #[wasm_bindgen(js_name = finalize)]
    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: Params = serde_wasm_bindgen::from_value(params)
            .map_err(|e| JsValue::from_str(&format!("bad params: {e}")))?;
        serde_wasm_bindgen::to_value(&self.mine_net(p.min_frequency.unwrap_or(1)))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Params {
    min_frequency: Option<u32>,
}

impl AlphaScan {
    /// The algorithm proper, free of wasm-bindgen types so it can be tested.
    pub fn mine_net(&self, min_frequency: u32) -> PetriNet {
        let n = self.n;
        let thr = min_frequency.max(1);

        // follows[a] = bitmask of b with a > b
        let mut follows = vec![0u64; n];
        for a in 0..n {
            for b in 0..n {
                if self.df[a * n + b] >= thr {
                    follows[a] |= 1u64 << b;
                }
            }
        }

        // causal[a] = { b : a > b and not b > a }
        // unrelated[a] = { b : not a > b and not b > a }
        let mut causal = vec![0u64; n];
        let mut unrelated = vec![0u64; n];
        let mut causal_pairs = 0usize;
        let mut parallel_pairs = 0usize;
        for a in 0..n {
            for b in 0..n {
                let ab = follows[a] >> b & 1 == 1;
                let ba = follows[b] >> a & 1 == 1;
                if ab && !ba {
                    causal[a] |= 1u64 << b;
                    causal_pairs += 1;
                } else if ab && ba {
                    parallel_pairs += 1;
                } else if !ab && !ba {
                    unrelated[a] |= 1u64 << b;
                }
            }
        }

        // Candidate pairs (A, B): grown from each causal pair by adding
        // activities that stay unrelated within their own set and keep the
        // causal relation to every member of the other set.
        // X_L requires a₁ # a₂ for all members of a set, including a₁ = a₂ —
        // which means ¬(a > a). An activity with a self-loop can therefore
        // appear in no set, so such seeds are skipped outright.
        let no_self_loop = |x: usize| unrelated[x] >> x & 1 == 1;

        let mut seen: HashSet<(u64, u64)> = HashSet::new();
        for a in 0..n {
            if !no_self_loop(a) { continue; }
            let mut bs = causal[a];
            while bs != 0 {
                let b = bs.trailing_zeros() as usize;
                bs &= bs - 1;
                if !no_self_loop(b) { continue; }
                expand(&causal, &unrelated, n, 1u64 << a, 1u64 << b, &mut seen);
            }
        }
        let mut candidates: Vec<(u64, u64)> = seen.into_iter().collect();
        candidates.sort_unstable();
        let candidate_count = candidates.len();

        // Y_L: keep only the maximal pairs under (A ⊆ A', B ⊆ B').
        let mut maximal: Vec<(u64, u64)> = Vec::new();
        for &(a, b) in &candidates {
            let dominated = candidates.iter().any(|&(a2, b2)| {
                (a2, b2) != (a, b) && (a & !a2) == 0 && (b & !b2) == 0
            });
            if !dominated {
                maximal.push((a, b));
            }
        }

        // --- build the net ---------------------------------------------------
        let activities: Vec<u32> = (0..n as u32).filter(|&a| self.counts[a as usize] > 0).collect();
        let start_activities: Vec<u32> =
            (0..n as u32).filter(|&a| self.starts[a as usize] > 0).collect();
        let end_activities: Vec<u32> =
            (0..n as u32).filter(|&a| self.ends[a as usize] > 0).collect();

        let mut places = Vec::new();
        let mut transition_to_place = Vec::new();
        let mut place_to_transition = Vec::new();

        // i_L
        places.push(Place {
            id: "i".into(),
            inputs: vec![],
            outputs: start_activities.clone(),
            kind: "initial",
        });
        for &t in &start_activities {
            place_to_transition.push((0u32, t));
        }

        // p_(A,B)
        for (idx, &(a_mask, b_mask)) in maximal.iter().enumerate() {
            let inputs = bits(a_mask);
            let outputs = bits(b_mask);
            let pi = (idx + 1) as u32;
            for &t in &inputs {
                transition_to_place.push((t, pi));
            }
            for &t in &outputs {
                place_to_transition.push((pi, t));
            }
            places.push(Place {
                id: format!("p{}", idx + 1),
                inputs,
                outputs,
                kind: "derived",
            });
        }

        // o_L
        let final_index = places.len() as u32;
        places.push(Place {
            id: "o".into(),
            inputs: end_activities.clone(),
            outputs: vec![],
            kind: "final",
        });
        for &t in &end_activities {
            transition_to_place.push((t, final_index));
        }

        let arcs = place_to_transition.len() + transition_to_place.len();
        PetriNet {
            activities,
            stats: Stats {
                activities: n,
                places: places.len(),
                arcs,
                causal_pairs,
                parallel_pairs: parallel_pairs / 2,
                candidate_pairs: candidate_count,
                maximal_pairs: maximal.len(),
                threshold: thr,
                truncated: self.truncated,
            },
            places,
            place_to_transition,
            transition_to_place,
            // An accepting Petri net: the net together with its markings, which
            // are meaningless on their own.
            initial_marking: vec![0],
            final_marking: vec![final_index],
            start_activities,
            end_activities,
            activity_counts: self.counts.clone(),
        }
    }
}

/// Grows (A, B) by every activity that may still join either side.
///
/// Recursion is bounded by the activity count, and duplicates are removed by
/// the caller — expanding from every causal seed reaches the same maximal pair
/// along several paths.
fn expand(
    causal: &[u64],
    unrelated: &[u64],
    n: usize,
    a_mask: u64,
    b_mask: u64,
    seen: &mut HashSet<(u64, u64)>,
) {
    if !seen.insert((a_mask, b_mask)) {
        return; // already grown from here along another path
    }
    if seen.len() > 200_000 {
        return; // pathological log: stop growing rather than hang the worker
    }

    for x in 0..n {
        let bit = 1u64 << x;
        if unrelated[x] >> x & 1 == 0 {
            continue; // self-loop: cannot join either set
        }

        // Extend A: x must be unrelated to every current member of A and
        // causally related to every member of B.
        if a_mask & bit == 0
            && (a_mask & !unrelated[x]) == 0
            && bits(b_mask).iter().all(|&b| causal[x] >> b & 1 == 1)
        {
            expand(causal, unrelated, n, a_mask | bit, b_mask, seen);
        }

        // Extend B, symmetrically.
        if b_mask & bit == 0
            && (b_mask & !unrelated[x]) == 0
            && bits(a_mask).iter().all(|&a| causal[a as usize] >> x & 1 == 1)
        {
            expand(causal, unrelated, n, a_mask, b_mask | bit, seen);
        }
    }
}

fn bits(mask: u64) -> Vec<u32> {
    let mut v = Vec::new();
    let mut m = mask;
    while m != 0 {
        v.push(m.trailing_zeros());
        m &= m - 1;
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feeds traces as (case, activity) pairs in order.
    fn scan(traces: &[Vec<usize>], n: usize) -> AlphaScan {
        let mut s = AlphaScan::new(n);
        for (case, tr) in traces.iter().enumerate() {
            let cases: Vec<i32> = vec![case as i32; tr.len()];
            let acts: Vec<i32> = tr.iter().map(|&a| a as i32).collect();
            s.push_chunk(&cases, &acts);
        }
        s.finish();
        s
    }

    fn set_of(mask_members: &[u32]) -> Vec<u32> {
        let mut v = mask_members.to_vec();
        v.sort_unstable();
        v
    }

    /// The textbook log L1 = [<a,b,c,d>³, <a,c,b,d>², <a,e,d>].
    ///
    /// van der Aalst's expected result is four derived places:
    ///   ({a},{b,e}) ({a},{c,e}) ({b,e},{d}) ({c,e},{d})
    /// plus the initial and final place. b and c are parallel, so no place
    /// separates them; e is unrelated to both.
    #[test]
    fn textbook_l1() {
        // a=0 b=1 c=2 d=3 e=4
        let mut traces = Vec::new();
        for _ in 0..3 { traces.push(vec![0, 1, 2, 3]); }
        for _ in 0..2 { traces.push(vec![0, 2, 1, 3]); }
        traces.push(vec![0, 4, 3]);

        let s = scan(&traces, 5);
        assert_eq!(s.case_count(), 6);
        assert_eq!(s.row_count(), 3 * 4 + 2 * 4 + 3);

        let net = s.mine_net(1);

        assert_eq!(set_of(&net.start_activities), vec![0]);
        assert_eq!(set_of(&net.end_activities), vec![3]);

        let derived: Vec<(Vec<u32>, Vec<u32>)> = net
            .places
            .iter()
            .filter(|p| p.kind == "derived")
            .map(|p| (set_of(&p.inputs), set_of(&p.outputs)))
            .collect();

        assert_eq!(derived.len(), 4, "expected 4 derived places, got {:?}", derived);
        for expected in [
            (vec![0], vec![1, 4]),
            (vec![0], vec![2, 4]),
            (vec![1, 4], vec![3]),
            (vec![2, 4], vec![3]),
        ] {
            assert!(derived.contains(&expected), "missing place {:?} in {:?}", expected, derived);
        }

        // b || c, so no place may separate them.
        assert!(!derived.contains(&(vec![1], vec![2])));
        assert!(!derived.contains(&(vec![2], vec![1])));

        assert_eq!(net.initial_marking, vec![0]);
        assert_eq!(net.final_marking, vec![net.places.len() as u32 - 1]);
    }

    /// A strict sequence must yield exactly one place between each step.
    #[test]
    fn simple_sequence() {
        let traces = vec![vec![0, 1, 2]; 5];
        let net = scan(&traces, 3).mine_net(1);
        let derived: Vec<(Vec<u32>, Vec<u32>)> = net
            .places.iter().filter(|p| p.kind == "derived")
            .map(|p| (set_of(&p.inputs), set_of(&p.outputs)))
            .collect();
        assert_eq!(derived.len(), 2, "{:?}", derived);
        assert!(derived.contains(&(vec![0], vec![1])));
        assert!(derived.contains(&(vec![1], vec![2])));
    }

    /// An activity with a self-loop belongs to no set, so it yields no place.
    #[test]
    fn self_loop_excluded() {
        let traces = vec![vec![0, 1, 1, 2]; 4];
        let net = scan(&traces, 3).mine_net(1);
        let derived: Vec<(Vec<u32>, Vec<u32>)> = net
            .places.iter().filter(|p| p.kind == "derived")
            .map(|p| (set_of(&p.inputs), set_of(&p.outputs)))
            .collect();
        for (a, b) in &derived {
            assert!(!a.contains(&1) && !b.contains(&1), "self-looping b in {:?}", derived);
        }
    }

    /// The frequency threshold must drop infrequent edges from the relation.
    ///
    /// The effect is structural, not a change in place count: one reversed
    /// trace makes 1 and 2 look parallel, which removes the place between them
    /// and adds one from 0 to 2. Filtering restores the sequence 0 → 1 → 2.
    #[test]
    fn threshold_filters_noise() {
        let mut traces = vec![vec![0, 1, 2]; 20];
        traces.push(vec![0, 2, 1]); // the noise
        let s = scan(&traces, 3);

        let derived = |net: &PetriNet| -> Vec<(Vec<u32>, Vec<u32>)> {
            net.places.iter().filter(|p| p.kind == "derived")
                .map(|p| (set_of(&p.inputs), set_of(&p.outputs))).collect()
        };

        let noisy = derived(&s.mine_net(1));
        // 1 || 2 under the noise, so nothing separates them.
        assert!(!noisy.contains(&(vec![1], vec![2])), "{:?}", noisy);
        assert!(noisy.contains(&(vec![0], vec![2])), "{:?}", noisy);

        let filtered = derived(&s.mine_net(5));
        // The sequence is back and the spurious 0 → 2 place is gone.
        assert!(filtered.contains(&(vec![0], vec![1])), "{:?}", filtered);
        assert!(filtered.contains(&(vec![1], vec![2])), "{:?}", filtered);
        assert!(!filtered.contains(&(vec![0], vec![2])), "{:?}", filtered);
    }
}
