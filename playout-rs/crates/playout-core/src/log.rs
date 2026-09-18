//! Simulated cases -> the columns of a traditional event log.
//!
//! Column names and shapes are the host's logical schema for a
//! `TraditionalEventLog` (`app/src/host/relational/schemas.ts`), which the
//! host checks this against before writing any storage. Numbers are `f64`
//! because that is what crosses the wasm boundary as a plain JS number;
//! microsecond timestamps stay exact well past the year 2200 in a double, and
//! the alternative (`i64` -> `BigInt`) would double the cost of every column
//! for no precision anyone gets to use.
//!
//! Two decisions here are worth more than their line count.
//!
//! **Events are interleaved across cases, not concatenated per case.** The log
//! is sorted by time, so case 2's first event sits between case 1's third and
//! fourth exactly as it would in a real log. Writing case after case would
//! produce a log in which nothing ever happens concurrently with anything —
//! and every metric about workload, waiting or resource contention computed
//! from it would be an artefact of the writing order.
//!
//! **Resources come in groups, not uniformly at random.** A pool assigned by
//! coin flip gives an organisational miner a complete graph with equal weights
//! — noise that looks like structure. Each activity is instead served by one
//! group of the pool, so handovers between activities are handovers between
//! groups, and a discovered organisational model has something real to find.

