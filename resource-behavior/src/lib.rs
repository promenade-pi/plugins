//! Resource behaviour — how the people in a log actually work, rather than
//! who they work with.
//!
//! The organisational plugins beside this one answer questions about
//! *relations*: who hands to whom, who belongs with whom. This one answers
//! questions about one person at a time — how much they do, how fast, how
//! often they are doing several things at once, whether they batch their work,
//! and whether they slow down when busy.
//!
//! After Pika et al., *Mining Resource Profiles from Event Logs* (ACM TMIS
//! 2017) for the taxonomy, and Nakatumba & van der Aalst, *Analyzing Resource
//! Behavior Using Process Mining* (BPM 2009) for the workload-dependent
//! processing speed the last metric measures.
//!
//! # What needs a lifecycle, and what does not
//!
//! Half of these metrics are about *durations*, and a log with one timestamp
//! per event has none: a single `complete` event says when work finished, not
//! how long it took. The scan therefore uses the host's `activityLifecycle`
//! classifier, which folds the lifecycle value into the activity name, and
//! pairs `start` with `complete` to recover real work items.
//!
//! On a log without lifecycle values every event classifies as `complete`,
//! nothing pairs, and the duration metrics are **absent rather than
//! approximated**. The alternative — treating the gap since the previous event
//! in the case as service time — conflates waiting with working and would
//! report a resource as slow when the case simply sat in a queue. Counting
//! metrics (volume, spread, specialisation, batching, collaboration) need no
//! lifecycle and are always computed, so the plugin is still useful on such a
//! log; it just says which half is missing.
//!
//! # Attribution
//!
//! A work item whose `start` and `complete` name *different* people is not
//! attributed to either: the interval belongs to whoever was working, and the
//! log does not say when the handover happened. These are counted
//! (`transferredItems`) rather than silently split or assigned to the finisher.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use wasm_bindgen::prelude::*;

/// The host's `activityLifecycle` classifier joins activity and lifecycle with
/// this character — deliberately unprintable, so an activity genuinely called
/// "A · start" cannot be confused with the lifecycle event A/start.
const LIFECYCLE_SEPARATOR: char = '\u{1f}';

/// Buckets in the timeline. Past this the bucket widens automatically rather
/// than emitting a row nobody can read or a payload nobody needs.
const MAX_BUCKETS: usize = 400;
/// Points kept for the workload-versus-speed chart. Every work item is used
/// for the correlation; only the plotted sample is capped.
const MAX_SCATTER: usize = 4_000;

const MS_PER_SEC: f64 = 1_000.0;
const MS_PER_DAY: f64 = 86_400_000.0;

// -------------------------------------------------------------- the scan ---

#[derive(Clone, Copy)]
struct Event {
    case: u32,
    /// Base activity, with the lifecycle phase already split off.
    activity: u32,
    resource: u32,
    phase: Phase,
    ts: f64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase { Enqueue, Start, Complete }

/// One paired unit of work: someone started something and finished it.
#[derive(Clone, Copy)]
struct Item {
    resource: u32,
    start: f64,
    end: f64,
    /// Time the item sat between `enqueue` and `start`, when the log says.
    wait: Option<f64>,
}

#[derive(Default)]
struct BehaviorScan {
    n_activities: usize,
    activity_names: Vec<String>,
    resource_names: Vec<String>,
    /// Activity id → (base activity index, phase), resolved once from the
    /// names the host supplied.
    decoded: Vec<(u32, Phase)>,
    base_names: Vec<String>,
    events: Vec<Event>,
    rows: u32,
    cases: u32,
    last_case: i64,
    have_last: bool,
    unattributed: u32,
    undated: u32,
}

impl BehaviorScan {
    fn new(n_activities: usize) -> BehaviorScan {
        BehaviorScan { n_activities, last_case: i64::MIN, ..BehaviorScan::default() }
    }

    /// Splits every classified activity name into its base activity and phase,
    /// building a dense base-activity dictionary as it goes.
    fn decode_activities(&mut self) {
        let mut index: HashMap<String, u32> = HashMap::new();
        let mut base_names: Vec<String> = Vec::new();
        let mut decoded = Vec::with_capacity(self.activity_names.len());
        for name in &self.activity_names {
            let (base, phase) = match name.split_once(LIFECYCLE_SEPARATOR) {
                Some((base, "enqueue")) => (base, Phase::Enqueue),
                Some((base, "start")) => (base, Phase::Start),
                Some((base, _)) => (base, Phase::Complete),
                // A name with no separator means the host was not asked for
                // the lifecycle classifier. Treat it as a completed item.
                None => (name.as_str(), Phase::Complete),
            };
            // Owned keys: one clone per *distinct* activity, paid once before
            // the first chunk, in exchange for a map that cannot dangle.
            let id = match index.get(base) {
                Some(&id) => id,
                None => {
                    let id = base_names.len() as u32;
                    base_names.push(base.to_string());
                    index.insert(base.to_string(), id);
                    id
                }
            };
            decoded.push((id, phase));
        }
        self.base_names = base_names;
        self.decoded = decoded;
    }

