//! Social network mining — who works with whom, derived from a log alone.
//!
//! Every metric here answers the same shape of question with a different
//! relation: given the people named in the log, how strongly is each pair
//! connected, and in which direction. The output is always one weighted
//! directed graph over resources, which is what lets five quite different
//! derivations share one artifact type and one renderer.
//!
//! After van der Aalst, Reijers & Song, *Discovering Social Networks from
//! Event Logs* (CSCW 2005) and van der Aalst & Song, *Mining Social Networks*
//! (BPM 2004).
//!
//! # The metrics
//!
//! **Handover of work** — inside one case, a does something and then b does
//! the next thing: a handed work to b. The basic relation, and the one that
//! recovers an organisation's actual routing rather than its org chart.
//!
//! **Subcontracting** — a ... b ... a: work went out to b and came back. Reads
//! as delegation rather than as a step forward.
//!
//! **Working together** — how often two people appear in the same case at
//! all. Undirected, and the only metric here that ignores order entirely.
//!
//! **Reassignment** — a and b both perform the *same* activity in one case,
//! a first. Work that was handed back to be redone, or passed up.
//!
//! **Similar task** — not a relation inside a case at all: two people are
//! close if they do the *same kind of work*, measured over their whole
//! activity profiles. Two resources who never share a case can score 1.0 here,
//! which is the point — it finds roles, not routes.
//!
//! # Two parameters that change what the numbers mean
//!
//! `maxDistance` and `beta` generalise "directly followed by" into "followed
//! by, within n steps, discounted by beta per step". At `maxDistance = 1` the
//! relation is strict succession; beyond it, a handover survives an
//! intervening step by someone else, weighted less. This matters on real logs
//! where an automated step sits between two people.
//!
//! `multipleTransfers` decides whether a pair that co-occurs ten times in one
//! long case counts ten times or once. Off — once per case — is the safer
//! default: otherwise a single pathological case can dominate the whole
//! network.
//!
//! # Unattributed events
//!
//! An event with no resource is dropped from the sequence rather than
//! breaking it, so a → (nobody) → b is a handover from a to b at distance 1,
//! not a broken chain. The alternative — treating "nobody" as a participant —
//! would invent a person who does not exist and route half the network
//! through them. The count is reported (`eventsWithoutResource`) so the
//! omission is never silent.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use wasm_bindgen::prelude::*;

/// Resources kept, most active first. The host already caps the dictionary it
/// hands over, but that cap is about transfer size; this one is about a graph
/// a person can read. Everything past it is reported, not hidden.
const DEFAULT_MAX_RESOURCES: usize = 200;

// -------------------------------------------------------------- the scan ---

/// One case's attributed events, in log order.
type CaseSeq = Vec<(u32, u32)>; // (activity, resource)

/// The shared scan: one pass over the ordered event stream, building one
/// (activity, resource) sequence per case.
///
/// Both actions this package ships scan identically and differ only in what
/// `finalize` computes, the same arrangement the Conformance Checking package
/// uses for its two kernels.
#[derive(Default)]
struct SocialScan {
    n_activities: usize,
    activity_names: Vec<String>,
    resource_names: Vec<String>,
    cases: Vec<CaseSeq>,
    cur: CaseSeq,
    last_case: i64,
    have_last: bool,
    rows: u32,
    case_count: u32,
    /// Events dropped because nothing in the log says who did them.
    unattributed: u32,
}

impl SocialScan {
    fn new(n_activities: usize) -> SocialScan {
        SocialScan { n_activities, last_case: i64::MIN, ..SocialScan::default() }
    }

    fn push_chunk(&mut self, cases: &[i32], activities: &[i32], resources: &[i32]) {
        let len = cases.len().min(activities.len()).min(resources.len());
        for i in 0..len {
            let case = cases[i] as i64;
            let act = activities[i];
            let res = resources[i];

            if !self.have_last || self.last_case != case {
                if self.have_last { self.cases.push(std::mem::take(&mut self.cur)); }
                self.case_count += 1;
            }
            self.last_case = case;
            self.have_last = true;

            // A synthetic empty-trace row (activity -1) is not an event and is
            // not unattributed work; it only says the case exists.
            if act < 0 || act as usize >= self.n_activities { continue; }
            if res < 0 {
                self.unattributed += 1;
                continue;
            }
            self.cur.push((act as u32, res as u32));
        }
        self.rows += len as u32;
    }

    fn finish(&mut self) {
        if self.have_last {
            self.cases.push(std::mem::take(&mut self.cur));
            self.have_last = false;
        }
    }
}

