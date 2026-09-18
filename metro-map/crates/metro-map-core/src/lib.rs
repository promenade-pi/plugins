//! OCPN → metro-map schematic graph.
//!
//! Turns an `ObjectCentricPetriNet` (places/transitions/arcs, one WF-net per
//! object type, merged by shared activity — see `plugins/ocpn-rs`) into a
//! smaller graph a transit-map-style view can draw: activities become
//! "stations" (already merged across object types, since a labelled
//! transition's id is a pure function of its activity), branching places and
//! silent transitions become gateway nodes (XOR/AND), and every node gets an
//! integer `rank` (top-to-bottom, roughly process time order) and `lane`
//! (left-to-right position within its rank) via a hand-rolled layered-graph
//! layout — no ELK, no external layout crate, so the whole thing stays a
//! small `cargo test`-able algorithm with zero non-serde dependencies.
//!
//! No pixel coordinates here: `rank`/`lane` are an integer grid, exactly the
//! shape a 45°-only octilinear router (the view's job) wants to snap to.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

// --------------------------------------------------------------- input model

type PlaceId = String;
type TransitionId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InPlaceKind {
    Normal,
    Source,
    Sink,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InPlace {
    pub id: PlaceId,
    #[serde(rename = "objectType")]
    pub object_type: String,
    pub kind: InPlaceKind,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InTransition {
    pub id: TransitionId,
    /// `None` for a silent (tau) transition.
    pub activity: Option<String>,
    #[serde(rename = "objectTypes")]
    pub object_types: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InNodeRef {
    Place { id: PlaceId },
    Transition { id: TransitionId },
}

#[derive(Debug, Clone, Deserialize)]
pub struct InArc {
    pub source: InNodeRef,
    pub target: InNodeRef,
    #[serde(rename = "objectType")]
    pub object_type: String,
    /// Mirrors `run.promenade.ocpn`'s `Arc.variable`: set when a single
    /// firing of the connected transition can consume/produce more than one
    /// token of this object type. `#[serde(default)]` so an OCPN payload
    /// from before this flag existed still deserializes, as `false` — the
    /// same "we don't know, so we don't claim it" default the rest of this
    /// crate uses for missing upstream facts.
    #[serde(default)]
    pub variable: bool,
}

/// The fields of `ObjectCentricPetriNet` this algorithm actually reads.
/// `metadata` is intentionally not modelled — serde ignores unknown fields
/// on a struct by default, and the algorithm needs none of it.
#[derive(Debug, Clone, Deserialize)]
pub struct OcpnPayload {
    #[serde(rename = "objectTypes")]
    pub object_types: Vec<String>,
    pub places: Vec<InPlace>,
    pub transitions: Vec<InTransition>,
    pub arcs: Vec<InArc>,
}

/// The fields of the `OCDFG` artifact this algorithm reads — mirrors
/// `plugins/ocdfg-flow-view/src/types.ts`'s `OcdfgPayload` (which itself
/// mirrors the host's `core.discover.ocdfg` output). `stats` and any other
/// field are ignored by serde.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcdfgPayload {
    pub object_types: Vec<String>,
    pub nodes: Vec<OcdfgNode>,
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
    /// Mean wait between the two activities, in seconds. Emitted by
    /// `core.discover.ocdfg` 0.2.0; absent (or null) on an older OCDFG, or
    /// where the log has no usable timestamps.
    #[serde(rename = "avgSecs", default)]
    pub avg_secs: Option<f64>,
}

// -------------------------------------------------------------- output model

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GatewayType {
    And,
    Xor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GatewayDirection {
    Split,
    Join,
    /// The same place/silent-transition both joins (in-degree > 1) and
    /// splits (out-degree > 1) at once — drawn the same as a split/join pair
    /// collapsed into one glyph rather than invented as two nodes.
    Both,
}

/// Optional per-node overlay data — only populated for the OC-DFG basis
/// (`frequency`) or the Petri-net basis (`reveal_order`, the structural
/// leaf-peel order the view's complexity slider reveals nodes in). Both are
/// skipped on the wire when absent, so the Petri-net payload the existing
/// view path already knows is unchanged except for the added `revealOrder`.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct NodeMeta {
    #[serde(rename = "frequency", skip_serializing_if = "Option::is_none")]
    pub frequency: Option<f64>,
    #[serde(rename = "revealOrder", skip_serializing_if = "Option::is_none")]
    pub reveal_order: Option<i32>,
}

impl NodeMeta {
    // `#[serde(flatten)]` would be nicer on the wire, but serde_wasm_bindgen
    // drops an internally-tagged enum's own `kind` tag when a variant also
    // has a flattened field — so this rides as a nested `"meta"` object,
    // omitted entirely when it carries nothing.
    fn is_empty(&self) -> bool {
        self.frequency.is_none() && self.reveal_order.is_none()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OutNode {
    Station {
        id: String,
        activity: String,
        #[serde(rename = "objectTypes")]
        object_types: Vec<String>,
        rank: i32,
        lane: f64,
        #[serde(skip_serializing_if = "NodeMeta::is_empty")]
        meta: NodeMeta,
    },
    Gateway {
        id: String,
        #[serde(rename = "gatewayType")]
        gateway_type: GatewayType,
        direction: GatewayDirection,
        #[serde(rename = "objectType")]
        object_type: String,
        rank: i32,
        lane: f64,
        #[serde(skip_serializing_if = "NodeMeta::is_empty")]
        meta: NodeMeta,
    },
    Source {
        id: String,
        #[serde(rename = "objectType")]
        object_type: String,
        rank: i32,
        lane: f64,
        #[serde(skip_serializing_if = "NodeMeta::is_empty")]
        meta: NodeMeta,
    },
    Sink {
        id: String,
        #[serde(rename = "objectType")]
        object_type: String,
        rank: i32,
        lane: f64,
        #[serde(skip_serializing_if = "NodeMeta::is_empty")]
        meta: NodeMeta,
    },
}

impl OutNode {
    pub fn id(&self) -> &str {
        match self {
            OutNode::Station { id, .. }
            | OutNode::Gateway { id, .. }
            | OutNode::Source { id, .. }
            | OutNode::Sink { id, .. } => id,
        }
    }
    fn rank(&self) -> i32 {
        match self {
            OutNode::Station { rank, .. }
            | OutNode::Gateway { rank, .. }
            | OutNode::Source { rank, .. }
            | OutNode::Sink { rank, .. } => *rank,
        }
    }
    #[cfg(test)]
    fn lane(&self) -> f64 {
        match self {
            OutNode::Station { lane, .. }
            | OutNode::Gateway { lane, .. }
            | OutNode::Source { lane, .. }
            | OutNode::Sink { lane, .. } => *lane,
        }
    }
    fn set_rank_lane(&mut self, rank: i32, lane: f64) {
        match self {
            OutNode::Station { rank: r, lane: l, .. }
            | OutNode::Gateway { rank: r, lane: l, .. }
            | OutNode::Source { rank: r, lane: l, .. }
            | OutNode::Sink { rank: r, lane: l, .. } => {
                *r = rank;
                *l = lane;
            }
        }
    }
    fn meta_mut(&mut self) -> &mut NodeMeta {
        match self {
            OutNode::Station { meta, .. }
            | OutNode::Gateway { meta, .. }
            | OutNode::Source { meta, .. }
            | OutNode::Sink { meta, .. } => meta,
        }
    }
    fn is_boundary(&self) -> bool {
        matches!(self, OutNode::Source { .. } | OutNode::Sink { .. })
    }
    fn is_source(&self) -> bool {
        matches!(self, OutNode::Source { .. })
    }
    fn any_object_type(&self) -> String {
        match self {
            OutNode::Station { object_types, .. } => object_types.first().cloned().unwrap_or_default(),
            OutNode::Gateway { object_type, .. }
            | OutNode::Source { object_type, .. }
            | OutNode::Sink { object_type, .. } => object_type.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EdgeKind {
    Flow,
    Loop,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Waypoint {
    pub rank: i32,
    pub lane: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(rename = "objectType")]
    pub object_type: String,
    /// Whether at least one arc collapsed into this drawn edge was a
    /// variable arc in the source OCPN (`InArc.variable`) — a single firing
    /// of the transition at either end can consume/produce more than one
    /// token of this object type, so the schematic's single line here
    /// actually stands for a one-to-many (or many-to-one) relation, not a
    /// one-to-one token pass. Always `false` on the OC-DFG basis: a
    /// directly-follows graph carries no arc/token structure to derive this
    /// from, so the fact simply isn't representable there — see
    /// `build_metro_map_from_ocdfg`. Always present (never optional), unlike
    /// `frequency`/`duration_secs`: this is a hard yes/no fact of the
    /// upstream model wherever there is one, not an observed count that can
    /// legitimately be absent.
    pub variable: bool,
    pub kind: EdgeKind,
    /// Fixed, alphabetical rank of this edge's object type among every
    /// object type in the net, applied globally (not just within edges
    /// sharing both endpoints) — the same relative left-right order
    /// wherever this object type's line runs alongside others.
    #[serde(rename = "laneOffset")]
    pub lane_offset: i32,
    /// One entry per rank this edge passes *through* without a real node
    /// there — present whenever `target`'s rank is more than one greater
    /// than `source`'s. These are classic Sugiyama "dummy nodes": with
    /// nothing occupying the intermediate ranks, the lane-ordering pass has
    /// no way to know a long edge is passing through them and can freely
    /// place an unrelated real node directly on its path. Reserving a lane
    /// at every intermediate rank (see `build_metro_map`'s dummy-chain
    /// construction) is what keeps that from happening; the view stitches
    /// these into one continuous routed line, not separate edges.
    #[serde(rename = "waypoints", skip_serializing_if = "Vec::is_empty")]
    pub waypoints: Vec<Waypoint>,
    /// Observed frequency of this directly-follows relation — only set for
    /// the OC-DFG basis (`build_metro_map_from_ocdfg`); `None` for the
    /// Petri-net basis, which has no per-arc counts. Drives the view's
    /// frequency-ranked complexity slider and the optional edge number.
    #[serde(rename = "frequency", skip_serializing_if = "Option::is_none")]
    pub frequency: Option<f64>,
    /// Mean wait along this relation, in seconds — the "performance"
    /// counterpart to `frequency`. Only set on the OC-DFG basis, and only
    /// when the upstream discovery supplied durations.
    #[serde(rename = "durationSecs", skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<f64>,
}

/// Which upstream model the metro map was derived from. The view adapts its
/// controls to this: `PetriNet` keeps the structurally-mined ×/+ gateways
/// and offers a leaf-peel complexity slider; `DirectlyFollows` has no
/// gateways but carries real frequencies, so its slider is frequency-ranked
/// (top-N arcs per object type).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Basis {
    PetriNet,
    DirectlyFollows,
}

/// Which edge to drop when a cycle exists only because two or more object
/// types share stations — see the long comment above `feedback_arcs`'s call
/// site in `assemble_metro_map`. `Structural` (the only option before this)
/// is a single greedy DFS pass: fast and deterministic, but which edge of the
/// cycle it drops is an accident of node-id sort order, not anything about
/// the edge itself — a rare cross-type wraparound can just as easily win over
/// a station's own high-traffic through-line as lose to it. `Frequency`
/// always drops the *lightest* edge of each cycle instead (ties broken by
/// node id, so the result stays deterministic), so ranking follows whichever
/// direction actually carries the traffic. Only the directly-follows basis
/// has real per-edge frequencies to weigh by; the Petri-net basis always
/// uses `Structural`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RankTiebreak {
    #[default]
    Structural,
    Frequency,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetroStats {
    /// Which upstream model this map came from. Rides into the artifact's
    /// `meta`, where the host can read it — the view's "edge labels" choice
    /// is only meaningful on the directly-follows basis, and declares a
    /// `showWhen` condition on exactly this fact.
    pub basis: Basis,
    pub stations: usize,
    pub arcs: usize,
    #[serde(rename = "objectTypes")]
    pub object_types: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetroMapPayload {
    pub basis: Basis,
    #[serde(rename = "objectTypes")]
    pub object_types: Vec<String>,
    pub nodes: Vec<OutNode>,
    pub edges: Vec<OutEdge>,
    /// Small facts about this map. The host copies these into the artifact's
    /// `meta`, so they show in the Statistics panel and are readable by a
    /// parameter's `showWhen` condition.
    pub stats: MetroStats,
}

// ------------------------------------------------------------- sub-node keys

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum SubNode {
    Place(PlaceId),
    Transition(TransitionId),
}

impl From<&InNodeRef> for SubNode {
    fn from(r: &InNodeRef) -> Self {
        match r {
            InNodeRef::Place { id } => SubNode::Place(id.clone()),
            InNodeRef::Transition { id } => SubNode::Transition(id.clone()),
        }
    }
}

fn node_id(n: &SubNode) -> String {
    match n {
        SubNode::Place(id) => format!("place:{id}"),
        SubNode::Transition(id) => format!("transition:{id}"),
    }
}

// ---------------------------------------------------------------- main entry

pub fn build_metro_map(net: &OcpnPayload) -> MetroMapPayload {
    let mut out_deg: HashMap<SubNode, u32> = HashMap::new();
    let mut in_deg: HashMap<SubNode, u32> = HashMap::new();
    for arc in &net.arcs {
        *out_deg.entry(SubNode::from(&arc.source)).or_default() += 1;
        *in_deg.entry(SubNode::from(&arc.target)).or_default() += 1;
    }
    let deg = |m: &HashMap<SubNode, u32>, n: &SubNode| *m.get(n).unwrap_or(&0);

    // A node is "meaningful" (survives into the metro map) when it carries
    // branching or boundary meaning; everything else is a wire, walked
    // through rather than drawn. See the module doc and the plan this
    // mirrors: place out/in-degree > 1 is a choice; a silent transition's
    // out/in-degree > 1 is parallelism; a source/sink place is always kept;
    // a labelled transition (an activity) is always kept as a station.
    let mut nodes: HashMap<String, OutNode> = HashMap::new();
    let mut meaningful: HashSet<SubNode> = HashSet::new();

    for t in &net.transitions {
        let sub = SubNode::Transition(t.id.clone());
        if let Some(activity) = &t.activity {
            meaningful.insert(sub.clone());
            nodes.insert(
                node_id(&sub),
                OutNode::Station {
                    id: node_id(&sub),
                    activity: activity.clone(),
                    object_types: t.object_types.clone(),
                    rank: 0,
                    lane: 0.0,
                    meta: NodeMeta::default(),
                },
            );
        } else {
            let (o, i) = (deg(&out_deg, &sub), deg(&in_deg, &sub));
            if o > 1 || i > 1 {
                meaningful.insert(sub.clone());
                let direction = match (i > 1, o > 1) {
                    (true, true) => GatewayDirection::Both,
                    (true, false) => GatewayDirection::Join,
                    _ => GatewayDirection::Split,
                };
                let object_type = t.object_types.first().cloned().unwrap_or_default();
                nodes.insert(
                    node_id(&sub),
                    OutNode::Gateway {
                        id: node_id(&sub),
                        gateway_type: GatewayType::And,
                        direction,
                        object_type,
                        rank: 0,
                        lane: 0.0,
                        meta: NodeMeta::default(),
                    },
                );
            }
        }
    }

    for p in &net.places {
        let sub = SubNode::Place(p.id.clone());
        let (o, i) = (deg(&out_deg, &sub), deg(&in_deg, &sub));
        match p.kind {
            InPlaceKind::Source => {
                meaningful.insert(sub.clone());
                nodes.insert(
                    node_id(&sub),
                    OutNode::Source { id: node_id(&sub), object_type: p.object_type.clone(), rank: 0, lane: 0.0, meta: NodeMeta::default() },
                );
            }
            InPlaceKind::Sink => {
                meaningful.insert(sub.clone());
                nodes.insert(
                    node_id(&sub),
                    OutNode::Sink { id: node_id(&sub), object_type: p.object_type.clone(), rank: 0, lane: 0.0, meta: NodeMeta::default() },
                );
            }
            InPlaceKind::Normal if o > 1 || i > 1 => {
                meaningful.insert(sub.clone());
                let direction = match (i > 1, o > 1) {
                    (true, true) => GatewayDirection::Both,
                    (true, false) => GatewayDirection::Join,
                    _ => GatewayDirection::Split,
                };
                nodes.insert(
                    node_id(&sub),
                    OutNode::Gateway {
                        id: node_id(&sub),
                        gateway_type: GatewayType::Xor,
                        direction,
                        object_type: p.object_type.clone(),
                        rank: 0,
                        lane: 0.0,
                        meta: NodeMeta::default(),
                    },
                );
            }
            InPlaceKind::Normal => {}
        }
    }

    // Forward adjacency, one map per object type (a place's or silent
    // transition's arcs are always homogeneous in object type by
    // construction — `validateOcpn` enforces this on the TS side — so no
    // cross-type leakage can happen while walking). `variable_of` mirrors
    // `next_by_ot`'s shape — one lookup per hop, keyed the same way — so a
    // walk can tell, hop by hop, whether the specific arc it is crossing was
    // a variable arc.
    let mut next_by_ot: HashMap<&str, HashMap<SubNode, Vec<SubNode>>> = HashMap::new();
    let mut variable_of: HashMap<&str, HashMap<(SubNode, SubNode), bool>> = HashMap::new();
    for arc in &net.arcs {
        let src = SubNode::from(&arc.source);
        let tgt = SubNode::from(&arc.target);
        next_by_ot
            .entry(arc.object_type.as_str())
            .or_default()
            .entry(src.clone())
            .or_default()
            .push(tgt.clone());
        // `or_insert(false)`, then OR in: two parallel arcs between the same
        // pair of nodes shouldn't occur in a valid OCPN, but nothing here
        // assumes it can't, and a later non-variable arc must not erase an
        // earlier variable one for the same (source, target) pair.
        let slot = variable_of.entry(arc.object_type.as_str()).or_default().entry((src, tgt)).or_insert(false);
        *slot = *slot || arc.variable;
    }

    // Walk from every meaningful node, through any chain of pass-through
    // wires, to the next meaningful node(s) it reaches — those become direct
    // edges. `walk_to_meaningful` also reports, per reached node, whether any
    // arc *inside* the walked chain was variable; the hop directly out of
    // `start` is looked up separately below, since that hop is not part of
    // the recursive walk itself. A variable arc anywhere along a collapsed
    // wire is a fact about the relation the whole chain represents, not
    // about whichever single arc happened to carry it, so every hop across
    // the full path from `start` to `reached` counts.
    let mut raw_edges: Vec<(SubNode, SubNode, String)> = Vec::new();
    let mut raw_variable: HashMap<(SubNode, SubNode, String), bool> = HashMap::new();
    for (ot, next) in &next_by_ot {
        let var_for_type = variable_of.get(ot);
        for start in meaningful.iter() {
            let Some(children) = next.get(start) else { continue };
            for child in children {
                let first_hop_variable = var_for_type
                    .and_then(|m| m.get(&(start.clone(), child.clone())))
                    .copied()
                    .unwrap_or(false);
                let mut visited = HashSet::new();
                for (reached, chain_variable) in
                    walk_to_meaningful(child, next, &meaningful, &mut visited, var_for_type)
                {
                    let key = (start.clone(), reached.clone(), (*ot).to_string());
                    raw_edges.push((start.clone(), reached, (*ot).to_string()));
                    let slot = raw_variable.entry(key).or_insert(false);
                    *slot = *slot || first_hop_variable || chain_variable;
                }
            }
        }
    }
    // De-duplicate: a walk can reach the same meaningful target more than
    // once through different pass-through branches that both mean "the same
    // direct step" once collapsed. `raw_variable` was already OR-merged
    // across every such branch above, independently of which occurrence
    // `retain` below happens to keep.
    let mut seen_edges = HashSet::new();
    raw_edges.retain(|(a, b, ot)| seen_edges.insert((a.clone(), b.clone(), ot.clone())));

    // Hand off to the shared, basis-agnostic layout back-end as plain id
    // triples. The Petri-net front-end (this function) carries no per-arc or
    // per-activity counts, so both frequency maps are empty; `reveal_order`
    // (the leaf-peel complexity order the view's slider uses on this basis)
    // is computed inside `assemble_metro_map`.
    let raw_edges: Vec<(String, String, String)> =
        raw_edges.into_iter().map(|(a, b, ot)| (node_id(&a), node_id(&b), ot)).collect();
    let edge_variable: HashMap<(String, String, String), bool> = raw_variable
        .into_iter()
        .map(|((a, b, ot), variable)| ((node_id(&a), node_id(&b), ot), variable))
        .collect();
    assemble_metro_map(
        nodes,
        raw_edges,
        net.object_types.clone(),
        Basis::PetriNet,
        HashMap::new(),
        HashMap::new(),
        HashMap::new(),
        edge_variable,
        // No frequency data on this basis, so there is nothing to weigh a
        // choice by — always the original structural tie-break.
        RankTiebreak::Structural,
    )
}

/// The shared layout back-end: cycle breaking, longest-path ranking, ALAP
/// false-roots, dummy waypoint chains, barycenter + transpose ordering, PAVA
/// coordinate assignment, spine centring and `concentrate_dummy_drift`. It
/// is entirely graph-shape agnostic — it works on id strings, ranks and an
/// adjacency map — so both the Petri-net front-end (`build_metro_map`) and
/// the OC-DFG front-end (`build_metro_map_from_ocdfg`) reuse it verbatim,
/// differing only in how they turn their source model into `nodes` and
/// `raw_edges`.
///
/// `node_freq` / `edge_freq` are the OC-DFG basis's observed counts (empty
/// for the Petri-net basis). `basis` selects whether a structural leaf-peel
/// `reveal_order` is computed for the view's complexity slider (Petri net)
/// or the slider ranks arcs by `edge_freq` instead (directly-follows).
/// `edge_variable` is the Petri-net basis's counterpart: whether *any* arc
/// collapsed into this key's drawn edge was a variable arc (empty for the
/// OC-DFG basis, which has no such concept — see `OutEdge::variable`).
fn assemble_metro_map(
    mut nodes: HashMap<String, OutNode>,
    mut raw_edges: Vec<(String, String, String)>,
    object_types_in: Vec<String>,
    basis: Basis,
    node_freq: HashMap<String, f64>,
    edge_freq: HashMap<(String, String, String), f64>,
    // Frequency-weighted sum of the mean wait per relation. Divided by the
    // relation's own frequency below to recover a mean that stays correct
    // when several upstream arcs collapse into one drawn edge.
    edge_dur_weighted: HashMap<(String, String, String), f64>,
    edge_variable: HashMap<(String, String, String), bool>,
    rank_tiebreak: RankTiebreak,
) -> MetroMapPayload {
    // A start ▶ / end ■ marker must carry exactly one line. When the model
    // gives a boundary place more than one first step (or a sink more than
    // one last step) — a choice sitting right on the boundary — splice a
    // synthetic XOR gateway between the marker and those steps so the marker
    // itself never appears to fan out to several activities.
    {
        let mut by_boundary: HashMap<String, Vec<usize>> = HashMap::new();
        for (idx, (a, b, _)) in raw_edges.iter().enumerate() {
            if nodes.get(a).map(|n| n.is_source()).unwrap_or(false) {
                by_boundary.entry(a.clone()).or_default().push(idx);
            }
            if nodes.get(b).map(|n| n.is_boundary() && !n.is_source()).unwrap_or(false) {
                by_boundary.entry(b.clone()).or_default().push(idx);
            }
        }
        let mut splices: Vec<String> = by_boundary
            .iter()
            .filter(|(_, idxs)| idxs.len() > 1)
            .map(|(bid, _)| bid.clone())
            .collect();
        splices.sort();
        for bid in splices {
            let is_src = nodes.get(&bid).map(|n| n.is_source()).unwrap_or(false);
            let ot = nodes.get(&bid).map(|n| n.any_object_type()).unwrap_or_default();
            let gid = format!("gateway:boundary-split:{bid}");
            nodes.insert(
                gid.clone(),
                OutNode::Gateway {
                    id: gid.clone(),
                    gateway_type: GatewayType::Xor,
                    direction: if is_src { GatewayDirection::Split } else { GatewayDirection::Join },
                    object_type: ot.clone(),
                    rank: 0,
                    lane: 0.0,
                    meta: NodeMeta::default(),
                },
            );
            for &idx in &by_boundary[&bid] {
                if is_src {
                    raw_edges[idx].0 = gid.clone();
                } else {
                    raw_edges[idx].1 = gid.clone();
                }
            }
            if is_src {
                raw_edges.push((bid.clone(), gid, ot));
            } else {
                raw_edges.push((gid, bid.clone(), ot));
            }
        }
    }

    // Sorted for the same reason `node_ids` is: `raw_edges` was built by
    // walking a `HashMap`/`HashSet`, so its order was otherwise random per
    // process. `adjacency`'s per-node child order below is built straight
    // from this list, and `feedback_arcs`'s DFS visits children in that
    // exact order — on a graph with more than one valid feedback-arc choice
    // (an ambiguous cycle), an unsorted order here meant *which* edge got
    // flagged `loop` (and everything downstream: ranks, ALAP, waypoints)
    // could silently differ between two runs of the identical input.
    raw_edges.sort();
    raw_edges.dedup();

    // ------------------------------------------------------- cycle breaking

    // Sorted, not just collected: `nodes` is a HashMap, whose iteration
    // order is randomised per process — leaving this unsorted meant which
    // node `feedback_arcs` happens to start its DFS from (and therefore
    // which edge of a cycle gets picked as the back edge) could silently
    // differ between two runs of the exact same input. Every other id
    // derivation in this crate is a pure function of meaning specifically
    // to avoid that; this was the one place still leaking HashMap order.
    let mut node_ids: Vec<String> = nodes.keys().cloned().collect();
    node_ids.sort();
    let mut adjacency: HashMap<String, Vec<String>> = HashMap::new();
    for (a, b, _) in &raw_edges {
        adjacency.entry(a.clone()).or_default().push(b.clone());
    }
    // Ranking needs the *whole* merged graph (every object type sharing
    // stations) to be acyclic, so this back-edge set is computed on
    // `adjacency` as built above — every type's edges together. That's
    // correct for ranking, but wrong for "is this a genuine redo loop":
    // two object types can each flow acyclically through their own
    // lifecycle and still form a cycle only once merged (type A goes
    // station1→station2, type B goes station2→station1 through some
    // other shared station — neither individually loops, the cycle is a
    // pure artefact of sharing stations). Marking whichever edge this
    // picks as `kind: Loop` would dash a perfectly ordinary edge with no
    // real redo behind it. `genuine_loop_edges` below is the fix: the
    // *visual*/semantic classification is a separate pass, over each
    // object type's own subgraph in isolation.
    let back_edges = match rank_tiebreak {
        RankTiebreak::Structural => feedback_arcs(&node_ids, &adjacency),
        RankTiebreak::Frequency => {
            // Aggregate frequency across object types onto the plain (from,
            // to) pair the merged graph actually cycles on — a cycle here is
            // never one object type's own doing (see the comment below), so
            // the choice has to be made on the merged edge's total traffic,
            // not any single type's share of it.
            let mut weight: HashMap<(String, String), f64> = HashMap::new();
            for (a, b, ot) in &raw_edges {
                *weight.entry((a.clone(), b.clone())).or_default() +=
                    edge_freq.get(&(a.clone(), b.clone(), ot.clone())).copied().unwrap_or(0.0);
            }
            feedback_arcs_weighted(&node_ids, &adjacency, &weight)
        }
    };

    let mut genuine_loop_edges: HashSet<(String, String, String)> = HashSet::new();
    let mut edges_by_type: HashMap<&str, Vec<(&String, &String)>> = HashMap::new();
    for (a, b, ot) in &raw_edges {
        edges_by_type.entry(ot.as_str()).or_default().push((a, b));
    }
    for (ot, type_edges) in &edges_by_type {
        let mut type_adjacency: HashMap<String, Vec<String>> = HashMap::new();
        let mut type_node_ids: HashSet<String> = HashSet::new();
        for (a, b) in type_edges {
            type_adjacency.entry((*a).clone()).or_default().push((*b).clone());
            type_node_ids.insert((*a).clone());
            type_node_ids.insert((*b).clone());
        }
        let mut type_node_ids: Vec<String> = type_node_ids.into_iter().collect();
        type_node_ids.sort();
        for (from, to) in feedback_arcs(&type_node_ids, &type_adjacency) {
            genuine_loop_edges.insert((from, to, (*ot).to_string()));
        }
    }

    let mut edges: Vec<OutEdge> = Vec::new();
    let mut dag_adjacency: HashMap<String, Vec<String>> = HashMap::new();
    for (a, b, ot) in &raw_edges {
        let (from, to) = (a.clone(), b.clone());
        let is_genuine_loop = genuine_loop_edges.contains(&(from.clone(), to.clone(), ot.clone()));
        // Ranking excludes an edge if *either* pass flagged it: the merged
        // graph's own back-edge set (needed so ranking always has a DAG to
        // work with, whatever cross-type cycles sharing stations creates)
        // or this type's own genuine loop (kept in sync with ranking even
        // on the rare cycle the two greedy DFS passes pick a different
        // edge of the same cycle for — excluding a superset is always
        // safe, it only ever removes an edge ranking shouldn't have
        // trusted anyway).
        let is_back = is_genuine_loop || back_edges.contains(&(from.clone(), to.clone()));
        if !is_back {
            dag_adjacency.entry(from.clone()).or_default().push(to.clone());
        }
        let key = (from.clone(), to.clone(), ot.clone());
        let frequency = edge_freq.get(&key).copied();
        let duration_secs = match (edge_dur_weighted.get(&key), frequency) {
            (Some(w), Some(f)) if f > 0.0 => Some(w / f),
            _ => None,
        };
        let variable = edge_variable.get(&key).copied().unwrap_or(false);
        edges.push(OutEdge {
            id: format!("edge:{ot}:{from}:{to}"),
            source: from,
            target: to,
            object_type: ot.clone(),
            variable,
            frequency,
            duration_secs,
            // `kind` (and therefore whether this draws dashed) reflects
            // only `is_genuine_loop` — this object type's *own* lifecycle
            // really does revisit an earlier point — never the merged
            // graph's back-edge set alone, which can flag a perfectly
            // ordinary edge purely because a *different* object type
            // happens to flow the opposite way through the same shared
            // stations.
            kind: if is_genuine_loop { EdgeKind::Loop } else { EdgeKind::Flow },
            lane_offset: 0,
            waypoints: Vec::new(),
        });
    }

    // ------------------------------------------------------------- ranking

    let mut ranks = rank_longest_path(&node_ids, &dag_adjacency);

    // ALAP (as-late-as-possible) for every "false root" — any node with no
    // *forward* predecessor in `dag_adjacency`, not just true `Source`
    // nodes. A source has no predecessor by construction, so ASAP ranking
    // always puts every one of them at rank 0 — correct in the sense that
    // nothing blocks it, but visually it forces every object type's
    // lifecycle to start in the same row even when one type (a vehicle
    // only booked much later in the process, say) isn't actually needed
    // until far down the diagram. But a source isn't the only way to end up
    // with zero forward predecessors: a gateway whose *only* incoming arc
    // got classified as a `Loop` back edge (its real predecessor is later
    // in the diagram, looping back to it) is invisible to `dag_adjacency`
    // too, and ASAP ranking placed it at rank 0 exactly the same way —
    // visually indistinguishable from a genuine starting point, which is
    // exactly what it isn't. Every node that *does* have a forward
    // predecessor keeps its ASAP rank unchanged — that's what makes
    // top-to-bottom order meaningful; only a node with no upstream
    // constraint at all gets pulled down to sit right before its own first
    // (forward) use.
    let mut has_forward_predecessor: HashSet<&str> = HashSet::new();
    for children in dag_adjacency.values() {
        for c in children {
            has_forward_predecessor.insert(c.as_str());
        }
    }
    for id in &node_ids {
        if has_forward_predecessor.contains(id.as_str()) {
            continue;
        }
        let min_succ = dag_adjacency
            .get(id)
            .and_then(|succs| succs.iter().filter_map(|s| ranks.get(s)).min().copied());
        if let Some(min_succ) = min_succ {
            ranks.insert(id.clone(), (min_succ - 1).max(0));
        }
    }

    // --------------------------------------- dummy chains for long edges
    //
    // Classic Sugiyama technique: an edge spanning more than one rank gets a
    // chain of dummy nodes, one per intermediate rank, spliced into the
    // *ordering* adjacency (never into `dag_adjacency` — ranks are already
    // final). `assign_lanes` then treats a dummy exactly like a real node
    // when computing barycenters and reserving lane space, so a long edge's
    // own path is accounted for and an unrelated real node can no longer
    // land directly on top of it.
    //
    // Every edge gets the same treatment regardless of `kind` — `kind` is
    // now a purely semantic/visual classification (a genuine redo for that
    // object type, see `genuine_loop_edges` above), not a promise about
    // rank direction: an edge ranking excluded only because a *different*
    // object type's cycle needed breaking is still labelled `Flow` (it
    // isn't a redo), but nothing constrained its target to rank above its
    // source, so it can just as easily come out "backward" as a genuine
    // `Loop` edge does. `order_adjacency` entries always walk from the
    // lower rank to the higher one, regardless of which end is
    // `source`/`target`, so a backward-ranked edge's back pointer can
    // never introduce a cycle into it — only `dag_adjacency` (ranking,
    // already final above) cares about an edge's real direction. Dummy ids
    // themselves are still listed `source → target` order (whichever way
    // that runs in rank space), matching what `routeThroughWaypoints` (the
    // view) expects to stitch into one routed line.
    let mut rank_of: HashMap<String, i32> = ranks.clone();
    let mut order_adjacency: HashMap<String, Vec<String>> = HashMap::new();
    let mut edge_waypoint_ids: HashMap<String, Vec<String>> = HashMap::new();
    // Which object type a dummy waypoint "belongs to" — its owning edge's —
    // needed below to recentre the diagram on the spine even through ranks
    // where the spine only has a pass-through waypoint, not a real node.
    let mut waypoint_object_type: HashMap<String, String> = HashMap::new();
    for e in &edges {
        let r_from = *rank_of.get(&e.source).unwrap_or(&0);
        let r_to = *rank_of.get(&e.target).unwrap_or(&0);

        if r_from == r_to {
            continue; // nothing to reserve for a same-rank pair
        }

        let step: i32 = if r_to >= r_from { 1 } else { -1 };
        if (r_to - r_from).abs() == 1 {
            let (lo, hi) = if r_from <= r_to { (&e.source, &e.target) } else { (&e.target, &e.source) };
            order_adjacency.entry(lo.clone()).or_default().push(hi.clone());
            continue;
        }

        let mut wp_ids = Vec::new();
        let mut r = r_from + step;
        while r != r_to {
            let wp_id = format!("__wp:{}:{}", e.id, r);
            rank_of.insert(wp_id.clone(), r);
            waypoint_object_type.insert(wp_id.clone(), e.object_type.clone());
            wp_ids.push(wp_id);
            r += step;
        }

        let mut chain: Vec<String> = Vec::with_capacity(wp_ids.len() + 2);
        chain.push(e.source.clone());
        chain.extend(wp_ids.iter().cloned());
        chain.push(e.target.clone());
        let ordered: Vec<&String> = if r_from <= r_to { chain.iter().collect() } else { chain.iter().rev().collect() };
        for w in ordered.windows(2) {
            order_adjacency.entry(w[0].clone()).or_default().push(w[1].clone());
        }
        edge_waypoint_ids.insert(e.id.clone(), wp_ids);
    }

    // -------------------------------------------------------------- lanes

    let mut lane_of = assign_lanes(&rank_of, &order_adjacency);

    // ---------------------------------------- centre the diagram on the spine
    //
    // `assign_coordinates` seeds every rank from the same left-packed
    // `0..N` sequence before its priority rounds pull nodes toward their
    // neighbours' *exact* positions across ranks — nothing anchors that
    // result to any particular position, so the whole diagram can still
    // drift arbitrarily left. The "spine" (the object type touching the
    // most stations — "most events", the closest proxy this crate can
    // measure without raw event counts) gets shifted to sit at 0 overall;
    // every node in the whole diagram shifts by the exact same single
    // amount (the spine's own mean position, one scalar, not a per-rank
    // value), so every alignment `assign_coordinates` already worked out
    // between adjacent ranks is carried over untouched — shifting each
    // rank by its own *independent* mean (the previous approach) could
    // silently undo exact cross-rank alignment the coordinate pass had
    // just achieved, whenever the spine's own mean position happened to
    // differ, even slightly, from one rank to the next.
    let mut station_count: HashMap<&str, usize> = HashMap::new();
    for n in nodes.values() {
        if let OutNode::Station { object_types, .. } = n {
            for ot in object_types {
                *station_count.entry(ot.as_str()).or_insert(0) += 1;
            }
        }
    }
    let mut counted: Vec<(&str, usize)> = station_count.into_iter().collect();
    counted.sort_by(|a, b| a.0.cmp(b.0));
    let mut spine: Option<&str> = None;
    let mut best = 0usize;
    for (ot, count) in &counted {
        if *count > best {
            best = *count;
            spine = Some(ot);
        }
    }

    if let Some(spine_ot) = spine {
        let belongs_to_spine = |n: &OutNode| -> bool {
            match n {
                OutNode::Station { object_types, .. } => object_types.iter().any(|t| t == spine_ot),
                OutNode::Gateway { object_type, .. }
                | OutNode::Source { object_type, .. }
                | OutNode::Sink { object_type, .. } => object_type == spine_ot,
            }
        };
        let mut sum = 0.0f64;
        let mut count = 0i64;
        for n in nodes.values().filter(|n| belongs_to_spine(n)) {
            sum += *lane_of.get(n.id()).unwrap_or(&0.0);
            count += 1;
        }
        for (wp_id, ot) in &waypoint_object_type {
            if ot == spine_ot {
                sum += *lane_of.get(wp_id).unwrap_or(&0.0);
                count += 1;
            }
        }

        if count > 0 {
            let shift = sum / count as f64;
            lane_of = lane_of.into_iter().map(|(id, l)| (id, l - shift)).collect();
        }
    }

    // ------------------------------------------- concentrate long-edge bends
    //
    // `assign_coordinates` gives each dummy waypoint its own "desired"
    // position independently (the mean of its immediate neighbours), which
    // for a long edge's whole chain converges to a smooth, roughly even
    // gradient spread across every intermediate rank — visually a "curly"
    // multi-segment wobble, confirmed against a live single-object-type
    // diagram (three ranks, two dummy waypoints, lanes drifting
    // -0.50 -> -0.28 -> 0.01 -> 0.36, a distinct bend at *every* rank
    // instead of one). Nothing about that is a bug in the least-squares
    // sense — it genuinely is the smoothest per-rank compromise — but it's
    // the wrong objective for a schematic that wants as *few* bends as
    // possible, not the smallest average one. A real transit map commits a
    // line to running exactly parallel to whichever track it just left,
    // then makes one deliberate diagonal switch right before its next stop,
    // not a continuous drift. Since a dummy waypoint is never shared
    // between edges (`build_metro_map`'s dummy-chain construction gives
    // each edge its own private ids), every interior waypoint of a chain
    // can simply be pinned to its edge's *source* lane and the one closest
    // to the target pinned to the *target* lane, with no risk of that
    // fighting another edge's own preference for the same node — concentrates
    // the whole shift into a single hop near the end, mirroring the view's
    // own `ARRIVAL_LEAD` bias (`route.ts#routeHop`) so both layers agree on
    // where an edge's one bend belongs. `resolve_order_preserving` still
    // settles each touched rank, so this can only move a dummy *within* the
    // order `layers` already fixed — it can shrink a gap to the >=1.0
    // minimum against a genuinely competing neighbour, never invert
    // anything, so it cannot introduce a crossing that wasn't already safe.
    concentrate_dummy_drift(&edges, &edge_waypoint_ids, &rank_of, &mut lane_of);

    // Structural reveal order for the view's complexity slider — Petri-net
    // basis only (the directly-follows basis ranks arcs by `edge_freq`
    // instead). Iterative minimum-degree peel over the undirected graph of
    // every non-boundary node: the innermost core comes out `0`, each
    // successive peeled shell `1, 2, …`, so the slider reveals the process
    // backbone first and optional leaf activities last. Boundaries are left
    // `None` — always shown whenever a neighbour is.
    let reveal_order = match basis {
        Basis::PetriNet => structural_reveal_order(&nodes, &raw_edges),
        Basis::DirectlyFollows => HashMap::new(),
    };

    let mut nodes: Vec<OutNode> = nodes.into_values().collect();
    for n in &mut nodes {
        let id = n.id().to_string();
        let r = *rank_of.get(&id).unwrap_or(&0);
        let l = *lane_of.get(&id).unwrap_or(&0.0);
        n.set_rank_lane(r, l);
        let freq = node_freq.get(&id).copied();
        let reveal = reveal_order.get(&id).copied();
        let meta = n.meta_mut();
        meta.frequency = freq;
        meta.reveal_order = reveal;
    }
    for e in &mut edges {
        if let Some(wp_ids) = edge_waypoint_ids.get(&e.id) {
            e.waypoints = wp_ids
                .iter()
                .map(|id| Waypoint { rank: rank_of[id], lane: *lane_of.get(id).unwrap_or(&0.0) })
                .collect();
        }
    }

    // --------------------------------------------------- global line order

    let mut object_types = object_types_in;
    object_types.sort();
    object_types.dedup();
    let ot_rank: HashMap<&str, i32> =
        object_types.iter().enumerate().map(|(i, ot)| (ot.as_str(), i as i32)).collect();
    for e in &mut edges {
        e.lane_offset = *ot_rank.get(e.object_type.as_str()).unwrap_or(&0);
    }

    nodes.sort_by(|a, b| a.rank().cmp(&b.rank()).then_with(|| a.id().cmp(b.id())));
    edges.sort_by(|a, b| a.id.cmp(&b.id));

    let stats = MetroStats {
        basis,
        stations: nodes.iter().filter(|n| matches!(n, OutNode::Station { .. })).count(),
        arcs: edges.len(),
        object_types: object_types.len(),
    };
    MetroMapPayload { basis, object_types, nodes, edges, stats }
}

/// Iterative minimum-degree peel — see the call site. Returns the peel
/// round (`0` = innermost core) for every non-boundary node id; boundary
/// nodes are omitted (the view always shows them next to a shown neighbour).
fn structural_reveal_order(
    nodes: &HashMap<String, OutNode>,
    raw_edges: &[(String, String, String)],
) -> HashMap<String, i32> {
    let mut degree: HashMap<String, usize> = HashMap::new();
    let mut adj: HashMap<String, HashSet<String>> = HashMap::new();
    let keep = |id: &str| nodes.get(id).map(|n| !n.is_boundary()).unwrap_or(false);
    for (a, b, _) in raw_edges {
        if a == b || !keep(a) || !keep(b) {
            continue;
        }
        if adj.entry(a.clone()).or_default().insert(b.clone()) {
            *degree.entry(a.clone()).or_default() += 1;
            *degree.entry(b.clone()).or_default() += 1;
        }
        adj.entry(b.clone()).or_default().insert(a.clone());
    }
    // Every non-boundary node participates, even one with no kept edge.
    for (id, n) in nodes {
        if !n.is_boundary() {
            degree.entry(id.clone()).or_insert(0);
        }
    }

    // Peel outer shells first (leaves before core), tagging each shell a
    // rising `peel_round`; then invert so the innermost core comes out `0`
    // and the outermost leaves highest — the order the slider reveals in.
    let mut peel_round: HashMap<String, i32> = HashMap::new();
    let mut remaining: HashSet<String> = degree.keys().cloned().collect();
    let mut round = 0i32;
    while !remaining.is_empty() {
        let min_deg = remaining.iter().map(|id| degree[id]).min().unwrap_or(0);
        let mut peel: Vec<String> =
            remaining.iter().filter(|id| degree[*id] == min_deg).cloned().collect();
        peel.sort();
        for id in &peel {
            peel_round.insert(id.clone(), round);
            remaining.remove(id);
            if let Some(neighbours) = adj.get(id) {
                for nb in neighbours {
                    if remaining.contains(nb) {
                        if let Some(d) = degree.get_mut(nb) {
                            *d = d.saturating_sub(1);
                        }
                    }
                }
            }
        }
        round += 1;
    }
    let max_round = round.saturating_sub(1);
    peel_round.into_iter().map(|(id, r)| (id, max_round - r)).collect()
}

// -------------------------------------------------- OC-DFG front-end

/// Builds a metro map from an Object-Centric Directly-Follows Graph instead
/// of a Petri net. No gateway diamonds (an OC-DFG cannot express choice vs.
/// concurrency — branching just reads as a line splitting, but every station
/// and arc carries its observed frequency,
/// so the view's complexity slider can rank arcs by weight (top-N per object
/// type) and optionally print counts.
///
/// `object_types` (when non-empty) restricts discovery to those types; empty
/// means every type in the DFG. Uses `RankTiebreak::Structural` — see
/// `build_metro_map_from_ocdfg_with_rank_tiebreak` for the frequency-aware
/// variant.
pub fn build_metro_map_from_ocdfg(dfg: &OcdfgPayload, object_types: &[String]) -> MetroMapPayload {
    build_metro_map_from_ocdfg_with_rank_tiebreak(dfg, object_types, RankTiebreak::default())
}

/// Same as `build_metro_map_from_ocdfg`, with an explicit choice of
/// `rank_tiebreak` (see `RankTiebreak`) for how a cross-type cycle is broken.
pub fn build_metro_map_from_ocdfg_with_rank_tiebreak(
    dfg: &OcdfgPayload,
    object_types: &[String],
    rank_tiebreak: RankTiebreak,
) -> MetroMapPayload {
    let selected: Option<HashSet<&str>> = if object_types.is_empty() {
        None
    } else {
        Some(object_types.iter().map(|s| s.as_str()).collect())
    };
    let wanted = |ot: &str| selected.as_ref().map(|s| s.contains(ot)).unwrap_or(true);

    let station_id = |activity: &str| format!("station:{activity}");
    let source_id = |ot: &str| format!("source:{ot}");
    let sink_id = |ot: &str| format!("sink:{ot}");

    let mut nodes: HashMap<String, OutNode> = HashMap::new();
    let mut node_freq: HashMap<String, f64> = HashMap::new();
    let mut edge_freq: HashMap<(String, String, String), f64> = HashMap::new();
    let mut edge_dur_weighted: HashMap<(String, String, String), f64> = HashMap::new();
    let mut raw_edges: Vec<(String, String, String)> = Vec::new();
    let mut station_types: HashMap<String, HashSet<String>> = HashMap::new();
    let mut kept_types: HashSet<String> = HashSet::new();

    for n in &dfg.nodes {
        if !wanted(&n.object_type) {
            continue;
        }
        kept_types.insert(n.object_type.clone());
        station_types.entry(n.activity.clone()).or_default().insert(n.object_type.clone());
        *node_freq.entry(station_id(&n.activity)).or_default() += n.count;

        if n.starts > 0.0 {
            let (s, a) = (source_id(&n.object_type), station_id(&n.activity));
            nodes.entry(s.clone()).or_insert_with(|| OutNode::Source {
                id: s.clone(),
                object_type: n.object_type.clone(),
                rank: 0,
                lane: 0.0,
                meta: NodeMeta::default(),
            });
            raw_edges.push((s.clone(), a.clone(), n.object_type.clone()));
            *edge_freq.entry((s, a, n.object_type.clone())).or_default() += n.starts;
        }
        if n.ends > 0.0 {
            let (a, k) = (station_id(&n.activity), sink_id(&n.object_type));
            nodes.entry(k.clone()).or_insert_with(|| OutNode::Sink {
                id: k.clone(),
                object_type: n.object_type.clone(),
                rank: 0,
                lane: 0.0,
                meta: NodeMeta::default(),
            });
            raw_edges.push((a.clone(), k.clone(), n.object_type.clone()));
            *edge_freq.entry((a, k, n.object_type.clone())).or_default() += n.ends;
        }
    }

    for (activity, types) in &station_types {
        let id = station_id(activity);
        let mut ots: Vec<String> = types.iter().cloned().collect();
        ots.sort();
        nodes.insert(
            id.clone(),
            OutNode::Station {
                id,
                activity: activity.clone(),
                object_types: ots,
                rank: 0,
                lane: 0.0,
                meta: NodeMeta::default(),
            },
        );
    }

    for e in &dfg.edges {
        if !wanted(&e.object_type) {
            continue;
        }
        // Only draw an arc between activities that actually became stations.
        if !station_types.contains_key(&e.src) || !station_types.contains_key(&e.dst) {
            continue;
        }
        let key = (station_id(&e.src), station_id(&e.dst), e.object_type.clone());
        raw_edges.push(key.clone());
        *edge_freq.entry(key.clone()).or_default() += e.freq;
        // Weighted by frequency so that collapsing several upstream arcs
        // into one drawn edge still yields the correct mean wait.
        if let Some(secs) = e.avg_secs {
            *edge_dur_weighted.entry(key).or_default() += secs * e.freq;
        }
    }

    let mut ots: Vec<String> = if object_types.is_empty() {
        kept_types.into_iter().collect()
    } else {
        object_types.iter().filter(|t| kept_types.contains(*t)).cloned().collect()
    };
    ots.sort();

    // An OC-DFG has no arcs and no tokens, so there is nothing here that
    // could correspond to a variable arc — every edge on this basis reports
    // `variable: false`, honestly, rather than guessing from frequency.
    assemble_metro_map(
        nodes,
        raw_edges,
        ots,
        Basis::DirectlyFollows,
        node_freq,
        edge_freq,
        edge_dur_weighted,
        HashMap::new(),
        rank_tiebreak,
    )
}

/// Returns, for every meaningful node reachable from `start` through pure
/// pass-through wires, `(reached, variable)` — `variable` is whether *any*
/// arc on the walked path from `start` to `reached` (not including whatever
/// hop led into `start` itself; the caller accounts for that one) was a
/// variable arc. `variable_of` is `None` for the OC-DFG front-end's call
/// shape, but that front-end never calls this function; it is always
/// `Some` in practice for the Petri-net front-end, which is the only caller.
fn walk_to_meaningful(
    start: &SubNode,
    next: &HashMap<SubNode, Vec<SubNode>>,
    meaningful: &HashSet<SubNode>,
    visited: &mut HashSet<SubNode>,
    variable_of: Option<&HashMap<(SubNode, SubNode), bool>>,
) -> Vec<(SubNode, bool)> {
    if meaningful.contains(start) {
        return vec![(start.clone(), false)];
    }
    if !visited.insert(start.clone()) {
        return Vec::new(); // pass-through cycle guard
    }
    let mut out = Vec::new();
    if let Some(children) = next.get(start) {
        for c in children {
            let hop_variable = variable_of
                .and_then(|m| m.get(&(start.clone(), c.clone())))
                .copied()
                .unwrap_or(false);
            for (reached, chain_variable) in walk_to_meaningful(c, next, meaningful, visited, variable_of) {
                out.push((reached, hop_variable || chain_variable));
            }
        }
    }
    out
}

/// Greedy DFS-based feedback arc set (the same idea ELK's own
/// `cycleBreaking.strategy: GREEDY` applies elsewhere in this repo): a
/// depth-first walk from every unvisited node, classifying an edge to a node
/// still on the current recursion stack as a back edge. Removing exactly
/// those edges leaves a DAG.
fn feedback_arcs(node_ids: &[String], adjacency: &HashMap<String, Vec<String>>) -> HashSet<(String, String)> {
    #[derive(PartialEq, Eq, Clone, Copy)]
    enum Color {
        White,
        Gray,
        Black,
    }
    let mut color: HashMap<String, Color> = node_ids.iter().map(|n| (n.clone(), Color::White)).collect();
    let mut back = HashSet::new();

    // Explicit stack to avoid recursion depth issues on large real graphs.
    for start in node_ids {
        if color.get(start).copied().unwrap_or(Color::White) != Color::White {
            continue;
        }
        let mut stack: Vec<(String, usize)> = vec![(start.clone(), 0)];
        color.insert(start.clone(), Color::Gray);
        while let Some((node, idx)) = stack.pop() {
            let children = adjacency.get(&node).cloned().unwrap_or_default();
            if idx < children.len() {
                stack.push((node.clone(), idx + 1));
                let child = &children[idx];
                match color.get(child).copied().unwrap_or(Color::White) {
                    Color::White => {
                        color.insert(child.clone(), Color::Gray);
                        stack.push((child.clone(), 0));
                    }
                    Color::Gray => {
                        back.insert((node.clone(), child.clone()));
                    }
                    Color::Black => {}
                }
            } else {
                color.insert(node.clone(), Color::Black);
            }
        }
    }
    back
}

/// Finds one directed cycle, returned as the sequence of nodes along it
/// (`[n0, n1, ..., nk]`, meaning `n0 -> n1 -> ... -> nk -> n0` closes it), or
/// `None` if the graph is already acyclic. Same DFS shape as `feedback_arcs`
/// (colours, explicit stack), but also tracks the current recursion path so
/// that hitting a Gray node lets it slice out exactly the cycle just closed.
fn find_one_cycle(node_ids: &[String], adjacency: &HashMap<String, Vec<String>>) -> Option<Vec<String>> {
    #[derive(PartialEq, Eq, Clone, Copy)]
    enum Color {
        White,
        Gray,
        Black,
    }
    let mut color: HashMap<String, Color> = node_ids.iter().map(|n| (n.clone(), Color::White)).collect();

    for start in node_ids {
        if color.get(start).copied().unwrap_or(Color::White) != Color::White {
            continue;
        }
        let mut path: Vec<String> = vec![start.clone()];
        let mut stack: Vec<(String, usize)> = vec![(start.clone(), 0)];
        color.insert(start.clone(), Color::Gray);
        while let Some((node, idx)) = stack.pop() {
            let children = adjacency.get(&node).cloned().unwrap_or_default();
            if idx < children.len() {
                stack.push((node.clone(), idx + 1));
                let child = children[idx].clone();
                match color.get(&child).copied().unwrap_or(Color::White) {
                    Color::White => {
                        color.insert(child.clone(), Color::Gray);
                        path.push(child.clone());
                        stack.push((child, 0));
                    }
                    Color::Gray => {
                        let start_idx = path.iter().position(|n| n == &child).expect("gray node must be on path");
                        return Some(path[start_idx..].to_vec());
                    }
                    Color::Black => {}
                }
            } else {
                color.insert(node.clone(), Color::Black);
                path.pop();
            }
        }
    }
    None
}

/// Weighted feedback arc set: like `feedback_arcs`, but when a cycle offers a
/// choice of which edge to drop, always drops the lightest one by `weight`
/// (ties broken by the `(from, to)` pair, so the result stays deterministic)
/// rather than whichever the DFS traversal order happens to close on. Finds
/// and removes one cycle's lightest edge at a time until none remain —
/// asymptotically worse than `feedback_arcs`'s single pass (one DFS per
/// cycle instead of one overall), but these are small real-world graphs and
/// this is the only way to make the *choice* weight-aware instead of an
/// accident of node-id order.
fn feedback_arcs_weighted(
    node_ids: &[String],
    adjacency: &HashMap<String, Vec<String>>,
    weight: &HashMap<(String, String), f64>,
) -> HashSet<(String, String)> {
    let mut working: HashMap<String, Vec<String>> = adjacency.clone();
    let mut back = HashSet::new();
    while let Some(cycle) = find_one_cycle(node_ids, &working) {
        let n = cycle.len();
        let mut best: Option<(f64, String, String)> = None;
        for i in 0..n {
            let u = cycle[i].clone();
            let v = cycle[(i + 1) % n].clone();
            let w = weight.get(&(u.clone(), v.clone())).copied().unwrap_or(0.0);
            let candidate = (w, u, v);
            if best.as_ref().map(|b| candidate < *b).unwrap_or(true) {
                best = Some(candidate);
            }
        }
        let (_, u, v) = best.expect("a cycle always has at least one edge");
        back.insert((u.clone(), v.clone()));
        if let Some(children) = working.get_mut(&u) {
            children.retain(|c| c != &v);
        }
    }
    back
}

/// `rank(n) = max(rank(pred) + 1)` over a DAG's own topological order
/// (Kahn's algorithm), nodes with no predecessor at rank 0.
fn rank_longest_path(node_ids: &[String], adjacency: &HashMap<String, Vec<String>>) -> HashMap<String, i32> {
    let mut indeg: HashMap<String, i32> = node_ids.iter().map(|n| (n.clone(), 0)).collect();
    for children in adjacency.values() {
        for c in children {
            *indeg.entry(c.clone()).or_insert(0) += 1;
        }
    }
    let mut remaining = indeg.clone();
    let mut queue: VecDeque<String> =
        node_ids.iter().filter(|n| indeg.get(n.as_str()).copied().unwrap_or(0) == 0).cloned().collect();
    let mut rank: HashMap<String, i32> = queue.iter().map(|n| (n.clone(), 0)).collect();

    while let Some(node) = queue.pop_front() {
        let r = rank.get(&node).copied().unwrap_or(0);
        for child in adjacency.get(&node).cloned().unwrap_or_default() {
            let candidate = r + 1;
            let entry = rank.entry(child.clone()).or_insert(0);
            if candidate > *entry {
                *entry = candidate;
            }
            if let Some(left) = remaining.get_mut(&child) {
                *left -= 1;
                if *left == 0 {
                    queue.push_back(child);
                }
            }
        }
    }
    for n in node_ids {
        rank.entry(n.clone()).or_insert(0);
    }
    rank
}

/// Two stages. First, a classic Sugiyama *ordering* stage — the
/// crossing-minimised left-to-right sequence within each rank, still a
/// dense `0..N` integer per rank at this point: an iterative barycenter
/// sweep (alternately order each rank by the mean lane of its
/// already-placed neighbours in the rank above, then below, a few times),
/// then `transpose_pass`, which swaps adjacent nodes whenever doing so
/// strictly reduces the actual edge-crossing count against both
/// neighbouring ranks — barycenter compares *mean* neighbour position, not
/// a real crossing count, and can settle for an order a direct count would
/// still improve ("switching the order of outgoing edges would remove edge
/// crossings").
///
/// Second, a *coordinate assignment* stage (`assign_coordinates`) that
/// turns that order into real-valued positions, not another dense
/// per-rank integer sequence. This distinction matters: two different
/// ranks generally have different node counts, so a source in a
/// two-node rank can never reach lane index 4 to sit exactly above its
/// successor in a six-node rank — no reordering fixes that, the *unit
/// itself* is the problem. Real coordinates remove that ceiling, letting a
/// degree-1 node (most commonly a dummy waypoint, which always has exactly
/// one neighbour per direction by construction, but also a real node like
/// a source with a single successor) land in *exactly* its only
/// neighbour's position rather than merely close to it — this is what a
/// visible "microbend" actually was: a crossing count can't tell "exactly
/// underneath" from "one lane off", so nothing about minimising crossings
/// would ever have moved it into alignment.
///
/// Operates over plain ids so dummy waypoint nodes (see `build_metro_map`'s
/// dummy-chain construction) compete for lane space exactly like real
/// ones, without `OutNode` needing to model them at all.
fn assign_lanes(rank_of: &HashMap<String, i32>, adjacency: &HashMap<String, Vec<String>>) -> HashMap<String, f64> {
    let max_rank = rank_of.values().copied().max().unwrap_or(0);
    let mut layers: Vec<Vec<String>> = vec![Vec::new(); (max_rank + 1) as usize];
    for (id, &r) in rank_of {
        layers[r as usize].push(id.clone());
    }
    for layer in &mut layers {
        layer.sort();
    }

    let mut predecessors: HashMap<String, Vec<String>> = HashMap::new();
    for (from, children) in adjacency {
        for to in children {
            predecessors.entry(to.clone()).or_default().push(from.clone());
        }
    }

    let mut lane_of: HashMap<String, f64> = HashMap::new();
    for layer in &layers {
        for (i, n) in layer.iter().enumerate() {
            lane_of.insert(n.clone(), i as f64);
        }
    }

    const SWEEPS: usize = 4;
    for sweep in 0..SWEEPS {
        let downward = sweep % 2 == 0;
        let indices: Vec<usize> = if downward { (1..layers.len()).collect() } else { (0..layers.len().saturating_sub(1)).rev().collect() };
        for r in indices {
            let neighbours_of = |id: &str| -> Vec<String> {
                if downward {
                    predecessors.get(id).cloned().unwrap_or_default()
                } else {
                    adjacency.get(id).cloned().unwrap_or_default()
                }
            };
            let mut order = layers[r].clone();
            order.sort_by(|a, b| {
                let ba = barycenter(a, &neighbours_of(a), &lane_of);
                let bb = barycenter(b, &neighbours_of(b), &lane_of);
                ba.partial_cmp(&bb).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.cmp(b))
            });
            for (i, id) in order.iter().enumerate() {
                lane_of.insert(id.clone(), i as f64);
            }
            layers[r] = order;
        }
    }

    transpose_pass(&mut layers, &predecessors, adjacency, &mut lane_of);

    assign_coordinates(&mut layers, &predecessors, adjacency)
}

fn barycenter(id: &str, neighbours: &[String], lane_of: &HashMap<String, f64>) -> f64 {
    if neighbours.is_empty() {
        return lane_of.get(id).copied().unwrap_or(0.0);
    }
    let sum: f64 = neighbours.iter().map(|n| lane_of.get(n).copied().unwrap_or(0.0)).sum();
    sum / neighbours.len() as f64
}

/// Crossings a pair of same-rank nodes contributes against one neighbouring
/// rank, for a specific left/right order: the count of (left's neighbour,
/// right's neighbour) lane pairs that are inverted relative to that order —
/// the standard pairwise crossing count the classic Sugiyama "transpose"
/// heuristic is built on.
fn crossing_count(left_lanes: &[f64], right_lanes: &[f64]) -> i64 {
    let mut count = 0i64;
    for &x in left_lanes {
        for &y in right_lanes {
            if x > y {
                count += 1;
            }
        }
    }
    count
}

/// Net change in total crossings, against both neighbouring ranks combined,
/// from swapping two same-rank nodes that currently sit with `left` to the
/// left of `right`. Negative means the swap helps, zero means neutral (no
/// edge of either node disagrees either way), positive means it would
/// introduce a new crossing.
fn swap_delta(
    left: &str,
    right: &str,
    predecessors: &HashMap<String, Vec<String>>,
    adjacency: &HashMap<String, Vec<String>>,
    lane_of: &HashMap<String, f64>,
) -> i64 {
    let empty: Vec<String> = Vec::new();
    let lanes_of = |ids: &[String]| -> Vec<f64> { ids.iter().map(|n| lane_of.get(n).copied().unwrap_or(0.0)).collect() };
    let left_up = lanes_of(predecessors.get(left).unwrap_or(&empty));
    let right_up = lanes_of(predecessors.get(right).unwrap_or(&empty));
    let left_down = lanes_of(adjacency.get(left).unwrap_or(&empty));
    let right_down = lanes_of(adjacency.get(right).unwrap_or(&empty));

    let before = crossing_count(&left_up, &right_up) + crossing_count(&left_down, &right_down);
    let after = crossing_count(&right_up, &left_up) + crossing_count(&right_down, &left_down);
    after - before
}

/// Repeatedly swaps adjacent same-rank nodes whenever doing so strictly
/// reduces crossings against both neighbouring ranks, until a full pass
/// makes no more improving swaps.
fn transpose_pass(
    layers: &mut [Vec<String>],
    predecessors: &HashMap<String, Vec<String>>,
    adjacency: &HashMap<String, Vec<String>>,
    lane_of: &mut HashMap<String, f64>,
) {
    const MAX_ROUNDS: usize = 6;
    for _ in 0..MAX_ROUNDS {
        let mut improved = false;
        for layer in layers.iter_mut() {
            for i in 0..layer.len().saturating_sub(1) {
                let delta = swap_delta(&layer[i], &layer[i + 1], predecessors, adjacency, lane_of);
                if delta < 0 {
                    layer.swap(i, i + 1);
                    lane_of.insert(layer[i].clone(), i as f64);
                    lane_of.insert(layer[i + 1].clone(), (i + 1) as f64);
                    improved = true;
                }
            }
        }
        if !improved {
            break;
        }
    }
}

/// Coordinate-assignment stage: turns the crossing-minimised order from
/// `layers` into real-valued positions. Each node's "desired" position is
/// the mean of *both* its predecessors' and its successors' current
/// positions when it has both, not just whichever direction some current
/// sweep happens to face — a station with, say, a single predecessor above
/// and a long branching chain below (both real, both pulling) needs one
/// stable compromise, not two different targets it keeps re-snapping
/// between every other round (an earlier version of this alternated by
/// sweep direction; that's exactly why a source and its sole successor
/// could still land a lane apart even after many rounds — the *last*
/// sweep's direction was deciding the answer, not genuine convergence).
///
/// Turning each rank's desired positions into a real assignment still has
/// to preserve the order `layers` already settled on (no rank's relative
/// left-to-right sequence may invert — that would undo the crossing
/// reduction `transpose_pass` already did) while keeping every node at
/// least 1.0 apart from its neighbours. That's a constrained least-squares
/// problem with a well-known exact solution: weighted isotonic regression,
/// solved with the standard pool-adjacent-violators algorithm (PAVA) — see
/// `isotonic_nondecreasing`. It has no directional bias, unlike a
/// first-come-first-served greedy resolution (an earlier version of this
/// processed nodes by priority and pushed lower-priority ones out of the
/// way one at a time): that greedy scheme could only ever push in the
/// direction its own processing order happened to go, which very visibly
/// compounded into a steady diagonal drift across dozens of ranks in a
/// real diagram — nothing pulled the other way to cancel it back out. PAVA
/// finds the genuinely closest valid arrangement instead, with no such
/// accumulating bias. A dummy waypoint id (`"__wp:…"`, see
/// `build_metro_map`'s dummy-chain construction) gets a much larger weight
/// than any real node's — it always has exactly one neighbour per
/// direction by construction, and keeping a long edge's own path straight
/// through it matters most visually — a real node's weight is its total
/// neighbour count.
fn assign_coordinates(
    layers: &mut [Vec<String>],
    predecessors: &HashMap<String, Vec<String>>,
    adjacency: &HashMap<String, Vec<String>>,
) -> HashMap<String, f64> {
    let mut pos: HashMap<String, f64> = HashMap::new();
    for layer in layers.iter() {
        for (i, id) in layer.iter().enumerate() {
            pos.insert(id.clone(), i as f64);
        }
    }

    // Alternates two passes until neither has anything left to do.
    // `relax_coordinates` finds the best *positions* for the current
    // order; `straighten_by_reordering` then checks whether the order
    // itself — fixed since `transpose_pass`, which only ever takes a swap
    // that strictly reduces crossings — was actually optimal for
    // straightness too. It usually wasn't: a swap that's crossing-*neutral*
    // (transpose_pass has no reason to take it) can still turn several
    // parallel lines detouring left-then-right in lockstep through a few
    // ranks into straight ones, since crossing count has no way to see
    // that. Re-relaxing after any reordering is what lets that
    // straightening then propagate to neighbouring ranks, which can in
    // turn unlock further reordering — hence the outer loop, capped only
    // as a safety net against a pathological input that never settles.
    const MAX_OUTER_ROUNDS: usize = 20;
    for _ in 0..MAX_OUTER_ROUNDS {
        relax_coordinates(layers, predecessors, adjacency, &mut pos);
        if !straighten_by_reordering(layers, predecessors, adjacency, &mut pos) {
            break;
        }
    }

    pos
}

fn desired_position(
    id: &str,
    predecessors: &HashMap<String, Vec<String>>,
    adjacency: &HashMap<String, Vec<String>>,
    pos: &HashMap<String, f64>,
) -> f64 {
    let mean_of = |ids: &[String]| -> f64 { ids.iter().map(|n| pos[n]).sum::<f64>() / ids.len() as f64 };
    let up = predecessors.get(id).filter(|v| !v.is_empty()).map(|v| mean_of(v));
    let down = adjacency.get(id).filter(|v| !v.is_empty()).map(|v| mean_of(v));
    match (up, down) {
        (Some(u), Some(d)) => (u + d) / 2.0,
        (Some(u), None) => u,
        (None, Some(d)) => d,
        (None, None) => pos[id],
    }
}

/// A dummy waypoint id (`"__wp:…"`, see `build_metro_map`'s dummy-chain
/// construction) gets a much larger weight than any real node's — it
/// always has exactly one neighbour per direction by construction, and
/// keeping a long edge's own path straight through it matters most
/// visually — a real node's weight is its total neighbour count.
fn weight_of(id: &str, predecessors: &HashMap<String, Vec<String>>, adjacency: &HashMap<String, Vec<String>>) -> f64 {
    if id.starts_with("__wp:") {
        return 1e6;
    }
    (predecessors.get(id).map(|v| v.len()).unwrap_or(0) + adjacency.get(id).map(|v| v.len()).unwrap_or(0)) as f64 + 1.0
}

/// Runs until positions stop moving, not a fixed round count: each round
/// only advances settled information by the ranks it sweeps across before
/// reversing direction, so a real diagram's full depth (dozens of ranks)
/// can need far more rounds than a small graph does for an alignment pull
/// starting at one end to finish propagating to the other. A fixed count
/// picked against small test fixtures (40) looked converged on every
/// synthetic case and still left a real ~20-rank diagram's positions
/// visibly still in motion — not a conflict, just not yet caught up —
/// which surfaced as the whole diagram drifting into a steady diagonal
/// live: the "spine" line's own per-rank position was still sliding by
/// whole lanes a round at a time, 40 rounds in. `MAX_ROUNDS` is only a
/// safety cap against a pathological input that never quite settles (this
/// scheme has no reason to oscillate — PAVA is deterministic and monotone
/// per rank — but a cap costs nothing and bounds worst-case work).
fn relax_coordinates(
    layers: &[Vec<String>],
    predecessors: &HashMap<String, Vec<String>>,
    adjacency: &HashMap<String, Vec<String>>,
    pos: &mut HashMap<String, f64>,
) {
    const MAX_ROUNDS: usize = 2000;
    const CONVERGED_BELOW: f64 = 1e-6;
    for sweep in 0..MAX_ROUNDS {
        let indices: Vec<usize> = if sweep % 2 == 0 { (0..layers.len()).collect() } else { (0..layers.len()).rev().collect() };
        let mut max_move: f64 = 0.0;
        for r in indices {
            let order = &layers[r];
            if order.is_empty() {
                continue;
            }
            let desired: Vec<f64> = order.iter().map(|id| desired_position(id, predecessors, adjacency, pos)).collect();
            let weights: Vec<f64> = order.iter().map(|id| weight_of(id, predecessors, adjacency)).collect();

            let resolved = resolve_order_preserving(&desired, &weights);
            for (id, v) in order.iter().zip(resolved.iter()) {
                let prev = pos.insert(id.clone(), *v).unwrap_or(*v);
                max_move = max_move.max((*v - prev).abs());
            }
        }
        if max_move < CONVERGED_BELOW {
            break;
        }
    }
}

/// Checks every adjacent same-rank pair for a beneficial swap — one that
/// doesn't cost a crossing (gated by the same `swap_delta` as
/// `transpose_pass`) and *does* strictly reduce the rank's total weighted
/// squared deviation from each node's own desired position. Repeats per
/// rank until no more improving swaps are left there, then moves on.
/// Returns whether anything changed, so the caller knows whether another
/// round of `relax_coordinates` is worth running.
fn straighten_by_reordering(
    layers: &mut [Vec<String>],
    predecessors: &HashMap<String, Vec<String>>,
    adjacency: &HashMap<String, Vec<String>>,
    pos: &mut HashMap<String, f64>,
) -> bool {
    let cost_of = |order: &[String], desired: &[f64], weights: &[f64], resolved: &[f64]| -> f64 {
        (0..order.len()).map(|i| weights[i] * (resolved[i] - desired[i]).powi(2)).sum()
    };

    let mut changed_any = false;
    for r in 0..layers.len() {
        loop {
            let order = layers[r].clone();
            if order.len() < 2 {
                break;
            }
            let desired: Vec<f64> = order.iter().map(|id| desired_position(id, predecessors, adjacency, pos)).collect();
            let weights: Vec<f64> = order.iter().map(|id| weight_of(id, predecessors, adjacency)).collect();
            let current_resolved = resolve_order_preserving(&desired, &weights);
            let current_cost = cost_of(&order, &desired, &weights, &current_resolved);

            let mut best: Option<(usize, Vec<f64>, f64)> = None;
            for i in 0..order.len() - 1 {
                if swap_delta(&order[i], &order[i + 1], predecessors, adjacency, pos) > 0 {
                    continue; // would cost a real crossing — never worth it
                }
                let mut swapped_order = order.clone();
                swapped_order.swap(i, i + 1);
                let swapped_desired: Vec<f64> = swapped_order.iter().map(|id| desired_position(id, predecessors, adjacency, pos)).collect();
                let swapped_weights: Vec<f64> = swapped_order.iter().map(|id| weight_of(id, predecessors, adjacency)).collect();
                let swapped_resolved = resolve_order_preserving(&swapped_desired, &swapped_weights);
                let swapped_cost = cost_of(&swapped_order, &swapped_desired, &swapped_weights, &swapped_resolved);
                if swapped_cost + 1e-9 < current_cost && best.as_ref().is_none_or(|(_, _, c)| swapped_cost < *c) {
                    best = Some((i, swapped_resolved, swapped_cost));
                }
            }

            let Some((i, resolved, _)) = best else { break };
            layers[r].swap(i, i + 1);
            for (id, v) in layers[r].iter().zip(resolved.iter()) {
                pos.insert(id.clone(), *v);
            }
            changed_any = true;
        }
    }
    changed_any
}

/// Post-processes every long edge's dummy chain to bend once, not
/// gradually — see the call site's comment in `build_metro_map` for why.
/// Every interior waypoint (all but the one nearest the target) is pinned
/// to the edge's own source lane; the final waypoint is pinned to the
/// target lane. Each touched rank is then re-settled with
/// `resolve_order_preserving`, `desired` set to the pin for a pinned
/// waypoint and to that node's own *already-settled* lane for everything
/// else in the rank (real node or an unrelated edge's own dummy) — so nothing
/// outside the pinned set moves unless the pin's much larger weight
/// (matching a dummy's usual weight elsewhere in this module) genuinely
/// forces a shared minimum gap open, and `layers`' order — implicit here in
/// each rank's current lane order, unchanged since `assign_coordinates`
/// converged — can only ever be preserved, never inverted.
fn concentrate_dummy_drift(
    edges: &[OutEdge],
    edge_waypoint_ids: &HashMap<String, Vec<String>>,
    rank_of: &HashMap<String, i32>,
    lane_of: &mut HashMap<String, f64>,
) {
    let mut pinned: HashMap<String, f64> = HashMap::new();
    for e in edges {
        let Some(wp_ids) = edge_waypoint_ids.get(&e.id) else { continue };
        let Some((last, interior)) = wp_ids.split_last() else { continue };
        let source_lane = *lane_of.get(&e.source).unwrap_or(&0.0);
        let target_lane = *lane_of.get(&e.target).unwrap_or(&0.0);
        for id in interior {
            pinned.insert(id.clone(), source_lane);
        }
        pinned.insert(last.clone(), target_lane);
    }
    if pinned.is_empty() {
        return;
    }

    let mut touched_ranks: HashSet<i32> = HashSet::new();
    for id in pinned.keys() {
        touched_ranks.insert(rank_of[id]);
    }

    for r in touched_ranks {
        let mut order: Vec<String> = rank_of.iter().filter(|(_, &rr)| rr == r).map(|(id, _)| id.clone()).collect();
        order.sort_by(|a, b| lane_of[a].partial_cmp(&lane_of[b]).unwrap_or(std::cmp::Ordering::Equal));
        if order.len() < 2 {
            if let (Some(id), Some(&v)) = (order.first(), order.first().and_then(|id| pinned.get(id))) {
                lane_of.insert(id.clone(), v);
            }
            continue;
        }
        let desired: Vec<f64> = order.iter().map(|id| pinned.get(id).copied().unwrap_or(lane_of[id])).collect();
        let weights: Vec<f64> = order.iter().map(|id| if pinned.contains_key(id) { 1e6 } else { 1.0 }).collect();
        let resolved = resolve_order_preserving(&desired, &weights);
        for (id, v) in order.iter().zip(resolved.iter()) {
            lane_of.insert(id.clone(), *v);
        }
    }
}

/// The exact (weighted least-squares) closest arrangement of `desired`
/// values that stays in the same order with at least 1.0 between
/// consecutive entries — substituting `desired[i] - i` and solving the
/// plain (gap-free) isotonic regression on that shifted sequence is a
/// standard reduction (adding `i` back afterwards restores the minimum
/// gaps exactly, since a non-decreasing solution there is precisely a
/// >=1.0-separated one here).
fn resolve_order_preserving(desired: &[f64], weight: &[f64]) -> Vec<f64> {
    let shifted: Vec<f64> = desired.iter().enumerate().map(|(i, d)| d - i as f64).collect();
    isotonic_nondecreasing(&shifted, weight).into_iter().enumerate().map(|(i, v)| v + i as f64).collect()
}

/// Pool-adjacent-violators algorithm: the unique non-decreasing sequence
/// minimising the weighted sum of squared deviations from `y`. Standard
/// technique, no directional bias — merging two blocks whenever they're
/// out of order and re-averaging is order-of-processing-independent by
/// construction, unlike a greedy left-to-right or priority-first pass.
fn isotonic_nondecreasing(y: &[f64], weight: &[f64]) -> Vec<f64> {
    struct Block {
        sum: f64,
        weight: f64,
        len: usize,
    }
    let mut blocks: Vec<Block> = Vec::new();
    for (&yi, &wi) in y.iter().zip(weight.iter()) {
        let mut b = Block { sum: yi * wi, weight: wi, len: 1 };
        while let Some(last) = blocks.last() {
            if last.sum / last.weight > b.sum / b.weight {
                let prev = blocks.pop().unwrap();
                b.sum += prev.sum;
                b.weight += prev.weight;
                b.len += prev.len;
            } else {
                break;
            }
        }
        blocks.push(b);
    }
    let mut result = Vec::with_capacity(y.len());
    for b in &blocks {
        let value = b.sum / b.weight;
        for _ in 0..b.len {
            result.push(value);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn place(id: &str, ot: &str, kind: InPlaceKind) -> InPlace {
        InPlace { id: id.into(), object_type: ot.into(), kind }
    }
    fn station(id: &str, activity: &str, ots: &[&str]) -> InTransition {
        InTransition { id: id.into(), activity: Some(activity.into()), object_types: ots.iter().map(|s| s.to_string()).collect() }
    }
    fn silent(id: &str, ot: &str) -> InTransition {
        InTransition { id: id.into(), activity: None, object_types: vec![ot.into()] }
    }
    fn arc(source: InNodeRef, target: InNodeRef, ot: &str) -> InArc {
        InArc { source, target, object_type: ot.into(), variable: false }
    }
    fn variable_arc(source: InNodeRef, target: InNodeRef, ot: &str) -> InArc {
        InArc { source, target, object_type: ot.into(), variable: true }
    }
    fn p(id: &str) -> InNodeRef {
        InNodeRef::Place { id: id.into() }
    }
    fn t(id: &str) -> InNodeRef {
        InNodeRef::Transition { id: id.into() }
    }

    fn station_of<'a>(map: &'a MetroMapPayload, activity: &str) -> &'a OutNode {
        map.nodes
            .iter()
            .find(|n| matches!(n, OutNode::Station { activity: a, .. } if a == activity))
            .unwrap_or_else(|| panic!("no station for {activity}"))
    }

    /// (a) One object type, a linear three-activity chain: src -> A -> B -> C -> sink.
    #[test]
    fn linear_chain_single_object_type() {
        let net = OcpnPayload {
            object_types: vec!["Order".into()],
            places: vec![
                place("src", "Order", InPlaceKind::Source),
                place("p1", "Order", InPlaceKind::Normal),
                place("p2", "Order", InPlaceKind::Normal),
                place("sink", "Order", InPlaceKind::Sink),
            ],
            transitions: vec![station("A", "A", &["Order"]), station("B", "B", &["Order"]), station("C", "C", &["Order"])],
            arcs: vec![
                arc(p("src"), t("A"), "Order"),
                arc(t("A"), p("p1"), "Order"),
                arc(p("p1"), t("B"), "Order"),
                arc(t("B"), p("p2"), "Order"),
                arc(p("p2"), t("C"), "Order"),
                arc(t("C"), p("sink"), "Order"),
            ],
        };
        let map = build_metro_map(&net);

        // Only meaningful nodes survive: source, A, B, C, sink. p1/p2 (pure
        // wires, indeg=outdeg=1) are collapsed.
        assert_eq!(map.nodes.len(), 5, "{:#?}", map.nodes);
        assert_eq!(map.edges.len(), 4);

        let rank_of = |activity: &str| station_of(&map, activity).rank();
        assert_eq!(rank_of("A"), 1);
        assert_eq!(rank_of("B"), 2);
        assert_eq!(rank_of("C"), 3);
        assert!(map.edges.iter().all(|e| e.kind == EdgeKind::Flow));
        assert!(map.edges.iter().all(|e| !e.variable), "no arc in this net is variable: {:#?}", map.edges);
    }

    /// A variable arc survives wire collapse: the A→p1→B wire has its
    /// variable arc on the A→p1 hop, and the collapsed A→B edge must still
    /// report `variable: true` — the flag is a fact about the relation the
    /// whole chain represents, not about which single arc happened to carry
    /// it. The unrelated src→A edge, with no variable arc anywhere on its
    /// own path, must stay `false`.
    #[test]
    fn variable_arc_survives_wire_collapse() {
        let net = OcpnPayload {
            object_types: vec!["Order".into()],
            places: vec![
                place("src", "Order", InPlaceKind::Source),
                place("p1", "Order", InPlaceKind::Normal),
                place("sink", "Order", InPlaceKind::Sink),
            ],
            transitions: vec![station("A", "A", &["Order"]), station("B", "B", &["Order"])],
            arcs: vec![
                arc(p("src"), t("A"), "Order"),
                variable_arc(t("A"), p("p1"), "Order"),
                arc(p("p1"), t("B"), "Order"),
                arc(t("B"), p("sink"), "Order"),
            ],
        };
        let map = build_metro_map(&net);

        let ab = map
            .edges
            .iter()
            .find(|e| e.source == "transition:A" && e.target == "transition:B")
            .unwrap_or_else(|| panic!("no A->B edge: {:#?}", map.edges));
        assert!(ab.variable, "a variable arc anywhere on the collapsed wire must mark the collapsed edge: {:#?}", map.edges);

        let src_a = map
            .edges
            .iter()
            .find(|e| e.target == "transition:A")
            .unwrap_or_else(|| panic!("no edge into A: {:#?}", map.edges));
        assert!(!src_a.variable, "an edge with no variable arc on its own path must stay false: {:#?}", map.edges);
    }

    /// (b) Two object types sharing one activity: each has its own
    /// source/sink, both flow through the same shared "Register" station.
    #[test]
    fn two_object_types_share_a_station() {
        let net = OcpnPayload {
            object_types: vec!["Order".into(), "Item".into()],
            places: vec![
                place("src-o", "Order", InPlaceKind::Source),
                place("sink-o", "Order", InPlaceKind::Sink),
                place("src-i", "Item", InPlaceKind::Source),
                place("sink-i", "Item", InPlaceKind::Sink),
            ],
            transitions: vec![station("reg", "Register", &["Order", "Item"])],
            arcs: vec![
                arc(p("src-o"), t("reg"), "Order"),
                arc(t("reg"), p("sink-o"), "Order"),
                arc(p("src-i"), t("reg"), "Item"),
                arc(t("reg"), p("sink-i"), "Item"),
            ],
        };
        let map = build_metro_map(&net);
        assert_eq!(map.nodes.len(), 5); // 2 sources + 1 shared station + 2 sinks
        let reg = station_of(&map, "Register");
        match reg {
            OutNode::Station { object_types, .. } => {
                let mut ot = object_types.clone();
                ot.sort();
                assert_eq!(ot, vec!["Item".to_string(), "Order".to_string()]);
            }
            _ => panic!("expected a station"),
        }
        assert_eq!(map.edges.len(), 4);
    }

    /// (c) XOR choice: after A, a place with two outgoing branches (B or C)
    /// rejoining at a place with two incoming arcs before D.
    #[test]
    fn xor_choice() {
        let net = OcpnPayload {
            object_types: vec!["Order".into()],
            places: vec![
                place("src", "Order", InPlaceKind::Source),
                place("split", "Order", InPlaceKind::Normal),
                place("join", "Order", InPlaceKind::Normal),
                place("sink", "Order", InPlaceKind::Sink),
            ],
            transitions: vec![
                station("A", "A", &["Order"]),
                station("B", "B", &["Order"]),
                station("C", "C", &["Order"]),
                station("D", "D", &["Order"]),
            ],
            arcs: vec![
                arc(p("src"), t("A"), "Order"),
                arc(t("A"), p("split"), "Order"),
                arc(p("split"), t("B"), "Order"),
                arc(p("split"), t("C"), "Order"),
                arc(t("B"), p("join"), "Order"),
                arc(t("C"), p("join"), "Order"),
                arc(p("join"), t("D"), "Order"),
                arc(t("D"), p("sink"), "Order"),
            ],
        };
        let map = build_metro_map(&net);
        let gateways: Vec<_> = map
            .nodes
            .iter()
            .filter_map(|n| match n {
                OutNode::Gateway { gateway_type, direction, .. } => Some((*gateway_type, *direction)),
                _ => None,
            })
            .collect();
        assert_eq!(gateways.len(), 2, "{:#?}", map.nodes);
        assert!(gateways.iter().all(|(gt, _)| *gt == GatewayType::Xor));
        assert!(gateways.contains(&(GatewayType::Xor, GatewayDirection::Split)));
        assert!(gateways.contains(&(GatewayType::Xor, GatewayDirection::Join)));
        // src->A, A->split, split->B, split->C, B->join, C->join, join->D, D->sink
        assert_eq!(map.edges.len(), 8);
    }

    /// (d) AND parallel: a silent split transition after A fans out to B and
    /// C concurrently, a silent join transition brings them back before D.
    #[test]
    fn and_parallel() {
        let net = OcpnPayload {
            object_types: vec!["Order".into()],
            places: vec![
                place("src", "Order", InPlaceKind::Source),
                place("p-a", "Order", InPlaceKind::Normal),
                place("p-b-in", "Order", InPlaceKind::Normal),
                place("p-c-in", "Order", InPlaceKind::Normal),
                place("p-b-out", "Order", InPlaceKind::Normal),
                place("p-c-out", "Order", InPlaceKind::Normal),
                place("p-d", "Order", InPlaceKind::Normal),
                place("sink", "Order", InPlaceKind::Sink),
            ],
            transitions: vec![
                station("A", "A", &["Order"]),
                silent("split", "Order"),
                station("B", "B", &["Order"]),
                station("C", "C", &["Order"]),
                silent("join", "Order"),
                station("D", "D", &["Order"]),
            ],
            arcs: vec![
                arc(p("src"), t("A"), "Order"),
                arc(t("A"), p("p-a"), "Order"),
                arc(p("p-a"), t("split"), "Order"),
                arc(t("split"), p("p-b-in"), "Order"),
                arc(t("split"), p("p-c-in"), "Order"),
                arc(p("p-b-in"), t("B"), "Order"),
                arc(p("p-c-in"), t("C"), "Order"),
                arc(t("B"), p("p-b-out"), "Order"),
                arc(t("C"), p("p-c-out"), "Order"),
                arc(p("p-b-out"), t("join"), "Order"),
                arc(p("p-c-out"), t("join"), "Order"),
                arc(t("join"), p("p-d"), "Order"),
                arc(p("p-d"), t("D"), "Order"),
                arc(t("D"), p("sink"), "Order"),
            ],
        };
        let map = build_metro_map(&net);
        let gateways: Vec<_> = map
            .nodes
            .iter()
            .filter_map(|n| match n {
                OutNode::Gateway { gateway_type, direction, .. } => Some((*gateway_type, *direction)),
                _ => None,
            })
            .collect();
        assert_eq!(gateways.len(), 2, "{:#?}", map.nodes);
        assert!(gateways.iter().all(|(gt, _)| *gt == GatewayType::And));
        assert!(gateways.contains(&(GatewayType::And, GatewayDirection::Split)));
        assert!(gateways.contains(&(GatewayType::And, GatewayDirection::Join)));
        assert_eq!(station_of(&map, "B").rank(), station_of(&map, "C").rank(), "parallel branches share a rank");
    }

    /// A direct AND-split-to-join edge (collapsed through a pass-through
    /// place, same as `edge:...:place:p:Transport Document:3:place:p:...:4`
    /// in the live payload) running alongside a two-station branch that
    /// occupies the exact same two intermediate ranks — the live-diagram
    /// contention `concentrate_dummy_drift` has to survive: its two
    /// waypoints must still land at `split`'s and `join`'s own lanes even
    /// though each intermediate rank also holds an unrelated real station.
    #[test]
    fn direct_edge_concentrates_despite_same_rank_real_stations() {
        let net = OcpnPayload {
            object_types: vec!["Order".into()],
            places: vec![
                place("src", "Order", InPlaceKind::Source),
                place("p-a", "Order", InPlaceKind::Normal),
                place("p-direct", "Order", InPlaceKind::Normal),
                place("p-b-in", "Order", InPlaceKind::Normal),
                place("p-mid", "Order", InPlaceKind::Normal),
                place("p-c-out", "Order", InPlaceKind::Normal),
                place("p-d", "Order", InPlaceKind::Normal),
                place("sink", "Order", InPlaceKind::Sink),
            ],
            transitions: vec![
                station("A", "A", &["Order"]),
                silent("split", "Order"),
                station("B", "B", &["Order"]),
                station("C", "C", &["Order"]),
                silent("join", "Order"),
                station("D", "D", &["Order"]),
            ],
            arcs: vec![
                arc(p("src"), t("A"), "Order"),
                arc(t("A"), p("p-a"), "Order"),
                arc(p("p-a"), t("split"), "Order"),
                // Direct branch: collapses to one edge, split -> join.
                arc(t("split"), p("p-direct"), "Order"),
                arc(p("p-direct"), t("join"), "Order"),
                // Two-station branch: shares split's and join's own ranks
                // with the direct edge's two dummy waypoints.
                arc(t("split"), p("p-b-in"), "Order"),
                arc(p("p-b-in"), t("B"), "Order"),
                arc(t("B"), p("p-mid"), "Order"),
                arc(p("p-mid"), t("C"), "Order"),
                arc(t("C"), p("p-c-out"), "Order"),
                arc(p("p-c-out"), t("join"), "Order"),
                arc(t("join"), p("p-d"), "Order"),
                arc(p("p-d"), t("D"), "Order"),
                arc(t("D"), p("sink"), "Order"),
            ],
        };
        let map = build_metro_map(&net);

        assert_eq!(station_of(&map, "B").rank(), station_of(&map, "C").rank() - 1);

        let direct_edge = map
            .edges
            .iter()
            .find(|e| e.object_type == "Order" && e.source.contains(":split") && e.target.contains(":join"))
            .expect("split->join direct edge");
        assert_eq!(direct_edge.waypoints.len(), 2, "{:#?}", direct_edge.waypoints);

        let split_lane = map.nodes.iter().find(|n| n.id() == direct_edge.source).unwrap().lane();
        let join_lane = map.nodes.iter().find(|n| n.id() == direct_edge.target).unwrap().lane();
        assert!(
            (direct_edge.waypoints[0].lane - split_lane).abs() < 1e-6,
            "interior waypoint should sit at split's own lane ({split_lane}), got {} -- B is at rank {}, lane {}",
            direct_edge.waypoints[0].lane,
            station_of(&map, "B").rank(),
            station_of(&map, "B").lane(),
        );
        assert!(
            (direct_edge.waypoints[1].lane - join_lane).abs() < 1e-6,
            "final waypoint should sit at join's own lane ({join_lane}), got {} -- C is at rank {}, lane {}",
            direct_edge.waypoints[1].lane,
            station_of(&map, "C").rank(),
            station_of(&map, "C").lane(),
        );
    }

    /// (e) A loop: D can route back to A. The back edge must not appear in
    /// the acyclic ranking, must be tagged `loop`, and the rest of the chain
    /// must still rank normally.
    #[test]
    fn loop_back_edge() {
        let net = OcpnPayload {
            object_types: vec!["Order".into()],
            places: vec![
                place("src", "Order", InPlaceKind::Source),
                place("p1", "Order", InPlaceKind::Normal),
                place("p-redo", "Order", InPlaceKind::Normal),
                place("sink", "Order", InPlaceKind::Sink),
            ],
            transitions: vec![station("A", "A", &["Order"]), station("D", "D", &["Order"])],
            arcs: vec![
                arc(p("src"), t("A"), "Order"),
                arc(t("A"), p("p1"), "Order"),
                arc(p("p1"), t("D"), "Order"),
                arc(t("D"), p("p-redo"), "Order"),
                arc(p("p-redo"), t("A"), "Order"),
                arc(t("D"), p("sink"), "Order"),
            ],
        };
        // D has out-degree 2 (redo place + sink) -> XOR-split; that's fine,
        // it does not affect the loop-detection behaviour under test.
        let map = build_metro_map(&net);
        let loop_edges: Vec<_> = map.edges.iter().filter(|e| e.kind == EdgeKind::Loop).collect();
        assert_eq!(loop_edges.len(), 1, "{:#?}", map.edges);
        assert_eq!(station_of(&map, "A").rank(), 1);
        assert!(station_of(&map, "D").rank() > station_of(&map, "A").rank());
    }

    #[test]
    fn cross_type_merge_cycle_is_not_a_genuine_loop() {
        // Order flows src→A→D→sink; Item flows src→D→A→sink — opposite
        // order through the same two shared stations. Neither type's own
        // lifecycle loops back to anything; the only "cycle" is the merged
        // graph having both A→D (Order) and D→A (Item). Ranking still needs
        // one of them excluded to stay a DAG, but *neither* is a genuine
        // redo for its own object type, so neither should draw dashed.
        let net = OcpnPayload {
            object_types: vec!["Item".into(), "Order".into()],
            places: vec![
                place("src-o", "Order", InPlaceKind::Source),
                place("sink-o", "Order", InPlaceKind::Sink),
                place("src-i", "Item", InPlaceKind::Source),
                place("sink-i", "Item", InPlaceKind::Sink),
            ],
            transitions: vec![station("A", "A", &["Order", "Item"]), station("D", "D", &["Order", "Item"])],
            arcs: vec![
                arc(p("src-o"), t("A"), "Order"),
                arc(t("A"), t("D"), "Order"),
                arc(t("D"), p("sink-o"), "Order"),
                arc(p("src-i"), t("D"), "Item"),
                arc(t("D"), t("A"), "Item"),
                arc(t("A"), p("sink-i"), "Item"),
            ],
        };
        let map = build_metro_map(&net);
        let loop_edges: Vec<_> = map.edges.iter().filter(|e| e.kind == EdgeKind::Loop).collect();
        assert!(loop_edges.is_empty(), "neither type genuinely loops — a merge-only cycle must not be dashed: {:#?}", map.edges);
    }

    /// (f) Two object types, one ("Order") skipping straight from A to D
    /// while the other ("Item") goes through B and C in between — A->D
    /// spans 3 ranks, so it needs two dummy waypoints (at B's and C's
    /// ranks) to keep the lane-ordering pass from placing an unrelated node
    /// directly on its path, and the view needs those waypoints to route
    /// through instead of drawing straight through B/C's stations.
    #[test]
    fn long_edge_gets_dummy_waypoints() {
        let net = OcpnPayload {
            object_types: vec!["Item".into(), "Order".into()],
            places: vec![
                place("src-o", "Order", InPlaceKind::Source),
                place("p-o1", "Order", InPlaceKind::Normal),
                place("sink-o", "Order", InPlaceKind::Sink),
                place("src-i", "Item", InPlaceKind::Source),
                place("p-i1", "Item", InPlaceKind::Normal),
                place("p-i2", "Item", InPlaceKind::Normal),
                place("p-i3", "Item", InPlaceKind::Normal),
                place("sink-i", "Item", InPlaceKind::Sink),
            ],
            transitions: vec![
                station("A", "A", &["Order", "Item"]),
                station("B", "B", &["Item"]),
                station("C", "C", &["Item"]),
                station("D", "D", &["Order", "Item"]),
            ],
            arcs: vec![
                // Order: A -> D directly (skips two ranks B/C occupy for Item).
                arc(p("src-o"), t("A"), "Order"),
                arc(t("A"), p("p-o1"), "Order"),
                arc(p("p-o1"), t("D"), "Order"),
                arc(t("D"), p("sink-o"), "Order"),
                // Item: A -> B -> C -> D.
                arc(p("src-i"), t("A"), "Item"),
                arc(t("A"), p("p-i1"), "Item"),
                arc(p("p-i1"), t("B"), "Item"),
                arc(t("B"), p("p-i2"), "Item"),
                arc(p("p-i2"), t("C"), "Item"),
                arc(t("C"), p("p-i3"), "Item"),
                arc(p("p-i3"), t("D"), "Item"),
                arc(t("D"), p("sink-i"), "Item"),
            ],
        };
        let map = build_metro_map(&net);

        assert_eq!(station_of(&map, "A").rank(), 1);
        assert_eq!(station_of(&map, "B").rank(), 2);
        assert_eq!(station_of(&map, "C").rank(), 3);
        assert_eq!(station_of(&map, "D").rank(), 4);

        let long_edge = map
            .edges
            .iter()
            .find(|e| e.object_type == "Order" && e.source.contains(":A") && e.target.contains(":D"))
            .expect("A->D Order edge");
        assert_eq!(long_edge.waypoints.len(), 2, "{:#?}", long_edge.waypoints);
        assert_eq!(long_edge.waypoints[0].rank, 2);
        assert_eq!(long_edge.waypoints[1].rank, 3);

        // Every single-rank edge carries no waypoints.
        let short_edge = map
            .edges
            .iter()
            .find(|e| e.object_type == "Item" && e.source.contains(":A") && e.target.contains(":B"))
            .expect("A->B Item edge");
        assert!(short_edge.waypoints.is_empty());

        // The long edge's own dummy chain bends once, right before it
        // reaches D, rather than drifting a little at every intermediate
        // rank (a real, live "curly" wobble this fixture reproduces:
        // Item's B/C stations pull the shared ranks' desired positions away
        // from a straight A-D line, and without `concentrate_dummy_drift`
        // the two waypoints used to land partway between A's and D's own
        // lanes instead of matching one or the other outright).
        let a_lane = station_of(&map, "A").lane();
        let d_lane = station_of(&map, "D").lane();
        assert!(
            (long_edge.waypoints[0].lane - a_lane).abs() < 1e-6,
            "interior waypoint should sit exactly at A's own lane ({a_lane}), got {}",
            long_edge.waypoints[0].lane
        );
        assert!(
            (long_edge.waypoints[1].lane - d_lane).abs() < 1e-6,
            "final waypoint should sit exactly at D's own lane ({d_lane}), got {}",
            long_edge.waypoints[1].lane
        );
    }

    fn source_of<'a>(map: &'a MetroMapPayload, object_type: &str) -> &'a OutNode {
        map.nodes
            .iter()
            .find(|n| matches!(n, OutNode::Source { object_type: ot, .. } if ot == object_type))
            .unwrap_or_else(|| panic!("no source for {object_type}"))
    }

    /// (g) ALAP for sources: "Order" is a five-station chain ending at a
    /// station shared with "Vehicle", whose *own* chain is a single direct
    /// hop from its source to that same shared station. Vehicle's source has
    /// no predecessor, so ASAP would put it at rank 0 like every other
    /// source — but it isn't actually needed until the shared station, which
    /// Order's own long chain pushes far down the diagram. Its rank should
    /// sit right before that, not at the very top.
    #[test]
    fn source_pushed_to_just_before_first_use() {
        let net = OcpnPayload {
            object_types: vec!["Order".into(), "Vehicle".into()],
            places: vec![
                place("src-o", "Order", InPlaceKind::Source),
                place("o1", "Order", InPlaceKind::Normal),
                place("o2", "Order", InPlaceKind::Normal),
                place("o3", "Order", InPlaceKind::Normal),
                place("o4", "Order", InPlaceKind::Normal),
                place("sink-o", "Order", InPlaceKind::Sink),
                place("src-v", "Vehicle", InPlaceKind::Source),
                place("sink-v", "Vehicle", InPlaceKind::Sink),
            ],
            transitions: vec![
                station("O1", "O1", &["Order"]),
                station("O2", "O2", &["Order"]),
                station("O3", "O3", &["Order"]),
                station("O4", "O4", &["Order"]),
                station("BookVehicle", "BookVehicle", &["Order", "Vehicle"]),
            ],
            arcs: vec![
                arc(p("src-o"), t("O1"), "Order"),
                arc(t("O1"), p("o1"), "Order"),
                arc(p("o1"), t("O2"), "Order"),
                arc(t("O2"), p("o2"), "Order"),
                arc(p("o2"), t("O3"), "Order"),
                arc(t("O3"), p("o3"), "Order"),
                arc(p("o3"), t("O4"), "Order"),
                arc(t("O4"), p("o4"), "Order"),
                arc(p("o4"), t("BookVehicle"), "Order"),
                arc(t("BookVehicle"), p("sink-o"), "Order"),
                arc(p("src-v"), t("BookVehicle"), "Vehicle"),
                arc(t("BookVehicle"), p("sink-v"), "Vehicle"),
            ],
        };
        let map = build_metro_map(&net);

        assert_eq!(station_of(&map, "O1").rank(), 1);
        assert_eq!(station_of(&map, "O4").rank(), 4);
        assert_eq!(station_of(&map, "BookVehicle").rank(), 5);
        assert_eq!(source_of(&map, "Order").rank(), 0, "Order's own chain still starts at the top");
        assert_eq!(
            source_of(&map, "Vehicle").rank(),
            4,
            "Vehicle isn't needed until BookVehicle (rank 5), so its source should sit right before that, not at rank 0: {:#?}",
            map.nodes,
        );
    }

    /// (h) Spine centring: "Order" is the longer chain (touches more
    /// stations) and shares a rank with a shorter, unrelated "Side" object
    /// type. The spine should land on lane 0 at every rank it occupies;
    /// "Side", sharing no station with it, should land on a different lane.
    #[test]
    fn spine_recentred_to_lane_zero() {
        let net = OcpnPayload {
            object_types: vec!["Order".into(), "Side".into()],
            places: vec![
                place("src-o", "Order", InPlaceKind::Source),
                place("o1", "Order", InPlaceKind::Normal),
                place("o2", "Order", InPlaceKind::Normal),
                place("sink-o", "Order", InPlaceKind::Sink),
                place("src-s", "Side", InPlaceKind::Source),
                place("s1", "Side", InPlaceKind::Normal),
                place("sink-s", "Side", InPlaceKind::Sink),
            ],
            transitions: vec![
                station("O1", "O1", &["Order"]),
                station("O2", "O2", &["Order"]),
                station("O3", "O3", &["Order"]),
                station("S0", "S0", &["Side"]),
                station("S1", "S1", &["Side"]),
            ],
            arcs: vec![
                arc(p("src-o"), t("O1"), "Order"),
                arc(t("O1"), p("o1"), "Order"),
                arc(p("o1"), t("O2"), "Order"),
                arc(t("O2"), p("o2"), "Order"),
                arc(p("o2"), t("O3"), "Order"),
                arc(t("O3"), p("sink-o"), "Order"),
                arc(p("src-s"), t("S0"), "Side"),
                arc(t("S0"), p("s1"), "Side"),
                arc(p("s1"), t("S1"), "Side"),
                arc(t("S1"), p("sink-s"), "Side"),
            ],
        };
        let map = build_metro_map(&net);

        // O1 and S0 both land at rank 1 (each is the first station of a
        // source directly behind it), competing for lane space there.
        assert_eq!(station_of(&map, "O1").rank(), 1);
        assert_eq!(station_of(&map, "S0").rank(), 1);
        assert_eq!(station_of(&map, "O1").lane(), 0.0, "the spine (more stations) should be recentred to lane 0: {:#?}", map.nodes);
        assert_ne!(station_of(&map, "S0").lane(), 0.0, "an unrelated type sharing no station with the spine should not also sit at lane 0");
    }

    /// (i) A loop spanning more than one rank needs waypoints exactly like a
    /// long forward edge does — without them, a back edge from a much later
    /// rank ran straight through whatever real content already occupied the
    /// ranks in between it never had a reserved lane for.
    #[test]
    fn long_loop_edge_gets_waypoints() {
        let net = OcpnPayload {
            object_types: vec!["Order".into()],
            places: vec![
                place("src", "Order", InPlaceKind::Source),
                place("p1", "Order", InPlaceKind::Normal),
                place("p2", "Order", InPlaceKind::Normal),
                place("p3", "Order", InPlaceKind::Normal),
                place("p-redo", "Order", InPlaceKind::Normal),
                place("sink", "Order", InPlaceKind::Sink),
            ],
            transitions: vec![
                station("A", "A", &["Order"]),
                station("B", "B", &["Order"]),
                station("C", "C", &["Order"]),
                station("D", "D", &["Order"]),
            ],
            arcs: vec![
                arc(p("src"), t("A"), "Order"),
                arc(t("A"), p("p1"), "Order"),
                arc(p("p1"), t("B"), "Order"),
                arc(t("B"), p("p2"), "Order"),
                arc(p("p2"), t("C"), "Order"),
                arc(t("C"), p("p3"), "Order"),
                arc(p("p3"), t("D"), "Order"),
                arc(t("D"), p("p-redo"), "Order"),
                arc(p("p-redo"), t("A"), "Order"),
                arc(t("D"), p("sink"), "Order"),
            ],
        };
        let map = build_metro_map(&net);

        assert_eq!(station_of(&map, "A").rank(), 1);
        assert_eq!(station_of(&map, "D").rank(), 4);

        let loop_edge = map
            .edges
            .iter()
            .find(|e| e.kind == EdgeKind::Loop)
            .expect("a loop edge from D back to A");
        assert_eq!(loop_edge.waypoints.len(), 2, "{:#?}", loop_edge.waypoints);
        let mut ranks: Vec<i32> = loop_edge.waypoints.iter().map(|w| w.rank).collect();
        ranks.sort();
        assert_eq!(ranks, vec![2, 3], "should reserve a lane at every rank the back edge passes through: {:#?}", loop_edge.waypoints);
    }

    /// (j) ALAP generalises past `Source` nodes: a gateway `G` reachable
    /// *only* through two back edges (C1->G, C2->G, both closing a cycle
    /// through G's single forward successor D1) has no forward predecessor
    /// at all, exactly like a source — ASAP ranking put it at rank 0 the
    /// same way it would a genuine starting point, even though D1 is
    /// actually shared with a much longer, unrelated chain ("B") that drags
    /// D1's own rank to 5. G should land at `rank(D1) - 1`, not 0 — the same
    /// reasoning `source_pushed_to_just_before_first_use` tests, just for a
    /// false root that isn't a `Source` kind at all.
    #[test]
    fn non_source_false_root_gets_alap_too() {
        let net = OcpnPayload {
            object_types: vec!["A".into(), "B".into()],
            places: vec![
                place("G", "A", InPlaceKind::Normal),
                place("p-c1", "A", InPlaceKind::Normal),
                place("p-c2", "A", InPlaceKind::Normal),
                place("src-b", "B", InPlaceKind::Source),
                place("b1", "B", InPlaceKind::Normal),
                place("b2", "B", InPlaceKind::Normal),
                place("b3", "B", InPlaceKind::Normal),
                place("p-s4", "B", InPlaceKind::Normal),
            ],
            transitions: vec![
                station("C1", "C1", &["A"]),
                station("C2", "C2", &["A"]),
                station("D1", "D1", &["A", "B"]),
                station("S1", "S1", &["B"]),
                station("S2", "S2", &["B"]),
                station("S3", "S3", &["B"]),
                station("S4", "S4", &["B"]),
            ],
            arcs: vec![
                // The cycle: G -> D1 -> {C1, C2} -> G. C1->G and C2->G must
                // both become back edges since G is reached (as the DFS
                // root, "place:G" sorting first) before either C1 or C2.
                arc(t("C1"), p("G"), "A"),
                arc(t("C2"), p("G"), "A"),
                arc(p("G"), t("D1"), "A"),
                arc(t("D1"), p("p-c1"), "A"),
                arc(p("p-c1"), t("C1"), "A"),
                arc(t("D1"), p("p-c2"), "A"),
                arc(p("p-c2"), t("C2"), "A"),
                // An unrelated, longer chain sharing D1 — this is what
                // drags D1's own rank up to 5, giving G real slack to fall
                // into instead of sitting at rank 0 with nothing pushing it.
                arc(p("src-b"), t("S1"), "B"),
                arc(t("S1"), p("b1"), "B"),
                arc(p("b1"), t("S2"), "B"),
                arc(t("S2"), p("b2"), "B"),
                arc(p("b2"), t("S3"), "B"),
                arc(t("S3"), p("b3"), "B"),
                arc(p("b3"), t("S4"), "B"),
                arc(t("S4"), p("p-s4"), "B"),
                arc(p("p-s4"), t("D1"), "B"),
            ],
        };
        let map = build_metro_map(&net);

        assert_eq!(station_of(&map, "D1").rank(), 5, "{:#?}", map.nodes);
        assert_eq!(station_of(&map, "C1").rank(), 6);
        assert_eq!(station_of(&map, "C2").rank(), 6);

        let loop_kinds: Vec<_> = map
            .edges
            .iter()
            .filter(|e| (e.source.contains(":C1") || e.source.contains(":C2")) && e.target.contains(":G"))
            .map(|e| e.kind)
            .collect();
        assert_eq!(loop_kinds.len(), 2, "{:#?}", map.edges);
        assert!(loop_kinds.iter().all(|k| *k == EdgeKind::Loop), "{:#?}", map.edges);

        let gateway = map
            .nodes
            .iter()
            .find(|n| matches!(n, OutNode::Gateway { object_type, .. } if object_type == "A"))
            .expect("gateway G");
        assert_eq!(
            gateway.rank(),
            4,
            "a false root with no forward predecessor should sit right before its own first use (rank(D1) - 1 = 4), not at rank 0: {:#?}",
            map.nodes,
        );
    }

    #[test]
    fn swap_delta_detects_crossing_reduction() {
        // rank0: a(lane0), b(lane1). rank1: c, d. Edges a->d, b->c — an X
        // crossing if c sits left of d, none if d sits left of c.
        let predecessors: HashMap<String, Vec<String>> = [
            ("c".to_string(), vec!["b".to_string()]),
            ("d".to_string(), vec!["a".to_string()]),
        ]
        .into_iter()
        .collect();
        let adjacency: HashMap<String, Vec<String>> = HashMap::new();
        let lane_of: HashMap<String, f64> =
            [("a", 0.0), ("b", 1.0)].into_iter().map(|(k, v)| (k.to_string(), v)).collect();

        let delta = swap_delta("c", "d", &predecessors, &adjacency, &lane_of);
        assert!(delta < 0, "swapping c left-of-d to d left-of-c uncrosses a->d/b->c, expected a negative delta, got {delta}");
    }

    #[test]
    fn degree_one_node_aligns_with_its_sole_neighbour() {
        // a (rank0, alone) -> c (rank1). b and d share c's rank but connect
        // to nothing at all. Plain barycenter ties b and c at the same mean
        // (b defaults to its own current lane, c's mean is exactly a's lane)
        // and alphabetical tie-break always keeps b left of c — c never
        // reaches a's lane through barycenter sweeps alone, however many
        // rounds run, which is exactly the "microbend with nothing forcing
        // it" case coordinate assignment (not just ordering) exists for.
        let rank_of: HashMap<String, i32> = [("a", 0), ("b", 1), ("c", 1), ("d", 1)]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        let adjacency: HashMap<String, Vec<String>> = [("a".to_string(), vec!["c".to_string()])].into_iter().collect();

        let lanes = assign_lanes(&rank_of, &adjacency);
        assert_eq!(
            lanes["c"], lanes["a"],
            "c's only neighbour is a — it should land in exactly a's lane, not just close to it: {lanes:?}"
        );
    }

    #[test]
    fn degree_one_node_aligns_across_differently_sized_ranks() {
        // a sits alone at rank0 (a one-node-wide rank) and connects only to
        // d, one of five nodes at rank1. A dense per-rank integer lane
        // physically cannot solve this: a's own rank only ever has index 0
        // to offer, however good the *order* is, so no amount of reordering
        // could ever put a at "lane 3" to match d. Real coordinate
        // assignment has no such ceiling — this is the actual case a source
        // with a single successor several lanes into a wider rank (e.g. a
        // real "Handling Unit" source several lanes from "Collect Goods")
        // needed fixed.
        let rank_of: HashMap<String, i32> = [("a", 0), ("b", 1), ("c", 1), ("d", 1), ("e", 1), ("f", 1)]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        let adjacency: HashMap<String, Vec<String>> = [("a".to_string(), vec!["d".to_string()])].into_iter().collect();

        let lanes = assign_lanes(&rank_of, &adjacency);
        assert_eq!(
            lanes["a"], lanes["d"],
            "a's only neighbour is d, in a much wider rank — a should land exactly under d, not be capped by its own rank's width: {lanes:?}"
        );
    }

    #[test]
    fn two_sources_align_with_their_own_targets_independently() {
        // rank0 = [HU, CO], rank1 = [CG, RC], HU->CG and CO->RC only. Both
        // pairs are mutually degree-1 and should each land in exact
        // alignment, without the two independent pairs interfering with
        // each other.
        let rank_of: HashMap<String, i32> = [("HU", 0), ("CO", 0), ("CG", 1), ("RC", 1)]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        let adjacency: HashMap<String, Vec<String>> = [
            ("HU".to_string(), vec!["CG".to_string()]),
            ("CO".to_string(), vec!["RC".to_string()]),
        ]
        .into_iter()
        .collect();
        let lanes = assign_lanes(&rank_of, &adjacency);
        assert_eq!(lanes["HU"], lanes["CG"], "HU/CG mutually degree-1: {lanes:?}");
        assert_eq!(lanes["CO"], lanes["RC"], "CO/RC mutually degree-1: {lanes:?}");
    }

    #[test]
    fn mid_chain_node_settles_instead_of_flip_flopping() {
        // a -> m -> lt, plus a second predecessor c -> lt sitting well away
        // from a. m has exactly one neighbour on each side, same as the
        // dummy/degree-1 cases above, but its *down* side (lt) is shared
        // with an unrelated line (c) that pulls lt away from directly
        // under m. The old alternating-direction desired calculation
        // overwrote m's target every other round (a's position on
        // downward sweeps, lt's on upward ones) and never settled between
        // them; blending both directions every round should converge to
        // one stable value instead of a mid-air oscillation. This is the
        // real shape that "Handling Unit" one lane off "Collect Goods"
        // turned out to be, confirmed against the live artifact's own
        // payload (Collect Goods's downstream "Load Truck" is also fed by
        // the unrelated Container line).
        let rank_of: HashMap<String, i32> = [("a", 0), ("m", 1), ("c", 1), ("lt", 2)]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        let adjacency: HashMap<String, Vec<String>> = [
            ("a".to_string(), vec!["m".to_string()]),
            ("m".to_string(), vec!["lt".to_string()]),
            ("c".to_string(), vec!["lt".to_string()]),
        ]
        .into_iter()
        .collect();
        let lanes = assign_lanes(&rank_of, &adjacency);
        // `a` has exactly one connection (down, to `m`) and no same-rank
        // competitor of its own — nothing clamps it, so it should track
        // `m`'s settled position exactly, the same "degree-1 copies its
        // neighbour" guarantee the other alignment tests check. Under the
        // old alternating-only desired calculation this was liable to
        // depend on which direction the *last* sweep happened to face,
        // rather than reflecting one genuinely settled value for `m`.
        assert_eq!(lanes["a"], lanes["m"], "a's only connection is m — it should track m's settled position exactly: {lanes:?}");
    }

    #[test]
    fn isotonic_nondecreasing_matches_hand_worked_cases() {
        // Already non-decreasing: no adjustment needed at all.
        let unweighted = vec![1.0; 4];
        assert_eq!(isotonic_nondecreasing(&[0.0, 1.0, 2.0], &unweighted[..3]), vec![0.0, 1.0, 2.0]);

        // A single violation (5.0 followed by 1.0) pools into the mean of
        // just those two, leaving the untouched neighbour alone.
        assert_eq!(isotonic_nondecreasing(&[0.0, 5.0, 1.0, 9.0], &unweighted), vec![0.0, 3.0, 3.0, 9.0]);

        // Unequal weights shift the pooled value toward the heavier point
        // instead of a plain average — this is the piece that lets a dummy
        // waypoint's near-fixed desired position resist being dragged as
        // far as an unweighted mean would. [10.0, 0.0] is a real violation
        // (descending); a heavier first point should pool closer to its
        // own 10.0 than an equal weighting would.
        let weighted = isotonic_nondecreasing(&[10.0, 0.0], &[9.0, 1.0]);
        let all_equal = isotonic_nondecreasing(&[10.0, 0.0], &[1.0, 1.0]);
        assert!(weighted[0] > all_equal[0], "heavier point should pull the pooled value closer to itself: {weighted:?} vs {all_equal:?}");
    }

    #[test]
    fn resolve_order_preserving_keeps_min_gap() {
        let weight = vec![1.0; 3];
        let resolved = resolve_order_preserving(&[0.0, 0.2, 0.1], &weight);
        for pair in resolved.windows(2) {
            assert!(pair[1] - pair[0] >= 1.0 - 1e-9, "consecutive positions must stay at least 1.0 apart: {resolved:?}");
        }
    }

    #[test]
    fn straighten_by_reordering_fixes_a_crossing_neutral_wobble() {
        // rank0 = [a, c], sharing no neighbours with each other, so
        // swapping them can never cost a crossing. a's only neighbour
        // wants it far to the right, c's wants it far to the left — the
        // *initial* order [a, c] forces PAVA to compromise (order must
        // stay non-decreasing, so neither reaches its own target), while
        // [c, a] lets each reach its desired position exactly. This is
        // the actual shape of a live "wobble": several unrelated lines
        // detouring in lockstep purely because of which order
        // transpose_pass (crossing-count only) settled on — it has no way
        // to see that a crossing-neutral swap would also straighten them.
        let mut layers = vec![vec!["a".to_string(), "c".to_string()]];
        let predecessors: HashMap<String, Vec<String>> = HashMap::new();
        let adjacency: HashMap<String, Vec<String>> = [
            ("a".to_string(), vec!["far_right".to_string()]),
            ("c".to_string(), vec!["far_left".to_string()]),
        ]
        .into_iter()
        .collect();
        let mut pos: HashMap<String, f64> = [("a", 0.0), ("c", 1.0), ("far_right", 10.0), ("far_left", 0.0)]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();

        let changed = straighten_by_reordering(&mut layers, &predecessors, &adjacency, &mut pos);
        assert!(changed, "swapping a and c is crossing-neutral and strictly straighter — should be adopted");
        assert_eq!(layers[0], vec!["c".to_string(), "a".to_string()]);
        assert_eq!(pos["a"], 10.0, "a should now sit exactly on its only neighbour: {pos:?}");
        assert_eq!(pos["c"], 0.0, "c should now sit exactly on its only neighbour: {pos:?}");
    }

    // ---------------------------------------------- OC-DFG front-end

    fn dnode(ot: &str, activity: &str, count: f64, starts: f64, ends: f64) -> OcdfgNode {
        OcdfgNode { object_type: ot.into(), activity: activity.into(), count, starts, ends }
    }
    fn dedge(ot: &str, src: &str, dst: &str, freq: f64) -> OcdfgEdge {
        OcdfgEdge { object_type: ot.into(), src: src.into(), dst: dst.into(), freq, avg_secs: None }
    }

    #[test]
    fn from_ocdfg_linear_chain_with_boundaries_and_frequencies() {
        let dfg = OcdfgPayload {
            object_types: vec!["Order".into()],
            nodes: vec![
                dnode("Order", "A", 10.0, 10.0, 0.0),
                dnode("Order", "B", 10.0, 0.0, 0.0),
                dnode("Order", "C", 10.0, 0.0, 10.0),
            ],
            edges: vec![dedge("Order", "A", "B", 8.0), dedge("Order", "B", "C", 9.0)],
        };
        let map = build_metro_map_from_ocdfg(&dfg, &[]);
        assert_eq!(map.basis, Basis::DirectlyFollows);
        // 3 stations + 1 source + 1 sink
        assert_eq!(map.nodes.len(), 5, "{:#?}", map.nodes);
        assert!(map.nodes.iter().all(|n| !matches!(n, OutNode::Gateway { .. })), "DFG basis has no gateways");

        let a = station_of(&map, "A");
        match a {
            OutNode::Station { meta, .. } => assert_eq!(meta.frequency, Some(10.0)),
            _ => panic!(),
        }
        let ab = map.edges.iter().find(|e| e.source == "station:A" && e.target == "station:B").unwrap();
        assert_eq!(ab.frequency, Some(8.0));
        // source→A carries the start count
        let sa = map.edges.iter().find(|e| e.source == "source:Order").unwrap();
        assert_eq!(sa.frequency, Some(10.0));
        assert!(station_of(&map, "A").rank() < station_of(&map, "C").rank());
    }

    #[test]
    fn from_ocdfg_shared_station_across_object_types() {
        let dfg = OcdfgPayload {
            object_types: vec!["Order".into(), "Item".into()],
            nodes: vec![
                dnode("Order", "Reg", 5.0, 5.0, 5.0),
                dnode("Item", "Reg", 7.0, 7.0, 7.0),
            ],
            edges: vec![],
        };
        let map = build_metro_map_from_ocdfg(&dfg, &[]);
        let reg = station_of(&map, "Reg");
        match reg {
            OutNode::Station { object_types, meta, .. } => {
                let mut ot = object_types.clone();
                ot.sort();
                assert_eq!(ot, vec!["Item".to_string(), "Order".to_string()]);
                assert_eq!(meta.frequency, Some(12.0), "counts summed across object types");
            }
            _ => panic!(),
        }
    }

    #[test]
    fn from_ocdfg_object_type_filter() {
        let dfg = OcdfgPayload {
            object_types: vec!["Order".into(), "Item".into()],
            nodes: vec![
                dnode("Order", "A", 3.0, 3.0, 3.0),
                dnode("Item", "B", 4.0, 4.0, 4.0),
            ],
            edges: vec![],
        };
        let map = build_metro_map_from_ocdfg(&dfg, &["Order".to_string()]);
        assert_eq!(map.object_types, vec!["Order".to_string()]);
        assert!(map.nodes.iter().any(|n| matches!(n, OutNode::Station { activity, .. } if activity == "A")));
        assert!(!map.nodes.iter().any(|n| matches!(n, OutNode::Station { activity, .. } if activity == "B")));
    }

    // ------------------------------------ RankTiebreak (frequency)

    /// Two object types, each acyclic on its own, form a cycle only once
    /// merged: Container goes Start -> X -> Y (a rare 1-count detour through
    /// X on its way to Y), Truck goes Y -> X directly (its own main flow,
    /// count 100). Merged, X and Y cycle back on each other. Structural mode
    /// (a single DFS pass, order decided by sorted node ids) happens to drop
    /// the *busy* Truck edge here, so X outranks Y even though for Truck's
    /// own lifecycle Y comes first. Frequency mode should instead drop the
    /// *light* Container edge, keeping Y before X.
    fn cross_type_cycle_dfg() -> OcdfgPayload {
        OcdfgPayload {
            object_types: vec!["Container".into(), "Truck".into()],
            nodes: vec![
                dnode("Container", "Start", 5.0, 5.0, 0.0),
                dnode("Container", "X", 5.0, 0.0, 0.0),
                dnode("Container", "Y", 1.0, 0.0, 1.0),
                dnode("Truck", "Y", 100.0, 100.0, 0.0),
                dnode("Truck", "X", 100.0, 0.0, 100.0),
            ],
            edges: vec![
                dedge("Container", "Start", "X", 5.0),
                dedge("Container", "X", "Y", 1.0),
                dedge("Truck", "Y", "X", 100.0),
            ],
        }
    }

    #[test]
    fn structural_tiebreak_can_rank_the_busy_edge_away() {
        let dfg = cross_type_cycle_dfg();
        let map = build_metro_map_from_ocdfg(&dfg, &[]);
        let x = station_of(&map, "X").rank();
        let y = station_of(&map, "Y").rank();
        assert!(x < y, "structural mode is expected to (wrongly) rank X before Y here: X={x} Y={y}");
    }

    #[test]
    fn frequency_tiebreak_keeps_the_busy_through_line_in_order() {
        let dfg = cross_type_cycle_dfg();
        let map = build_metro_map_from_ocdfg_with_rank_tiebreak(&dfg, &[], RankTiebreak::Frequency);
        let x = station_of(&map, "X").rank();
        let y = station_of(&map, "Y").rank();
        assert!(y < x, "frequency mode should keep Truck's Y->X order (count 100) over Container's X->Y (count 1): X={x} Y={y}");
    }

    #[test]
    fn frequency_tiebreak_matches_structural_when_explicitly_requested() {
        // build_metro_map_from_ocdfg's existing 2-arg signature must keep
        // meaning exactly RankTiebreak::Structural for every existing caller
        // (JS view code, and every test above this one).
        let dfg = cross_type_cycle_dfg();
        let a = build_metro_map_from_ocdfg(&dfg, &[]);
        let b = build_metro_map_from_ocdfg_with_rank_tiebreak(&dfg, &[], RankTiebreak::Structural);
        assert_eq!(station_of(&a, "X").rank(), station_of(&b, "X").rank());
        assert_eq!(station_of(&a, "Y").rank(), station_of(&b, "Y").rank());
    }

    #[test]
    fn payload_stats_report_the_basis() {
        // The basis rides into the artifact's `meta`, where the view's
        // "edge labels" parameter reads it through a `showWhen` condition.
        let dfg = OcdfgPayload {
            object_types: vec!["Order".into()],
            nodes: vec![dnode("Order", "A", 2.0, 2.0, 0.0), dnode("Order", "B", 2.0, 0.0, 2.0)],
            edges: vec![dedge("Order", "A", "B", 2.0)],
        };
        let dfg_map = build_metro_map_from_ocdfg(&dfg, &[]);
        assert_eq!(dfg_map.stats.basis, Basis::DirectlyFollows);
        assert_eq!(dfg_map.stats.stations, 2);
        assert!(dfg_map.stats.arcs > 0);

        let net = OcpnPayload {
            object_types: vec!["Order".into()],
            places: vec![
                place("src", "Order", InPlaceKind::Source),
                place("sink", "Order", InPlaceKind::Sink),
            ],
            transitions: vec![station("A", "A", &["Order"])],
            arcs: vec![arc(p("src"), t("A"), "Order"), arc(t("A"), p("sink"), "Order")],
        };
        assert_eq!(build_metro_map(&net).stats.basis, Basis::PetriNet);
    }

    #[test]
    fn from_ocdfg_carries_frequency_weighted_duration() {
        // Two upstream arcs collapse into one drawn edge (A -> B, seen for
        // two object types). The mean wait must be weighted by frequency —
        // a plain average of the two means would be wrong.
        let dfg = OcdfgPayload {
            object_types: vec!["Order".into()],
            nodes: vec![
                dnode("Order", "A", 10.0, 10.0, 0.0),
                dnode("Order", "B", 10.0, 0.0, 10.0),
            ],
            edges: vec![OcdfgEdge {
                object_type: "Order".into(), src: "A".into(), dst: "B".into(),
                freq: 4.0, avg_secs: Some(120.0),
            }],
        };
        let map = build_metro_map_from_ocdfg(&dfg, &[]);
        let ab = map
            .edges
            .iter()
            .find(|e| e.source == "station:A" && e.target == "station:B")
            .expect("A -> B edge");
        assert_eq!(ab.duration_secs, Some(120.0));

        // An arc with no duration leaves the field unset rather than zero.
        let bare = OcdfgPayload {
            object_types: vec!["Order".into()],
            nodes: vec![dnode("Order", "A", 2.0, 2.0, 0.0), dnode("Order", "B", 2.0, 0.0, 2.0)],
            edges: vec![dedge("Order", "A", "B", 2.0)],
        };
        let map2 = build_metro_map_from_ocdfg(&bare, &[]);
        let ab2 = map2
            .edges
            .iter()
            .find(|e| e.source == "station:A" && e.target == "station:B")
            .expect("A -> B edge");
        assert_eq!(ab2.duration_secs, None);
    }

    #[test]
    fn from_ocdfg_self_loop_is_kept() {
        let dfg = OcdfgPayload {
            object_types: vec!["Order".into()],
            nodes: vec![dnode("Order", "A", 4.0, 4.0, 4.0)],
            edges: vec![dedge("Order", "A", "A", 2.0)],
        };
        let map = build_metro_map_from_ocdfg(&dfg, &[]);
        assert!(map.edges.iter().any(|e| e.source == "station:A" && e.target == "station:A"));
    }

    #[test]
    fn petri_basis_gets_structural_reveal_order() {
        // src -> A -> B -> C -> sink, plus a leaf spur A -> D. B/C are the
        // core (degree 2), A is a hub (degree 3), D is a leaf (degree 1).
        let net = OcpnPayload {
            object_types: vec!["Order".into()],
            places: vec![
                place("src", "Order", InPlaceKind::Source),
                place("pa", "Order", InPlaceKind::Normal),
                place("pb", "Order", InPlaceKind::Normal),
                place("pc", "Order", InPlaceKind::Normal),
                place("pd", "Order", InPlaceKind::Normal),
                place("sink", "Order", InPlaceKind::Sink),
            ],
            transitions: vec![
                station("A", "A", &["Order"]),
                station("B", "B", &["Order"]),
                station("C", "C", &["Order"]),
                station("D", "D", &["Order"]),
            ],
            arcs: vec![
                arc(p("src"), t("A"), "Order"),
                arc(t("A"), p("pa"), "Order"),
                arc(p("pa"), t("B"), "Order"),
                arc(t("B"), p("pb"), "Order"),
                arc(p("pb"), t("C"), "Order"),
                arc(t("C"), p("pc"), "Order"),
                arc(p("pc"), p("sink"), "Order"),
                arc(t("A"), p("pd"), "Order"),
                arc(p("pd"), t("D"), "Order"),
            ],
        };
        let map = build_metro_map(&net);
        assert_eq!(map.basis, Basis::PetriNet);
        let reveal = |activity: &str| match station_of(&map, activity) {
            OutNode::Station { meta, .. } => meta.reveal_order,
            _ => None,
        };
        assert!(reveal("D").unwrap() > reveal("B").unwrap(), "leaf D revealed after core B");
        assert!(reveal("A").is_some() && reveal("C").is_some());
        // Boundaries carry no reveal order.
        for n in &map.nodes {
            if let OutNode::Source { meta, .. } | OutNode::Sink { meta, .. } = n {
                assert_eq!(meta.reveal_order, None);
            }
        }
    }

    #[test]
    fn boundary_with_two_first_steps_gets_a_split_gateway() {
        // The Order source place feeds *two* first activities directly (a
        // choice sitting on the boundary). The ▶ marker must still carry a
        // single line: a synthetic XOR-split gateway is spliced in.
        let net = OcpnPayload {
            object_types: vec!["Order".into()],
            places: vec![
                place("src", "Order", InPlaceKind::Source),
                place("pa", "Order", InPlaceKind::Normal),
                place("pb", "Order", InPlaceKind::Normal),
                place("sink", "Order", InPlaceKind::Sink),
            ],
            transitions: vec![
                station("A", "A", &["Order"]),
                station("B", "B", &["Order"]),
            ],
            arcs: vec![
                arc(p("src"), t("A"), "Order"),
                arc(p("src"), t("B"), "Order"),
                arc(t("A"), p("pa"), "Order"),
                arc(t("B"), p("pb"), "Order"),
                arc(p("pa"), p("sink"), "Order"),
                arc(p("pb"), p("sink"), "Order"),
            ],
        };
        let map = build_metro_map(&net);
        let src_id = map
            .nodes
            .iter()
            .find(|n| matches!(n, OutNode::Source { .. }))
            .unwrap()
            .id()
            .to_string();
        let src_out: Vec<_> = map.edges.iter().filter(|e| e.source == src_id).collect();
        assert_eq!(src_out.len(), 1, "source must have exactly one outgoing edge");
        let gw_id = &src_out[0].target;
        assert!(
            map.nodes.iter().any(|n| matches!(n, OutNode::Gateway { id, direction, .. } if id == gw_id && *direction == GatewayDirection::Split)),
            "source's single edge leads to a split gateway",
        );
        // Both first activities are reachable from that gateway.
        let from_gw: HashSet<&str> =
            map.edges.iter().filter(|e| &e.source == gw_id).map(|e| e.target.as_str()).collect();
        assert!(from_gw.contains("transition:A") && from_gw.contains("transition:B"));
    }
}
