//! The directly-follows algorithm itself, free of any host-binding glue.
//!
//! This module (`dfg_core`, not `core` — that name is reserved by Rust's own
//! `core` crate and shadowing it invites ambiguous-name errors) is what makes
//! `dfg-rs` a Promenade Compute plugin as well as a browser one: it has no
//! `wasm_bindgen`, no JS types, nothing that only exists inside a
//! `wasm32-unknown-unknown` + wasm-bindgen build. `lib.rs` wraps it for the
//! browser (wasm-bindgen cdylib); `wasi.rs` wraps the same struct for the
//! engine (a plain WASI cdylib driven by Wasmtime). Both wrap the exact same
//! push_chunk/finish/filter/finalize sequence, so a discovery run produces
//! byte-identical DFGs regardless of which build ran it.

use std::collections::HashMap;

/// Accumulates directly-follows counts across chunks of an ordered event stream.
///
/// Rows must arrive ordered by their case sequence. The host guarantees that
/// with `ORDER BY trace_idx, ts NULLS LAST, event_idx`, which is where such
/// work belongs.
pub struct DfgCore {
    /// (predecessor, successor) -> frequency
    edges: HashMap<(u32, u32), u32>,
    activity_counts: Vec<u32>,
    starts: HashMap<u32, u32>,
    ends: HashMap<u32, u32>,

    /// Carried across chunk boundaries so a case split over two chunks still
    /// produces the edge that spans the boundary.
    last_case: i64,
    last_activity: u32,
    have_last: bool,

    rows: u32,
    cases: u32,

    /// Optional labels in the activity-id order assigned by the host. Only
    /// `finalize` (the generic scan-finalize/1 ABI) needs these — the
    /// original two-stage methods below don't touch this field.
    names: Vec<String>,
}

/// Flat, JSON/serde-friendly shape for the generic `scan-finalize/1` result —
/// matches `DfgResultPayload` in `app/src/host/relational/reference-actions/discover-dfg/build.ts`
/// field for field, so a WASM/browser run, a WASI/engine run and a relational
/// (SQL) run of the same log are byte-comparable and render in the same view.
pub struct DfgStats {
    pub rows: u32,
    pub cases: u32,
    pub total_edges: u32,
    pub shown_edges: u32,
    pub heap_estimate: u32,
}

pub struct DfgFinalizeResult {
    pub activities: Vec<String>,
    pub edges: Vec<u32>,
    pub starts: Vec<u32>,
    pub ends: Vec<u32>,
    pub counts: Vec<u32>,
    pub stats: DfgStats,
}

impl DfgCore {
    pub fn new(n_activities: usize) -> DfgCore {
        DfgCore {
            edges: HashMap::new(),
            activity_counts: vec![0; n_activities],
            starts: HashMap::new(),
            ends: HashMap::new(),
            last_case: i64::MIN,
            last_activity: 0,
            have_last: false,
            rows: 0,
            cases: 0,
            names: Vec::new(),
        }
    }

    pub fn set_activity_names(&mut self, names: Vec<String>) {
        self.names = names;
    }

    /// Consumes one ordered chunk. `cases` and `activities` are parallel arrays.
    pub fn push_chunk(&mut self, cases: &[i32], activities: &[i32]) {
        let n = cases.len().min(activities.len());
        for i in 0..n {
            let case = cases[i] as i64;
            let act = activities[i] as u32;

            if (act as usize) < self.activity_counts.len() {
                self.activity_counts[act as usize] += 1;
            }

            if self.have_last && self.last_case == case {
                *self.edges.entry((self.last_activity, act)).or_insert(0) += 1;
            } else {
                // New case: close the previous one and open this one.
                if self.have_last {
                    *self.ends.entry(self.last_activity).or_insert(0) += 1;
                }
                *self.starts.entry(act).or_insert(0) += 1;
                self.cases += 1;
            }

            self.last_case = case;
            self.last_activity = act;
            self.have_last = true;
        }
        self.rows += n as u32;
    }

    /// Closes the final case. Must be called before `filter`/`finalize`.
    pub fn finish(&mut self) {
        if self.have_last {
            *self.ends.entry(self.last_activity).or_insert(0) += 1;
            self.have_last = false;
        }
    }

    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    pub fn row_count(&self) -> u32 {
        self.rows
    }

