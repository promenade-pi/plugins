//! Executable invariants for a finished station map.
//!
//! These exist because looking at a rendered diagram is not a test. Every
//! property here is one that a plausible-looking picture can violate — two
//! routes sharing a line for part of their length, a platform sitting on top
//! of another, a hand-off that does not descend — and each is checked over
//! fixed graphs *and* randomised ones, because a routing heuristic that
//! passes a fixture and fails on the next real log is the normal outcome.
//!
//! `Violation::Excursion` is the second kind of check the metro-map work
//! argued for: satisfying "no overlap" by moving something a long way is not
//! success, so the displacement itself is bounded too, against the diagram's
//! own size rather than an absolute number.

use std::collections::HashMap;
use std::fmt;

use crate::{Line, Point, StationMapPayload};

#[derive(Debug, Clone, PartialEq)]
pub enum Violation {
    /// Two segments of different routes lie on the same line and overlap.
    Overlap {
        a: String,
        b: String,
        axis: &'static str,
        at: f64,
        from: f64,
        to: f64,
    },
    /// A forward hand-off that does not descend.
    NotDescending { source: String, target: String, from: f64, to: f64 },
    /// Two platforms whose discs intersect.
    PlatformCollision { a: String, b: String, gap: f64 },
    /// A route drawn through a platform that is not one of its endpoints.
    ThroughPlatform { line: String, platform: String },
    /// A shaft standing on a platform.
    ShaftCollision { shaft: String, platform: String },
    /// A route that takes a far longer way round than its endpoints justify.
    Excursion { line: String, drawn: f64, direct: f64, budget: f64 },
    /// A platform whose depth is not a finite, non-negative number.
    BadDepth { platform: String, t: f64 },
    /// A segment that is neither horizontal nor vertical.
    ///
    /// Its own defect is small — a hairline diagonal where a right angle was
    /// meant — but it also disables the overlap rule above, which can only
    /// compare axis-aligned segments. A drawing full of near-diagonals would
    /// pass that rule by never being tested by it.
    NotOrthogonal { line: String, at: usize, dx: f64, dz: f64 },
}

impl fmt::Display for Violation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Violation::Overlap { a, b, axis, at, from, to } => write!(
                f,
                "routes {a} and {b} share the {axis} line at {at:.3} over {from:.3}..{to:.3}"
            ),
            Violation::NotDescending { source, target, from, to } => write!(
                f,
                "hand-off {source} -> {target} does not descend ({from} -> {to})"
            ),
            Violation::PlatformCollision { a, b, gap } => {
                write!(f, "platforms {a} and {b} overlap by {gap:.3}")
            }
            Violation::ThroughPlatform { line, platform } => {
                write!(f, "route {line} is drawn through platform {platform}")
            }
            Violation::ShaftCollision { shaft, platform } => {
                write!(f, "shaft {shaft} stands on platform {platform}")
            }
            Violation::Excursion { line, drawn, direct, budget } => write!(
                f,
                "route {line} is drawn {drawn:.2} long for a {direct:.2} hand-off (budget {budget:.2})"
            ),
            Violation::BadDepth { platform, t } => write!(f, "platform {platform} has depth {t}"),
            Violation::NotOrthogonal { line, at, dx, dz } => write!(
                f,
                "route {line} segment {at} is diagonal (dx {dx:.9}, dz {dz:.9})"
            ),
        }
    }
}

/// How close two coordinates have to be to count as the same line.
const SAME: f64 = 1e-6;
/// Overlap shorter than this is a shared endpoint, not a shared track.
const TOUCH: f64 = 1e-6;

