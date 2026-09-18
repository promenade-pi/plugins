//! The event log, as trace variants with multiplicities.
//!
//! ProM walks individual traces. Every operation it performs — the log-info
//! pass, all four splitters, every base case and fall-through — is per-trace and
//! order-independent, and depends only on a trace's *content*. So identical
//! traces can be collapsed into one variant carrying a count, which is the
//! difference between a log with 1.2 M traces and one with 4 000 variants.
//!
//! The one place this needs care is the loop splitter, which turns one trace
//! into several: each resulting subtrace inherits the variant's multiplicity.

use crate::tree::ActivityId;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Variant {
    pub events: Vec<ActivityId>,
    pub count: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EventLog {
    pub variants: Vec<Variant>,
}

impl EventLog {
    pub fn new() -> Self {
        EventLog::default()
    }

    /// Builds a log from raw traces, collapsing duplicates.
    pub fn from_traces<I, T>(traces: I) -> Self
    where
        I: IntoIterator<Item = T>,
        T: Into<Vec<ActivityId>>,
    {
        let mut log = EventLog::new();
        for t in traces {
            log.variants.push(Variant {
                events: t.into(),
                count: 1,
            });
        }
        log.collapse();
        log
    }

    /// Total number of traces, i.e. the sum of the multiplicities.
    ///
    /// This is what ProM's `log.size()` returns, and it is what the base cases
    /// and fall-throughs compare against — not the number of variants.
    pub fn trace_count(&self) -> u64 {
        self.variants.iter().map(|v| v.count).sum()
    }

    pub fn event_count(&self) -> u64 {
        self.variants
            .iter()
            .map(|v| v.count * v.events.len() as u64)
            .sum()
    }

    pub fn is_empty(&self) -> bool {
        self.variants.is_empty()
    }

    /// Merges variants with identical event sequences.
    ///
    /// Called after every split. Without it, splitting is the operation that
    /// makes the log grow: projecting a 12-activity log onto three of its
    /// activities collapses thousands of variants into a handful, and not
    /// noticing that means carrying the original variant count all the way down
    /// the recursion.
    pub fn collapse(&mut self) {
        if self.variants.len() < 2 {
            return;
        }
        let mut seen: HashMap<Vec<ActivityId>, usize> = HashMap::with_capacity(self.variants.len());
        let mut out: Vec<Variant> = Vec::with_capacity(self.variants.len());
        for v in self.variants.drain(..) {
            match seen.get(&v.events) {
                Some(&i) => out[i].count += v.count,
                None => {
                    seen.insert(v.events.clone(), out.len());
                    out.push(v);
                }
            }
        }
        self.variants = out;
    }

    /// Drops every empty trace, returning how many were removed.
    pub fn without_empty_traces(&self) -> EventLog {
        EventLog {
            variants: self
                .variants
                .iter()
                .filter(|v| !v.events.is_empty())
                .cloned()
                .collect(),
        }
    }
}
