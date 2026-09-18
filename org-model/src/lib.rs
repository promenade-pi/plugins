//! Organizational model mining — groups the people in a social network into
//! roles, and says what each role does.
//!
//! The input is a `SocialNetwork`, not a log. That is the whole design: the
//! network already states *which* relation is being clustered, and the answer
//! means different things for different relations. Clustering a similar-task
//! network finds **roles** — people who do the same kind of work, whether or
//! not they ever meet. Clustering a working-together or handover network
//! finds **organisational units** — people who share the work itself,
//! whatever each of them does in it. Both are in van der Aalst & Song, both
//! are useful, and the difference is not something this plugin should hide
//! behind one word. It reads the metric off the network and says which it
//! just produced.
//!
//! # Clustering
//!
//! Agglomerative, by default with average linkage: start with everyone in
//! their own role and repeatedly merge the two closest, recording every merge
//! as it goes. Three reasons it is the right family here rather than k-means
//! or a modularity method:
//!
//!   - It is **deterministic**. No seed, no restart, no "run it again and get
//!     a different org chart".
//!   - It needs only a *distance between two people*, which is exactly what a
//!     social network is. k-means would need coordinates, which people do not
//!     have.
//!   - The merge sequence *is* a dendrogram, so the cut is a slider rather
//!     than a guess: the same run supports every number of roles at once, and
//!     the view can show what the next merge would join.
//!
//! Connected components is offered too, as the honest floor: "everyone linked
//! above this threshold, transitively". It answers a different question and
//! answers it exactly.
//!
//! # Distance
//!
//! Every metric's weight means "more is closer", but they are on three
//! different scales (see the network's `weightKind`), so they are normalised
//! to a similarity in [0,1] before being turned into a distance:
//!
//!   share, ratio  →  weight / max weight
//!   similarity    →  (weight + 1) / 2, since a correlation can be negative
//!
//! and `distance = 1 - similarity`. A pair with no edge at all is at distance
//! 1 — as far apart as the scale goes. That is a real modelling choice and not
//! a neutral one: it means an absent relation is treated as a *maximally
//! weak* one rather than as missing data, which is what makes the clustering
//! well-defined on the sparse networks every real log produces.
//!
//! A directed network is symmetrised first — a → b and b → a are averaged.
//! Membership of a group is not directional; only the relation that suggested
//! it is.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use wasm_bindgen::prelude::*;

/// How many activities name a role. A role's identity is its dominant work;
/// past a handful the label stops being one.
const LABEL_ACTIVITIES: usize = 3;
/// How many activities a role reports a share for.
const ROLE_PROFILE: usize = 12;

