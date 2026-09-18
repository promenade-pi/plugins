//! Log splitting — one splitter per operator.
//!
//! Splitting is where a trace that does not fit the chosen cut perfectly gets
//! resolved, which is why two of these are named "filtering" in ProM. That
//! filtering is **not** the noise threshold: it happens identically in IM and
//! IMf, at every threshold including zero.
//!
//! Every splitter works per trace, so a variant with multiplicity `m`
//! contributes its results `m` times. The loop splitter is the one that turns
//! one trace into several; the others preserve or drop whole traces.

use crate::cuts::{Cut, Operator};
use crate::info::LogInfo;
use crate::log::{EventLog, Variant};
use crate::tree::ActivityId;

/// Splits `log` into one sublog per part of `cut`.
///
/// Parts are given as local indices; the sublogs carry global activity ids, so
/// that ids stay stable all the way down the recursion.
pub fn split(log: &EventLog, info: &LogInfo, cut: &Cut) -> Vec<EventLog> {
    // local index -> part number, over global ids
    let mut part_of: Vec<usize> = vec![usize::MAX; info.n()];
    for (p, part) in cut.parts.iter().enumerate() {
        for &a in part {
            part_of[a] = p;
        }
    }
    let global_part = |a: ActivityId| -> usize {
        match info.activities.binary_search(&a) {
            Ok(i) => part_of[i],
            Err(_) => usize::MAX,
        }
    };

    let k = cut.parts.len();
    let mut out = match cut.operator {
        Operator::Xor => split_xor(log, k, &global_part),
        Operator::Sequence => split_sequence(log, k, &global_part),
        Operator::Parallel => split_parallel(log, k, &global_part),
        Operator::Loop => split_loop(log, k, &global_part),
    };
    for sublog in out.iter_mut() {
        sublog.collapse();
    }
    out
}

/// A trace goes to the part holding the plurality of its events.
///
/// Ties go to whichever part *reached* the winning count first in event order,
/// not to the lowest-numbered part — the running maximum is updated on a strict
/// increase only. An empty trace has no evidence either way and is kept in
/// every sublog.
fn split_xor(log: &EventLog, k: usize, part_of: &impl Fn(ActivityId) -> usize) -> Vec<EventLog> {
    let mut out = vec![EventLog::new(); k];
    let mut counters = vec![0u32; k];
    for v in &log.variants {
        if v.events.is_empty() {
            for sublog in out.iter_mut() {
                sublog.variants.push(v.clone());
            }
            continue;
        }

        counters.iter_mut().for_each(|c| *c = 0);
        let (mut max_count, mut winner) = (0u32, 0usize);
        for &e in &v.events {
            let p = part_of(e);
            counters[p] += 1;
            if counters[p] > max_count {
                max_count = counters[p];
                winner = p;
            }
        }

        out[winner].variants.push(Variant {
            events: v.events.iter().copied().filter(|&e| part_of(e) == winner).collect(),
            count: v.count,
        });
    }
    out
}

/// A trace is cut into `k` consecutive segments, one per part in cut order.
fn split_sequence(log: &EventLog, k: usize, part_of: &impl Fn(ActivityId) -> usize) -> Vec<EventLog> {
    let mut out = vec![EventLog::new(); k];
    for v in &log.variants {
        let mut at = 0usize;
        let mut consumed = vec![false; k];
        for p in 0..k {
            let from = at;
            at = if p + 1 < k {
                optimal_split(&v.events, p, at, &consumed, part_of)
            } else {
                v.events.len()
            };
            consumed[p] = true;
            out[p].variants.push(Variant {
                events: v.events[from..at]
                    .iter()
                    .copied()
                    .filter(|&e| part_of(e) == p)
                    .collect(),
                count: v.count,
            });
        }
    }
    out
}

/// Where should part `p`'s segment end?
///
/// Walks forward from `start`, charging `−1` for an event that belongs to `p`
/// and `+1` for one that belongs to a part still to come; events of parts
/// already consumed are free, because they have been accounted for. The answer
/// is the position of least running cost — earliest on a tie, since the minimum
/// is only updated on a strict improvement.
fn optimal_split(
    events: &[ActivityId],
    part: usize,
    start: usize,
    consumed: &[bool],
    part_of: &impl Fn(ActivityId) -> usize,
) -> usize {
    let (mut best_pos, mut best_cost, mut cost) = (start, 0i64, 0i64);
    for (i, &e) in events.iter().enumerate().skip(start) {
        let p = part_of(e);
        if consumed[p] {
            // already placed in an earlier segment
        } else if p == part {
            cost -= 1;
        } else {
            cost += 1;
        }
        if cost < best_cost {
            best_cost = cost;
            best_pos = i + 1;
        }
    }
    best_pos
}

/// Straight projection: every trace appears in every sublog, restricted to that
/// part. Traces with no events of a part become empty traces, which is exactly
/// how an optional branch gets discovered further down.
fn split_parallel(log: &EventLog, k: usize, part_of: &impl Fn(ActivityId) -> usize) -> Vec<EventLog> {
    let mut out = vec![EventLog::new(); k];
    for v in &log.variants {
        for (p, sublog) in out.iter_mut().enumerate() {
            sublog.variants.push(Variant {
                events: v.events.iter().copied().filter(|&e| part_of(e) == p).collect(),
                count: v.count,
            });
        }
    }
    out
}

/// A trace is chopped into its maximal runs of one part.
///
/// Part 0 is the body: it starts "inside", so a trace beginning with a redo
/// event yields an empty body segment first — which is the evidence that the
/// body is skippable. Non-body parts start "outside", so they get no leading
/// empty segment, and a trace with none of their events is dropped rather than
/// contributed as empty.
fn split_loop(log: &EventLog, k: usize, part_of: &impl Fn(ActivityId) -> usize) -> Vec<EventLog> {
    let mut out = vec![EventLog::new(); k];
    for v in &log.variants {
        for p in 0..k {
            let is_body = p == 0;
            let mut segments: Vec<Vec<ActivityId>> = Vec::new();
            let mut current: Vec<ActivityId> = Vec::new();
            let mut last_in = is_body;
            let mut any_in = false;

            for &e in &v.events {
                if part_of(e) == p {
                    if !last_in && (is_body || any_in) {
                        segments.push(std::mem::take(&mut current));
                    }
                    last_in = true;
                    any_in = true;
                    current.push(e);
                } else {
                    last_in = false;
                }
            }
            segments.push(current);

            if !is_body && !any_in {
                continue;
            }
            for events in segments {
                out[p].variants.push(Variant {
                    events,
                    count: v.count,
                });
            }
        }
    }
    out
}
