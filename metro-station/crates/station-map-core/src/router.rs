//! The orthogonal router.
//!
//! Route overlap is a *global* property of a drawing, so nothing here repairs
//! it locally. Every horizontal run and every lateral move is allocated a
//! track in one shared occupancy model for the corridor it uses, and two
//! things that share a corridor and overlap along it are given different
//! tracks by construction. What is left over — routes *crossing* each other —
//! is not a defect: a metro map crosses lines all the time, and the view draws
//! those as bridges.
//!
//! Three facts make the allocation simple enough to be trustworthy:
//!
//!  * Long hand-offs are split by **dummy nodes**, one per rank they cross, and
//!    the dummies take part in the lane ordering. So a horizontal run never
//!    passes over a platform that is not one of its own endpoints — that is
//!    structural, not checked.
//!  * A platform's *fan* — every route attached to it on one side — is
//!    allocated inside the platform's own disc, and the disc is then grown to
//!    whatever the fan needs. A busy interchange is a bigger platform, which is
//!    the grammar anyway.
//!  * Every segment registers its lateral move as a band item, even a hairline
//!    one, so two routes stepping sideways by a hair at the same column cannot
//!    land on the same line.

use std::collections::HashMap;

use crate::{
    Line, PlanNode, Point, Shaft, BAND_GAP, LINE_PITCH, PLATFORM_CLEAR, R_MIN, SHAFT_MIN_RADIUS,
};