// ------------------------------------------------------------ parameters ---

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
struct Params {
    metric: Option<String>,
    similarity: Option<String>,
    max_distance: Option<u32>,
    beta: Option<f64>,
    multiple_transfers: Option<bool>,
    ignore_self_loops: Option<bool>,
    min_weight: Option<f64>,
    max_resources: Option<u32>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Metric {
    Handover,
    Subcontracting,
    WorkingTogether,
    Reassignment,
}

impl Metric {
    fn parse(s: &str) -> Metric {
        match s {
            "subcontracting" => Metric::Subcontracting,
            "workingTogether" => Metric::WorkingTogether,
            "reassignment" => Metric::Reassignment,
            _ => Metric::Handover,
        }
    }
    fn is_directed(self) -> bool { self != Metric::WorkingTogether }
    fn id(self) -> &'static str {
        match self {
            Metric::Handover => "handover",
            Metric::Subcontracting => "subcontracting",
            Metric::WorkingTogether => "workingTogether",
            Metric::Reassignment => "reassignment",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Similarity { Pearson, Cosine, Euclidean }

impl Similarity {
    fn parse(s: &str) -> Similarity {
        match s {
            "cosine" => Similarity::Cosine,
            "euclidean" => Similarity::Euclidean,
            _ => Similarity::Pearson,
        }
    }
    fn id(self) -> &'static str {
        match self {
            Similarity::Pearson => "pearson",
            Similarity::Cosine => "cosine",
            Similarity::Euclidean => "euclidean",
        }
    }
}

// ----------------------------------------------------------- wire format ---

/// How many activities a node names in its emitted profile.
///
/// The profile exists so a *consumer* can say what someone does — the
/// Organizational Model plugin labels a role by its members' dominant work.
/// A person's identity is in the handful of activities they actually perform;
/// the tail labels nothing and would make the payload grow with the product
/// of the two dictionaries. The similarity metrics still use the complete
/// profile internally — only what is written out is capped.
const PROFILE_ACTIVITIES: usize = 64;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeOut {
    resource: u32,
    /// Events this resource performed, over the whole log.
    events: u32,
    /// Cases this resource appears in.
    cases: u32,
    /// Distinct activities this resource ever performed.
    activities: u32,
    /// `(activity index, times performed)`, most frequent first, capped at
    /// `PROFILE_ACTIVITIES`. Indexes `SocialNetwork::activities`.
    profile: Vec<(u32, u32)>,
    /// Summed outgoing and incoming edge weight — a person's share of the
    /// relation in each direction. For an undirected metric the two are equal.
    out_weight: f64,
    in_weight: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EdgeOut {
    from: u32,
    to: u32,
    /// Normalised weight, in the unit `weightKind` names.
    weight: f64,
    /// What was actually counted, before normalisation — the number a reader
    /// can check by hand against the log.
    raw: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    cases: u32,
    events: u32,
    events_without_resource: u32,
    resources_total: usize,
    resources_omitted: usize,
    edges_before_pruning: usize,
    self_loops_dropped: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SocialNetwork {
    /// Which derivation produced this — the view labels itself from it, and
    /// two networks are only comparable when it matches.
    metric: String,
    /// How to read `edges[].weight`:
    ///   `share`      — the pair's fraction of every transfer counted, sums to 1
    ///   `ratio`      — a per-pair ratio in [0,1], independent of the rest
    ///   `similarity` — a correlation or cosine, already in [-1,1] or [0,1]
    weight_kind: String,
    /// False for working-together and similar-task: the relation has no
    /// direction and each pair is emitted once, not twice.
    directed: bool,
    resources: Vec<String>,
    /// The activity dictionary `nodes[].profile` indexes. Empty when the host
    /// did not supply names (it is an optional part of the scan ABI).
    activities: Vec<String>,
    nodes: Vec<NodeOut>,
    edges: Vec<EdgeOut>,
    stats: Stats,
}

// ------------------------------------------------------------ the mining ---

/// Accumulates a weighted directed relation over resource indices.
#[derive(Default)]
struct Relation {
    weights: HashMap<(u32, u32), f64>,
    self_loops: usize,
}

impl Relation {
    fn add(&mut self, from: u32, to: u32, w: f64, ignore_self_loops: bool) {
        if from == to {
            self.self_loops += 1;
            if ignore_self_loops { return; }
        }
        *self.weights.entry((from, to)).or_insert(0.0) += w;
    }
}

/// Per-resource involvement, needed by every metric for the node sizes and by
/// working-together for its denominator.
struct Involvement {
    events: Vec<u32>,
    cases: Vec<u32>,
    activities: Vec<HashSet<u32>>,
    /// Activity-frequency profile, resource-major — the similar-task input.
    profile: Vec<Vec<f64>>,
}

impl Involvement {
    fn collect(scan: &SocialScan, n_resources: usize) -> Involvement {
        let mut inv = Involvement {
            events: vec![0; n_resources],
            cases: vec![0; n_resources],
            activities: vec![HashSet::new(); n_resources],
            profile: vec![vec![0.0; scan.n_activities]; n_resources],
        };
        for case in &scan.cases {
            let mut seen: HashSet<u32> = HashSet::new();
            for &(activity, resource) in case {
                let r = resource as usize;
                if r >= n_resources { continue; }
                inv.events[r] += 1;
                inv.activities[r].insert(activity);
                if (activity as usize) < scan.n_activities {
                    inv.profile[r][activity as usize] += 1.0;
                }
                if seen.insert(resource) { inv.cases[r] += 1; }
            }
        }
        inv
    }
}

impl SocialScan {
    /// Resources kept, and the events-per-resource table the ranking used.
    ///
    /// Truncation is by activity, not by identity: the people who barely
    /// appear are the ones whose absence changes the picture least. Their
    /// events are then treated exactly like unattributed ones — dropped from
    /// the sequence rather than routed through a phantom node.
    fn kept_resources(&self, limit: usize) -> (Vec<usize>, usize) {
        let n = self.resource_names.len().max(
            self.cases.iter().flatten().map(|&(_, r)| r as usize + 1).max().unwrap_or(0),
        );
        let mut counts = vec![0u32; n];
        for case in &self.cases {
            for &(_, r) in case {
                if (r as usize) < n { counts[r as usize] += 1; }
            }
        }
        let mut order: Vec<usize> = (0..n).filter(|&r| counts[r] > 0).collect();
        order.sort_by(|&a, &b| counts[b].cmp(&counts[a]).then_with(|| a.cmp(&b)));
        let omitted = order.len().saturating_sub(limit);
        order.truncate(limit);
        // Back to log order so the output is stable and readable rather than
        // permuted by frequency.
        order.sort_unstable();
        (order, omitted)
    }

    /// Restricts every case sequence to the kept resources, renumbering them
    /// into a dense 0..k index.
    fn projected(&self, kept: &[usize]) -> (Vec<CaseSeq>, Vec<String>, u32) {
        let mut index = HashMap::new();
        let mut names = Vec::with_capacity(kept.len());
        for (dense, &r) in kept.iter().enumerate() {
            index.insert(r as u32, dense as u32);
            names.push(self.resource_names.get(r).cloned().unwrap_or_else(|| format!("#{r}")));
        }
        let mut dropped = 0u32;
        let cases = self.cases.iter().map(|case| {
            case.iter().filter_map(|&(a, r)| match index.get(&r) {
                Some(&dense) => Some((a, dense)),
                None => { dropped += 1; None }
            }).collect()
        }).collect();
        (cases, names, dropped)
    }

    fn mine(&self, p: &Params) -> SocialNetwork {
        let limit = p.max_resources.unwrap_or(DEFAULT_MAX_RESOURCES as u32).max(2) as usize;
        let (kept, omitted) = self.kept_resources(limit);
        let (cases, names, dropped_events) = self.projected(&kept);
        let n = names.len();

        let metric = Metric::parse(p.metric.as_deref().unwrap_or("handover"));
        let max_distance = p.max_distance.unwrap_or(1).max(1) as usize;
        let beta = p.beta.unwrap_or(0.5).clamp(0.0, 1.0);
        let multiple = p.multiple_transfers.unwrap_or(false);
        let ignore_self_loops = p.ignore_self_loops.unwrap_or(true);

        let mut rel = Relation::default();
        for case in &cases {
            match metric {
                Metric::Handover => handover(case, max_distance, beta, multiple, ignore_self_loops, &mut rel),
                Metric::Subcontracting => subcontracting(case, max_distance, beta, multiple, ignore_self_loops, &mut rel),
                Metric::Reassignment => reassignment(case, multiple, ignore_self_loops, &mut rel),
                Metric::WorkingTogether => working_together(case, &mut rel),
            }
        }

        let inv = Involvement::collect_projected(&cases, n, self.n_activities);
        let weight_kind = match metric {
            Metric::WorkingTogether => "ratio",
            _ => "share",
        };
        // Working together is a per-pair ratio against how many cases the two
        // are in at all; everything else is a share of all transfers counted.
        // Normalising the ratio again would make it depend on the rest of the
        // network, which is exactly what a ratio is not supposed to do.
        let edges = if metric == Metric::WorkingTogether {
            normalise_ratio(&rel, &inv)
        } else {
            normalise_share(&rel)
        };

        finish_network(
            metric.id().to_string(), weight_kind.to_string(), metric.is_directed(),
            names, self.activity_names.clone(), inv, edges, p,
            Stats {
                cases: self.case_count,
                events: self.rows,
                events_without_resource: self.unattributed + dropped_events,
                resources_total: n + omitted,
                resources_omitted: omitted,
                edges_before_pruning: rel.weights.len(),
                self_loops_dropped: if ignore_self_loops { rel.self_loops } else { 0 },
            },
        )
    }

    fn mine_similar_task(&self, p: &Params) -> SocialNetwork {
        let limit = p.max_resources.unwrap_or(DEFAULT_MAX_RESOURCES as u32).max(2) as usize;
        let (kept, omitted) = self.kept_resources(limit);
        let (cases, names, dropped_events) = self.projected(&kept);
        let n = names.len();
        let inv = Involvement::collect_projected(&cases, n, self.n_activities);
        let similarity = Similarity::parse(p.similarity.as_deref().unwrap_or("pearson"));

        // Every unordered pair, emitted once: the relation is symmetric and
        // storing both directions would double every weight in the node totals.
        let mut edges = Vec::new();
        for a in 0..n {
            for b in (a + 1)..n {
                let s = profile_similarity(&inv.profile[a], &inv.profile[b], similarity);
                if s.is_finite() {
                    edges.push(EdgeOut { from: a as u32, to: b as u32, weight: s, raw: s });
                }
            }
        }

        finish_network(
            format!("similarTask:{}", similarity.id()), "similarity".to_string(), false,
            names, self.activity_names.clone(), inv, edges, p,
            Stats {
                cases: self.case_count,
                events: self.rows,
                events_without_resource: self.unattributed + dropped_events,
                resources_total: n + omitted,
                resources_omitted: omitted,
                edges_before_pruning: n * n.saturating_sub(1) / 2,
                self_loops_dropped: 0,
            },
        )
    }
}

impl Involvement {
    fn collect_projected(cases: &[CaseSeq], n_resources: usize, n_activities: usize) -> Involvement {
        let scan = SocialScan {
            n_activities,
            cases: cases.to_vec(),
            ..SocialScan::default()
        };
        Involvement::collect(&scan, n_resources)
    }
}

/// Assembles nodes, prunes, and sorts — everything both derivations do the
/// same way once they have their edges.
fn finish_network(
    metric: String, weight_kind: String, directed: bool,
    resources: Vec<String>, activities: Vec<String>, inv: Involvement,
    edges: Vec<EdgeOut>, p: &Params, stats: Stats,
) -> SocialNetwork {
    let min_weight = p.min_weight.unwrap_or(0.0);
    let mut edges: Vec<EdgeOut> = edges.into_iter().filter(|e| e.weight >= min_weight).collect();
    // Strongest first, then by endpoint, so the order is stable across runs
    // and the head of the list is the part worth reading.
    edges.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| a.from.cmp(&b.from))
        .then_with(|| a.to.cmp(&b.to)));

    let n = resources.len();
    let mut out_weight = vec![0.0; n];
    let mut in_weight = vec![0.0; n];
    for e in &edges {
        out_weight[e.from as usize] += e.weight;
        in_weight[e.to as usize] += e.weight;
        if !directed {
            // An undirected pair is stored once; both endpoints still carry it.
            out_weight[e.to as usize] += e.weight;
            in_weight[e.from as usize] += e.weight;
        }
    }

    let nodes = (0..n).map(|r| {
        let mut profile: Vec<(u32, u32)> = inv.profile[r].iter().enumerate()
            .filter(|(_, &count)| count > 0.0)
            .map(|(a, &count)| (a as u32, count as u32))
            .collect();
        // Most frequent first, ties by activity index so the output is stable.
        profile.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        profile.truncate(PROFILE_ACTIVITIES);
        NodeOut {
            resource: r as u32,
            events: inv.events[r],
            cases: inv.cases[r],
            activities: inv.activities[r].len() as u32,
            profile,
            out_weight: out_weight[r],
            in_weight: in_weight[r],
        }
    }).collect();

    SocialNetwork { metric, weight_kind, directed, resources, activities, nodes, edges, stats }
}

/// Divides every weight by the total, so the network's weights sum to 1 and
/// two logs of different sizes can be compared.
fn normalise_share(rel: &Relation) -> Vec<EdgeOut> {
    let total: f64 = rel.weights.values().sum();
    rel.weights.iter().map(|(&(from, to), &raw)| EdgeOut {
        from, to,
        weight: if total > 0.0 { raw / total } else { 0.0 },
        raw,
    }).collect()
}

/// Jaccard over the two resources' case sets: how much of the work either of
/// them touched they touched together.
fn normalise_ratio(rel: &Relation, inv: &Involvement) -> Vec<EdgeOut> {
    rel.weights.iter().map(|(&(a, b), &joint)| {
        let union = inv.cases[a as usize] as f64 + inv.cases[b as usize] as f64 - joint;
        EdgeOut { from: a, to: b, weight: if union > 0.0 { joint / union } else { 0.0 }, raw: joint }
    }).collect()
}

// ----------------------------------------------------- the four relations ---

/// Records a case's contributions, honouring `multipleTransfers`.
///
/// With multiple transfers off, a pair is counted once per case — but at its
/// *best* weight, not at 1.0: the distance discount is a statement about how
/// direct the transfer was, and collapsing it to "it happened" would throw
/// that away while still claiming to respect `beta`.
struct CaseTally {
    multiple: bool,
    best: HashMap<(u32, u32), f64>,
}

impl CaseTally {
    fn new(multiple: bool) -> CaseTally { CaseTally { multiple, best: HashMap::new() } }

