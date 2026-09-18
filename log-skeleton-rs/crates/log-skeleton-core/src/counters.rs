//! What one pass over the log leaves behind.
//!
//! The same shape as `declare-core`'s counters, and for the same reason: the
//! host caches the scan and calls `finalize` again on every slider move, so the
//! noise threshold has to be applied to numbers rather than to the log.
//!
//! The inner loop runs over the pairs of activities a trace actually contains.
//! Every other pair says the same thing every time — a relation about an
//! activity that did not occur is decided by `holds_with_one_missing`, which is
//! a fact about the relation and not about the trace — so those are counted
//! arithmetically from three per-activity totals.

use crate::relations::{Relation, ALL};
use declare_core::TraceIndex;
use std::collections::HashMap;

/// How a candidate constraint fared over the whole log.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Assessment {
    pub violated: u32,
    pub traces: u32,
}

impl Assessment {
    pub fn support(&self) -> f64 {
        if self.traces == 0 {
            return 0.0;
        }
        (self.traces - self.violated) as f64 / self.traces as f64
    }
}

pub struct Counters {
    pub n: usize,
    pub traces: u32,
    pub events: u64,
    /// Traces containing each activity.
    with: Vec<u32>,
    /// Traces containing both, per ordered pair.
    both: Vec<u32>,
    /// Per relation: violations among the traces containing both.
    violated: Vec<Vec<u32>>,
    /// Per activity: how many traces had exactly this many occurrences (≥ 1).
    counts: Vec<HashMap<u32, u32>>,
}

impl Counters {
    pub fn new(n: usize) -> Self {
        Self {
            n,
            traces: 0,
            events: 0,
            with: vec![0; n],
            both: vec![0; n * n],
            violated: vec![vec![0; n * n]; ALL.len()],
            counts: vec![HashMap::new(); n],
        }
    }

    pub fn observe(&mut self, trace: &TraceIndex) {
        self.traces += 1;
        self.events += trace.len() as u64;

        for &a in trace.present() {
            self.with[a as usize] += 1;
            *self.counts[a as usize].entry(trace.count(a) as u32).or_insert(0) += 1;
        }

        for &a in trace.present() {
            for &b in trace.present() {
                if a == b {
                    continue;
                }
                let cell = a as usize * self.n + b as usize;
                self.both[cell] += 1;
                for (slot, relation) in ALL.iter().enumerate() {
                    if !relation.holds_when_both_present(trace, a, b) {
                        self.violated[slot][cell] += 1;
                    }
                }
            }
        }
    }

    fn both_of(&self, a: u32, b: u32) -> u32 {
        self.both[a as usize * self.n + b as usize]
    }

    pub fn assess(&self, relation: Relation, a: u32, b: u32) -> Assessment {
        let (wa, wb) = (self.with[a as usize], self.with[b as usize]);
        let both = self.both_of(a, b);
        let slot = ALL.iter().position(|&r| r == relation).unwrap();
        let counted = self.violated[slot][a as usize * self.n + b as usize];

        // `wa - both` is "a occurred and b did not", `wb - both` its mirror.
        // The two are disjoint from each other and from the both-present
        // traces, so no trace is counted twice.
        let only_a = wa - both;
        let only_b = wb - both;
        let violated = match relation {
            Relation::Equivalence => only_a + only_b + counted,
            Relation::AlwaysBefore | Relation::AlwaysAfter | Relation::DirectlyFollows => {
                only_a + counted
            }
            Relation::NeverTogether => both,
        };
        Assessment { violated, traces: self.traces }
    }

    /// Every occurrence count seen for `a`, with how many traces had it —
    /// including zero, for the traces the activity is absent from.
    pub fn frequencies(&self, a: u32) -> Vec<(u32, u32)> {
        let mut out: Vec<(u32, u32)> = self.counts[a as usize].iter().map(|(&c, &n)| (c, n)).collect();
        let absent = self.traces - self.with[a as usize];
        if absent > 0 {
            out.push((0, absent));
        }
        out.sort_unstable();
        out
    }

    pub fn occurrences(&self, a: u32) -> u32 {
        self.with[a as usize]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log(traces: &[&str]) -> Counters {
        let mut counters = Counters::new(26);
        let mut index = TraceIndex::new(26);
        for trace in traces {
            index.reset();
            for letter in trace.chars() {
                index.push(letter as u32 - 'a' as u32);
            }
            counters.observe(&index);
        }
        counters
    }

    /// The same question asked the slow way: one trace at a time, straight from
    /// the definitions.
    fn reference(traces: &[&str], relation: Relation, a: u32, b: u32) -> Assessment {
        let mut violated = 0;
        for trace in traces {
            let mut index = TraceIndex::new(26);
            for letter in trace.chars() {
                index.push(letter as u32 - 'a' as u32);
            }
            let (has_a, has_b) = (index.contains(a), index.contains(b));
            let holds = match (has_a, has_b) {
                (true, true) => relation.holds_when_both_present(&index, a, b),
                (true, false) => relation.holds_with_one_missing(true),
                (false, true) => relation.holds_with_one_missing(false),
                (false, false) => true,
            };
            if !holds {
                violated += 1;
            }
        }
        Assessment { violated, traces: traces.len() as u32 }
    }

    #[test]
    fn the_counters_agree_with_a_direct_evaluation() {
        let traces = ["abc", "ba", "a", "cba", "abab", "b", "", "acb", "aabb"];
        let counters = log(&traces);
        for relation in ALL {
            for a in 0..3u32 {
                for b in 0..3u32 {
                    if a == b {
                        continue;
                    }
                    assert_eq!(
                        counters.assess(relation, a, b),
                        reference(&traces, relation, a, b),
                        "{} of {a},{b}", relation.id()
                    );
                }
            }
        }
    }

    #[test]
    fn frequencies_include_the_traces_an_activity_is_absent_from() {
        let counters = log(&["a", "aa", "b"]);
        assert_eq!(counters.frequencies(0), vec![(0, 1), (1, 1), (2, 1)]);
        assert_eq!(counters.frequencies(1), vec![(0, 2), (1, 1)]);
    }

    #[test]
    fn an_empty_trace_breaks_nothing_and_counts_as_a_zero() {
        let counters = log(&["", "ab"]);
        assert_eq!(counters.traces, 2);
        assert_eq!(counters.assess(Relation::AlwaysAfter, 0, 1).violated, 0);
        assert_eq!(counters.frequencies(0), vec![(0, 1), (1, 1)]);
    }
}