// ------------------------------------------------------------- the input ---

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NodeIn {
    #[serde(default)]
    events: u32,
    #[serde(default)]
    cases: u32,
    /// `(activity index, count)` — see the Social Network plugin.
    #[serde(default)]
    profile: Vec<(u32, u32)>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EdgeIn {
    from: u32,
    to: u32,
    weight: f64,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SocialNetworkIn {
    #[serde(default)]
    metric: String,
    #[serde(default)]
    weight_kind: String,
    /// Present in the payload and deliberately unused: both directions of a
    /// pair are averaged whether or not the network calls itself directed,
    /// because membership of a group is never directional. Kept in the shape
    /// so the field is accounted for rather than silently ignored.
    #[serde(default, rename = "directed")]
    _directed: bool,
    #[serde(default)]
    resources: Vec<String>,
    #[serde(default)]
    activities: Vec<String>,
    #[serde(default)]
    nodes: Vec<NodeIn>,
    #[serde(default)]
    edges: Vec<EdgeIn>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Params {
    input_value: Option<SocialNetworkIn>,
    /// One of `hierarchicalCount`, `hierarchicalThreshold`, `components`.
    ///
    /// The cut is folded into the method rather than being its own parameter
    /// because the host's `showWhen` conditions are ANDed: a separate "cut by"
    /// control would leave the threshold needing "cut by is threshold **or**
    /// method is components", which cannot be stated. Three named methods say
    /// the same thing, and say it better in a dropdown.
    method: Option<String>,
    linkage: Option<String>,
    role_count: Option<u32>,
    threshold: Option<f64>,
}

/// What the three method names mean internally.
enum Method { Hierarchical(Cut), Components(f64) }

impl Method {
    fn parse(p: &Params) -> Method {
        let threshold = p.threshold.unwrap_or(0.5).clamp(0.0, 1.0);
        match p.method.as_deref().unwrap_or("hierarchicalCount") {
            "components" => Method::Components(threshold),
            "hierarchicalThreshold" => Method::Hierarchical(Cut::Threshold(threshold)),
            _ => Method::Hierarchical(Cut::Count(p.role_count.unwrap_or(5).max(1) as usize)),
        }
    }
}

// ------------------------------------------------------------ the output ---

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RoleOut {
    id: u32,
    /// The role's dominant activities, joined — what to call it in a list.
    label: String,
    members: Vec<u32>,
    size: usize,
    events: u32,
    cases: u32,
    /// `(activity index, share of the role's events)`, strongest first.
    profile: Vec<(u32, f64)>,
    /// Mean similarity between two members. 1 for a role of one, which is
    /// vacuous rather than perfect — `size` is right there to say so.
    cohesion: f64,
    /// Mean similarity from a member to everyone outside the role. A role
    /// worth the name has cohesion well above this.
    separation: f64,
}

/// One agglomeration step, in the order it happened — the dendrogram.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MergeOut {
    /// Cluster ids being joined. Ids below `resources.len()` are the original
    /// people; the merge at index `i` creates id `resources.len() + i`.
    a: u32,
    b: u32,
    /// Linkage distance at which they joined. Non-decreasing for average and
    /// complete linkage, which is what makes the dendrogram drawable.
    distance: f64,
    size: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    resources: usize,
    roles: usize,
    /// Roles with exactly one member — people the network could not group.
    singletons: usize,
    largest_role: usize,
    /// Mean silhouette over everyone, in [-1,1]. Above 0 means people are on
    /// average closer to their own role than to the nearest other one; it is
    /// the number to move the cut against.
    mean_silhouette: f64,
    mean_cohesion: f64,
    /// Pairs the network never related at all, as a share of all pairs — how
    /// much of this clustering rests on the absent-means-distant convention.
    sparsity: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OrgModel {
    /// What was clustered, carried through so the result is self-describing.
    source_metric: String,
    /// `roles` for a similar-task network, `units` otherwise — see the module
    /// header. The word the view uses.
    grouping: String,
    method: String,
    linkage: String,
    cut_by: String,
    /// The cut actually applied: a role count, or a distance threshold.
    cut: f64,
    resources: Vec<String>,
    activities: Vec<String>,
    roles: Vec<RoleOut>,
    /// Role index per resource, parallel to `resources`.
    role_of: Vec<u32>,
    merges: Vec<MergeOut>,
    stats: Stats,
}

// ------------------------------------------------------------- distances ---

/// Symmetric similarity matrix in [0,1], with 0 for "never related".
///
/// Returned flat, row-major, because it is read O(n²) times by the linkage
/// and a `Vec<Vec<f64>>` would chase a pointer for every one of them.
struct Similarity {
    n: usize,
    values: Vec<f64>,
    /// Pairs that had no edge in either direction.
    absent_pairs: usize,
}

impl Similarity {
    fn get(&self, a: usize, b: usize) -> f64 { self.values[a * self.n + b] }

    fn build(net: &SocialNetworkIn) -> Similarity {
        let n = net.resources.len();
        let mut values = vec![0.0; n * n];
        let max_weight = net.edges.iter().map(|e| e.weight.abs()).fold(0.0f64, f64::max);

        // Normalise to a similarity in [0,1]. A correlation is already on a
        // fixed scale and must not be divided by the largest one observed:
        // that would make one pair's similarity depend on the rest of the
        // network, which is exactly what a correlation is not.
        let normalise = |w: f64| -> f64 {
            if net.weight_kind == "similarity" {
                ((w + 1.0) / 2.0).clamp(0.0, 1.0)
            } else if max_weight > 0.0 {
                (w.abs() / max_weight).clamp(0.0, 1.0)
            } else {
                0.0
            }
        };

        let mut seen: HashSet<(usize, usize)> = HashSet::new();
        for e in &net.edges {
            let (a, b) = (e.from as usize, e.to as usize);
            if a >= n || b >= n || a == b { continue; }
            let s = normalise(e.weight);
            let (lo, hi) = if a < b { (a, b) } else { (b, a) };
            if seen.insert((lo, hi)) {
                values[lo * n + hi] = s;
                values[hi * n + lo] = s;
            } else {
                // Both directions present: average them. Which way work flows
                // is not an argument about whether two people belong together.
                let mean = (values[lo * n + hi] + s) / 2.0;
                values[lo * n + hi] = mean;
                values[hi * n + lo] = mean;
            }
        }
        for i in 0..n { values[i * n + i] = 1.0; }

        let total_pairs = n * n.saturating_sub(1) / 2;
        Similarity { n, values, absent_pairs: total_pairs.saturating_sub(seen.len()) }
    }
}

// ------------------------------------------------------------ clustering ---

#[derive(Clone, Copy, PartialEq, Eq)]
enum Linkage { Average, Complete, Single }

impl Linkage {
    fn parse(s: &str) -> Linkage {
        match s {
            "complete" => Linkage::Complete,
            "single" => Linkage::Single,
            _ => Linkage::Average,
        }
    }
    fn id(self) -> &'static str {
        match self {
            Linkage::Average => "average",
            Linkage::Complete => "complete",
            Linkage::Single => "single",
        }
    }
}

/// The full agglomeration, from n clusters down to one.
///
/// Recomputed linkage rather than a Lance-Williams update: n is the number of
/// *people*, which the Social Network plugin already caps at a few hundred,
/// and the straightforward version is the one whose correctness is obvious
/// from reading it. Cutting is then a separate, cheap step, which is what
/// lets the cut be a slider over one computation.
fn agglomerate(sim: &Similarity, linkage: Linkage) -> Vec<MergeOut> {
    let n = sim.n;
    if n < 2 { return Vec::new(); }

    // Live clusters, each a list of member indices, with the dendrogram id
    // it currently carries.
    let mut clusters: Vec<(u32, Vec<usize>)> =
        (0..n).map(|i| (i as u32, vec![i])).collect();
    let mut merges = Vec::with_capacity(n - 1);
    let mut next_id = n as u32;

    while clusters.len() > 1 {
        let mut best = (f64::INFINITY, 0usize, 1usize);
        for i in 0..clusters.len() {
            for j in (i + 1)..clusters.len() {
                let d = linkage_distance(sim, &clusters[i].1, &clusters[j].1, linkage);
                // Strict `<` keeps the first pair on a tie, and the scan order
                // is by original index, so ties resolve identically every run.
                if d < best.0 { best = (d, i, j); }
            }
        }
        let (distance, i, j) = best;
        let (id_b, members_b) = clusters.remove(j);
        let (id_a, members_a) = clusters.remove(i);
        let mut merged = members_a;
        merged.extend(members_b);
        merges.push(MergeOut { a: id_a, b: id_b, distance, size: merged.len() });
        clusters.push((next_id, merged));
        next_id += 1;
    }
    merges
}

fn linkage_distance(sim: &Similarity, a: &[usize], b: &[usize], linkage: Linkage) -> f64 {
    let mut sum = 0.0;
    let mut best = f64::INFINITY;
    let mut worst = f64::NEG_INFINITY;
    for &x in a {
        for &y in b {
            let d = 1.0 - sim.get(x, y);
            sum += d;
            if d < best { best = d; }
            if d > worst { worst = d; }
        }
    }
    match linkage {
        Linkage::Average => sum / (a.len() * b.len()) as f64,
        Linkage::Complete => worst,
        Linkage::Single => best,
    }
}

/// Replays the merge sequence, stopping at the requested cut, and returns one
/// group per surviving cluster.
///
/// Cutting a recorded dendrogram rather than re-clustering is what makes the
/// count and the threshold two views of the same answer: at the same cut they
/// produce identical groups, because they are literally the same merges.
fn cut_dendrogram(n: usize, merges: &[MergeOut], stop: &Cut) -> Vec<Vec<usize>> {
    let mut members: HashMap<u32, Vec<usize>> = (0..n).map(|i| (i as u32, vec![i])).collect();
    let mut next_id = n as u32;
    let mut live = n;

    for m in merges {
        match stop {
            Cut::Count(k) => if live <= (*k).max(1) { break },
            // A merge *at* the threshold still joins: the threshold is the
            // greatest distance two people may be and still share a role.
            Cut::Threshold(t) => if m.distance > *t { break },
        }
        let a = members.remove(&m.a).unwrap_or_default();
        let b = members.remove(&m.b).unwrap_or_default();
        let mut joined = a;
        joined.extend(b);
        members.insert(next_id, joined);
        next_id += 1;
        live -= 1;
    }

    // Ordered by the lowest member index so role ids are stable across runs
    // and reads in the order the people appear.
    let mut groups: Vec<Vec<usize>> = members.into_values()
        .map(|mut g| { g.sort_unstable(); g })
        .collect();
    groups.sort_by_key(|g| g.first().copied().unwrap_or(usize::MAX));
    groups
}

enum Cut { Count(usize), Threshold(f64) }

/// Connected components over the edges at or above a similarity threshold.
fn components(sim: &Similarity, min_similarity: f64) -> Vec<Vec<usize>> {
    let n = sim.n;
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut Vec<usize>, x: usize) -> usize {
        let mut r = x;
        while parent[r] != r { r = parent[r]; }
        let mut c = x;
        while parent[c] != c { let next = parent[c]; parent[c] = r; c = next; }
        r
    }
    for a in 0..n {
        for b in (a + 1)..n {
            if sim.get(a, b) >= min_similarity {
                let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
                if ra != rb { parent[ra] = rb; }
            }
        }
    }
    let mut by_root: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n { by_root.entry(find(&mut parent, i)).or_default().push(i); }
    let mut groups: Vec<Vec<usize>> = by_root.into_values().collect();
    for g in &mut groups { g.sort_unstable(); }
    groups.sort_by_key(|g| g.first().copied().unwrap_or(usize::MAX));
    groups
}

// ------------------------------------------------------------- describing ---

/// Mean similarity within a group, and from the group to everyone else.
fn cohesion_and_separation(sim: &Similarity, group: &[usize], n: usize) -> (f64, f64) {
    let mut within = 0.0;
    let mut within_pairs = 0usize;
    for i in 0..group.len() {
        for j in (i + 1)..group.len() {
            within += sim.get(group[i], group[j]);
            within_pairs += 1;
        }
    }
    let inside: HashSet<usize> = group.iter().copied().collect();
    let mut outside = 0.0;
    let mut outside_pairs = 0usize;
    for &m in group {
        for other in 0..n {
            if inside.contains(&other) { continue; }
            outside += sim.get(m, other);
            outside_pairs += 1;
        }
    }
    (
        if within_pairs > 0 { within / within_pairs as f64 } else { 1.0 },
        if outside_pairs > 0 { outside / outside_pairs as f64 } else { 0.0 },
    )
}

/// Mean silhouette over everyone.
///
/// Per person: how much closer they are to their own group than to the
/// nearest other group, scaled so 1 is "unambiguously in the right group" and
/// -1 is "belongs in another one". Someone alone in their group scores 0 —
/// neither well nor badly placed, which is the honest reading of a group of
/// one rather than the perfect score a naive formula gives.
fn mean_silhouette(sim: &Similarity, groups: &[Vec<usize>], role_of: &[u32]) -> f64 {
    let n = role_of.len();
    if groups.len() < 2 || n == 0 { return 0.0; }
    let mut total = 0.0;
    for i in 0..n {
        let own = role_of[i] as usize;
        let mut a = 0.0;
        let mut a_count = 0usize;
        for &m in &groups[own] {
            if m == i { continue; }
            a += 1.0 - sim.get(i, m);
            a_count += 1;
        }
        if a_count == 0 { continue; } // a group of one: contributes 0
        let a = a / a_count as f64;

        let mut b = f64::INFINITY;
        for (g, group) in groups.iter().enumerate() {
            if g == own || group.is_empty() { continue; }
            let mean: f64 = group.iter().map(|&m| 1.0 - sim.get(i, m)).sum::<f64>()
                / group.len() as f64;
            if mean < b { b = mean; }
        }
        if !b.is_finite() { continue; }
        let denom = a.max(b);
        if denom > 0.0 { total += (b - a) / denom; }
    }
    total / n as f64
}

/// The role's activity mix, and a name made from the top of it.
fn describe(net: &SocialNetworkIn, group: &[usize]) -> (Vec<(u32, f64)>, String, u32, u32) {
    let mut counts: HashMap<u32, u64> = HashMap::new();
    let mut events = 0u32;
    let mut cases = 0u32;
    for &m in group {
        let Some(node) = net.nodes.get(m) else { continue };
        events = events.saturating_add(node.events);
        // Summed, not deduplicated: the network does not say *which* cases a
        // person worked on, only how many, so this is "case involvements"
        // rather than distinct cases. Named `cases` for the same reason the
        // node field is, and not to be read as a distinct count.
        cases = cases.saturating_add(node.cases);
        for &(activity, count) in &node.profile {
            *counts.entry(activity).or_insert(0) += count as u64;
        }
    }
    let total: u64 = counts.values().sum();
    let mut profile: Vec<(u32, f64)> = counts.into_iter()
        .map(|(a, c)| (a, if total > 0 { c as f64 / total as f64 } else { 0.0 }))
        .collect();
    profile.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| x.0.cmp(&y.0)));

    let label = if profile.is_empty() {
        // Nothing to name it after — better an honest placeholder than a
        // confident wrong name.
        String::from("unnamed")
    } else {
        let named: Vec<&str> = profile.iter().take(LABEL_ACTIVITIES)
            .map(|(a, _)| net.activities.get(*a as usize).map(String::as_str).unwrap_or("?"))
            .collect();
        let rest = profile.len().saturating_sub(named.len());
        if rest > 0 { format!("{} +{rest}", named.join(", ")) } else { named.join(", ") }
    };
    profile.truncate(ROLE_PROFILE);
    (profile, label, events, cases)
}

