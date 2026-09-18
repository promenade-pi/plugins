//! The station-map layout kernel.
//!
//! Turns an Object-Centric Directly-Follows Graph into the plan for a
//! "Shinjuku-style" station diagram: activities become circular platforms,
//! object types become coloured routes, horizontal position is process order,
//! and *vertical* position is accumulated elapsed time — so a long wait is a
//! literal drop, drawn as an elevator shaft.
//!
//! Only the plan is computed here. Nothing in this crate knows how many world
//! units a second is worth, because that is a view-time choice (linear or
//! logarithmic, and a relief slider on top). Every platform and every route
//! vertex therefore carries a time in **seconds**; the view maps seconds to a
//! height. The one thing that has to hold across every such mapping is that a
//! forward hand-off descends, so that is asserted here in seconds and is
//! preserved by any monotone mapping.
//!
//! The router is the part that took the design work. Route overlap is a
//! *global* property, so it is not repaired locally: every route segment is
//! allocated a track in one shared occupancy model per corridor
//! (`router::allocate`), by interval-graph colouring with variable-width
//! bands. Two segments that share a corridor and overlap along it are given
//! different offsets by construction, which is why `check::violations` can be
//! run over randomised graphs and come back empty rather than "mostly empty".

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

pub mod check;
mod order;
mod rank;
mod router;

pub use check::{violations, Violation};

// --------------------------------------------------------------- input model

/// The `OCDFG` payload as `core.discover.ocdfg` emits it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcdfgPayload {
    #[serde(default)]
    pub object_types: Vec<String>,
    #[serde(default)]
    pub nodes: Vec<OcdfgNode>,
    #[serde(default)]
    pub edges: Vec<OcdfgEdge>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcdfgNode {
    pub object_type: String,
    pub activity: String,
    #[serde(default)]
    pub count: f64,
    #[serde(default)]
    pub starts: f64,
    #[serde(default)]
    pub ends: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcdfgEdge {
    pub object_type: String,
    pub src: String,
    pub dst: String,
    #[serde(default)]
    pub freq: f64,
    /// Mean wait between the two activities, in seconds. `core.discover.ocdfg`
    /// 0.2.0 emits it; an older OC-DFG, or a log without usable timestamps,
    /// does not — in which case the whole map falls back to rank-as-depth and
    /// says so through `stats.has_timing`.
    #[serde(rename = "avgSecs", default)]
    pub avg_secs: Option<f64>,
}

/// Everything the action's own parameters can change about the plan.
#[derive(Debug, Clone)]
pub struct Params {
    /// Empty means every object type in the graph.
    pub object_types: Vec<String>,
    /// The most frequent activities, at most this many.
    pub max_activities: usize,
    /// Keep the strongest hand-offs until they account for this share of all
    /// observed hand-offs, 0..=100.
    pub edge_coverage: f64,
    /// Draw the hand-offs that go back against process order.
    pub show_rework: bool,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            object_types: Vec::new(),
            max_activities: 14,
            edge_coverage: 90.0,
            show_rework: true,
        }
    }
}

// -------------------------------------------------------------- output model

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub x: f64,
    pub z: f64,
}

/// One activity: a circular platform.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Platform {
    pub id: String,
    pub activity: String,
    pub x: f64,
    pub z: f64,
    /// Accumulated elapsed time from the start of the process, in seconds.
    pub t: f64,
    /// Plan radius of the disc, in the same units as `x`/`z`.
    pub radius: f64,
    pub rank: i32,
    pub lane: i32,
    /// Object types that pass through, in the payload's own type order.
    pub object_types: Vec<String>,
    /// Occurrences per object type, aligned with `object_types`.
    pub counts: Vec<f64>,
    pub count: f64,
    /// A place object lifecycles begin — drawn with an origin pin.
    pub is_start: bool,
    pub is_end: bool,
}

