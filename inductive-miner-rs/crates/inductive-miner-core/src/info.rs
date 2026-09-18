//! Everything the detectors need about one recursion node, from one pass.
//!
//! Activities are re-indexed **locally** at every node: the recursion shrinks
//! the alphabet fast, and a cut over 4 of 300 activities should not carry a
//! 300-wide structure into its sublogs. `local[i]` ↔ `activities[i]`, and
//! `activities` is sorted ascending by global id — which is also the tie-break
//! wherever ProM leaves a choice to trove's hash iteration order.

use crate::log::EventLog;
use crate::tree::ActivityId;
use std::collections::{HashMap, HashSet};

pub struct LogInfo {
    /// Global activity ids present at this node, ascending.
    pub activities: Vec<ActivityId>,
    /// Occurrences of each activity (events, not traces).
    pub counts: Vec<u64>,
    pub start: Vec<u64>,
    pub end: Vec<u64>,
    /// Directly-follows weights, keyed `source * n + target` over local indices.
    pub edges: HashMap<u64, u64>,
    pub out_adj: Vec<Vec<usize>>,
    pub in_adj: Vec<Vec<usize>>,
    /// Activities lying strictly between the closest repeat of each activity.
    pub msd_between: Vec<Vec<usize>>,
    pub empty_traces: u64,
    pub trace_count: u64,
    pub event_count: u64,
}

impl LogInfo {
    pub fn n(&self) -> usize {
        self.activities.len()
    }

    pub fn has_edge(&self, a: usize, b: usize) -> bool {
        self.edges.contains_key(&(a as u64 * self.n() as u64 + b as u64))
    }

    pub fn edge_weight(&self, a: usize, b: usize) -> u64 {
        *self
            .edges
            .get(&(a as u64 * self.n() as u64 + b as u64))
            .unwrap_or(&0)
    }

    pub fn is_start(&self, a: usize) -> bool {
        self.start[a] > 0
    }

    pub fn is_end(&self, a: usize) -> bool {
        self.end[a] > 0
    }

    pub fn has_start_activities(&self) -> bool {
        self.start.iter().any(|&c| c > 0)
    }

    pub fn has_end_activities(&self) -> bool {
        self.end.iter().any(|&c| c > 0)
    }

    pub fn start_indices(&self) -> Vec<usize> {
        (0..self.n()).filter(|&i| self.is_start(i)).collect()
    }

    pub fn end_indices(&self) -> Vec<usize> {
        (0..self.n()).filter(|&i| self.is_end(i)).collect()
    }

    pub fn build(log: &EventLog) -> LogInfo {
        // Local indices, ascending by global id.
        let mut present: Vec<ActivityId> = {
            let mut set: HashSet<ActivityId> = HashSet::new();
            for v in &log.variants {
                set.extend(v.events.iter().copied());
            }
            set.into_iter().collect()
        };
        present.sort_unstable();

        let n = present.len();
        let local: HashMap<ActivityId, usize> =
            present.iter().enumerate().map(|(i, &a)| (a, i)).collect();

        let mut info = LogInfo {
            activities: present,
            counts: vec![0; n],
            start: vec![0; n],
            end: vec![0; n],
            edges: HashMap::new(),
            out_adj: vec![Vec::new(); n],
            in_adj: vec![Vec::new(); n],
            msd_between: vec![Vec::new(); n],
            empty_traces: 0,
            trace_count: log.trace_count(),
            event_count: log.event_count(),
        };

        // Minimum self-distance, minimised over the whole log. The
        // between-set is reset when a strictly shorter gap turns up and
        // extended when an equal one does, so the result does not depend on
        // the order the variants are visited in.
        let mut msd: Vec<usize> = vec![usize::MAX; n];
        let mut seen_at: HashMap<usize, usize> = HashMap::new();

        for v in &log.variants {
            if v.events.is_empty() {
                info.empty_traces += v.count;
                continue;
            }

            let trace: Vec<usize> = v.events.iter().map(|a| local[a]).collect();
            info.start[trace[0]] += v.count;
            info.end[trace[trace.len() - 1]] += v.count;

            seen_at.clear();
            for (pos, &a) in trace.iter().enumerate() {
                info.counts[a] += v.count;
                if pos > 0 {
                    let key = trace[pos - 1] as u64 * n as u64 + a as u64;
                    let e = info.edges.entry(key).or_insert(0);
                    if *e == 0 {
                        info.out_adj[trace[pos - 1]].push(a);
                        info.in_adj[a].push(trace[pos - 1]);
                    }
                    *e += v.count;
                }

                if let Some(&prev) = seen_at.get(&a) {
                    let d = pos - prev;
                    if d <= msd[a] {
                        if msd[a] > d {
                            msd[a] = d;
                            info.msd_between[a].clear();
                        }
                        info.msd_between[a].extend_from_slice(&trace[prev + 1..pos]);
                    }
                }
                seen_at.insert(a, pos);
            }
        }

        for between in info.msd_between.iter_mut() {
            between.sort_unstable();
            between.dedup();
        }
        for adj in info.out_adj.iter_mut().chain(info.in_adj.iter_mut()) {
            adj.sort_unstable();
        }

        info
    }