    fn add(&mut self, from: u32, to: u32, w: f64, rel: &mut Relation, ignore_self_loops: bool) {
        if self.multiple {
            rel.add(from, to, w, ignore_self_loops);
        } else {
            let slot = self.best.entry((from, to)).or_insert(0.0);
            if w > *slot { *slot = w; }
        }
    }

    fn flush(self, rel: &mut Relation, ignore_self_loops: bool) {
        for ((from, to), w) in self.best {
            rel.add(from, to, w, ignore_self_loops);
        }
    }
}

/// a then b, within `max_distance` steps, discounted `beta^(d-1)` per step.
fn handover(case: &CaseSeq, max_distance: usize, beta: f64, multiple: bool,
            ignore_self_loops: bool, rel: &mut Relation) {
    let mut tally = CaseTally::new(multiple);
    for i in 0..case.len() {
        for d in 1..=max_distance {
            let Some(&(_, to)) = case.get(i + d) else { break };
            tally.add(case[i].1, to, beta.powi(d as i32 - 1), rel, ignore_self_loops);
        }
    }
    tally.flush(rel, ignore_self_loops);
}

/// a ... b ... a — work that went out and came back. Both legs are bounded by
/// `max_distance`, and the weight discounts the total detour.
fn subcontracting(case: &CaseSeq, max_distance: usize, beta: f64, multiple: bool,
                  ignore_self_loops: bool, rel: &mut Relation) {
    let mut tally = CaseTally::new(multiple);
    for i in 0..case.len() {
        let a = case[i].1;
        for d1 in 1..=max_distance {
            let Some(&(_, b)) = case.get(i + d1) else { break };
            if b == a { continue; }
            for d2 in 1..=max_distance {
                let Some(&(_, back)) = case.get(i + d1 + d2) else { break };
                if back != a { continue; }
                tally.add(a, b, beta.powi((d1 + d2) as i32 - 2), rel, ignore_self_loops);
            }
        }
    }
    tally.flush(rel, ignore_self_loops);
}

/// The same activity performed twice in one case by two different people, the
/// second after the first.
fn reassignment(case: &CaseSeq, multiple: bool, ignore_self_loops: bool, rel: &mut Relation) {
    let mut tally = CaseTally::new(multiple);
    // Positions grouped by activity, in log order — the pairs are then every
    // earlier/later combination within one activity's group.
    let mut by_activity: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(activity, resource) in case {
        by_activity.entry(activity).or_default().push(resource);
    }
    for performers in by_activity.values() {
        for i in 0..performers.len() {
            for j in (i + 1)..performers.len() {
                if performers[i] != performers[j] {
                    tally.add(performers[i], performers[j], 1.0, rel, ignore_self_loops);
                }
            }
        }
    }
    tally.flush(rel, ignore_self_loops);
}

/// Co-appearance in one case. Symmetric, so each unordered pair is recorded
/// once with the lower index first — storing both directions would double
/// every weight the moment anything sums them.
fn working_together(case: &CaseSeq, rel: &mut Relation) {
    let mut present: Vec<u32> = case.iter().map(|&(_, r)| r).collect();
    present.sort_unstable();
    present.dedup();
    for i in 0..present.len() {
        for j in (i + 1)..present.len() {
            rel.add(present[i], present[j], 1.0, false);
        }
    }
}

// ----------------------------------------------------------- similar task ---

/// How alike two activity-frequency profiles are.
///
/// Pearson is the metric the original paper uses: it compares the *shape* of
/// two people's work, so someone who does a tenth as much of exactly the same
/// mix still scores 1.0. Cosine agrees with it on direction but not on
/// centring. Euclidean is the odd one out — it is a distance, mapped to
/// `1/(1+d)` so that larger still means "more similar" like the other two,
/// and it is the only one that treats sheer volume as a difference.
fn profile_similarity(a: &[f64], b: &[f64], kind: Similarity) -> f64 {
    match kind {
        Similarity::Pearson => {
            let n = a.len() as f64;
            if n == 0.0 { return f64::NAN; }
            let (ma, mb) = (a.iter().sum::<f64>() / n, b.iter().sum::<f64>() / n);
            let mut num = 0.0;
            let (mut da, mut db) = (0.0, 0.0);
            for i in 0..a.len() {
                let (x, y) = (a[i] - ma, b[i] - mb);
                num += x * y;
                da += x * x;
                db += y * y;
            }
            // A resource who only ever does one activity has no variance, so
            // correlation is undefined rather than zero. Reported as no edge.
            if da <= 0.0 || db <= 0.0 { f64::NAN } else { num / (da.sqrt() * db.sqrt()) }
        }
        Similarity::Cosine => {
            let dot: f64 = a.iter().zip(b).map(|(x, y)| x * y).sum();
            let na: f64 = a.iter().map(|x| x * x).sum::<f64>().sqrt();
            let nb: f64 = b.iter().map(|x| x * x).sum::<f64>().sqrt();
            if na <= 0.0 || nb <= 0.0 { f64::NAN } else { dot / (na * nb) }
        }
        Similarity::Euclidean => {
            let d: f64 = a.iter().zip(b).map(|(x, y)| (x - y) * (x - y)).sum::<f64>().sqrt();
            1.0 / (1.0 + d)
        }
    }
}

// ---------------------------------------------------------- the two kernels ---

/// Shared kernel body. Both exported classes below are the same scan; only
/// `finalize` differs, so the host addresses them by two `kernel.class` names
/// while this file keeps one implementation.
macro_rules! scan_kernel {
    ($name:ident, $finalize:ident) => {
        #[wasm_bindgen]
        pub struct $name { inner: SocialScan }

        #[wasm_bindgen]
        impl $name {
            #[wasm_bindgen(constructor)]
            pub fn new(n_activities: usize) -> $name {
                $name { inner: SocialScan::new(n_activities) }
            }

            #[wasm_bindgen(js_name = setActivityNames)]
            pub fn set_activity_names(&mut self, names: Vec<String>) {
                self.inner.activity_names = names;
            }

            #[wasm_bindgen(js_name = setResourceNames)]
            pub fn set_resource_names(&mut self, names: Vec<String>) {
                self.inner.resource_names = names;
            }

            /// `timestamps` is part of the host's scan ABI and ignored here:
            /// every metric is defined on the *order* of events within a case,
            /// which the scan has already applied, not on elapsed time.
            #[wasm_bindgen(js_name = pushChunk)]
            pub fn push_chunk(&mut self, cases: &[i32], activities: &[i32],
                              _timestamps: &[f64], resources: &[i32]) {
                self.inner.push_chunk(cases, activities, resources);
            }

            pub fn finish(&mut self) { self.inner.finish(); }

            #[wasm_bindgen(js_name = rowCount)]
            pub fn row_count(&self) -> u32 { self.inner.rows }

            #[wasm_bindgen(js_name = caseCount)]
            pub fn case_count(&self) -> u32 { self.inner.case_count }

            #[wasm_bindgen(js_name = finalize)]
            pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
                let p: Params = serde_wasm_bindgen::from_value(params)
                    .map_err(|e| JsValue::from_str(&format!("bad params: {e}")))?;
                serde_wasm_bindgen::to_value(&self.inner.$finalize(&p))
                    .map_err(|e| JsValue::from_str(&e.to_string()))
            }
        }
    };
}

scan_kernel!(SocialScanKernel, mine);
scan_kernel!(SimilarTaskKernel, mine_similar_task);

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a scan from cases given as (activity, resource) name pairs, so a
    /// test reads like the log it describes rather than like index arithmetic.
    fn scan(cases: &[&[(&str, &str)]]) -> SocialScan {
        let mut activities: Vec<String> = Vec::new();
        let mut resources: Vec<String> = Vec::new();
        let id = |list: &mut Vec<String>, name: &str| -> i32 {
            if let Some(i) = list.iter().position(|x| x == name) { return i as i32; }
            list.push(name.to_string());
            list.len() as i32 - 1
        };
        let mut c: Vec<i32> = Vec::new();
        let mut a: Vec<i32> = Vec::new();
        let mut r: Vec<i32> = Vec::new();
        for (case_idx, case) in cases.iter().enumerate() {
            for &(activity, resource) in case.iter() {
                c.push(case_idx as i32);
                a.push(id(&mut activities, activity));
                // An empty resource name is how a test says "nobody is named".
                r.push(if resource.is_empty() { -1 } else { id(&mut resources, resource) });
            }
        }
        let mut s = SocialScan::new(activities.len());
        s.activity_names = activities;
        s.resource_names = resources;
        s.push_chunk(&c, &a, &r);
        s.finish();
        s
    }