// ---------------------------------------------------------------- mining ---

fn mine(net: &SocialNetworkIn, p: &Params) -> OrgModel {
    let n = net.resources.len();
    let sim = Similarity::build(net);
    let linkage = Linkage::parse(p.linkage.as_deref().unwrap_or("average"));
    let method = Method::parse(p);

    // The dendrogram is computed for every hierarchical run whatever the cut:
    // it costs the same as one cut, it is what the view draws, and it is what
    // makes the two cuts two readings of one computation.
    let merges = match method {
        Method::Components(_) => Vec::new(),
        Method::Hierarchical(_) => agglomerate(&sim, linkage),
    };

    let (groups, cut, method_id, cut_by) = match &method {
        Method::Components(t) => (components(&sim, *t), *t, "components", "threshold"),
        Method::Hierarchical(stop @ Cut::Threshold(t)) =>
            (cut_dendrogram(n, &merges, stop), *t, "agglomerative", "threshold"),
        Method::Hierarchical(stop @ Cut::Count(k)) =>
            (cut_dendrogram(n, &merges, stop), *k as f64, "agglomerative", "count"),
    };

    let mut role_of = vec![0u32; n];
    for (id, group) in groups.iter().enumerate() {
        for &m in group { if m < n { role_of[m] = id as u32; } }
    }

    let roles: Vec<RoleOut> = groups.iter().enumerate().map(|(id, group)| {
        let (profile, label, events, cases) = describe(net, group);
        let (cohesion, separation) = cohesion_and_separation(&sim, group, n);
        RoleOut {
            id: id as u32,
            label,
            members: group.iter().map(|&m| m as u32).collect(),
            size: group.len(),
            events, cases, profile, cohesion, separation,
        }
    }).collect();

    let singletons = roles.iter().filter(|r| r.size == 1).count();
    let largest_role = roles.iter().map(|r| r.size).max().unwrap_or(0);
    let mean_cohesion = if roles.is_empty() { 0.0 }
        else { roles.iter().map(|r| r.cohesion).sum::<f64>() / roles.len() as f64 };
    let total_pairs = n * n.saturating_sub(1) / 2;

    OrgModel {
        source_metric: net.metric.clone(),
        // A similar-task network groups people by the work itself; every
        // other relation groups them by the work they share.
        grouping: if net.metric.starts_with("similarTask") { "roles" } else { "units" }.to_string(),
        method: method_id.to_string(),
        linkage: linkage.id().to_string(),
        cut_by: cut_by.to_string(),
        cut,
        resources: net.resources.clone(),
        activities: net.activities.clone(),
        stats: Stats {
            resources: n,
            roles: roles.len(),
            singletons,
            largest_role,
            mean_silhouette: mean_silhouette(&sim, &groups, &role_of),
            mean_cohesion,
            sparsity: if total_pairs > 0 { sim.absent_pairs as f64 / total_pairs as f64 } else { 0.0 },
        },
        roles,
        role_of,
        merges,
    }
}