    fn push_chunk(&mut self, cases: &[i32], activities: &[i32], timestamps: &[f64], resources: &[i32]) {
        let len = cases.len().min(activities.len()).min(resources.len()).min(timestamps.len());
        for i in 0..len {
            let case = cases[i] as i64;
            if !self.have_last || self.last_case != case { self.cases += 1; }
            self.last_case = case;
            self.have_last = true;

            let act = activities[i];
            if act < 0 || act as usize >= self.n_activities { continue; }
            let res = resources[i];
            if res < 0 { self.unattributed += 1; continue; }
            let ts = timestamps[i];
            // The host sends -1 for an event with no timestamp. Every metric
            // here is a statement about time, so such an event is counted and
            // dropped rather than placed at the epoch.
            if !(ts.is_finite() && ts >= 0.0) { self.undated += 1; continue; }

            let (activity, phase) = self.decoded.get(act as usize).copied().unwrap_or((0, Phase::Complete));
            self.events.push(Event { case: case as u32, activity, resource: res as u32, phase, ts });
        }
        self.rows += len as u32;
    }
}

// ------------------------------------------------------------ parameters ---

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
struct Params {
    bucket: Option<String>,
    batch_window_mins: Option<f64>,
    min_events: Option<u32>,
    max_resources: Option<u32>,
}

// ----------------------------------------------------------- wire format ---

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    resource: u32,
    // --- always available ---
    events: u32,
    activities: u32,
    cases: u32,
    /// Distinct other people who worked on a case this person also worked on.
    collaborators: u32,
    first_ms: f64,
    last_ms: f64,
    /// Calendar days on which this person did anything at all.
    active_days: u32,
    events_per_active_day: f64,
    /// The activity they perform most, and its share of their work.
    top_activity: Option<u32>,
    top_activity_share: f64,
    /// Shannon entropy of their activity mix, normalised to [0,1]. 0 means
    /// they only ever do one thing; 1 means they spread evenly over
    /// everything they touch.
    spread: f64,
    /// Share of this person's events that sit in a run of the same activity
    /// performed back to back within the batch window.
    batched_share: f64,
    mean_batch_size: f64,

    // --- only with a lifecycle; `null` otherwise ---
    /// Work items this person both started and finished.
    items: u32,
    mean_service_secs: Option<f64>,
    median_service_secs: Option<f64>,
    mean_wait_secs: Option<f64>,
    /// Time spent working, counting overlapping items once.
    busy_secs: Option<f64>,
    /// Summed item durations — larger than `busySecs` when they multitask.
    work_secs: Option<f64>,
    /// `busySecs` over the span between their first and last event.
    utilisation: Option<f64>,
    /// Share of busy time with more than one item in progress.
    multitasking_share: Option<f64>,
    /// Correlation between how many items this person had in progress when
    /// each one started and how long it then took. Positive means they slow
    /// down when busy — the Nakatumba & van der Aalst effect.
    workload_speed_r: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TimelineRow {
    resource: u32,
    /// Events per bucket, dense over `bucketCount`.
    counts: Vec<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    events: u32,
    cases: u32,
    resources: usize,
    resources_omitted: usize,
    events_without_resource: u32,
    events_without_timestamp: u32,
    /// True when the log carried lifecycle values the scan could pair.
    has_lifecycle: bool,
    items_paired: u32,
    /// Work items whose start and complete name different people, and which
    /// are therefore attributed to neither.
    transferred_items: u32,
    /// `start` events that never saw a matching `complete`.
    unfinished_items: u32,
    /// Correlation between workload and duration over every person's items
    /// pooled — the headline version of the per-person number.
    workload_speed_r: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceProfiles {
    resources: Vec<String>,
    activities: Vec<String>,
    profiles: Vec<Profile>,
    /// Bucket width actually used — widened from the requested one when the
    /// log spans more buckets than are worth drawing.
    bucket: String,
    bucket_ms: f64,
    bucket_start_ms: f64,
    bucket_count: usize,
    timeline: Vec<TimelineRow>,
    /// `(items in progress at start, duration in seconds, resource)`, sampled.
    scatter: Vec<(u32, f64, u32)>,
    stats: Stats,
}

// -------------------------------------------------------------- analysis ---

/// Union of a set of intervals, and the part of that union covered more than
/// once — busy time and multitasking time, from one sweep.
fn busy_and_overlap(intervals: &mut [(f64, f64)]) -> (f64, f64) {
    if intervals.is_empty() { return (0.0, 0.0); }
    // A boundary sweep: +1 opens an item, -1 closes one. Sorting the endpoints
    // rather than the intervals is what makes "covered at least twice"
    // computable in the same pass as "covered at all".
    let mut points: Vec<(f64, i32)> = Vec::with_capacity(intervals.len() * 2);
    for &(a, b) in intervals.iter() {
        if b > a { points.push((a, 1)); points.push((b, -1)); }
    }
    points.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| y.1.cmp(&x.1)));
    let mut depth = 0i32;
    let mut prev = 0.0f64;
    let (mut busy, mut overlap) = (0.0, 0.0);
    for (at, delta) in points {
        if depth >= 1 { busy += at - prev; }
        if depth >= 2 { overlap += at - prev; }
        depth += delta;
        prev = at;
    }
    (busy, overlap)
}

fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() { return None; }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = values.len() / 2;
    Some(if values.len() % 2 == 0 { (values[mid - 1] + values[mid]) / 2.0 } else { values[mid] })
}

/// Pearson correlation, or `None` when either side never varies — which is
/// the honest answer for someone who only ever had one item in progress.
fn pearson(xs: &[f64], ys: &[f64]) -> Option<f64> {
    let n = xs.len();
    if n < 3 || n != ys.len() { return None; }
    let (mx, my) = (xs.iter().sum::<f64>() / n as f64, ys.iter().sum::<f64>() / n as f64);
    let (mut num, mut dx, mut dy) = (0.0, 0.0, 0.0);
    for i in 0..n {
        let (a, b) = (xs[i] - mx, ys[i] - my);
        num += a * b; dx += a * a; dy += b * b;
    }
    if dx <= 0.0 || dy <= 0.0 { None } else { Some(num / (dx.sqrt() * dy.sqrt())) }
}

/// Normalised Shannon entropy of a distribution.
fn spread(counts: &[u32]) -> f64 {
    let total: u32 = counts.iter().sum();
    if total == 0 || counts.len() < 2 { return 0.0; }
    let mut h = 0.0;
    for &c in counts {
        if c == 0 { continue; }
        let p = c as f64 / total as f64;
        h -= p * p.ln();
    }
    (h / (counts.len() as f64).ln()).clamp(0.0, 1.0)
}