    fn params(metric: &str) -> Params {
        Params { metric: Some(metric.to_string()), ..Params::default() }
    }

    /// The weight of one ordered pair, by name.
    fn edge(net: &SocialNetwork, from: &str, to: &str) -> Option<f64> {
        let fi = net.resources.iter().position(|r| r == from)? as u32;
        let ti = net.resources.iter().position(|r| r == to)? as u32;
        net.edges.iter().find(|e| e.from == fi && e.to == ti).map(|e| e.weight)
    }
    fn raw(net: &SocialNetwork, from: &str, to: &str) -> Option<f64> {
        let fi = net.resources.iter().position(|r| r == from)? as u32;
        let ti = net.resources.iter().position(|r| r == to)? as u32;
        net.edges.iter().find(|e| e.from == fi && e.to == ti).map(|e| e.raw)
    }

    #[test]
    fn handover_follows_the_order_of_work_inside_a_case() {
        let s = scan(&[&[("a", "ann"), ("b", "bob"), ("c", "cat")]]);
        let net = s.mine(&params("handover"));
        assert_eq!(raw(&net, "ann", "bob"), Some(1.0));
        assert_eq!(raw(&net, "bob", "cat"), Some(1.0));
        assert_eq!(edge(&net, "cat", "ann"), None, "handover is not a cycle");
        // Two transfers, each half the network's weight.
        assert_eq!(edge(&net, "ann", "bob"), Some(0.5));
    }

