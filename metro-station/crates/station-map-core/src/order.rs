//! Lateral order: which lane each platform sits in.
//!
//! Two stages, the standard layered-drawing pair. Barycentre sweeps decide the
//! *order* within each rank, which is what removes crossings; an isotonic
//! projection then decides the *coordinates*, which is what makes a route that
//! could be straight actually be straight.
//!
//! The projection is order-preserving by construction rather than by repair:
//! subtracting the index turns "strictly increasing with a gap of at least one
//! lane" into plain "non-decreasing", pool-adjacent-violators solves that
//! exactly, and adding the index back restores the gap. So no pass can ever
//! swap two platforms in a rank behind the crossing-minimisation's back, and
//! every platform ends up at the lane closest to its neighbours' median that
//! its own rank's order leaves available.

use std::collections::HashMap;

const SWEEPS: usize = 6;
const RELAXATIONS: usize = 8;

pub fn assign_lanes(
    ids: &[String],
    rank_of: &HashMap<String, i32>,
    forward: &HashMap<String, Vec<String>>,
    pairs: &[(String, String)],
    // How hard each node resists being moved off the lane its neighbours want
    // for it. The dummies that stand in for a hand-off spanning several ranks
    // are given the larger say, because a bend in one of those is a bend in a
    // route, while a real platform's own lane is arbitrary.
    weight: &HashMap<String, f64>,
) -> HashMap<String, i32> {
    let weight_of = |id: &str| weight.get(id).copied().unwrap_or(1.0);
    let max_rank = ids.iter().map(|id| rank_of[id]).max().unwrap_or(0);
    let mut ranks: Vec<Vec<String>> = vec![Vec::new(); (max_rank + 1) as usize];
    // Seeded by a depth-first walk from the sources, so a plain chain starts
    // out already straight and the sweeps have nothing to undo.
    for id in seed_order(ids, rank_of, forward) {
        ranks[rank_of[&id] as usize].push(id);
    }

    let mut neighbours: HashMap<&str, Vec<&str>> = HashMap::new();
    for (s, t) in pairs {
        if s == t {
            continue;
        }
        neighbours.entry(s.as_str()).or_default().push(t.as_str());
        neighbours.entry(t.as_str()).or_default().push(s.as_str());
    }

    // ------------------------------------------------------------- ordering
    let mut position: HashMap<String, f64> = HashMap::new();
    for layer in &ranks {
        for (i, id) in layer.iter().enumerate() {
            position.insert(id.clone(), i as f64);
        }
    }
    for sweep in 0..SWEEPS {
        let indices: Vec<usize> = if sweep % 2 == 0 {
            (0..ranks.len()).collect()
        } else {
            (0..ranks.len()).rev().collect()
        };
        for r in indices {
            let layer = &mut ranks[r];
            let mut scored: Vec<(f64, String)> = layer
                .iter()
                .enumerate()
                .map(|(i, id)| {
                    let mine = neighbours.get(id.as_str());
                    let bary = match mine {
                        Some(ns) if !ns.is_empty() => {
                            // Only neighbours in a *different* rank inform the
                            // barycentre; a same-rank neighbour's position is
                            // the very thing being decided.
                            let vals: Vec<f64> = ns
                                .iter()
                                .filter(|n| rank_of[**n] != r as i32)
                                .filter_map(|n| position.get(*n).copied())
                                .collect();
                            if vals.is_empty() {
                                i as f64
                            } else {
                                vals.iter().sum::<f64>() / vals.len() as f64
                            }
                        }
                        _ => i as f64,
                    };
                    (bary, id.clone())
                })
                .collect();
            scored.sort_by(|a, b| {
                a.0.partial_cmp(&b.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.1.cmp(&b.1))
            });
            *layer = scored.into_iter().map(|(_, id)| id).collect();
            for (i, id) in layer.iter().enumerate() {
                position.insert(id.clone(), i as f64);
            }
        }
    }

    // ---------------------------------------------------------- coordinates
    let mut lane: HashMap<String, f64> = HashMap::new();
    for layer in &ranks {
        let half = (layer.len() as f64 - 1.0) / 2.0;
        for (i, id) in layer.iter().enumerate() {
            lane.insert(id.clone(), i as f64 - half);
        }
    }
    for _ in 0..RELAXATIONS {
        for layer in &ranks {
            if layer.is_empty() {
                continue;
            }
            let desired: Vec<f64> = layer
                .iter()
                .map(|id| match neighbours.get(id.as_str()) {
                    Some(ns) if !ns.is_empty() => {
                        let mut vals: Vec<f64> = ns
                            .iter()
                            .filter(|n| rank_of[**n] != rank_of[id])
                            .filter_map(|n| lane.get(*n).copied())
                            .collect();
                        if vals.is_empty() {
                            lane[id]
                        } else {
                            vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
                            median(&vals)
                        }
                    }
                    _ => lane[id],
                })
                .collect();
            let weights: Vec<f64> = layer.iter().map(|id| weight_of(id)).collect();
            let placed = isotonic_with_gap(&desired, &weights);
            for (id, value) in layer.iter().zip(placed) {
                lane.insert(id.clone(), value);
            }
        }
    }

    // Snap to whole lanes, then re-separate: rounding can collide two
    // platforms that the continuous solution had a hair apart.
    let mut out: HashMap<String, i32> = HashMap::new();
    for layer in &ranks {
        let weights: Vec<f64> = layer.iter().map(|id| weight_of(id)).collect();
        let rounded: Vec<f64> = layer.iter().map(|id| lane[id].round()).collect();
        for (id, value) in layer.iter().zip(isotonic_with_gap(&rounded, &weights)) {
            out.insert(id.clone(), value.round() as i32);
        }
    }
    out
}