use crate::engine::{duration_us, Case, Execution, Outcome};
use crate::rng::Rng;
use crate::{Options, SimulatedCase, Stats};
use serde::Serialize;
use soundness_core::net::Net;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct EventColumns {
    pub event_idx: Vec<f64>,
    pub trace_idx: Vec<f64>,
    pub activity: Vec<String>,
    /// Epoch microseconds; the host turns these into real timestamps.
    pub ts: Vec<f64>,
    pub lifecycle: Vec<String>,
    /// Absent, rather than a column of empty strings, when no pool was asked
    /// for: a log without resources should not advertise `event.resource`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct CaseColumns {
    pub trace_idx: Vec<f64>,
    pub case_id: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct LogColumns {
    pub events: EventColumns,
    pub cases: CaseColumns,
}

pub struct Built {
    pub columns: LogColumns,
    pub stats: Stats,
}

/// Times a firing sequence that is already fixed — the extensive mode's case.
///
/// Sequential rather than the concurrent engine's overlap: the sequence came
/// from the untimed token game, where each transition's outputs appear the
/// instant it fires, so its order is the only order these executions are known
/// to be valid in. Giving them overlapping intervals would assert a
/// concurrency the enumeration never established.
pub fn time_sequence(
    net: &Net, sequence: &[usize], arrival_us: i64, rng: &mut Rng, options: &Options,
) -> Case {
    let mut now = arrival_us;
    let executions = sequence
        .iter()
        .map(|&transition| {
            let complete_us = now + duration_us(net, transition, rng, options);
            let execution = Execution { transition, start_us: now, complete_us };
            now = complete_us;
            execution
        })
        .collect();
    Case { executions, outcome: Outcome::Complete }
}

/// Which resources may perform which activity.
///
/// `groups` is the pool split as evenly as it goes; activity *k* (in order of
/// first appearance in the net) is served by group `k % groups`, and a
/// resource belongs to group `r % groups`. With a pool smaller than the
/// activity count the groups are shared, which is what a small team is.
struct Pool {
    names: Vec<String>,
    groups: usize,
}

impl Pool {
    fn new(size: usize, activity_count: usize) -> Option<Self> {
        if size == 0 || activity_count == 0 {
            return None;
        }
        let width = size.to_string().len();
        Some(Self {
            names: (0..size).map(|r| format!("Resource {:0width$}", r + 1, width = width)).collect(),
            groups: size.min(activity_count).max(1),
        })
    }

    fn pick(&self, activity: usize, rng: &mut Rng) -> String {
        let group = activity % self.groups;
        let members: Vec<usize> = (0..self.names.len()).filter(|r| r % self.groups == group).collect();
        self.names[members[rng.below(members.len())]].clone()
    }
}

/// One row of the log before it is sorted and flattened into columns.
struct Row {
    ts_us: i64,
    trace_idx: usize,
    /// Position of the execution within its case, to break a timestamp tie
    /// the way the simulation itself ordered them.
    step: usize,
    /// 0 = start, 1 = complete. A zero-duration activity's two events are
    /// still in the order they happened.
    phase: u8,
    activity: String,
    lifecycle: &'static str,
    resource: Option<String>,
}

pub fn build(net: &Net, cases: &[&SimulatedCase], options: &Options) -> Built {
    // Activity index in order of first appearance, which is what the resource
    // groups are keyed on. Two transitions carrying the same label are one
    // activity, as they are everywhere else in this codebase.
    let mut activity_index: HashMap<&str, usize> = HashMap::new();
    for label in net.labels.iter().flatten() {
        let next = activity_index.len();
        activity_index.entry(label.as_str()).or_insert(next);
    }
    let pool = Pool::new(options.resources, activity_index.len());
    // A resource stream of its own, drawn after the control flow: the same
    // net and seed then give the same traces whether or not a pool was asked
    // for, so turning resources on does not silently change the process.
    let mut resource_rng = Rng::new(options.seed ^ 0x5265_736F_7572_6365);

    let mut rows: Vec<Row> = Vec::new();
    let mut case_id: Vec<String> = Vec::with_capacity(cases.len());
    let mut trace_idx_column: Vec<f64> = Vec::with_capacity(cases.len());
    let width = cases.len().max(1).to_string().len();

    for (trace_idx, simulated) in cases.iter().enumerate() {
        case_id.push(format!("case_{:0width$}", trace_idx + 1, width = width));
        trace_idx_column.push(trace_idx as f64);

        for (step, execution) in simulated.case.executions.iter().enumerate() {
            let Some(label) = net.labels[execution.transition].as_deref() else {
                continue; // a silent transition is not an event
            };
            let resource = pool
                .as_ref()
                .map(|p| p.pick(activity_index[label], &mut resource_rng));
            if options.lifecycle == crate::Lifecycle::StartComplete {
                rows.push(Row {
                    ts_us: execution.start_us, trace_idx, step, phase: 0,
                    activity: label.to_string(), lifecycle: "start", resource: resource.clone(),
                });
            }
            rows.push(Row {
                ts_us: execution.complete_us, trace_idx, step, phase: 1,
                activity: label.to_string(), lifecycle: "complete", resource,
            });
        }
    }

    rows.sort_by_key(|r| (r.ts_us, r.trace_idx, r.step, r.phase));

    let mut events = EventColumns {
        event_idx: Vec::with_capacity(rows.len()),
        trace_idx: Vec::with_capacity(rows.len()),
        activity: Vec::with_capacity(rows.len()),
        ts: Vec::with_capacity(rows.len()),
        lifecycle: Vec::with_capacity(rows.len()),
        resource: pool.as_ref().map(|_| Vec::with_capacity(rows.len())),
    };
    for (i, row) in rows.iter().enumerate() {
        events.event_idx.push(i as f64);
        events.trace_idx.push(row.trace_idx as f64);
        events.activity.push(row.activity.clone());
        events.ts.push(row.ts_us as f64);
        events.lifecycle.push(row.lifecycle.to_string());
        if let Some(column) = events.resource.as_mut() {
            column.push(row.resource.clone().unwrap_or_default());
        }
    }

    // The variant of a case is the sequence of activities as the *log* shows
    // it — completions in time order — not the order the simulation happened
    // to start them in. That is what a miner reading this log will see.
    let variants: HashSet<Vec<&str>> = {
        // Seeded with every case, so a case that fired only silent
        // transitions counts as the empty trace — a variant a log genuinely
        // has, rather than a case that quietly went missing from the count.
        let mut per_case: HashMap<usize, Vec<&str>> =
            (0..cases.len()).map(|i| (i, Vec::new())).collect();
        for row in rows.iter().filter(|r| r.phase == 1) {
            per_case.entry(row.trace_idx).or_default().push(row.activity.as_str());
        }
        per_case.into_values().collect()
    };
    let activities: HashSet<&str> = rows.iter().map(|r| r.activity.as_str()).collect();

    Built {
        stats: Stats {
            cases: cases.len(),
            events: rows.len(),
            variants: variants.len(),
            activities: activities.len(),
            ..Stats::default()
        },
        columns: LogColumns {
            events,
            cases: CaseColumns { trace_idx: trace_idx_column, case_id },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{play_out, Lifecycle, Mode};
    use soundness_core::testing::fixtures;

    #[test]
    fn complete_only_is_one_event_per_activity() {
        let log = play_out(&fixtures::sequence(), &Options { traces: 3, ..Options::default() });
        assert_eq!(log.columns.events.activity.len(), 6);
        assert!(log.columns.events.lifecycle.iter().all(|l| l == "complete"));
        assert!(log.columns.events.resource.is_none());
    }

    #[test]
    fn start_and_complete_bracket_every_activity() {
        let options = Options { traces: 1, lifecycle: Lifecycle::StartComplete, ..Options::default() };
        let log = play_out(&fixtures::sequence(), &options);
        assert_eq!(log.columns.events.lifecycle, vec!["start", "complete", "start", "complete"]);
        // Each pair brackets a real duration, in order.
        let ts = &log.columns.events.ts;
        assert!(ts[0] <= ts[1] && ts[1] <= ts[2] && ts[2] <= ts[3]);
        assert!(ts[1] > ts[0], "an activity with a duration cannot start and finish at once");
    }

    #[test]
    fn events_are_interleaved_across_cases_in_time_order() {
        let log = play_out(&fixtures::sequence(), &Options { traces: 40, ..Options::default() });
        let ts = &log.columns.events.ts;
        assert!(ts.windows(2).all(|w| w[0] <= w[1]), "the log must be in time order");
        // With arrivals every ~15 minutes and activities taking ~10, cases
        // overlap — so the case column cannot be a run of 1s then a run of 2s.
        let traces = &log.columns.events.trace_idx;
        assert!(
            traces.windows(2).filter(|w| w[0] != w[1]).count() > log.stats.cases,
            "cases are concatenated, not interleaved"
        );
    }

    #[test]
    fn event_ids_are_dense_and_cases_are_all_declared() {
        let log = play_out(&fixtures::parallel(), &Options { traces: 12, ..Options::default() });
        let events = &log.columns.events;
        assert_eq!(events.event_idx, (0..events.event_idx.len()).map(|i| i as f64).collect::<Vec<_>>());
        let declared: HashSet<u64> = log.columns.cases.trace_idx.iter().map(|&t| t as u64).collect();
        assert!(events.trace_idx.iter().all(|&t| declared.contains(&(t as u64))));
        assert_eq!(log.columns.cases.case_id[0], "case_01");
    }

    #[test]
    fn a_resource_pool_serves_each_activity_from_its_own_group() {
        // Silent split and join, so the log has exactly two activities and
        // the pool of six splits evenly into two groups of three.
        let net = soundness_core::testing::build(
            6,
            &[("", &[0], &[1, 2]), ("A", &[1], &[3]), ("B", &[2], &[4]), ("", &[3, 4], &[5])],
            &[0],
            &[5],
        );
        let options = Options { traces: 60, resources: 6, ..Options::default() };
        let log = play_out(&net, &options);
        let events = &log.columns.events;
        let resources = events.resource.as_ref().unwrap();
        assert_eq!(resources.len(), events.activity.len());

        let mut per_activity: HashMap<&str, HashSet<&str>> = HashMap::new();
        for (activity, resource) in events.activity.iter().zip(resources) {
            per_activity.entry(activity).or_default().insert(resource);
        }
        // Two activities, six resources: three each, and no overlap — that
        // separation is what an organisational miner is meant to recover.
        let a = &per_activity["A"];
        let b = &per_activity["B"];
        assert_eq!(a.len(), 3);
        assert_eq!(b.len(), 3);
        assert!(a.is_disjoint(b), "{a:?} vs {b:?}");
    }

    #[test]
    fn asking_for_resources_does_not_change_the_traces() {
        let plain = play_out(&fixtures::parallel(), &Options { traces: 25, ..Options::default() });
        let staffed =
            play_out(&fixtures::parallel(), &Options { traces: 25, resources: 3, ..Options::default() });
        assert_eq!(plain.columns.events.activity, staffed.columns.events.activity);
        assert_eq!(plain.columns.events.ts, staffed.columns.events.ts);
    }

    #[test]
    fn an_extensive_case_is_timed_sequentially() {
        let options = Options { mode: Mode::Extensive, lifecycle: Lifecycle::StartComplete, ..Options::default() };
        let log = play_out(&fixtures::parallel(), &options);
        // Every activity of a case finishes before the next one starts: the
        // enumeration fixed the order, so nothing here may overlap.
        let events = &log.columns.events;
        for case in 0..log.stats.cases as u64 {
            let ts: Vec<f64> = events.ts.iter().zip(&events.trace_idx)
                .filter(|(_, &t)| t as u64 == case).map(|(&ts, _)| ts).collect();
            assert!(ts.windows(2).all(|w| w[0] <= w[1]));
        }
    }
}