    #[test]
    fn weights_of_a_share_metric_sum_to_one() {
        let s = scan(&[
            &[("a", "ann"), ("b", "bob"), ("c", "cat")],
            &[("a", "ann"), ("b", "cat")],
        ]);
        let net = s.mine(&params("handover"));
        let total: f64 = net.edges.iter().map(|e| e.weight).sum();
        assert!((total - 1.0).abs() < 1e-12, "weights summed to {total}");
        assert_eq!(net.weight_kind, "share");
    }

    #[test]
    fn a_handover_to_oneself_is_dropped_by_default() {
        let s = scan(&[&[("a", "ann"), ("b", "ann"), ("c", "bob")]]);
        let net = s.mine(&params("handover"));
        assert_eq!(edge(&net, "ann", "ann"), None);
        assert_eq!(edge(&net, "ann", "bob"), Some(1.0), "the only transfer left carries all the weight");
        assert_eq!(net.stats.self_loops_dropped, 1);

        let kept = s.mine(&Params { ignore_self_loops: Some(false), ..params("handover") });
        assert_eq!(kept.edge_count_for("ann", "ann"), 1);
    }

    #[test]
    fn an_unattributed_event_does_not_break_the_chain() {
        // Ann, then an automated step nobody is named for, then Bob. The
        // handover is still Ann to Bob — inventing a "nobody" node would route
        // the whole network through a person who does not exist.
        let s = scan(&[&[("a", "ann"), ("system", ""), ("c", "bob")]]);
        let net = s.mine(&params("handover"));
        assert_eq!(edge(&net, "ann", "bob"), Some(1.0));
        assert_eq!(net.stats.events_without_resource, 1);
        assert_eq!(net.resources.len(), 2);
    }