fn median(sorted: &[f64]) -> f64 {
    let n = sorted.len();
    if n == 0 {
        0.0
    } else if n % 2 == 1 {
        sorted[n / 2]
    } else {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    }
}

fn seed_order(
    ids: &[String],
    rank_of: &HashMap<String, i32>,
    forward: &HashMap<String, Vec<String>>,
) -> Vec<String> {
    let mut roots: Vec<&String> = ids.iter().filter(|id| rank_of[*id] == 0).collect();
    roots.sort();
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    let mut stack: Vec<&str> = roots.iter().rev().map(|s| s.as_str()).collect();
    while let Some(v) = stack.pop() {
        if !seen.insert(v) {
            continue;
        }
        out.push(v.to_string());
        if let Some(ts) = forward.get(v) {
            let mut next: Vec<&str> = ts.iter().map(|s| s.as_str()).collect();
            next.sort();
            for t in next.into_iter().rev() {
                if !seen.contains(t) {
                    stack.push(t);
                }
            }
        }
    }
    for id in ids {
        if seen.insert(id.as_str()) {
            out.push(id.clone());
        }
    }
    out
}

/// The nearest sequence to `desired` that increases by at least one per step.
///
/// Exact, not iterative: `y[i] - i` turns the gap constraint into plain
/// monotonicity, and pool-adjacent-violators is the least-squares isotonic
/// solution. Centred afterwards so a rank with no reason to lean does not.
fn isotonic_with_gap(desired: &[f64], weights: &[f64]) -> Vec<f64> {
    let n = desired.len();
    if n == 0 {
        return Vec::new();
    }
    let shifted: Vec<f64> = desired.iter().enumerate().map(|(i, v)| v - i as f64).collect();

    // Pools of (weighted sum, weight); merged while the previous pool's mean
    // exceeds this one's, which is exactly PAVA for a non-decreasing fit.
    let mut sums: Vec<f64> = Vec::with_capacity(n);
    let mut counts: Vec<f64> = Vec::with_capacity(n);
    let mut sizes: Vec<usize> = Vec::with_capacity(n);
    for (i, value) in shifted.iter().enumerate() {
        let w = weights.get(i).copied().unwrap_or(1.0).max(1e-6);
        sums.push(*value * w);
        counts.push(w);
        sizes.push(1);
        while sums.len() > 1 {
            let last = sums.len() - 1;
            if sums[last - 1] / counts[last - 1] <= sums[last] / counts[last] {
                break;
            }
            let (s, c, z) = (sums.pop().unwrap(), counts.pop().unwrap(), sizes.pop().unwrap());
            let end = sums.len() - 1;
            sums[end] += s;
            counts[end] += c;
            sizes[end] += z;
        }
    }
    let mut fitted: Vec<f64> = Vec::with_capacity(n);
    for ((s, c), z) in sums.iter().zip(&counts).zip(&sizes) {
        let mean = s / c;
        for _ in 0..*z {
            fitted.push(mean);
        }
    }
    let mut out: Vec<f64> = fitted
        .iter()
        .enumerate()
        .map(|(i, v)| v + i as f64)
        .collect();
    // Re-centred by the same weights the fit used, so a rank containing one
    // through-route and one ordinary platform moves the platform rather than
    // putting a kink in the route.
    let total: f64 = weights.iter().take(n).map(|w| w.max(1e-6)).sum();
    let centre: f64 = out
        .iter()
        .enumerate()
        .map(|(i, v)| v * weights.get(i).copied().unwrap_or(1.0).max(1e-6))
        .sum::<f64>()
        / total.max(1e-6);
    let wanted: f64 = desired
        .iter()
        .enumerate()
        .map(|(i, v)| v * weights.get(i).copied().unwrap_or(1.0).max(1e-6))
        .sum::<f64>()
        / total.max(1e-6);
    let shift = wanted - centre;
    for value in out.iter_mut() {
        *value += shift;
    }
    out
}