pub fn violations(map: &StationMapPayload) -> Vec<Violation> {
    let mut out = Vec::new();
    let time: HashMap<&str, f64> = map.platforms.iter().map(|p| (p.id.as_str(), p.t)).collect();

    for platform in &map.platforms {
        if !platform.t.is_finite() || platform.t < 0.0 {
            out.push(Violation::BadDepth {
                platform: platform.id.clone(),
                t: platform.t,
            });
        }
    }

    // 1. Every forward hand-off descends. Strictly: a route drawn dead level
    //    has no readable direction of travel, and the whole premise is that
    //    depth is elapsed time.
    for line in &map.lines {
        if line.backward || line.self_loop {
            continue;
        }
        let (from, to) = (
            time.get(line.source.as_str()).copied().unwrap_or(0.0),
            time.get(line.target.as_str()).copied().unwrap_or(0.0),
        );
        if !(to > from) {
            out.push(Violation::NotDescending {
                source: line.source.clone(),
                target: line.target.clone(),
                from,
                to,
            });
        }
    }

    // 2. No two routes share a line. Segments of the *same* route bundle are
    //    excluded only when they are literally the same drawn line; two
    //    different object types on one hand-off run on their own tracks and
    //    are held to the rule like everything else.
    let mut segments: Vec<(usize, Point, Point)> = Vec::new();
    for (index, line) in map.lines.iter().enumerate() {
        for (at, pair) in line.points.windows(2).enumerate() {
            let (dx, dz) = (pair[1].x - pair[0].x, pair[1].z - pair[0].z);
            if dx.abs() >= SAME && dz.abs() >= SAME {
                out.push(Violation::NotOrthogonal {
                    line: line.id.clone(),
                    at,
                    dx,
                    dz,
                });
            }
            segments.push((index, pair[0], pair[1]));
        }
    }
    for i in 0..segments.len() {
        for j in (i + 1)..segments.len() {
            let (li, a0, a1) = segments[i];
            let (lj, b0, b1) = segments[j];
            if li == lj {
                continue;
            }
            if let Some(v) = collinear_overlap(&map.lines[li], &map.lines[lj], a0, a1, b0, b1) {
                out.push(v);
            }
        }
    }

    // 3. Platforms are discs on a plan and may not intersect.
    for i in 0..map.platforms.len() {
        for j in (i + 1)..map.platforms.len() {
            let (a, b) = (&map.platforms[i], &map.platforms[j]);
            let distance = ((a.x - b.x).powi(2) + (a.z - b.z).powi(2)).sqrt();
            let gap = a.radius + b.radius - distance;
            if gap > 1e-6 {
                out.push(Violation::PlatformCollision {
                    a: a.id.clone(),
                    b: b.id.clone(),
                    gap,
                });
            }
        }
    }

    // 4. A route may end at a platform; it may not be drawn across one.
    for line in &map.lines {
        for platform in &map.platforms {
            if platform.id == line.source || platform.id == line.target {
                continue;
            }
            let hit = line.points.windows(2).any(|pair| {
                segment_disc_distance(pair[0], pair[1], platform.x, platform.z)
                    < platform.radius - 1e-6
            });
            if hit {
                out.push(Violation::ThroughPlatform {
                    line: line.id.clone(),
                    platform: platform.id.clone(),
                });
            }
        }
    }

    // 5. A shaft is a solid object standing in a corridor, not on a platform.
    for shaft in &map.shafts {
        for platform in &map.platforms {
            let distance = ((shaft.x - platform.x).powi(2) + (shaft.z - platform.z).powi(2)).sqrt();
            if distance < shaft.radius + platform.radius - 1e-6 {
                out.push(Violation::ShaftCollision {
                    shaft: shaft.id.clone(),
                    platform: platform.id.clone(),
                });
            }
        }
    }

    // 6. The displacement bound. Overlap-freedom bought by sending a route
    //    the long way round the diagram is not overlap-freedom worth having.
    let scale = map.extent.x.abs() + map.extent.z.abs();
    let position: HashMap<&str, (f64, f64)> = map
        .platforms
        .iter()
        .map(|p| (p.id.as_str(), (p.x, p.z)))
        .collect();
    for line in &map.lines {
        if line.self_loop {
            continue;
        }
        let (Some(a), Some(b)) = (
            position.get(line.source.as_str()),
            position.get(line.target.as_str()),
        ) else {
            continue;
        };
        let direct = (a.0 - b.0).abs() + (a.1 - b.1).abs();
        let drawn: f64 = line
            .points
            .windows(2)
            .map(|p| (p[0].x - p[1].x).abs() + (p[0].z - p[1].z).abs())
            .sum();
        // Rework is drawn out and back, so its own budget is the round trip.
        let budget = direct * if line.backward { 2.6 } else { 1.35 } + 0.30 * scale;
        if drawn > budget {
            out.push(Violation::Excursion {
                line: line.id.clone(),
                drawn,
                direct,
                budget,
            });
        }
    }

    out
}

fn collinear_overlap(
    a: &Line,
    b: &Line,
    a0: Point,
    a1: Point,
    b0: Point,
    b1: Point,
) -> Option<Violation> {
    let horizontal = |p: Point, q: Point| (p.z - q.z).abs() < SAME;
    let vertical = |p: Point, q: Point| (p.x - q.x).abs() < SAME;

    if horizontal(a0, a1) && horizontal(b0, b1) && (a0.z - b0.z).abs() < SAME {
        let (lo, hi) = span(a0.x, a1.x, b0.x, b1.x)?;
        return Some(Violation::Overlap {
            a: a.id.clone(),
            b: b.id.clone(),
            axis: "z",
            at: a0.z,
            from: lo,
            to: hi,
        });
    }
    if vertical(a0, a1) && vertical(b0, b1) && (a0.x - b0.x).abs() < SAME {
        let (lo, hi) = span(a0.z, a1.z, b0.z, b1.z)?;
        return Some(Violation::Overlap {
            a: a.id.clone(),
            b: b.id.clone(),
            axis: "x",
            at: a0.x,
            from: lo,
            to: hi,
        });
    }
    None
}

fn span(a0: f64, a1: f64, b0: f64, b1: f64) -> Option<(f64, f64)> {
    let lo = a0.min(a1).max(b0.min(b1));
    let hi = a0.max(a1).min(b0.max(b1));
    if hi - lo > TOUCH {
        Some((lo, hi))
    } else {
        None
    }
}

fn segment_disc_distance(a: Point, b: Point, cx: f64, cz: f64) -> f64 {
    let (dx, dz) = (b.x - a.x, b.z - a.z);
    let len2 = dx * dx + dz * dz;
    let t = if len2 < 1e-12 {
        0.0
    } else {
        (((cx - a.x) * dx + (cz - a.z) * dz) / len2).clamp(0.0, 1.0)
    };
    let (px, pz) = (a.x + dx * t, a.z + dz * t);
    ((px - cx).powi(2) + (pz - cz).powi(2)).sqrt()
}