    #[test]
    fn distance_lets_a_handover_survive_an_intervening_step() {
        let s = scan(&[&[("a", "ann"), ("b", "bob"), ("c", "cat")]]);
        let p = Params { max_distance: Some(2), beta: Some(0.5), ..params("handover") };
        let net = s.mine(&p);
        // ann→bob and bob→cat at distance 1 (weight 1 each), ann→cat at
        // distance 2 (weight 0.5). Total 2.5.
        assert_eq!(raw(&net, "ann", "cat"), Some(0.5));
        assert!((edge(&net, "ann", "bob").unwrap() - 1.0 / 2.5).abs() < 1e-12);
        assert!((edge(&net, "ann", "cat").unwrap() - 0.5 / 2.5).abs() < 1e-12);
    }

    #[test]
    fn multiple_transfers_off_counts_a_repeating_pair_once_per_case() {
        // Ann hands to Bob three times in one case.
        let s = scan(&[&[("a", "ann"), ("b", "bob"), ("c", "ann"), ("d", "bob"),
                         ("e", "ann"), ("f", "bob")]]);
        let once = s.mine(&params("handover"));
        assert_eq!(raw(&once, "ann", "bob"), Some(1.0), "counted once per case");

        let every = s.mine(&Params { multiple_transfers: Some(true), ..params("handover") });
        assert_eq!(raw(&every, "ann", "bob"), Some(3.0));
    }

    #[test]
    fn subcontracting_needs_the_work_to_come_back() {
        // Ann → Bob → Ann is subcontracting; Ann → Bob → Cat is not.
        let returned = scan(&[&[("a", "ann"), ("b", "bob"), ("c", "ann")]]);
        let net = returned.mine(&Params { max_distance: Some(1), ..params("subcontracting") });
        assert_eq!(raw(&net, "ann", "bob"), Some(1.0));

        let onward = scan(&[&[("a", "ann"), ("b", "bob"), ("c", "cat")]]);
        let net = onward.mine(&Params { max_distance: Some(1), ..params("subcontracting") });
        assert!(net.edges.is_empty(), "nothing came back, so nothing was subcontracted");
    }