    pub fn case_count(&self) -> u32 {
        self.cases
    }

    /// The cheap, parameter-dependent stage.
    ///
    /// Returns flat triples [src, dst, freq, ...] so the boundary stays a
    /// single typed array rather than a serialised object graph. This is what
    /// the inspector's threshold control calls on every change.
    pub fn filter(&self, min_frequency: u32) -> Vec<u32> {
        let mut out: Vec<u32> = Vec::with_capacity(self.edges.len() * 3);
        for (&(src, dst), &freq) in self.edges.iter() {
            if freq >= min_frequency {
                out.push(src);
                out.push(dst);
                out.push(freq);
            }
        }
        out
    }

    /// Start activities above the threshold, as [activity, freq, ...].
    pub fn start_activities(&self, min_frequency: u32) -> Vec<u32> {
        flatten(&self.starts, min_frequency)
    }

    /// End activities above the threshold, as [activity, freq, ...].
    pub fn end_activities(&self, min_frequency: u32) -> Vec<u32> {
        flatten(&self.ends, min_frequency)
    }

    /// Per-activity occurrence counts, indexed by activity id.
    pub fn activity_counts(&self) -> Vec<u32> {
        self.activity_counts.clone()
    }

    /// Approximate retained size, so the host can enforce a memory budget.
    pub fn heap_estimate(&self) -> u32 {
        let per_edge = (std::mem::size_of::<(u32, u32)>() + std::mem::size_of::<u32>()) as u32;
        self.edges.len() as u32 * per_edge
            + (self.activity_counts.len() * 4) as u32
            + ((self.starts.len() + self.ends.len()) * 8) as u32
    }

    /// The generic `scan-finalize/1` cheap stage: everything a `DfgView`
    /// needs, in one call, keyed by whatever `min_frequency` the live filter
    /// control is currently set to.
    pub fn finalize(&self, min_frequency: u32) -> DfgFinalizeResult {
        let edges = self.filter(min_frequency);
        let shown_edges = (edges.len() / 3) as u32;
        DfgFinalizeResult {
            activities: self.names.clone(),
            edges,
            starts: self.start_activities(1),
            ends: self.end_activities(1),
            counts: self.activity_counts(),
            stats: DfgStats {
                rows: self.rows,
                cases: self.cases,
                total_edges: self.edges.len() as u32,
                shown_edges,
                heap_estimate: self.heap_estimate(),
            },
        }
    }
}

fn flatten(m: &HashMap<u32, u32>, min_frequency: u32) -> Vec<u32> {
    let mut out = Vec::with_capacity(m.len() * 2);
    for (&k, &v) in m.iter() {
        if v >= min_frequency {
            out.push(k);
            out.push(v);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::DfgCore;

    #[test]
    fn retains_immediate_self_loops() {
        // case 0: A → A → B; case 1: B → B
        let mut dfg = DfgCore::new(2);
        dfg.push_chunk(&[0, 0, 0, 1, 1], &[0, 0, 1, 1, 1]);
        dfg.finish();

        let triples = dfg.filter(1);
        let edges: std::collections::HashMap<_, _> = triples.chunks_exact(3)
            .map(|chunk| ((chunk[0], chunk[1]), chunk[2]))
            .collect();
        assert_eq!(edges.get(&(0, 0)), Some(&1));
        assert_eq!(edges.get(&(1, 1)), Some(&1));
        assert_eq!(edges.get(&(0, 1)), Some(&1));
    }

    #[test]
    fn finalize_matches_two_stage_methods() {
        let mut dfg = DfgCore::new(2);
        dfg.set_activity_names(vec!["A".into(), "B".into()]);
        dfg.push_chunk(&[0, 0, 0, 1, 1], &[0, 0, 1, 1, 1]);
        dfg.finish();

        let out = dfg.finalize(1);
        assert_eq!(out.activities, vec!["A".to_string(), "B".to_string()]);
        assert_eq!(out.edges, dfg.filter(1));
        assert_eq!(out.stats.rows, dfg.row_count());
        assert_eq!(out.stats.cases, dfg.case_count());
        assert_eq!(out.stats.total_edges, dfg.edge_count() as u32);
    }
}