/// `value-finalize/1`: the whole input is one inline artifact, handed over as
/// `inputValue`. No log is scanned — everything needed is already in the
/// network, which is the point of making the network the input.
#[wasm_bindgen]
pub struct OrgModelKernel;

#[wasm_bindgen]
impl OrgModelKernel {
    #[wasm_bindgen(constructor)]
    pub fn new() -> OrgModelKernel { OrgModelKernel }

    #[wasm_bindgen(js_name = finalize)]
    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: Params = serde_wasm_bindgen::from_value(params)
            .map_err(|e| JsValue::from_str(&format!("bad params: {e}")))?;
        let net = p.input_value.clone()
            .ok_or_else(|| JsValue::from_str("no social network to cluster"))?;
        if net.resources.is_empty() {
            return Err(JsValue::from_str("this social network has no people in it"));
        }
        serde_wasm_bindgen::to_value(&mine(&net, &p))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(js_name = rowCount)]
    pub fn row_count(&self) -> u32 { 0 }
    #[wasm_bindgen(js_name = caseCount)]
    pub fn case_count(&self) -> u32 { 0 }
}

impl Default for OrgModelKernel {
    fn default() -> Self { Self::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a similarity network from named pairs, so a test reads like the
    /// organisation it describes.
    fn network(
        people: &[&str], activities: &[&str],
        profiles: &[(&str, &[(&str, u32)])],
        pairs: &[(&str, &str, f64)],
    ) -> SocialNetworkIn {
        let idx = |list: &[&str], name: &str| list.iter().position(|x| *x == name).unwrap() as u32;
        let nodes = people.iter().map(|person| {
            let profile: Vec<(u32, u32)> = profiles.iter()
                .find(|(p, _)| p == person)
                .map(|(_, entries)| entries.iter()
                    .map(|(a, c)| (idx(activities, a), *c)).collect())
                .unwrap_or_default();
            let events = profile.iter().map(|(_, c)| c).sum();
            NodeIn { events, cases: events, profile }
        }).collect();
        SocialNetworkIn {
            metric: "similarTask:cosine".into(),
            weight_kind: "similarity".into(),
            _directed: false,
            resources: people.iter().map(|s| s.to_string()).collect(),
            activities: activities.iter().map(|s| s.to_string()).collect(),
            nodes,
            edges: pairs.iter().map(|(a, b, w)| EdgeIn {
                from: idx(people, a), to: idx(people, b), weight: *w,
            }).collect(),
        }
    }

    /// Two clear groups: {ann, bob} review, {cat, dan} approve.
    fn two_groups() -> SocialNetworkIn {
        network(
            &["ann", "bob", "cat", "dan"],
            &["review", "approve"],
            &[
                ("ann", &[("review", 10)]), ("bob", &[("review", 8)]),
                ("cat", &[("approve", 9)]), ("dan", &[("approve", 7)]),
            ],
            // Similarity-kind weights, so 1.0 is identical and -1.0 opposite.
            &[
                ("ann", "bob", 1.0), ("cat", "dan", 1.0),
                ("ann", "cat", -1.0), ("ann", "dan", -1.0),
                ("bob", "cat", -1.0), ("bob", "dan", -1.0),
            ],
        )
    }

    fn params(role_count: u32) -> Params {
        Params { role_count: Some(role_count), ..Params::default() }
    }

    fn members_of(m: &OrgModel, person: &str) -> Vec<String> {
        let i = m.resources.iter().position(|r| r == person).unwrap();
        let role = m.role_of[i] as usize;
        m.roles[role].members.iter().map(|&x| m.resources[x as usize].clone()).collect()
    }

    #[test]
    fn people_who_do_the_same_work_end_up_together() {
        let m = mine(&two_groups(), &params(2));
        assert_eq!(m.stats.roles, 2);
        assert_eq!(members_of(&m, "ann"), vec!["ann", "bob"]);
        assert_eq!(members_of(&m, "cat"), vec!["cat", "dan"]);
        assert_eq!(m.grouping, "roles", "a similar-task network gives roles, not units");
    }

    #[test]
    fn a_role_is_named_after_the_work_its_members_do() {
        let m = mine(&two_groups(), &params(2));
        let ann_role = &m.roles[m.role_of[0] as usize];
        assert_eq!(ann_role.label, "review");
        let cat_role = &m.roles[m.role_of[2] as usize];
        assert_eq!(cat_role.label, "approve");
        // And the profile is a share of the role's own work.
        assert_eq!(ann_role.profile.len(), 1);
        assert!((ann_role.profile[0].1 - 1.0).abs() < 1e-12);
        assert_eq!(ann_role.events, 18);
    }

    #[test]
    fn a_role_mixing_two_activities_names_both() {
        let net = network(
            &["ann", "bob"], &["review", "approve", "file"],
            &[("ann", &[("review", 10), ("approve", 5)]), ("bob", &[("review", 6), ("file", 1)])],
            &[("ann", "bob", 0.9)],
        );
        let m = mine(&net, &params(1));
        assert_eq!(m.roles.len(), 1);
        // Most of the role's work first, and the tail counted rather than listed.
        assert_eq!(m.roles[0].label, "review, approve, file");
        let total: f64 = m.roles[0].profile.iter().map(|(_, s)| s).sum();
        assert!((total - 1.0).abs() < 1e-12, "the profile is a distribution");
    }

    #[test]
    fn the_cut_controls_how_many_roles_come_back() {
        let net = two_groups();
        for k in 1..=4 {
            let m = mine(&net, &params(k));
            assert_eq!(m.stats.roles, k as usize, "asked for {k}");
            // Every person is in exactly one role, whatever the cut.
            let assigned: usize = m.roles.iter().map(|r| r.size).sum();
            assert_eq!(assigned, m.resources.len());
        }
    }

    #[test]
    fn a_count_cut_and_a_threshold_cut_agree_when_they_mean_the_same_thing() {
        let net = two_groups();
        let by_count = mine(&net, &params(2));
        // The merge that would join the two groups is the last one; cutting
        // just below its distance must give the same two groups.
        let joining = by_count.merges.last().unwrap().distance;
        let by_threshold = mine(&net, &Params {
            method: Some("hierarchicalThreshold".into()),
            threshold: Some(joining - 1e-9),
            ..Params::default()
        });
        assert_eq!(by_threshold.stats.roles, by_count.stats.roles);
        for person in ["ann", "bob", "cat", "dan"] {
            assert_eq!(members_of(&by_threshold, person), members_of(&by_count, person), "{person}");
        }
    }

    #[test]
    fn cohesion_beats_separation_for_a_real_group() {
        let m = mine(&two_groups(), &params(2));
        for role in &m.roles {
            assert!(role.cohesion > role.separation,
                "role {} cohesion {} vs separation {}", role.label, role.cohesion, role.separation);
        }
        assert!(m.stats.mean_silhouette > 0.5, "clear groups: {}", m.stats.mean_silhouette);
    }

    #[test]
    fn a_directed_network_is_symmetrised_before_clustering() {
        // a → b strong, b → a weak. Membership is not directional, so the two
        // must be averaged rather than one direction winning.
        let mut net = network(
            &["ann", "bob", "cat"], &["x"],
            &[("ann", &[("x", 1)]), ("bob", &[("x", 1)]), ("cat", &[("x", 1)])],
            &[],
        );
        net.metric = "handover".into();
        net.weight_kind = "share".into();
        net._directed = true;
        net.edges = vec![
            EdgeIn { from: 0, to: 1, weight: 1.0 },
            EdgeIn { from: 1, to: 0, weight: 0.0 },
        ];
        let sim = Similarity::build(&net);
        assert!((sim.get(0, 1) - 0.5).abs() < 1e-12, "got {}", sim.get(0, 1));
        assert_eq!(sim.get(0, 1), sim.get(1, 0));

        let m = mine(&net, &params(2));
        assert_eq!(m.grouping, "units", "a handover network gives units, not roles");
    }

    #[test]
    fn components_groups_everything_linked_above_the_threshold() {
        let net = two_groups();
        let m = mine(&net, &Params {
            method: Some("components".into()),
            threshold: Some(0.9),
            ..Params::default()
        });
        assert_eq!(m.method, "components");
        assert_eq!(m.stats.roles, 2);
        assert_eq!(members_of(&m, "ann"), vec!["ann", "bob"]);
        // A threshold the data never reaches leaves everyone alone. It has to
        // be tested against a network whose best pair falls short, not with an
        // out-of-range number: the threshold is clamped into [0,1], so 1.0 is
        // the strictest there is and still admits a perfectly similar pair.
        let short = network(
            &["ann", "bob", "cat", "dan"], &["x"],
            &[("ann", &[("x", 1)]), ("bob", &[("x", 1)]), ("cat", &[("x", 1)]), ("dan", &[("x", 1)])],
            // 0.8 on the similarity scale is 0.9 once mapped into [0,1].
            &[("ann", "bob", 0.8), ("cat", "dan", 0.8)],
        );
        let alone = mine(&short, &Params {
            method: Some("components".into()), threshold: Some(1.0), ..Params::default()
        });
        assert_eq!(alone.stats.roles, 4);
        assert_eq!(alone.stats.singletons, 4);
        // And just below it, the two pairs are back.
        let paired = mine(&short, &Params {
            method: Some("components".into()), threshold: Some(0.9), ..Params::default()
        });
        assert_eq!(paired.stats.roles, 2);
    }

    #[test]
    fn a_person_nobody_is_related_to_stays_on_their_own() {
        let net = network(
            &["ann", "bob", "zoe"], &["x", "y"],
            &[("ann", &[("x", 5)]), ("bob", &[("x", 5)]), ("zoe", &[("y", 5)])],
            &[("ann", "bob", 1.0)],
        );
        let m = mine(&net, &params(2));
        assert_eq!(members_of(&m, "zoe"), vec!["zoe"]);
        assert_eq!(m.stats.singletons, 1);
        // The absent pairs are reported, since the whole clustering rests on
        // reading them as maximally distant.
        assert!(m.stats.sparsity > 0.0);
    }

    #[test]
    fn linkage_changes_where_a_chain_is_cut() {
        // A chain: ann—bob strong, bob—cat medium, cat—dan strong. Single
        // linkage chains them into one group readily; complete linkage
        // resists, because it judges a group by its worst pair.
        let net = network(
            &["ann", "bob", "cat", "dan"], &["x"],
            &[("ann", &[("x", 1)]), ("bob", &[("x", 1)]), ("cat", &[("x", 1)]), ("dan", &[("x", 1)])],
            &[("ann", "bob", 1.0), ("bob", "cat", 0.2), ("cat", "dan", 1.0)],
        );
        let single = mine(&net, &Params { linkage: Some("single".into()), ..params(2) });
        let complete = mine(&net, &Params { linkage: Some("complete".into()), ..params(2) });
        // Both give two groups here; what differs is the distance recorded for
        // the merge that would join them.
        let last_single = single.merges.last().unwrap().distance;
        let last_complete = complete.merges.last().unwrap().distance;
        assert!(last_complete > last_single,
            "complete linkage must judge the join at least as harshly: {last_complete} vs {last_single}");
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

    fn random_network(rng: &mut Rng) -> SocialNetworkIn {
        let n = 2 + rng.below(14);
        let acts = 1 + rng.below(5);
        let resources: Vec<String> = (0..n).map(|i| format!("p{i}")).collect();
        let activities: Vec<String> = (0..acts).map(|i| format!("a{i}")).collect();
        let nodes: Vec<NodeIn> = (0..n).map(|_| {
            let mut profile: Vec<(u32, u32)> = Vec::new();
            for a in 0..acts {
                if rng.unit() < 0.6 { profile.push((a as u32, 1 + rng.below(20) as u32)); }
            }
            let events = profile.iter().map(|(_, c)| c).sum();
            NodeIn { events, cases: events, profile }
        }).collect();
        let mut edges = Vec::new();
        for a in 0..n {
            for b in (a + 1)..n {
                if rng.unit() < 0.5 {
                    edges.push(EdgeIn { from: a as u32, to: b as u32, weight: rng.unit() * 2.0 - 1.0 });
                }
            }
        }
        SocialNetworkIn {
            metric: "similarTask:pearson".into(), weight_kind: "similarity".into(),
            _directed: false, resources, activities, nodes, edges,
        }
    }

    #[test]
    fn every_clustering_partitions_everyone_exactly_once() {
        for seed in 1..200u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
            let net = random_network(&mut rng);
            let n = net.resources.len();
            for method in ["hierarchicalCount", "components"] {
                for k in [1usize, 2, 3, n] {
                    let m = mine(&net, &Params {
                        method: Some(method.into()),
                        role_count: Some(k as u32),
                        threshold: Some(0.4),
                        ..Params::default()
                    });
                    let where_ = format!("seed {seed}, {method}, k={k}, n={n}");

                    // A partition: every person in exactly one role.
                    let mut seen = vec![0usize; n];
                    for role in &m.roles {
                        for &member in &role.members {
                            assert!((member as usize) < n, "{where_}: member out of range");
                            seen[member as usize] += 1;
                        }
                    }
                    assert!(seen.iter().all(|&c| c == 1), "{where_}: not a partition: {seen:?}");

                    // role_of agrees with the membership lists.
                    for (person, &role) in m.role_of.iter().enumerate() {
                        assert!(m.roles[role as usize].members.contains(&(person as u32)),
                            "{where_}: role_of disagrees for {person}");
                    }

                    // Every reported number is finite and in range.
                    assert!(m.stats.mean_silhouette >= -1.0 - 1e-9
                        && m.stats.mean_silhouette <= 1.0 + 1e-9, "{where_}");
                    for role in &m.roles {
                        assert!(role.cohesion.is_finite() && role.separation.is_finite(), "{where_}");
                        assert!(!role.label.is_empty(), "{where_}: a role with no name");
                        let share: f64 = role.profile.iter().map(|(_, s)| s).sum();
                        assert!(share <= 1.0 + 1e-9, "{where_}: profile shares sum to {share}");
                    }
                }
            }
        }
    }

    #[test]
    fn a_coarser_cut_only_ever_merges_roles() {
        // Monotone: lowering the role count may join two groups but must never
        // split one. Without it the "number of roles" slider would reshuffle
        // people rather than aggregate them, and the dendrogram would be a lie.
        for seed in 1..150u64 {
            let mut rng = Rng(seed.wrapping_mul(0x2545_F491_4F6C_DD1D));
            let net = random_network(&mut rng);
            let n = net.resources.len();
            for k in 2..=n {
                let fine = mine(&net, &params(k as u32));
                let coarse = mine(&net, &params(k as u32 - 1));
                for (person, &role) in fine.role_of.iter().enumerate() {
                    for &other in &fine.roles[role as usize].members {
                        assert_eq!(
                            coarse.role_of[person], coarse.role_of[other as usize],
                            "seed {seed}, k={k}: {person} and {other} shared a role and no longer do",
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn the_dendrogram_is_drawable() {
        for seed in 1..150u64 {
            let mut rng = Rng(seed.wrapping_mul(0xD1B5_4A32_D192_ED03));
            let net = random_network(&mut rng);
            let n = net.resources.len();
            let m = mine(&net, &Params { linkage: Some("average".into()), ..params(2) });

            assert_eq!(m.merges.len(), n - 1, "seed {seed}: a dendrogram has n-1 merges");
            // Distances never decrease for average linkage, which is what lets
            // a renderer place a merge at a height.
            for pair in m.merges.windows(2) {
                assert!(pair[1].distance >= pair[0].distance - 1e-9,
                    "seed {seed}: inversion {} then {}", pair[0].distance, pair[1].distance);
            }
            // Every cluster id is used once as a child, and the ids are the
            // ones a renderer expects.
            let mut used: HashSet<u32> = HashSet::new();
            for (i, merge) in m.merges.iter().enumerate() {
                for id in [merge.a, merge.b] {
                    assert!((id as usize) < n + i, "seed {seed}: merge references a future cluster");
                    assert!(used.insert(id), "seed {seed}: cluster {id} merged twice");
                }
                assert!(merge.distance >= 0.0 && merge.distance <= 1.0 + 1e-9, "seed {seed}");
            }
        }
    }
}