    #[test]
    fn working_together_ignores_order_and_is_stored_once_per_pair() {
        let s = scan(&[
            &[("a", "ann"), ("b", "bob")],
            &[("a", "bob"), ("b", "ann")],
            &[("a", "ann"), ("b", "cat")],
        ]);
        let net = s.mine(&params("workingTogether"));
        assert!(!net.directed);
        // Ann and Bob share two of the three cases either is in
        // (ann: 3, bob: 2, joint: 2 → 2 / (3 + 2 - 2)).
        assert!((edge(&net, "ann", "bob").unwrap() - 2.0 / 3.0).abs() < 1e-12);
        assert_eq!(edge(&net, "bob", "ann"), None, "the pair is stored once, not twice");
        assert_eq!(net.weight_kind, "ratio");
    }

    #[test]
    fn reassignment_needs_the_same_activity_done_by_two_people() {
        let s = scan(&[&[("review", "ann"), ("file", "bob"), ("review", "cat")]]);
        let net = s.mine(&params("reassignment"));
        assert_eq!(raw(&net, "ann", "cat"), Some(1.0), "both reviewed, ann first");
        assert_eq!(edge(&net, "ann", "bob"), None, "different activities are not a reassignment");
    }

    #[test]
    fn similar_task_scores_identical_work_mixes_alike() {
        // Ann and Bob do the same mix at different volumes; Cat does something
        // else entirely.
        let s = scan(&[
            &[("a", "ann"), ("a", "ann"), ("b", "ann")],
            &[("a", "bob"), ("b", "bob")],
            &[("c", "cat"), ("c", "cat")],
        ]);
        let net = s.mine_similar_task(&Params { similarity: Some("cosine".into()), ..Params::default() });
        assert!(!net.directed);
        assert_eq!(net.weight_kind, "similarity");
        let ab = edge(&net, "ann", "bob").unwrap();
        let ac = edge(&net, "ann", "cat").unwrap();
        assert!(ab > 0.9, "same mix, different volume: {ab}");
        assert!(ac < 0.1, "different work entirely: {ac}");
    }

    #[test]
    fn similar_task_can_relate_people_who_never_share_a_case() {
        let s = scan(&[&[("a", "ann")], &[("a", "bob")]]);
        let together = s.mine(&params("workingTogether"));
        assert!(together.edges.is_empty(), "they never met");
        let similar = s.mine_similar_task(&Params { similarity: Some("cosine".into()), ..Params::default() });
        assert_eq!(edge(&similar, "ann", "bob"), Some(1.0), "but they do exactly the same work");
    }

    #[test]
    fn min_weight_prunes_and_leaves_the_nodes_consistent() {
        let s = scan(&[
            &[("a", "ann"), ("b", "bob")], &[("a", "ann"), ("b", "bob")],
            &[("a", "ann"), ("b", "bob")], &[("a", "ann"), ("b", "cat")],
        ]);
        let net = s.mine(&Params { min_weight: Some(0.5), ..params("handover") });
        assert_eq!(net.edges.len(), 1, "only the frequent pair survives");
        // Node weights must describe the edges that are actually there.
        let total_out: f64 = net.nodes.iter().map(|n| n.out_weight).sum();
        let edge_total: f64 = net.edges.iter().map(|e| e.weight).sum();
        assert!((total_out - edge_total).abs() < 1e-12);
    }

    #[test]
    fn a_node_carries_the_activity_mix_a_consumer_needs_to_name_it() {
        // The profile is what lets the Organizational Model plugin say what a
        // role *does*, so it has to be present, ordered, and indexed against
        // the dictionary beside it.
        let s = scan(&[
            &[("review", "ann"), ("review", "ann"), ("file", "ann")],
            &[("file", "bob")],
        ]);
        let net = s.mine(&params("handover"));
        assert_eq!(net.activities, vec!["review", "file"]);
        let ann = net.nodes.iter().find(|n| net.resources[n.resource as usize] == "ann").unwrap();
        // Most frequent first: review twice, then file once.
        assert_eq!(ann.profile, vec![(0, 2), (1, 1)]);
        let bob = net.nodes.iter().find(|n| net.resources[n.resource as usize] == "bob").unwrap();
        assert_eq!(bob.profile, vec![(1, 1)]);
        // And the names line up with the indices.
        assert_eq!(net.activities[ann.profile[0].0 as usize], "review");
    }

    #[test]
    fn a_profile_names_at_most_the_capped_number_of_activities() {
        let owned: Vec<(String, String)> = (0..(PROFILE_ACTIVITIES + 20))
            .map(|i| (format!("act-{i}"), "ann".to_string())).collect();
        let case: Vec<(&str, &str)> = owned.iter().map(|(a, r)| (a.as_str(), r.as_str())).collect();
        let s = scan(&[&case]);
        let net = s.mine(&params("handover"));
        let ann = &net.nodes[0];
        assert_eq!(ann.activities, (PROFILE_ACTIVITIES + 20) as u32, "the count is not capped");
        assert_eq!(ann.profile.len(), PROFILE_ACTIVITIES, "the emitted profile is");
    }

    #[test]
    fn node_involvement_counts_what_the_person_actually_did() {
        let s = scan(&[
            &[("a", "ann"), ("b", "ann"), ("c", "bob")],
            &[("a", "ann")],
        ]);
        let net = s.mine(&params("handover"));
        let ann = net.nodes.iter().find(|n| net.resources[n.resource as usize] == "ann").unwrap();
        assert_eq!(ann.events, 3);
        assert_eq!(ann.cases, 2);
        assert_eq!(ann.activities, 2);
    }