impl BehaviorScan {
    /// Keeps the most active people, by event count.
    fn kept_resources(&self, limit: usize, min_events: u32) -> (Vec<usize>, usize) {
        let n = self.resource_names.len().max(
            self.events.iter().map(|e| e.resource as usize + 1).max().unwrap_or(0));
        let mut counts = vec![0u32; n];
        for e in &self.events { counts[e.resource as usize] += 1; }
        let mut order: Vec<usize> = (0..n).filter(|&r| counts[r] >= min_events.max(1)).collect();
        let omitted_by_min = (0..n).filter(|&r| counts[r] > 0 && counts[r] < min_events.max(1)).count();
        order.sort_by(|&a, &b| counts[b].cmp(&counts[a]).then_with(|| a.cmp(&b)));
        let omitted = omitted_by_min + order.len().saturating_sub(limit);
        order.truncate(limit);
        order.sort_unstable();
        (order, omitted)
    }

    fn analyse(&self, p: &Params) -> ResourceProfiles {
        let limit = p.max_resources.unwrap_or(200).max(1) as usize;
        let min_events = p.min_events.unwrap_or(1);
        let (kept, omitted) = self.kept_resources(limit, min_events);

        let mut dense = HashMap::new();
        let mut names = Vec::with_capacity(kept.len());
        for (i, &r) in kept.iter().enumerate() {
            dense.insert(r as u32, i as u32);
            names.push(self.resource_names.get(r).cloned().unwrap_or_else(|| format!("#{r}")));
        }
        let n = names.len();
        let events: Vec<Event> = self.events.iter()
            .filter_map(|e| dense.get(&e.resource).map(|&r| Event { resource: r, ..*e }))
            .collect();

        let has_lifecycle = self.decoded.iter().any(|&(_, phase)| phase != Phase::Complete);
        let (items, transferred, unfinished) = pair_items(&events, has_lifecycle);

        // ---------------- counting metrics, always available ----------------
        let mut per_resource_events = vec![0u32; n];
        let mut activity_counts: Vec<HashMap<u32, u32>> = vec![HashMap::new(); n];
        let mut cases_of: Vec<HashSet<u32>> = vec![HashSet::new(); n];
        let mut days_of: Vec<HashSet<i64>> = vec![HashSet::new(); n];
        let mut first = vec![f64::INFINITY; n];
        let mut last = vec![f64::NEG_INFINITY; n];
        for e in &events {
            let r = e.resource as usize;
            per_resource_events[r] += 1;
            *activity_counts[r].entry(e.activity).or_insert(0) += 1;
            cases_of[r].insert(e.case);
            days_of[r].insert((e.ts / MS_PER_DAY).floor() as i64);
            if e.ts < first[r] { first[r] = e.ts; }
            if e.ts > last[r] { last[r] = e.ts; }
        }

        // Collaborators: everyone who touched a case this person also touched.
        let mut case_members: HashMap<u32, HashSet<u32>> = HashMap::new();
        for e in &events { case_members.entry(e.case).or_default().insert(e.resource); }
        let mut collaborators: Vec<HashSet<u32>> = vec![HashSet::new(); n];
        for members in case_members.values() {
            for &a in members {
                for &b in members {
                    if a != b { collaborators[a as usize].insert(b); }
                }
            }
        }

        let batch_window = p.batch_window_mins.unwrap_or(5.0).max(0.0) * 60.0 * MS_PER_SEC;
        let batching = batching_per_resource(&events, n, batch_window);

        // ---------------- duration metrics, lifecycle only ------------------
        let mut per_items: Vec<Vec<Item>> = vec![Vec::new(); n];
        for item in &items { per_items[item.resource as usize].push(*item); }

        let mut scatter: Vec<(u32, f64, u32)> = Vec::new();
        let mut pooled_load: Vec<f64> = Vec::new();
        let mut pooled_secs: Vec<f64> = Vec::new();

        let profiles: Vec<Profile> = (0..n).map(|r| {
            let counts: Vec<u32> = activity_counts[r].values().copied().collect();
            let top = activity_counts[r].iter()
                .max_by_key(|(activity, count)| (**count, std::cmp::Reverse(**activity)))
                .map(|(activity, count)| (*activity, *count));
            let total = per_resource_events[r].max(1) as f64;
            let active_days = days_of[r].len() as u32;

            let mine = &per_items[r];
            let (duration_metrics, load, secs) = if mine.is_empty() {
                (None, Vec::new(), Vec::new())
            } else {
                let (metrics, load, secs) = describe_items(mine);
                (Some(metrics), load, secs)
            };

            pooled_load.extend(load.iter().copied());
            pooled_secs.extend(secs.iter().copied());
            for i in 0..load.len() {
                scatter.push((load[i] as u32, secs[i], r as u32));
            }

            let span = (last[r] - first[r]).max(0.0);
            Profile {
                resource: r as u32,
                events: per_resource_events[r],
                activities: activity_counts[r].len() as u32,
                cases: cases_of[r].len() as u32,
                collaborators: collaborators[r].len() as u32,
                first_ms: if first[r].is_finite() { first[r] } else { 0.0 },
                last_ms: if last[r].is_finite() { last[r] } else { 0.0 },
                active_days,
                events_per_active_day: if active_days > 0 { total / active_days as f64 } else { 0.0 },
                top_activity: top.map(|(a, _)| a),
                top_activity_share: top.map(|(_, c)| c as f64 / total).unwrap_or(0.0),
                spread: spread(&counts),
                batched_share: batching[r].0,
                mean_batch_size: batching[r].1,
                items: mine.len() as u32,
                mean_service_secs: duration_metrics.as_ref().map(|m| m.mean_service),
                median_service_secs: duration_metrics.as_ref().and_then(|m| m.median_service),
                mean_wait_secs: duration_metrics.as_ref().and_then(|m| m.mean_wait),
                busy_secs: duration_metrics.as_ref().map(|m| m.busy),
                work_secs: duration_metrics.as_ref().map(|m| m.work),
                utilisation: duration_metrics.as_ref()
                    .map(|m| if span > 0.0 { (m.busy * MS_PER_SEC / span).clamp(0.0, 1.0) } else { 0.0 }),
                multitasking_share: duration_metrics.as_ref()
                    .map(|m| if m.busy > 0.0 { (m.overlap / m.busy).clamp(0.0, 1.0) } else { 0.0 }),
                workload_speed_r: pearson(&load, &secs),
            }
        }).collect();

        // Deterministic thinning: every nth point, so the sample keeps the
        // shape of the cloud rather than its first corner.
        if scatter.len() > MAX_SCATTER {
            let step = (scatter.len() as f64 / MAX_SCATTER as f64).ceil() as usize;
            scatter = scatter.into_iter().step_by(step.max(1)).collect();
        }

        let (bucket, bucket_ms, bucket_start, bucket_count, timeline) =
            build_timeline(&events, n, p.bucket.as_deref().unwrap_or("day"));

        ResourceProfiles {
            resources: names,
            activities: self.base_names.clone(),
            profiles,
            bucket, bucket_ms, bucket_start_ms: bucket_start, bucket_count, timeline,
            scatter,
            stats: Stats {
                events: self.rows,
                cases: self.cases,
                resources: n,
                resources_omitted: omitted,
                events_without_resource: self.unattributed,
                events_without_timestamp: self.undated,
                has_lifecycle,
                items_paired: items.len() as u32,
                transferred_items: transferred,
                unfinished_items: unfinished,
                workload_speed_r: pearson(&pooled_load, &pooled_secs),
            },
        }
    }
}