    /// The IMf noise filter: a *copy* of the graph with weak behaviour removed.
    ///
    /// Per-source and relative, not a global cutoff. An activity's own
    /// end-cardinality counts as one of its outgoing options, so an activity
    /// that mostly ends the trace prunes its rare successors hard. Strictly
    /// `<`, so a threshold of 0 removes nothing at all.
    pub fn filter_noise(&self, threshold: f64) -> LogInfo {
        let n = self.n();
        let mut start = self.start.clone();
        let mut end = self.end.clone();

        if let Some(&max_start) = start.iter().filter(|&&c| c > 0).max() {
            for c in start.iter_mut() {
                if (*c as f64) < threshold * max_start as f64 {
                    *c = 0;
                }
            }
        }
        if let Some(&max_end) = end.iter().filter(|&&c| c > 0).max() {
            for c in end.iter_mut() {
                if (*c as f64) < threshold * max_end as f64 {
                    *c = 0;
                }
            }
        }

        let mut edges = HashMap::with_capacity(self.edges.len());
        let mut out_adj = vec![Vec::new(); n];
        let mut in_adj = vec![Vec::new(); n];
        for source in 0..n {
            // Edge filtering runs *after* the end activities have been thinned,
            // so an activity that just lost its end status prunes its
            // successors against a smaller yardstick than the raw log suggests.
            let mut max_out = end[source];
            for &t in &self.out_adj[source] {
                max_out = max_out.max(self.edge_weight(source, t));
            }

            // ProM walks its activities as `0 .. numberOfActivities-1`, which
            // is a range over *global* activity ids rather than over the
            // activities actually present. Deeper in the recursion the ids are
            // sparse, so only those below the count get filtered at all, and
            // everything above keeps its edges. Reproduced deliberately: it is
            // a large part of what IMf does on real logs, and a "corrected"
            // filter discovers visibly different models.
            let filtered_source = (self.activities[source] as usize) < n;

            for &t in &self.out_adj[source] {
                let w = self.edge_weight(source, t);
                if filtered_source && (w as f64) < threshold * max_out as f64 {
                    continue;
                }
                edges.insert(source as u64 * n as u64 + t as u64, w);
                out_adj[source].push(t);
                in_adj[t].push(source);
            }
        }
        for adj in out_adj.iter_mut().chain(in_adj.iter_mut()) {
            adj.sort_unstable();
        }

        LogInfo {
            activities: self.activities.clone(),
            counts: self.counts.clone(),
            start,
            end,
            edges,
            out_adj,
            in_adj,
            msd_between: self.msd_between.clone(),
            empty_traces: self.empty_traces,
            trace_count: self.trace_count,
            event_count: self.event_count,
        }
    }
}