    // -------------------------------------------- randomised invariants ---

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: usize) -> usize { (self.next() % n as u64) as usize }
    }

    /// A random log over a handful of people and activities, including events
    /// nobody is named for.
    fn random_scan(rng: &mut Rng, cases: usize) -> SocialScan {
        let people = ["ann", "bob", "cat", "dan", "eve"];
        let acts = ["a", "b", "c", "d"];
        let mut owned: Vec<Vec<(String, String)>> = Vec::new();
        for _ in 0..cases {
            let len = 1 + rng.below(8);
            let mut case = Vec::new();
            for _ in 0..len {
                let r = if rng.below(8) == 0 { String::new() } else { people[rng.below(people.len())].to_string() };
                case.push((acts[rng.below(acts.len())].to_string(), r));
            }
            owned.push(case);
        }
        let borrowed: Vec<Vec<(&str, &str)>> = owned.iter()
            .map(|c| c.iter().map(|(a, r)| (a.as_str(), r.as_str())).collect())
            .collect();
        let slices: Vec<&[(&str, &str)]> = borrowed.iter().map(|c| c.as_slice()).collect();
        scan(&slices)
    }

    #[test]
    fn every_metric_produces_a_consistent_network() {
        for seed in 1..120u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
            let s = random_scan(&mut rng, 1 + (seed as usize % 20));
            for metric in ["handover", "subcontracting", "workingTogether", "reassignment"] {
                let p = Params {
                    max_distance: Some(1 + (seed % 3) as u32),
                    beta: Some(0.5),
                    multiple_transfers: Some(seed % 2 == 0),
                    ..params(metric)
                };
                let net = s.mine(&p);
                let label = format!("seed {seed}, metric {metric}");

                // Every edge names a node that exists.
                for e in &net.edges {
                    assert!((e.from as usize) < net.nodes.len(), "{label}: edge from out of range");
                    assert!((e.to as usize) < net.nodes.len(), "{label}: edge to out of range");
                    assert!(e.weight.is_finite() && e.weight >= 0.0, "{label}: weight {}", e.weight);
                }
                // Node totals describe exactly the edges that survived.
                let edge_total: f64 = net.edges.iter().map(|e| e.weight).sum();
                let out_total: f64 = net.nodes.iter().map(|n| n.out_weight).sum();
                let in_total: f64 = net.nodes.iter().map(|n| n.in_weight).sum();
                let expected = if net.directed { edge_total } else { edge_total * 2.0 };
                assert!((out_total - expected).abs() < 1e-9, "{label}: out {out_total} vs {expected}");
                assert!((in_total - expected).abs() < 1e-9, "{label}: in {in_total} vs {expected}");
                // A share metric's weights are a distribution.
                if net.weight_kind == "share" && !net.edges.is_empty() {
                    assert!((edge_total - 1.0).abs() < 1e-9, "{label}: share total {edge_total}");
                }
                // A ratio is a ratio.
                if net.weight_kind == "ratio" {
                    for e in &net.edges {
                        assert!(e.weight <= 1.0 + 1e-12, "{label}: ratio {} > 1", e.weight);
                    }
                }
                // Nobody who never appears gets a node.
                assert!(net.nodes.iter().all(|n| n.events > 0), "{label}: a node with no events");
            }
        }
    }

    #[test]
    fn similarity_stays_in_its_declared_range() {
        for seed in 1..120u64 {
            let mut rng = Rng(seed.wrapping_mul(0x2545_F491_4F6C_DD1D));
            let s = random_scan(&mut rng, 1 + (seed as usize % 20));
            for kind in ["pearson", "cosine", "euclidean"] {
                let net = s.mine_similar_task(&Params {
                    similarity: Some(kind.to_string()), ..Params::default()
                });
                for e in &net.edges {
                    assert!(e.weight.is_finite(), "seed {seed}, {kind}: non-finite weight");
                    assert!(e.weight >= -1.0 - 1e-12 && e.weight <= 1.0 + 1e-12,
                        "seed {seed}, {kind}: {} out of range", e.weight);
                    assert!(e.from < e.to, "seed {seed}, {kind}: pair stored twice or reversed");
                }
                // Symmetric by construction: no pair may appear both ways.
                let mut seen = HashSet::new();
                for e in &net.edges {
                    assert!(seen.insert((e.from, e.to)), "seed {seed}, {kind}: duplicate pair");
                }
            }
        }
    }

    #[test]
    fn a_resource_limit_drops_the_least_active_people_and_says_so() {
        let s = scan(&[
            &[("a", "ann"), ("b", "ann"), ("c", "ann")],
            &[("a", "bob"), ("b", "bob")],
            &[("a", "cat")],
        ]);
        let net = s.mine(&Params { max_resources: Some(2), ..params("handover") });
        assert_eq!(net.resources.len(), 2);
        assert!(net.resources.contains(&"ann".to_string()));
        assert!(net.resources.contains(&"bob".to_string()));
        assert_eq!(net.stats.resources_omitted, 1);
        assert_eq!(net.stats.resources_total, 3);
        // Cat's event is accounted for, not quietly lost.
        assert_eq!(net.stats.events_without_resource, 1);
    }

    impl SocialNetwork {
        fn edge_count_for(&self, from: &str, to: &str) -> usize {
            let fi = self.resources.iter().position(|r| r == from);
            let ti = self.resources.iter().position(|r| r == to);
            match (fi, ti) {
                (Some(f), Some(t)) => self.edges.iter()
                    .filter(|e| e.from == f as u32 && e.to == t as u32).count(),
                _ => 0,
            }
        }
    }
}