struct DurationMetrics {
    mean_service: f64,
    median_service: Option<f64>,
    mean_wait: Option<f64>,
    busy: f64,
    work: f64,
    overlap: f64,
}

/// Everything derivable from one person's work items, plus the paired
/// (workload, duration) series the correlation is computed over.
fn describe_items(items: &[Item]) -> (DurationMetrics, Vec<f64>, Vec<f64>) {
    let durations: Vec<f64> = items.iter().map(|i| (i.end - i.start) / MS_PER_SEC).collect();
    let work: f64 = durations.iter().sum();
    let mean_service = if durations.is_empty() { 0.0 } else { work / durations.len() as f64 };
    let median_service = median(&mut durations.clone());

    let waits: Vec<f64> = items.iter().filter_map(|i| i.wait).map(|w| w / MS_PER_SEC).collect();
    let mean_wait = if waits.is_empty() { None } else { Some(waits.iter().sum::<f64>() / waits.len() as f64) };

    let mut intervals: Vec<(f64, f64)> = items.iter().map(|i| (i.start, i.end)).collect();
    let (busy_ms, overlap_ms) = busy_and_overlap(&mut intervals);

    // Workload for an item is how many of this person's other items were
    // already in progress when it started — the operationalisation of "how
    // busy were they at that moment" that a log can actually support.
    let mut load = Vec::with_capacity(items.len());
    let mut secs = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let concurrent = items.iter().enumerate()
            .filter(|(j, other)| *j != i && other.start <= item.start && other.end > item.start)
            .count();
        load.push(concurrent as f64);
        secs.push((item.end - item.start) / MS_PER_SEC);
    }

    (
        DurationMetrics {
            mean_service, median_service, mean_wait,
            busy: busy_ms / MS_PER_SEC,
            work,
            overlap: overlap_ms / MS_PER_SEC,
        },
        load, secs,
    )
}

/// Pairs `start` with `complete` within one case and activity, and reads the
/// preceding `enqueue` as the item's waiting time.
///
/// Pairing is first-in-first-out inside a `(case, activity)` group: a loop
/// that runs the same activity twice produces two items, and the earlier start
/// belongs with the earlier completion. Anything else would need information
/// the log does not carry.
fn pair_items(events: &[Event], has_lifecycle: bool) -> (Vec<Item>, u32, u32) {
    if !has_lifecycle { return (Vec::new(), 0, 0); }

    let mut by_key: HashMap<(u32, u32), Vec<&Event>> = HashMap::new();
    for e in events { by_key.entry((e.case, e.activity)).or_default().push(e); }

    let mut items = Vec::new();
    let mut transferred = 0u32;
    let mut unfinished = 0u32;

    for group in by_key.values_mut() {
        group.sort_by(|a, b| a.ts.partial_cmp(&b.ts).unwrap_or(std::cmp::Ordering::Equal));
        let mut pending_enqueue: Vec<f64> = Vec::new();
        let mut pending_start: Vec<(f64, u32, Option<f64>)> = Vec::new();
        for e in group.iter() {
            match e.phase {
                Phase::Enqueue => pending_enqueue.push(e.ts),
                Phase::Start => {
                    let wait = if pending_enqueue.is_empty() { None }
                        else { Some(e.ts - pending_enqueue.remove(0)) };
                    pending_start.push((e.ts, e.resource, wait));
                }
                Phase::Complete => {
                    if pending_start.is_empty() { continue; }
                    let (start, resource, wait) = pending_start.remove(0);
                    if resource != e.resource {
                        // Started by one person and finished by another: the
                        // interval belongs to whoever was working, and the log
                        // does not say when it changed hands.
                        transferred += 1;
                        continue;
                    }
                    items.push(Item { resource, start, end: e.ts, wait });
                }
            }
        }
        unfinished += pending_start.len() as u32;
    }
    (items, transferred, unfinished)
}

/// Runs of the same activity performed back to back by one person, close
/// enough together in time to read as one sitting.
fn batching_per_resource(events: &[Event], n: usize, window_ms: f64) -> Vec<(f64, f64)> {
    let mut by_resource: Vec<Vec<&Event>> = vec![Vec::new(); n];
    for e in events { by_resource[e.resource as usize].push(e); }

    by_resource.iter_mut().map(|own| {
        if own.is_empty() { return (0.0, 0.0); }
        own.sort_by(|a, b| a.ts.partial_cmp(&b.ts).unwrap_or(std::cmp::Ordering::Equal));
        let mut batched = 0usize;
        let mut runs = 0usize;
        let mut run_total = 0usize;
        let mut i = 0usize;
        while i < own.len() {
            let mut j = i + 1;
            while j < own.len()
                && own[j].activity == own[i].activity
                && own[j].ts - own[j - 1].ts <= window_ms
            { j += 1; }
            let len = j - i;
            if len >= 2 { batched += len; runs += 1; run_total += len; }
            i = j;
        }
        (
            batched as f64 / own.len() as f64,
            if runs > 0 { run_total as f64 / runs as f64 } else { 0.0 },
        )
    }).collect()
}

