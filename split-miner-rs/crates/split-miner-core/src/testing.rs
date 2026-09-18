//! Log builders for the tests and the invariant harness.
//!
//! Public rather than `#[cfg(test)]` because `tests/invariants.rs` is a
//! separate compilation unit and needs the same builders the unit tests use —
//! the alternative is two drifting notions of "how you write a log down".

use crate::observe::{Observations, Phase, Scanner};

/// A log of life-cycle-annotated traces.
pub fn scan(traces: &[&[(usize, Phase)]], activity_count: usize) -> Observations {
    let mut scanner = Scanner::new(activity_count);
    scanner.set_has_lifecycle(true);
    for trace in traces {
        scanner.begin_case();
        for &(activity, phase) in *trace {
            scanner.push(activity, phase);
        }
    }
    scanner.finish()
}

/// A log with no life-cycle information — every event is a completion, which
/// is exactly how the host presents a log with no `lifecycle:transition`.
pub fn scan_complete(traces: &[&[usize]], activity_count: usize) -> Observations {
    let mut scanner = Scanner::new(activity_count);
    for trace in traces {
        scanner.begin_case();
        for &activity in *trace {
            scanner.push(activity, Phase::Complete);
        }
    }
    scanner.finish()
}

/// Repeats `trace` `times` times, for building a log where one path dominates.
pub fn repeat(trace: &[usize], times: usize) -> Vec<Vec<usize>> {
    vec![trace.to_vec(); times]
}

/// Borrows a `Vec<Vec<usize>>` as the slice-of-slices [`scan_complete`] takes.
pub fn as_refs(traces: &[Vec<usize>]) -> Vec<&[usize]> {
    traces.iter().map(Vec::as_slice).collect()
}