/// One drawn route line: a single object type travelling one hand-off.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub id: String,
    pub link: String,
    pub object_type: String,
    pub source: String,
    pub target: String,
    pub freq: f64,
    /// This object type's own mean wait on this hand-off, in seconds.
    /// `null` where the OC-DFG carried no timing for it.
    pub wait_secs: Option<f64>,
    /// Runs against process order — rework.
    pub backward: bool,
    pub self_loop: bool,
    /// This hand-off is the one that *sets* the target's depth: its drop is
    /// exactly its own measured wait. Every other incoming line drops further
    /// than it waited, because a platform has one depth and it is the deepest
    /// of the paths that reach it.
    pub critical: bool,
    /// The drawn polyline in the plan, already offset onto its own track.
    pub points: Vec<Point>,
    /// Index into `points` of the vertex the vertical move happens at: the
    /// route is at the source's depth up to and including it, and at the
    /// target's depth from the next vertex on.
    pub drop_at: usize,
}

/// A vertical move shared by every line of one hand-off — the elevator shaft.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shaft {
    pub id: String,
    pub link: String,
    pub x: f64,
    pub z: f64,
    pub radius: f64,
    pub source: String,
    pub target: String,
    /// Depth at the top and bottom of the shaft, in seconds. `t_bottom` is
    /// past `t_top` on a forward hand-off and before it on rework.
    pub t_top: f64,
    pub t_bottom: f64,
    /// The measured mean wait behind this drop, frequency-weighted over the
    /// object types on the hand-off. Equal to the drop only on the hand-off
    /// that sets the target's depth (`critical`).
    pub wait_secs: Option<f64>,
    pub critical: bool,
    pub backward: bool,
    pub object_types: Vec<String>,
    pub freq: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectTypeInfo {
    pub name: String,
    pub count: f64,
    /// Activities this type visits, in rank order — the lifecycle a click on
    /// the legend highlights.
    pub route: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub activities: usize,
    pub lines: usize,
    pub shafts: usize,
    pub object_types: usize,
    /// Deepest platform, in seconds.
    pub max_time_secs: f64,
    /// The OC-DFG carried usable per-edge timing.
    pub has_timing: bool,
    /// Activities dropped by `max_activities`, and hand-offs dropped by
    /// `edge_coverage` — stated rather than hidden.
    pub dropped_activities: usize,
    pub dropped_edges: usize,
    /// Share of all observed hand-offs the drawn ones account for, 0..=1.
    pub coverage: f64,
    pub basis: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StationMapPayload {
    pub object_types: Vec<ObjectTypeInfo>,
    pub platforms: Vec<Platform>,
    pub lines: Vec<Line>,
    pub shafts: Vec<Shaft>,
    /// Platform ids in an order in which every forward hand-off's source comes
    /// before its target — what the view's monotone depth refinement walks.
    pub order: Vec<String>,
    /// Half-extent of the plan, for the view's camera fit.
    pub extent: Point,
    pub stats: Stats,
}

// ------------------------------------------------------------------ geometry

/// Spacing between two parallel lines sharing a corridor, in plan units.
pub(crate) const LINE_PITCH: f64 = 0.075;
/// Clear space kept between two allocated bands in a corridor.
pub(crate) const BAND_GAP: f64 = 0.055;
/// Smallest platform radius; the busiest activity reaches `R_MAX`.
pub(crate) const R_MIN: f64 = 0.26;
pub(crate) const R_MAX: f64 = 0.46;
/// Clear space between a platform's rim and anything routed past it.
pub(crate) const PLATFORM_CLEAR: f64 = 0.13;
/// Narrowest a lift shaft may be.
///
/// A shaft carrying one route would otherwise be barely wider than the route,
/// and a shaft that thin cannot hold a car anyone can see. The floor is here,
/// in the kernel, rather than in the view, because the shaft's radius is what
/// `check::violations` holds clear of the platforms — a view that quietly drew
/// them wider than the payload says would be drawing something unverified.
pub(crate) const SHAFT_MIN_RADIUS: f64 = 0.24;

// ---------------------------------------------------------------- main entry

pub fn build_station_map(dfg: &OcdfgPayload, params: &Params) -> StationMapPayload {
    let wanted: BTreeSet<&str> = params.object_types.iter().map(|s| s.as_str()).collect();
    let keep_type = |t: &str| wanted.is_empty() || wanted.contains(t);

    // Object types in a stable, meaningful order: busiest first, so the legend
    // and every parallel-track ordering agree without a second sort anywhere.
    let mut type_count: BTreeMap<String, f64> = BTreeMap::new();
    for n in &dfg.nodes {
        if keep_type(&n.object_type) {
            *type_count.entry(n.object_type.clone()).or_insert(0.0) += n.count;
        }
    }
    for t in &dfg.object_types {
        if keep_type(t) {
            type_count.entry(t.clone()).or_insert(0.0);
        }
    }
    let mut types: Vec<String> = type_count.keys().cloned().collect();
    types.sort_by(|a, b| {
        type_count[b]
            .partial_cmp(&type_count[a])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.cmp(b))
    });
    let type_index: HashMap<&str, usize> =
        types.iter().enumerate().map(|(i, t)| (t.as_str(), i)).collect();

    // ---------------------------------------------------------- activities
    let mut act_count: BTreeMap<String, f64> = BTreeMap::new();
    let mut act_by_type: BTreeMap<String, BTreeMap<String, f64>> = BTreeMap::new();
    let mut starts: BTreeMap<String, f64> = BTreeMap::new();
    let mut ends: BTreeMap<String, f64> = BTreeMap::new();
    for n in &dfg.nodes {
        if !keep_type(&n.object_type) {
            continue;
        }
        *act_count.entry(n.activity.clone()).or_insert(0.0) += n.count;
        *act_by_type
            .entry(n.activity.clone())
            .or_default()
            .entry(n.object_type.clone())
            .or_insert(0.0) += n.count;
        *starts.entry(n.activity.clone()).or_insert(0.0) += n.starts;
        *ends.entry(n.activity.clone()).or_insert(0.0) += n.ends;
    }

    let total_activities = act_count.len();
    let mut ranked: Vec<(String, f64)> = act_count.iter().map(|(a, c)| (a.clone(), *c)).collect();
    ranked.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    let cap = params.max_activities.max(2);
    let kept: BTreeSet<String> = ranked.iter().take(cap).map(|(a, _)| a.clone()).collect();

    if kept.is_empty() {
        return empty_payload(total_activities);
    }

    // --------------------------------------------------------- hand-offs
    // One record per (source, target) *pair*; the per-object-type lines it
    // carries live inside it, because they share one corridor and one shaft.
    #[derive(Default)]
    struct RawLink {
        per_type: BTreeMap<String, (f64, f64, f64)>, // freq, wait*freq, freq-with-wait
        freq: f64,
    }
    let mut links: BTreeMap<(String, String), RawLink> = BTreeMap::new();
    let mut observed_total = 0.0_f64;
    let mut kept_total = 0.0_f64;
    let mut dropped_edges = 0usize;

    for e in &dfg.edges {
        if !keep_type(&e.object_type) {
            continue;
        }
        observed_total += e.freq;
        if !kept.contains(&e.src) || !kept.contains(&e.dst) {
            continue;
        }
        let entry = links.entry((e.src.clone(), e.dst.clone())).or_default();
        let slot = entry
            .per_type
            .entry(e.object_type.clone())
            .or_insert((0.0, 0.0, 0.0));
        slot.0 += e.freq;
        if let Some(w) = e.avg_secs.filter(|w| w.is_finite() && *w >= 0.0) {
            slot.1 += w * e.freq;
            slot.2 += e.freq;
        }
        entry.freq += e.freq;
    }

    // Coverage pruning: strongest hand-offs first, until they account for the
    // requested share of everything that actually happened. Every platform
    // keeps its strongest incoming and outgoing hand-off regardless, so the
    // abstraction can never leave a station unreachable.
    let mut by_strength: Vec<((String, String), f64)> =
        links.iter().map(|(k, v)| (k.clone(), v.freq)).collect();
    by_strength.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    let all_freq: f64 = by_strength.iter().map(|(_, f)| *f).sum();
    let target = all_freq * (params.edge_coverage.clamp(0.0, 100.0) / 100.0);
    let mut keep_link: HashSet<(String, String)> = HashSet::new();
    let mut acc = 0.0;
    for (key, freq) in &by_strength {
        if acc >= target && !keep_link.is_empty() {
            break;
        }
        keep_link.insert(key.clone());
        acc += freq;
    }
    for act in &kept {
        let best_out = by_strength
            .iter()
            .filter(|((s, t), _)| s == act && t != act)
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        let best_in = by_strength
            .iter()
            .filter(|((s, t), _)| t == act && s != act)
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        for candidate in [best_out, best_in].into_iter().flatten() {
            keep_link.insert(candidate.0.clone());
        }
    }
    links.retain(|k, _| {
        let hit = keep_link.contains(k);
        if !hit {
            dropped_edges += 1;
        }
        hit
    });
    for (_, link) in links.iter() {
        kept_total += link.freq;
    }

    // ------------------------------------------------------ ranks and depth
    let ids: Vec<String> = kept.iter().cloned().collect();
    let mut adjacency: HashMap<String, Vec<String>> = HashMap::new();
    for (s, t) in links.keys() {
        if s != t {
            adjacency.entry(s.clone()).or_default().push(t.clone());
        }
    }
    for id in &ids {
        adjacency.entry(id.clone()).or_default();
    }
    let back = rank::feedback_arcs(&ids, &adjacency);
    let forward: HashMap<String, Vec<String>> = adjacency
        .iter()
        .map(|(s, ts)| {
            (
                s.clone(),
                ts.iter()
                    .filter(|t| !back.contains(&(s.clone(), (*t).clone())))
                    .cloned()
                    .collect(),
            )
        })
        .collect();
    let rank_of = rank::longest_path_rank(&ids, &forward);

    let mut wait_of: HashMap<(String, String), Option<f64>> = HashMap::new();
    for (key, link) in &links {
        let mut num = 0.0;
        let mut den = 0.0;
        for (_, wf, f) in link.per_type.values() {
            num += wf;
            den += f;
        }
        wait_of.insert(key.clone(), if den > 0.0 { Some(num / den) } else { None });
    }
    // "Has timing" has to mean *usable* timing. An OC-DFG that carries an
    // `avgSecs` of zero on every edge is arithmetically a timed graph and
    // visually a flat one, so it takes the same fallback as an untimed graph
    // rather than producing a map whose depth axis is labelled in seconds and
    // is entirely made of the epsilon.
    let has_timing = wait_of
        .values()
        .any(|w| w.map(|v| v.is_finite() && v > 0.0).unwrap_or(false));
    let (time_of, critical_link) = rank::depth(&ids, &forward, &rank_of, &wait_of, has_timing);

    // -------------------------------------------------------- the hand-offs
    // Built before the lane order, because a hand-off that spans more than one
    // rank is split by dummy nodes and those dummies have to take part in the
    // ordering. That is what stops a long route from being drawn straight over
    // a platform it has nothing to do with.
    let mut route_links: Vec<router::LinkSpec> = Vec::new();
    let mut chains: Vec<router::Chain> = Vec::new();
    for ((s, t), link) in &links {
        let backward = back.contains(&(s.clone(), t.clone()));
        let self_loop = s == t;
        if (backward || self_loop) && !params.show_rework {
            continue;
        }
        let mut lines: Vec<router::LineSpec> = link
            .per_type
            .iter()
            .filter(|(ot, _)| type_index.contains_key(ot.as_str()))
            .map(|(ot, (freq, wf, f))| router::LineSpec {
                object_type: ot.clone(),
                order: type_index[ot.as_str()],
                freq: *freq,
                wait_secs: if *f > 0.0 { Some(wf / f) } else { None },
            })
            .collect();
        if lines.is_empty() {
            continue;
        }
        lines.sort_by_key(|l| l.order);
        let index = route_links.len();
        route_links.push(router::LinkSpec {
            source: s.clone(),
            target: t.clone(),
            backward,
            self_loop,
            freq: link.freq,
            wait_secs: wait_of[&(s.clone(), t.clone())].filter(|_| has_timing),
            critical: !backward && !self_loop && critical_link.get(t).map(|c| c == s).unwrap_or(false),
            lines,
        });

        let (ra, rb) = (rank_of[s], rank_of[t]);
        if self_loop || ra == rb {
            chains.push(router::Chain {
                link: index,
                nodes: vec![s.clone(), t.clone()],
                u_turn: true,
            });
            continue;
        }
        // Laid out left to right in rank space whichever way it is drawn.
        let (low, high) = if ra < rb { (s, t) } else { (t, s) };
        let (low_rank, high_rank) = (rank_of[low], rank_of[high]);
        let mut nodes = vec![low.clone()];
        for r in (low_rank + 1)..high_rank {
            nodes.push(format!("~{}>{}@{}", s, t, r));
        }
        nodes.push(high.clone());
        chains.push(router::Chain {
            link: index,
            nodes,
            u_turn: false,
        });
    }

    // ------------------------------------------------------- lateral order
    let mut layout_rank = rank_of.clone();
    let mut layout_ids = ids.clone();
    let mut layout_pairs: Vec<(String, String)> = Vec::new();
    let mut layout_forward: HashMap<String, Vec<String>> = HashMap::new();
    for id in &layout_ids {
        layout_forward.entry(id.clone()).or_default();
    }
    for chain in &chains {
        if chain.u_turn {
            layout_pairs.push((chain.nodes[0].clone(), chain.nodes[1].clone()));
            continue;
        }
        let base = layout_rank[&chain.nodes[0]];
        for (step, node) in chain.nodes.iter().enumerate() {
            if node.starts_with('~') && !layout_rank.contains_key(node) {
                layout_rank.insert(node.clone(), base + step as i32);
                layout_ids.push(node.clone());
            }
        }
        for pair in chain.nodes.windows(2) {
            layout_pairs.push((pair[0].clone(), pair[1].clone()));
            layout_forward
                .entry(pair[0].clone())
                .or_default()
                .push(pair[1].clone());
            layout_forward.entry(pair[1].clone()).or_default();
        }
    }
    // A dummy stands for a stretch of a route rather than for anything in the
    // log, so it is the one that should stay put when a rank has to spread.
    let layout_weight: HashMap<String, f64> = layout_ids
        .iter()
        .map(|id| (id.clone(), if id.starts_with('~') { 3.0 } else { 1.0 }))
        .collect();
    let lane_of = order::assign_lanes(
        &layout_ids,
        &layout_rank,
        &layout_forward,
        &layout_pairs,
        &layout_weight,
    );

    // ------------------------------------------------------------- platforms
    let busiest = act_count
        .values()
        .cloned()
        .fold(1.0_f64, |a, b| if b > a { b } else { a });
    let max_shared = act_by_type
        .iter()
        .filter(|(a, _)| kept.contains(*a))
        .map(|(_, m)| m.len())
        .max()
        .unwrap_or(1)
        .max(1);

    let mut plan: Vec<PlanNode> = ids
        .iter()
        .map(|id| {
            let by_type = act_by_type.get(id).cloned().unwrap_or_default();
            let mut ots: Vec<String> = by_type
                .keys()
                .filter(|t| type_index.contains_key(t.as_str()))
                .cloned()
                .collect();
            ots.sort_by_key(|t| type_index[t.as_str()]);
            // Radius mixes the two things the metaphor says a big platform
            // means: many object types interchange here, and a lot happens
            // here. Shared-ness leads, because "larger platforms are shared
            // activities" is the grammar; volume only modulates it. The
            // router may grow it further to fit what is attached.
            let share = (ots.len() as f64 - 1.0) / (max_shared as f64 - 1.0).max(1.0);
            let volume = (act_count.get(id).copied().unwrap_or(0.0) / busiest).clamp(0.0, 1.0);
            let radius = R_MIN + (R_MAX - R_MIN) * (0.68 * share + 0.32 * volume.sqrt());
            PlanNode {
                id: id.clone(),
                rank: rank_of[id],
                lane: lane_of.get(id).copied().unwrap_or(0),
                radius,
                object_types: ots.clone(),
                counts: ots
                    .iter()
                    .map(|t| by_type.get(t).copied().unwrap_or(0.0))
                    .collect(),
                count: act_count.get(id).copied().unwrap_or(0.0),
                t: time_of[id],
                is_start: starts.get(id).copied().unwrap_or(0.0) > 0.0,
                is_end: ends.get(id).copied().unwrap_or(0.0) > 0.0,
            }
        })
        .collect();
    plan.sort_by(|a, b| (a.rank, a.lane).cmp(&(b.rank, b.lane)));

    let routed = router::route(&plan, &chains, &route_links, &layout_rank, &lane_of);

    // --------------------------------------------------------------- assemble
    let platforms: Vec<Platform> = plan
        .iter()
        .map(|n| {
            let pos = routed.position[&n.id];
            Platform {
                id: n.id.clone(),
                activity: n.id.clone(),
                x: pos.x,
                z: pos.z,
                t: n.t,
                radius: routed.radius.get(&n.id).copied().unwrap_or(n.radius),
                rank: n.rank,
                lane: n.lane,
                object_types: n.object_types.clone(),
                counts: n.counts.clone(),
                count: n.count,
                is_start: n.is_start,
                is_end: n.is_end,
            }
        })
        .collect();

    let order = rank::topological(&ids, &forward, &rank_of);
    let object_types: Vec<ObjectTypeInfo> = types
        .iter()
        .map(|name| {
            let mut route: Vec<&PlanNode> = plan
                .iter()
                .filter(|n| n.object_types.iter().any(|t| t == name))
                .collect();
            route.sort_by(|a, b| {
                a.t.partial_cmp(&b.t)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| (a.rank, a.lane).cmp(&(b.rank, b.lane)))
            });
            ObjectTypeInfo {
                name: name.clone(),
                count: type_count.get(name).copied().unwrap_or(0.0),
                route: route.into_iter().map(|n| n.id.clone()).collect(),
            }
        })
        .filter(|info| !info.route.is_empty())
        .collect();

    let max_time = plan.iter().map(|n| n.t).fold(0.0_f64, f64::max);
    let stats = Stats {
        activities: platforms.len(),
        lines: routed.lines.len(),
        shafts: routed.shafts.len(),
        object_types: object_types.len(),
        max_time_secs: max_time,
        has_timing,
        dropped_activities: total_activities.saturating_sub(platforms.len()),
        dropped_edges,
        coverage: if observed_total > 0.0 {
            (kept_total / observed_total).clamp(0.0, 1.0)
        } else {
            0.0
        },
        basis: "OCDFG".into(),
    };

    StationMapPayload {
        object_types,
        platforms,
        lines: routed.lines,
        shafts: routed.shafts,
        order,
        extent: routed.extent,
        stats,
    }
}

/// The node the router works on: index-space position plus what the payload
/// will eventually need to say about it.
#[derive(Debug, Clone)]
pub(crate) struct PlanNode {
    pub id: String,
    pub rank: i32,
    pub lane: i32,
    pub radius: f64,
    pub object_types: Vec<String>,
    pub counts: Vec<f64>,
    pub count: f64,
    pub t: f64,
    pub is_start: bool,
    pub is_end: bool,
}

fn empty_payload(total: usize) -> StationMapPayload {
    StationMapPayload {
        object_types: Vec::new(),
        platforms: Vec::new(),
        lines: Vec::new(),
        shafts: Vec::new(),
        order: Vec::new(),
        extent: Point { x: 1.0, z: 1.0 },
        stats: Stats {
            activities: 0,
            lines: 0,
            shafts: 0,
            object_types: 0,
            max_time_secs: 0.0,
            has_timing: false,
            dropped_activities: total,
            dropped_edges: 0,
            coverage: 0.0,
            basis: "OCDFG".into(),
        },
    }
}