/// Per-resource event counts over calendar buckets.
///
/// The requested width is widened, one step at a time, until the log's span
/// fits in `MAX_BUCKETS`. A month-long log asked for months would otherwise be
/// one column, and a five-year log asked for days would be two thousand — the
/// effective width is reported rather than assumed.
fn build_timeline(events: &[Event], n: usize, requested: &str)
    -> (String, f64, f64, usize, Vec<TimelineRow>)
{
    let widths: [(&str, f64); 4] = [
        ("hour", 3_600_000.0), ("day", MS_PER_DAY),
        ("week", MS_PER_DAY * 7.0), ("month", MS_PER_DAY * 30.0),
    ];
    let start_index = widths.iter().position(|(name, _)| *name == requested).unwrap_or(1);
    if events.is_empty() {
        let (name, ms) = widths[start_index];
        return (name.to_string(), ms, 0.0, 0, Vec::new());
    }

    let min_ts = events.iter().map(|e| e.ts).fold(f64::INFINITY, f64::min);
    let max_ts = events.iter().map(|e| e.ts).fold(f64::NEG_INFINITY, f64::max);
    let span = (max_ts - min_ts).max(1.0);

    let mut chosen = start_index;
    while chosen + 1 < widths.len() && (span / widths[chosen].1).ceil() as usize > MAX_BUCKETS {
        chosen += 1;
    }
    let (name, width) = widths[chosen];
    let start = (min_ts / width).floor() * width;
    let count = (((max_ts - start) / width).floor() as usize + 1).min(MAX_BUCKETS);

    let mut rows: Vec<TimelineRow> = (0..n)
        .map(|r| TimelineRow { resource: r as u32, counts: vec![0; count] })
        .collect();
    for e in events {
        let b = (((e.ts - start) / width).floor() as usize).min(count.saturating_sub(1));
        rows[e.resource as usize].counts[b] += 1;
    }
    (name.to_string(), width, start, count, rows)
}

// --------------------------------------------------------------- the kernel ---

/// The host's WASM scan ABI, with two optional parts this kernel needs: the
/// timestamp vector (every metric here is about time) and the dictionary-coded
/// resource column.
#[wasm_bindgen]
pub struct ResourceBehaviorScan { inner: BehaviorScan }

#[wasm_bindgen]
impl ResourceBehaviorScan {
    #[wasm_bindgen(constructor)]
    pub fn new(n_activities: usize) -> ResourceBehaviorScan {
        ResourceBehaviorScan { inner: BehaviorScan::new(n_activities) }
    }

    /// Called before the first chunk, which is what lets the lifecycle phase
    /// be split off the names once rather than per event.
    #[wasm_bindgen(js_name = setActivityNames)]
    pub fn set_activity_names(&mut self, names: Vec<String>) {
        self.inner.activity_names = names;
        self.inner.decode_activities();
    }