#[derive(Debug, Clone)]
pub struct LineSpec {
    pub object_type: String,
    /// Position in the payload's object-type order; parallel tracks keep it,
    /// so the same type is on the same side of a bundle everywhere.
    pub order: usize,
    pub freq: f64,
    pub wait_secs: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct LinkSpec {
    pub source: String,
    pub target: String,
    pub backward: bool,
    pub self_loop: bool,
    pub freq: f64,
    pub wait_secs: Option<f64>,
    pub critical: bool,
    pub lines: Vec<LineSpec>,
}

/// One hand-off's node sequence in rank order, dummies included.
#[derive(Debug, Clone)]
pub struct Chain {
    pub link: usize,
    /// Left to right in rank space. A same-rank hand-off (only rework can be
    /// one) and a self-loop both have two entries at the same rank, and are
    /// drawn as a U-turn out of the right-hand side.
    pub nodes: Vec<String>,
    pub u_turn: bool,
}

pub struct Routed {
    pub position: HashMap<String, Point>,
    pub radius: HashMap<String, f64>,
    pub lines: Vec<Line>,
    pub shafts: Vec<Shaft>,
    pub extent: Point,
}

/// A claim on a corridor: `lo..hi` along it, `width` across it.
#[derive(Debug, Clone)]
struct Claim {
    lo: f64,
    hi: f64,
    width: f64,
    /// Stable tie-break, and how the caller finds its answer again.
    key: usize,
    /// Lower sorts nearer the corridor's first track; used by fans to keep a
    /// route heading "up" on the up side of the bundle.
    rank_key: i64,
}

/// Centre offsets for a set of claims on one corridor.
///
/// Interval-graph colouring with variable band widths: claims are placed in
/// order and each takes the lowest offset whose band clears every already
/// placed claim it actually overlaps. Non-overlap is therefore a property of
/// the construction, and the result is centred so a corridor with nothing to
/// avoid does not drift off its nominal line.
fn allocate(claims: &[Claim]) -> HashMap<usize, f64> {
    let mut sorted: Vec<&Claim> = claims.iter().collect();
    sorted.sort_by(|a, b| {
        a.rank_key
            .cmp(&b.rank_key)
            .then_with(|| a.lo.partial_cmp(&b.lo).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| a.key.cmp(&b.key))
    });

    let mut placed: Vec<(f64, f64, f64, f64)> = Vec::new(); // lo, hi, start, end
    let mut out: HashMap<usize, f64> = HashMap::new();
    for claim in &sorted {
        let mut candidates: Vec<f64> = vec![0.0];
        for (lo, hi, _, end) in &placed {
            if overlaps(claim.lo, claim.hi, *lo, *hi) {
                candidates.push(end + BAND_GAP);
            }
        }
        candidates.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mut chosen = 0.0;
        for candidate in candidates {
            let (s, e) = (candidate, candidate + claim.width);
            let clear = placed.iter().all(|(lo, hi, ps, pe)| {
                !overlaps(claim.lo, claim.hi, *lo, *hi) || !overlaps(s, e, ps - BAND_GAP, pe + BAND_GAP)
            });
            if clear {
                chosen = candidate;
                break;
            }
        }
        placed.push((claim.lo, claim.hi, chosen, chosen + claim.width));
        out.insert(claim.key, chosen + claim.width / 2.0);
    }

    if placed.is_empty() {
        return out;
    }

    // Centred per *group*, not per corridor.
    //
    // A corridor spans the whole diagram, and one crowded stretch of it must
    // not drag the quiet stretches off their own centre line — which is what a
    // single global shift does. It moves a claim that had nothing to avoid,
    // and downstream that grows a platform's disc to cover an offset it never
    // needed, until the disc reaches across a corridor it has no business in.
    // Claims in different groups do not overlap along the corridor by
    // definition, so centring them independently cannot create an overlap.
    let mut group: Vec<usize> = (0..placed.len()).collect();
    fn root(group: &mut Vec<usize>, mut i: usize) -> usize {
        while group[i] != i {
            group[i] = group[group[i]];
            i = group[i];
        }
        i
    }
    for i in 0..placed.len() {
        for j in (i + 1)..placed.len() {
            if overlaps(placed[i].0, placed[i].1, placed[j].0, placed[j].1) {
                let (a, b) = (root(&mut group, i), root(&mut group, j));
                if a != b {
                    group[a] = b;
                }
            }
        }
    }
    let mut span: HashMap<usize, (f64, f64)> = HashMap::new();
    for i in 0..placed.len() {
        let key = root(&mut group, i);
        let entry = span.entry(key).or_insert((f64::INFINITY, f64::NEG_INFINITY));
        entry.0 = entry.0.min(placed[i].2);
        entry.1 = entry.1.max(placed[i].3);
    }
    for (i, claim) in sorted.iter().enumerate() {
        let key = root(&mut group, i);
        let (lo, hi) = span[&key];
        if let Some(value) = out.get_mut(&claim.key) {
            *value += -(lo + hi) / 2.0;
        }
    }
    out
}

fn overlaps(a0: f64, a1: f64, b0: f64, b1: f64) -> bool {
    a0 < b1 - 1e-9 && b0 < a1 - 1e-9
}

pub fn route(
    plan: &[PlanNode],
    chains: &[Chain],
    links: &[LinkSpec],
    rank_of: &HashMap<String, i32>,
    lane_of: &HashMap<String, i32>,
) -> Routed {
    let width_of = |chain: &Chain| links[chain.link].lines.len() as f64 * LINE_PITCH;
    let lane = |id: &str| lane_of.get(id).copied().unwrap_or(0);
    let rank = |id: &str| rank_of.get(id).copied().unwrap_or(0);

    // ------------------------------------------------- 1. the lateral moves
    // Claimed in *lane index* space, not in plan units, so that the columns
    // can be spaced before the rows are — which is what breaks the circular
    // dependency between the two pitches. Half a lane of padding at each end
    // covers wherever inside its own lane a route ends up sitting.
    // An upper bound on how large each platform's disc can end up.
    //
    // The disc is grown later to hold whatever the row allocation attaches to
    // it, and the column spacing below has to leave room for that — but the
    // row allocation needs the column positions, so the real figure is not
    // available yet. The total width of everything incident to the node is a
    // bound on it that needs nothing, and being generous here costs a little
    // width in a place that has traffic to justify it.
    let mut incident: HashMap<&str, f64> = HashMap::new();
    for chain in chains {
        let width = width_of(chain) + BAND_GAP;
        for end in [chain.nodes.first(), chain.nodes.last()].into_iter().flatten() {
            *incident.entry(end.as_str()).or_insert(0.0) += width;
        }
    }
    let mut rank_bound: HashMap<i32, f64> = HashMap::new();
    for node in plan {
        let bound = node
            .radius
            .max(incident.get(node.id.as_str()).copied().unwrap_or(0.0) / 2.0 + LINE_PITCH * 0.9);
        let entry = rank_bound.entry(node.rank).or_insert(R_MIN);
        *entry = entry.max(bound);
    }

    let mut band_claims: HashMap<i32, Vec<Claim>> = HashMap::new();
    let mut band_key: HashMap<(usize, usize), (i32, usize)> = HashMap::new();
    let mut counter = 0usize;
    for (index, chain) in chains.iter().enumerate() {
        let width = width_of(chain);
        let steps = if chain.u_turn { 1 } else { chain.nodes.len().saturating_sub(1) };
        for step in 0..steps {
            let a = &chain.nodes[step];
            let b = &chain.nodes[step + 1];
            let (la, lb) = (lane(a) as f64, lane(b) as f64);
            let column = rank(a);
            let key = counter;
            counter += 1;
            band_claims.entry(column).or_default().push(Claim {
                lo: la.min(lb) - 0.5,
                hi: la.max(lb) + 0.5,
                width,
                key,
                rank_key: (la.min(lb) * 4.0) as i64,
            });
            band_key.insert((index, step), (column, key));
        }
    }

    let mut band_offset: HashMap<i32, HashMap<usize, f64>> = HashMap::new();
    // Per column, not one global maximum. Spacing every rank boundary for the
    // busiest one turns a ten-platform map into forty plan units of mostly
    // empty corridor, and a route drawn at its honest width then arrives on
    // screen as a hairline — which is exactly how the first run against a real
    // log looked.
    let mut band_half: HashMap<i32, f64> = HashMap::new();
    for (column, claims) in &band_claims {
        let placed = allocate(claims);
        let entry = band_half.entry(*column).or_insert(0.0);
        for claim in claims {
            if let Some(offset) = placed.get(&claim.key) {
                *entry = entry.max(offset.abs() + claim.width / 2.0);
            }
        }
        band_offset.insert(*column, placed);
    }

    /// Room past the band's own extent for a shaft standing at its edge.
    const SHAFT_MARGIN: f64 = SHAFT_MIN_RADIUS;
    let ranks: Vec<i32> = {
        let mut all: Vec<i32> = plan.iter().map(|n| n.rank).collect();
        all.extend(band_claims.keys().copied());
        all.extend(band_claims.keys().map(|r| r + 1));
        all.sort_unstable();
        all.dedup();
        all
    };
    let mut rank_at: HashMap<i32, f64> = HashMap::new();
    let mut cursor = 0.0_f64;
    for (i, r) in ranks.iter().enumerate() {
        if i > 0 {
            let previous = ranks[i - 1];
            // Whatever the widest lateral move at this boundary needs, plus
            // room for a disc on either side of it.
            let widest = (previous..*r)
                .map(|k| band_half.get(&k).copied().unwrap_or(0.0))
                .fold(0.0_f64, f64::max);
            // Symmetric about the band's centre, using the larger of the two
            // ranks' discs on both sides, so the midpoint really is far enough
            // from each of them.
            let disc = rank_bound
                .get(&previous)
                .copied()
                .unwrap_or(R_MIN)
                .max(rank_bound.get(r).copied().unwrap_or(R_MIN));
            cursor += 2.0 * (widest + SHAFT_MARGIN + disc + PLATFORM_CLEAR);
        }
        rank_at.insert(*r, cursor);
    }
    let rank_x = |r: i32| -> f64 {
        rank_at.get(&r).copied().unwrap_or_else(|| {
            // A rank nothing was placed at cannot be interpolated meaningfully;
            // fall back to the mean pitch so the value is at least ordered.
            let span = cursor.max(1.0);
            let count = (ranks.len().max(2) - 1) as f64;
            r as f64 * (span / count)
        })
    };
    let band_x = |chain: usize, step: usize| -> f64 {
        match band_key.get(&(chain, step)) {
            Some((column, key)) => {
                let offset = band_offset
                    .get(column)
                    .and_then(|m| m.get(key))
                    .copied()
                    .unwrap_or(0.0);
                (rank_x(*column) + rank_x(column + 1)) / 2.0 + offset
            }
            None => 0.0,
        }
    };

    // ----------------------------------------------- 2. the horizontal runs
    // One corridor per lane, spanning the whole diagram. Defining it that way
    // rather than per half-column is the difference between "no two routes
    // share a line" being true and being nearly true: a route's turn happens
    // at its own allocated column offset, so the point where one route's run
    // ends is *not* where another's begins, and two half-corridors that were
    // assumed to meet cleanly in fact overlap by that difference.
    let mut row_claims: HashMap<i32, Vec<Claim>> = HashMap::new();
    // (chain, node index) -> claim key
    let mut row_key: HashMap<(usize, usize), (i32, usize)> = HashMap::new();
    counter = 0;
    for (index, chain) in chains.iter().enumerate() {
        let width = width_of(chain);
        let last = chain.nodes.len() - 1;
        for (i, node) in chain.nodes.iter().enumerate() {
            let (from, to) = if chain.u_turn {
                (rank_x(rank(node)), band_x(index, 0))
            } else {
                (
                    if i == 0 { rank_x(rank(node)) } else { band_x(index, i - 1) },
                    if i == last { rank_x(rank(node)) } else { band_x(index, i) },
                )
            };
            // Ordered by where the run is heading laterally, so a bundle
            // fanning out of a platform keeps the route going "up" on the
            // upper side and does not cross itself at the very first turn.
            let heading = if i < last {
                lane(&chain.nodes[i + 1])
            } else if last > 0 {
                lane(&chain.nodes[i - 1])
            } else {
                lane(node)
            };
            let key = counter;
            counter += 1;
            row_claims.entry(lane(node)).or_default().push(Claim {
                lo: from.min(to),
                hi: from.max(to),
                width,
                key,
                rank_key: heading as i64 * 1000 + i as i64,
            });
            row_key.insert((index, i), (lane(node), key));
        }
    }

    let mut row_offset: HashMap<i32, HashMap<usize, f64>> = HashMap::new();
    let mut lane_spread: HashMap<i32, f64> = HashMap::new();
    for (row, claims) in &row_claims {
        let placed = allocate(claims);
        let entry = lane_spread.entry(*row).or_insert(0.0);
        for claim in claims {
            if let Some(offset) = placed.get(&claim.key) {
                *entry = entry.max(offset.abs() + claim.width / 2.0 + LINE_PITCH * 0.9);
            }
        }
        row_offset.insert(*row, placed);
    }
    let offset_of = |chain: usize, node: usize| -> f64 {
        row_key
            .get(&(chain, node))
            .and_then(|(row, key)| row_offset.get(row).and_then(|m| m.get(key)).copied())
            .unwrap_or(0.0)
    };

    // A disc has to hold everything attached to it: a busy interchange grows
    // rather than sprouting routes from thin air beside itself.
    let mut radius: HashMap<String, f64> = HashMap::new();
    for node in plan {
        radius.insert(node.id.clone(), node.radius);
    }
    for (index, chain) in chains.iter().enumerate() {
        for (i, node) in chain.nodes.iter().enumerate() {
            if let Some(entry) = radius.get_mut(node) {
                let needed = offset_of(index, i).abs()
                    + width_of(chain) / 2.0
                    + LINE_PITCH * 0.9;
                if needed > *entry {
                    *entry = needed;
                }
            }
        }
    }
    for node in plan {
        let entry = lane_spread.entry(node.lane).or_insert(0.0);
        *entry = entry.max(radius.get(&node.id).copied().unwrap_or(node.radius));
    }

    // Lanes are spaced by what they actually hold, so one crowded corridor
    // does not push every other lane apart with it.
    let mut lanes: Vec<i32> = lane_spread.keys().copied().collect();
    lanes.sort();
    let mut lane_z: HashMap<i32, f64> = HashMap::new();
    let mut cursor = 0.0_f64;
    for (i, row) in lanes.iter().enumerate() {
        if i > 0 {
            cursor += lane_spread[&lanes[i - 1]] + lane_spread[row] + 2.0 * PLATFORM_CLEAR;
        }
        lane_z.insert(*row, cursor);
    }
    // Centred on lane zero, which the ordering pass already centred the graph
    // on, so the plan is symmetric about the origin rather than about lane 0's
    // accumulated position.
    let zero = lane_z.get(&0).copied().unwrap_or(0.0);
    for value in lane_z.values_mut() {
        *value -= zero;
    }
    let z_of = |chain: usize, node_index: usize, node: &str| -> f64 {
        lane_z.get(&lane(node)).copied().unwrap_or(0.0) + offset_of(chain, node_index)
    };

    // -------------------------------------------------------- 3. polylines
    let position: HashMap<String, Point> = plan
        .iter()
        .map(|n| {
            (
                n.id.clone(),
                Point {
                    x: rank_x(n.rank),
                    z: lane_z.get(&n.lane).copied().unwrap_or(0.0),
                },
            )
        })
        .collect();

    let mut out_lines: Vec<Line> = Vec::new();
    let mut shafts: Vec<Shaft> = Vec::new();
    let time_of: HashMap<&str, f64> = plan.iter().map(|n| (n.id.as_str(), n.t)).collect();

    for (index, chain) in chains.iter().enumerate() {
        let link = &links[chain.link];
        let mut centre: Vec<Point> = Vec::new();
        let last = chain.nodes.len() - 1;

        centre.push(Point {
            x: rank_x(rank(&chain.nodes[0])),
            z: z_of(index, 0, &chain.nodes[0]),
        });
        let steps = if chain.u_turn { 1 } else { last };
        for step in 0..steps {
            let bx = band_x(index, step);
            centre.push(Point { x: bx, z: z_of(index, step, &chain.nodes[step]) });
            centre.push(Point { x: bx, z: z_of(index, step + 1, &chain.nodes[step + 1]) });
        }
        centre.push(Point {
            x: rank_x(rank(&chain.nodes[last])),
            z: z_of(index, last, &chain.nodes[last]),
        });

        // Laid out left to right in rank space whichever way it is drawn; a
        // hand-off that runs against process order is simply reversed at the
        // end, which keeps rework on the same track system as everything else
        // instead of in a return channel of its own.
        if chain.nodes[0] != link.source {
            centre.reverse();
        }
        // The drop is always the corner immediately before the target: the
        // route travels at the source's depth, steps down, and arrives. It is
        // protected from the tidy-up, because on a straight one-rank hand-off
        // it is a vertex in the middle of a straight run and would otherwise
        // be collapsed away — taking the shaft down onto the platform with it.
        let keep = centre.len().saturating_sub(2);
        let (centre, drop_at) = dedupe(centre, keep);

        let t_top = time_of.get(link.source.as_str()).copied().unwrap_or(0.0);
        let t_bottom = time_of.get(link.target.as_str()).copied().unwrap_or(0.0);

        let n = link.lines.len() as f64;
        for (i, spec) in link.lines.iter().enumerate() {
            let d = (i as f64 - (n - 1.0) / 2.0) * LINE_PITCH;
            out_lines.push(Line {
                id: format!("{}>{}|{}", link.source, link.target, spec.object_type),
                link: format!("{}>{}", link.source, link.target),
                object_type: spec.object_type.clone(),
                source: link.source.clone(),
                target: link.target.clone(),
                freq: spec.freq,
                wait_secs: spec.wait_secs,
                backward: link.backward,
                self_loop: link.self_loop,
                critical: link.critical,
                points: offset_polyline(&centre, d),
                drop_at,
            });
        }

        if !link.self_loop && centre.len() >= 2 {
            let at = centre[drop_at];
            shafts.push(Shaft {
                id: format!("shaft:{}>{}", link.source, link.target),
                link: format!("{}>{}", link.source, link.target),
                x: at.x,
                z: at.z,
                radius: (n * LINE_PITCH / 2.0 + LINE_PITCH * 0.6).max(SHAFT_MIN_RADIUS),
                source: link.source.clone(),
                target: link.target.clone(),
                t_top,
                t_bottom,
                wait_secs: link.wait_secs,
                critical: link.critical,
                backward: link.backward,
                object_types: link.lines.iter().map(|l| l.object_type.clone()).collect(),
                freq: link.freq,
            });
        }
    }

    let mut extent = Point { x: 1.0, z: 1.0 };
    for (id, p) in &position {
        let r = radius.get(id).copied().unwrap_or(R_MIN);
        extent.x = extent.x.max(p.x.abs() + r);
        extent.z = extent.z.max(p.z.abs() + r);
    }
    for line in &out_lines {
        for p in &line.points {
            extent.x = extent.x.max(p.x.abs());
            extent.z = extent.z.max(p.z.abs());
        }
    }

    Routed {
        position,
        radius,
        lines: out_lines,
        shafts,
        extent,
    }
}

/// Drops repeated vertices and vertices in the middle of a straight run.
///
/// The straight-run half matters for more than tidiness: a route crossing
/// three ranks in one lane arrives here as five collinear vertices, and every
/// one of them would become a bend in the view's chamfering and a step in its
/// flow animation.
fn dedupe(points: Vec<Point>, keep: usize) -> (Vec<Point>, usize) {
    let mut out: Vec<Point> = Vec::with_capacity(points.len());
    let mut kept = 0usize;
    for (i, p) in points.into_iter().enumerate() {
        match out.last() {
            Some(q) if (q.x - p.x).abs() < 1e-9 && (q.z - p.z).abs() < 1e-9 => {
                if i == keep {
                    kept = out.len() - 1;
                }
            }
            _ => {
                if i == keep {
                    kept = out.len();
                }
                out.push(p);
            }
        }
    }
    if out.len() < 3 {
        let at = kept.min(out.len().saturating_sub(1));
        return (out, at);
    }
    let mut collapsed: Vec<Point> = vec![out[0]];
    let mut moved = if kept == 0 { 0 } else { usize::MAX };
    for i in 1..out.len() - 1 {
        let (a, b, c) = (collapsed[collapsed.len() - 1], out[i], out[i + 1]);
        let cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
        if cross.abs() > 1e-9 || i == kept {
            if i == kept {
                moved = collapsed.len();
            }
            collapsed.push(b);
        }
    }
    if kept == out.len() - 1 {
        moved = collapsed.len();
    }
    collapsed.push(out[out.len() - 1]);
    let last = collapsed.len() - 1;
    (collapsed, if moved == usize::MAX { last.saturating_sub(1) } else { moved })
}

/// The polyline `d` to the left of the travel direction, vertex for vertex.
///
/// Vertex count is preserved deliberately: `drop_at` is an index into the
/// centre line, and every parallel track has to drop at the same corner or a
/// bundle would come apart at the shaft.
fn offset_polyline(points: &[Point], d: f64) -> Vec<Point> {
    if d.abs() < 1e-12 || points.len() < 2 {
        return points.to_vec();
    }
    let normal = |a: &Point, b: &Point| -> (f64, f64) {
        let (dx, dz) = (b.x - a.x, b.z - a.z);
        let len = (dx * dx + dz * dz).sqrt();
        if len < 1e-12 {
            (0.0, 0.0)
        } else {
            (-dz / len, dx / len)
        }
    };
    let mut out: Vec<Point> = Vec::with_capacity(points.len());
    for i in 0..points.len() {
        let before = if i == 0 { None } else { Some(normal(&points[i - 1], &points[i])) };
        let after = if i + 1 == points.len() {
            None
        } else {
            Some(normal(&points[i], &points[i + 1]))
        };
        let (nx, nz) = match (before, after) {
            (Some(a), Some(b)) => {
                // Miter: the intersection of the two offset lines. For the
                // right angles this router produces that is exactly the
                // corner, and the general form costs nothing.
                let (mx, mz) = (a.0 + b.0, a.1 + b.1);
                let len = (mx * mx + mz * mz).sqrt();
                if len < 1e-9 {
                    a
                } else {
                    let scale = 1.0 / (len / 2.0).max(0.35);
                    (mx / len * scale, mz / len * scale)
                }
            }
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => (0.0, 0.0),
        };
        out.push(Point {
            x: points[i].x + nx * d,
            z: points[i].z + nz * d,
        });
    }
    out
}