    #[wasm_bindgen(js_name = setResourceNames)]
    pub fn set_resource_names(&mut self, names: Vec<String>) {
        self.inner.resource_names = names;
    }

    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, cases: &[i32], activities: &[i32],
                      timestamps: &[f64], resources: &[i32]) {
        self.inner.push_chunk(cases, activities, timestamps, resources);
    }

    pub fn finish(&mut self) {}

    #[wasm_bindgen(js_name = rowCount)]
    pub fn row_count(&self) -> u32 { self.inner.rows }

    #[wasm_bindgen(js_name = caseCount)]
    pub fn case_count(&self) -> u32 { self.inner.cases }

    #[wasm_bindgen(js_name = finalize)]
    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: Params = serde_wasm_bindgen::from_value(params)
            .map_err(|e| JsValue::from_str(&format!("bad params: {e}")))?;
        serde_wasm_bindgen::to_value(&self.inner.analyse(&p))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: f64 = 3_600_000.0;

    /// Builds a scan from `(case, "activity/phase", resource, hours)` rows, so
    /// a test reads like the log it describes.
    fn scan(rows: &[(u32, &str, &str, f64)]) -> BehaviorScan {
        let mut activities: Vec<String> = Vec::new();
        let mut resources: Vec<String> = Vec::new();
        let id = |list: &mut Vec<String>, name: &str| -> i32 {
            if let Some(i) = list.iter().position(|x| x == name) { return i as i32; }
            list.push(name.to_string());
            list.len() as i32 - 1
        };
        let (mut cs, mut acts, mut ts, mut res) = (vec![], vec![], vec![], vec![]);
        for (case, activity, resource, hours) in rows {
            // "Review/start" becomes the host's classified name.
            let classified = match activity.split_once('/') {
                Some((base, phase)) => format!("{base}{LIFECYCLE_SEPARATOR}{phase}"),
                None => format!("{activity}{LIFECYCLE_SEPARATOR}complete"),
            };
            cs.push(*case as i32);
            acts.push(id(&mut activities, &classified));
            res.push(if resource.is_empty() { -1 } else { id(&mut resources, resource) });
            ts.push(hours * HOUR);
        }
        let mut s = BehaviorScan::new(activities.len());
        s.activity_names = activities;
        s.resource_names = resources;
        s.decode_activities();
        s.push_chunk(&cs, &acts, &ts, &res);
        s
    }

    fn profile<'a>(out: &'a ResourceProfiles, who: &str) -> &'a Profile {
        let i = out.resources.iter().position(|r| r == who).expect("resource in output");
        out.profiles.iter().find(|p| p.resource == i as u32).unwrap()
    }

    #[test]
    fn a_start_and_a_complete_make_one_work_item() {
        let s = scan(&[
            (1, "Review/start", "ann", 0.0),
            (1, "Review/complete", "ann", 2.0),
        ]);
        let out = s.analyse(&Params::default());
        assert!(out.stats.has_lifecycle);
        assert_eq!(out.stats.items_paired, 1);
        let ann = profile(&out, "ann");
        assert_eq!(ann.items, 1);
        assert_eq!(ann.mean_service_secs, Some(2.0 * 3600.0));
        assert_eq!(ann.busy_secs, Some(2.0 * 3600.0));
        assert_eq!(ann.multitasking_share, Some(0.0));
    }

    #[test]
    fn a_log_without_lifecycle_reports_no_durations_rather_than_guessing() {
        // Every event is a bare completion, which is what a log with no
        // lifecycle extension looks like after classification.
        let s = scan(&[
            (1, "Review", "ann", 0.0), (1, "Approve", "bob", 3.0),
            (2, "Review", "ann", 5.0),
        ]);
        let out = s.analyse(&Params::default());
        assert!(!out.stats.has_lifecycle);
        assert_eq!(out.stats.items_paired, 0);
        let ann = profile(&out, "ann");
        assert_eq!(ann.items, 0);
        assert_eq!(ann.mean_service_secs, None, "a gap between events is not a service time");
        assert_eq!(ann.utilisation, None);
        assert_eq!(ann.multitasking_share, None);
        // The counting metrics still work, which is the point of degrading
        // rather than refusing.
        assert_eq!(ann.events, 2);
        assert_eq!(ann.cases, 2);
        assert_eq!(ann.activities, 1);
    }

    #[test]
    fn overlapping_items_are_counted_once_for_busy_time_and_flagged_as_multitasking() {
        // Two items, each two hours, overlapping by one.
        let s = scan(&[
            (1, "Review/start", "ann", 0.0),
            (2, "Approve/start", "ann", 1.0),
            (1, "Review/complete", "ann", 2.0),
            (2, "Approve/complete", "ann", 3.0),
        ]);
        let out = s.analyse(&Params::default());
        let ann = profile(&out, "ann");
        assert_eq!(ann.items, 2);
        assert_eq!(ann.work_secs, Some(4.0 * 3600.0), "summed durations");
        assert_eq!(ann.busy_secs, Some(3.0 * 3600.0), "union of intervals");
        // One of the three busy hours had two items open.
        assert!((ann.multitasking_share.unwrap() - 1.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn utilisation_is_busy_time_over_the_span_worked() {
        // One hour of work inside a four-hour span.
        let s = scan(&[
            (1, "Review/start", "ann", 0.0),
            (1, "Review/complete", "ann", 1.0),
            (2, "Review/start", "ann", 3.0),
            (2, "Review/complete", "ann", 4.0),
        ]);
        let out = s.analyse(&Params::default());
        let ann = profile(&out, "ann");
        // Busy two hours across a four-hour span.
        assert!((ann.utilisation.unwrap() - 0.5).abs() < 1e-9, "got {:?}", ann.utilisation);
    }

    #[test]
    fn an_item_handed_over_midway_is_attributed_to_nobody() {
        let s = scan(&[
            (1, "Review/start", "ann", 0.0),
            (1, "Review/complete", "bob", 2.0),
        ]);
        let out = s.analyse(&Params::default());
        assert_eq!(out.stats.items_paired, 0);
        assert_eq!(out.stats.transferred_items, 1);
        assert_eq!(profile(&out, "ann").items, 0);
        assert_eq!(profile(&out, "bob").items, 0);
    }

    #[test]
    fn a_start_with_no_completion_is_counted_not_dropped() {
        let s = scan(&[
            (1, "Review/start", "ann", 0.0),
            (1, "Approve/start", "ann", 1.0),
            (1, "Approve/complete", "ann", 2.0),
        ]);
        let out = s.analyse(&Params::default());
        assert_eq!(out.stats.items_paired, 1);
        assert_eq!(out.stats.unfinished_items, 1);
    }

    #[test]
    fn waiting_time_comes_from_the_enqueue_before_the_start() {
        let s = scan(&[
            (1, "Review/enqueue", "ann", 0.0),
            (1, "Review/start", "ann", 1.0),
            (1, "Review/complete", "ann", 2.0),
        ]);
        let out = s.analyse(&Params::default());
        let ann = profile(&out, "ann");
        assert_eq!(ann.mean_wait_secs, Some(3600.0));
        assert_eq!(ann.mean_service_secs, Some(3600.0));
    }

    #[test]
    fn a_loop_produces_one_item_per_pass_paired_in_order() {
        let s = scan(&[
            (1, "Review/start", "ann", 0.0),
            (1, "Review/complete", "ann", 1.0),
            (1, "Review/start", "ann", 4.0),
            (1, "Review/complete", "ann", 5.0),
        ]);
        let out = s.analyse(&Params::default());
        assert_eq!(out.stats.items_paired, 2);
        let ann = profile(&out, "ann");
        assert_eq!(ann.items, 2);
        assert_eq!(ann.mean_service_secs, Some(3600.0));
    }

    #[test]
    fn work_done_back_to_back_reads_as_a_batch() {
        // Four reviews within a few minutes, then one much later.
        let s = scan(&[
            (1, "Review", "ann", 0.0),
            (2, "Review", "ann", 0.01),
            (3, "Review", "ann", 0.02),
            (4, "Review", "ann", 0.03),
            (5, "Review", "ann", 10.0),
        ]);
        let out = s.analyse(&Params { batch_window_mins: Some(5.0), ..Params::default() });
        let ann = profile(&out, "ann");
        assert!((ann.batched_share - 0.8).abs() < 1e-9, "got {}", ann.batched_share);
        assert!((ann.mean_batch_size - 4.0).abs() < 1e-9);

        // A window short enough to separate them makes the batch disappear —
        // the metric is a statement about the window, and says so.
        let tight = s.analyse(&Params { batch_window_mins: Some(0.1), ..Params::default() });
        assert_eq!(profile(&tight, "ann").batched_share, 0.0);
    }

    #[test]
    fn spread_separates_a_specialist_from_a_generalist() {
        let s = scan(&[
            (1, "Review", "spec", 0.0), (2, "Review", "spec", 1.0),
            (3, "Review", "spec", 2.0), (4, "Review", "spec", 3.0),
            (1, "Review", "gen", 4.0), (2, "Approve", "gen", 5.0),
            (3, "File", "gen", 6.0), (4, "Escalate", "gen", 7.0),
        ]);
        let out = s.analyse(&Params::default());
        assert_eq!(profile(&out, "spec").spread, 0.0, "one activity only");
        assert_eq!(profile(&out, "spec").top_activity_share, 1.0);
        assert!((profile(&out, "gen").spread - 1.0).abs() < 1e-9, "four activities, evenly");
        assert!((profile(&out, "gen").top_activity_share - 0.25).abs() < 1e-9);
    }

    #[test]
    fn collaborators_are_the_people_met_on_a_case() {
        let s = scan(&[
            (1, "Review", "ann", 0.0), (1, "Approve", "bob", 1.0),
            (2, "Review", "ann", 2.0), (2, "Approve", "cat", 3.0),
            (3, "Review", "dan", 4.0),
        ]);
        let out = s.analyse(&Params::default());
        assert_eq!(profile(&out, "ann").collaborators, 2, "bob and cat");
        assert_eq!(profile(&out, "bob").collaborators, 1);
        assert_eq!(profile(&out, "dan").collaborators, 0, "worked alone");
    }

    #[test]
    fn working_more_slowly_when_busier_shows_up_as_a_positive_correlation() {
        // Items that overlap more take longer, which is the effect the metric
        // exists to find.
        let mut rows: Vec<(u32, String, String, f64)> = Vec::new();
        let mut case = 1u32;
        for round in 0..8 {
            // `round` items open at once; each takes `round + 1` hours.
            let base = round as f64 * 100.0;
            for k in 0..=round {
                rows.push((case, "Review/start".into(), "ann".into(), base + k as f64 * 0.01));
                rows.push((case, "Review/complete".into(), "ann".into(),
                           base + k as f64 * 0.01 + (round + 1) as f64));
                case += 1;
            }
        }
        let borrowed: Vec<(u32, &str, &str, f64)> = rows.iter()
            .map(|(c, a, r, t)| (*c, a.as_str(), r.as_str(), *t)).collect();
        let s = scan(&borrowed);
        let out = s.analyse(&Params::default());
        let r = profile(&out, "ann").workload_speed_r.expect("enough items to correlate");
        assert!(r > 0.5, "expected a clear positive correlation, got {r}");
        assert!(out.stats.workload_speed_r.unwrap() > 0.5);
    }

    #[test]
    fn the_timeline_widens_its_bucket_rather_than_emitting_thousands() {
        // Twenty years of daily work: days would be seven thousand buckets.
        let mut rows: Vec<(u32, &str, &str, f64)> = Vec::new();
        for d in 0..(20 * 365) {
            rows.push((d as u32, "Review", "ann", d as f64 * 24.0));
        }
        let s = scan(&rows);
        let out = s.analyse(&Params { bucket: Some("day".into()), ..Params::default() });
        assert_ne!(out.bucket, "day", "the requested width could not fit");
        assert!(out.bucket_count <= MAX_BUCKETS, "got {}", out.bucket_count);
        // Nothing is lost by widening: every event still lands in a bucket.
        let total: u32 = out.timeline.iter().flat_map(|row| row.counts.iter()).sum();
        assert_eq!(total, 20 * 365);
    }

    #[test]
    fn the_timeline_accounts_for_every_event_it_was_given() {
        let s = scan(&[
            (1, "Review", "ann", 0.0), (1, "Approve", "bob", 30.0),
            (2, "Review", "ann", 60.0),
        ]);
        let out = s.analyse(&Params { bucket: Some("day".into()), ..Params::default() });
        assert_eq!(out.bucket, "day");
        let total: u32 = out.timeline.iter().flat_map(|r| r.counts.iter()).sum();
        assert_eq!(total, 3);
        assert_eq!(out.timeline.len(), out.profiles.len());
        for row in &out.timeline {
            assert_eq!(row.counts.len(), out.bucket_count);
        }
    }

    #[test]
    fn events_nobody_or_no_clock_accounts_for_are_reported_not_hidden() {
        let mut s = scan(&[(1, "Review", "ann", 1.0)]);
        // One event with no resource, one with no timestamp.
        s.push_chunk(&[1, 1], &[0, 0], &[2.0 * HOUR, -1.0], &[-1, 0]);
        let out = s.analyse(&Params::default());
        assert_eq!(out.stats.events_without_resource, 1);
        assert_eq!(out.stats.events_without_timestamp, 1);
        assert_eq!(profile(&out, "ann").events, 1);
    }

    #[test]
    fn a_minimum_event_count_drops_the_occasional_visitor_and_says_so() {
        let s = scan(&[
            (1, "Review", "ann", 0.0), (2, "Review", "ann", 1.0), (3, "Review", "ann", 2.0),
            (4, "Review", "rare", 3.0),
        ]);
        let out = s.analyse(&Params { min_events: Some(2), ..Params::default() });
        assert_eq!(out.resources, vec!["ann"]);
        assert_eq!(out.stats.resources_omitted, 1);
    }

    // -------------------------------------------- randomised invariants ---

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0
        }
        fn unit(&mut self) -> f64 { (self.next() % 1_000_000) as f64 / 1_000_000.0 }
        fn below(&mut self, n: usize) -> usize { (self.next() % n as u64) as usize }
    }

    fn random_scan(rng: &mut Rng, lifecycle: bool) -> BehaviorScan {
        let people = ["ann", "bob", "cat", "dan"];
        let acts = ["Review", "Approve", "File"];
        let mut rows: Vec<(u32, String, String, f64)> = Vec::new();
        let cases = 1 + rng.below(20);
        for case in 0..cases {
            let mut t = rng.unit() * 100.0;
            for _ in 0..(1 + rng.below(5)) {
                let who = people[rng.below(people.len())].to_string();
                let act = acts[rng.below(acts.len())];
                if lifecycle && rng.unit() < 0.8 {
                    rows.push((case as u32, format!("{act}/start"), who.clone(), t));
                    t += rng.unit() * 3.0;
                    // Occasionally leave it unfinished, or finish it as someone
                    // else — both happen in real logs.
                    let finisher = if rng.unit() < 0.1 {
                        people[rng.below(people.len())].to_string()
                    } else { who };
                    if rng.unit() < 0.9 {
                        rows.push((case as u32, format!("{act}/complete"), finisher, t));
                    }
                } else {
                    rows.push((case as u32, act.to_string(), who, t));
                }
                t += rng.unit() * 5.0;
            }
        }
        let borrowed: Vec<(u32, &str, &str, f64)> = rows.iter()
            .map(|(c, a, r, t)| (*c, a.as_str(), r.as_str(), *t)).collect();
        scan(&borrowed)
    }

    #[test]
    fn every_profile_is_internally_consistent() {
        for seed in 1..200u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
            let lifecycle = seed % 2 == 0;
            let s = random_scan(&mut rng, lifecycle);
            let out = s.analyse(&Params { bucket: Some("day".into()), ..Params::default() });
            let where_ = format!("seed {seed}, lifecycle {lifecycle}");

            let mut total_events = 0u32;
            for p in &out.profiles {
                total_events += p.events;
                assert!(p.events > 0, "{where_}: a profile with no events");
                assert!(p.activities > 0 && p.cases > 0, "{where_}");
                assert!(p.last_ms >= p.first_ms, "{where_}");
                assert!((0.0..=1.0).contains(&p.top_activity_share), "{where_}: {}", p.top_activity_share);
                assert!((0.0..=1.0).contains(&p.spread), "{where_}: {}", p.spread);
                assert!((0.0..=1.0).contains(&p.batched_share), "{where_}: {}", p.batched_share);
                assert!(p.collaborators < out.resources.len() as u32, "{where_}");

                // Duration metrics are all-or-nothing: a profile never reports
                // some of them and not the others.
                let have: Vec<bool> = vec![
                    p.mean_service_secs.is_some(), p.busy_secs.is_some(),
                    p.work_secs.is_some(), p.utilisation.is_some(),
                    p.multitasking_share.is_some(),
                ];
                assert!(have.iter().all(|x| *x) || have.iter().all(|x| !*x),
                    "{where_}: partially reported durations for resource {}", p.resource);

                if let (Some(busy), Some(work)) = (p.busy_secs, p.work_secs) {
                    assert!(busy <= work + 1e-6,
                        "{where_}: busy {busy} exceeds summed work {work}");
                    assert!(busy >= 0.0 && work >= 0.0, "{where_}");
                }
                if let Some(u) = p.utilisation { assert!((0.0..=1.0).contains(&u), "{where_}: {u}"); }
                if let Some(m) = p.multitasking_share { assert!((0.0..=1.0).contains(&m), "{where_}: {m}"); }
                if let Some(r) = p.workload_speed_r {
                    assert!((-1.0..=1.0).contains(&r), "{where_}: r {r}");
                }
                assert_eq!(p.items > 0, p.busy_secs.is_some(),
                    "{where_}: durations reported exactly when there are items");
            }

            // The timeline is a complete accounting of the same events.
            let timeline_total: u32 = out.timeline.iter().flat_map(|r| r.counts.iter()).sum();
            assert_eq!(timeline_total, total_events, "{where_}: timeline lost events");
            assert_eq!(out.timeline.len(), out.profiles.len(), "{where_}");

            // Scatter points reference real people and real durations.
            for &(load, secs, resource) in &out.scatter {
                assert!((resource as usize) < out.resources.len(), "{where_}");
                assert!(secs >= 0.0 && secs.is_finite(), "{where_}: {secs}");
                assert!(load < out.stats.items_paired.max(1), "{where_}");
            }
            assert!(out.scatter.len() <= MAX_SCATTER, "{where_}");
        }
    }

    #[test]
    fn busy_time_never_exceeds_the_span_it_happened_in() {
        for seed in 1..150u64 {
            let mut rng = Rng(seed.wrapping_mul(0x2545_F491_4F6C_DD1D));
            let s = random_scan(&mut rng, true);
            let out = s.analyse(&Params::default());
            for p in &out.profiles {
                let Some(busy) = p.busy_secs else { continue };
                let span = (p.last_ms - p.first_ms) / MS_PER_SEC;
                assert!(busy <= span + 1e-6,
                    "seed {seed}: resource {} busy {busy}s inside a {span}s span", p.resource);
            }
        }
    }

    #[test]
    fn the_interval_sweep_matches_a_brute_force_measure() {
        // Busy and overlap time are the one piece of geometry here, so they
        // are checked against the obvious slow version on random intervals.
        for seed in 1..200u64 {
            let mut rng = Rng(seed.wrapping_mul(0xD1B5_4A32_D192_ED03));
            let count = 1 + rng.below(8);
            let intervals: Vec<(f64, f64)> = (0..count).map(|_| {
                let a = (rng.below(40)) as f64;
                let b = a + 1.0 + (rng.below(10)) as f64;
                (a, b)
            }).collect();
            let (busy, overlap) = busy_and_overlap(&mut intervals.clone());

            // Sample every unit of the timeline and count coverage directly.
            let (mut brute_busy, mut brute_overlap) = (0.0, 0.0);
            for t in 0..60 {
                let at = t as f64 + 0.5;
                let depth = intervals.iter().filter(|(a, b)| *a <= at && at < *b).count();
                if depth >= 1 { brute_busy += 1.0; }
                if depth >= 2 { brute_overlap += 1.0; }
            }
            assert!((busy - brute_busy).abs() < 1e-9, "seed {seed}: busy {busy} vs {brute_busy}");
            assert!((overlap - brute_overlap).abs() < 1e-9,
                "seed {seed}: overlap {overlap} vs {brute_overlap}");
        }
    }
}
