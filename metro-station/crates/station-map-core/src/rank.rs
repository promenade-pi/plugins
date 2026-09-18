//! Process order (`rank`) and accumulated elapsed time (`depth`).
//!
//! Both are longest paths. Rank is the longest path in hand-offs, which is
//! what puts a step to the right of everything it can only happen after.
//! Depth is the longest path in *seconds*, which is the honest reading of
//! "how long into the process is this step": a platform is as deep as the
//! slowest way of reaching it, because a platform has one depth and cases do
//! not get to arrive at several.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

/// A set of arcs whose removal leaves the graph acyclic.
///
/// Greedy-sequence (Eades, Lin & Smyth 1993): repeatedly take every sink, then
/// every source, then the vertex with the largest out-minus-in degree, and
/// read the resulting linear order. Every arc that runs backwards in that
/// order is a feedback arc — so acyclicity is structural, not hoped for, and
/// the heuristic only decides *how few* arcs pay for it.
pub fn feedback_arcs(
    ids: &[String],
    adjacency: &HashMap<String, Vec<String>>,
) -> HashSet<(String, String)> {
    let mut out: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut inn: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for id in ids {
        out.entry(id.as_str()).or_default();
        inn.entry(id.as_str()).or_default();
    }
    for (s, ts) in adjacency {
        for t in ts {
            if s == t || !out.contains_key(t.as_str()) || !out.contains_key(s.as_str()) {
                continue;
            }
            out.get_mut(s.as_str()).unwrap().push(t.as_str());
            inn.get_mut(t.as_str()).unwrap().push(s.as_str());
        }
    }

    let mut alive: HashSet<&str> = ids.iter().map(|s| s.as_str()).collect();
    let mut head: Vec<&str> = Vec::new();
    let mut tail: Vec<&str> = Vec::new();
    let degree = |v: &str, alive: &HashSet<&str>, m: &BTreeMap<&str, Vec<&str>>| -> usize {
        m[v].iter().filter(|u| alive.contains(**u)).count()
    };

    while !alive.is_empty() {
        loop {
            let sink = ids
                .iter()
                .map(|s| s.as_str())
                .find(|v| alive.contains(v) && degree(v, &alive, &out) == 0);
            match sink {
                Some(v) => {
                    alive.remove(v);
                    tail.push(v);
                }
                None => break,
            }
        }
        loop {
            let source = ids
                .iter()
                .map(|s| s.as_str())
                .find(|v| alive.contains(v) && degree(v, &alive, &inn) == 0);
            match source {
                Some(v) => {
                    alive.remove(v);
                    head.push(v);
                }
                None => break,
            }
        }
        if alive.is_empty() {
            break;
        }
        // Ties broken by the id, so the same graph always yields the same map.
        let best = ids
            .iter()
            .map(|s| s.as_str())
            .filter(|v| alive.contains(v))
            .max_by_key(|v| {
                (
                    degree(v, &alive, &out) as i64 - degree(v, &alive, &inn) as i64,
                    std::cmp::Reverse(*v),
                )
            });
        if let Some(v) = best {
            alive.remove(v);
            head.push(v);
        }
    }
    tail.reverse();
    head.extend(tail);

    let position: HashMap<&str, usize> = head.iter().enumerate().map(|(i, v)| (*v, i)).collect();
    let mut back = HashSet::new();
    for (s, ts) in adjacency {
        for t in ts {
            if s == t {
                continue;
            }
            match (position.get(s.as_str()), position.get(t.as_str())) {
                (Some(a), Some(b)) if b <= a => {
                    back.insert((s.clone(), t.clone()));
                }
                _ => {}
            }
        }
    }
    back
}

/// Longest path from any source, in hand-offs. `forward` must be acyclic.
pub fn longest_path_rank(
    ids: &[String],
    forward: &HashMap<String, Vec<String>>,
) -> HashMap<String, i32> {
    let mut indegree: HashMap<&str, usize> = ids.iter().map(|s| (s.as_str(), 0)).collect();
    for (s, ts) in forward {
        if !indegree.contains_key(s.as_str()) {
            continue;
        }
        for t in ts {
            if let Some(d) = indegree.get_mut(t.as_str()) {
                *d += 1;
            }
        }
    }
    let mut rank: HashMap<String, i32> = ids.iter().map(|s| (s.clone(), 0)).collect();
    let mut queue: VecDeque<&str> = ids
        .iter()
        .map(|s| s.as_str())
        .filter(|v| indegree[v] == 0)
        .collect();
    while let Some(v) = queue.pop_front() {
        let here = rank[v];
        if let Some(ts) = forward.get(v) {
            for t in ts {
                let entry = rank.get_mut(t.as_str()).unwrap();
                if *entry < here + 1 {
                    *entry = here + 1;
                }
                let d = indegree.get_mut(t.as_str()).unwrap();
                *d -= 1;
                if *d == 0 {
                    queue.push_back(t.as_str());
                }
            }
        }
    }
    rank
}

/// Ids in an order every forward hand-off respects.
pub fn topological(
    ids: &[String],
    _forward: &HashMap<String, Vec<String>>,
    rank_of: &HashMap<String, i32>,
) -> Vec<String> {
    let mut out = ids.to_vec();
    out.sort_by(|a, b| (rank_of[a], a).cmp(&(rank_of[b], b)));
    out
}

/// Accumulated elapsed seconds per activity, and which hand-off set it.
///
/// A measured wait of zero still descends, by a hairline, so that the strict
/// ordering every later stage relies on is a fact rather than a hope. The
/// hairline is deliberately far too small to see: making a descent *visible*
/// is the view's job (`view-src/src/depth.ts` refines the mapping from seconds
/// to height), and doing it here instead would mean writing a number into the
/// payload that the log does not support. An earlier draft used 2% of the
/// map's own depth for this, which on the worked example made a 55-second
/// hand-off report as nine minutes — a legibility fix quietly editing the
/// data it was meant to draw.
pub fn depth(
    ids: &[String],
    forward: &HashMap<String, Vec<String>>,
    rank_of: &HashMap<String, i32>,
    wait_of: &HashMap<(String, String), Option<f64>>,
    has_timing: bool,
) -> (HashMap<String, f64>, HashMap<String, String>) {
    const EPS_BUDGET: f64 = 1e-5;

    let order = topological(ids, forward, rank_of);
    let raw = |s: &str, t: &str| -> f64 {
        if !has_timing {
            return 1.0;
        }
        wait_of
            .get(&(s.to_string(), t.to_string()))
            .copied()
            .flatten()
            .filter(|w| w.is_finite() && *w >= 0.0)
            .unwrap_or(0.0)
    };

    let walk = |eps: f64| -> (HashMap<String, f64>, HashMap<String, String>) {
        let mut time: HashMap<String, f64> = ids.iter().map(|s| (s.clone(), 0.0)).collect();
        let mut critical: HashMap<String, String> = HashMap::new();
        for v in &order {
            let here = time[v];
            if let Some(ts) = forward.get(v) {
                for t in ts {
                    let candidate = here + raw(v, t).max(eps);
                    let slot = time.get_mut(t).unwrap();
                    if candidate > *slot {
                        *slot = candidate;
                        critical.insert(t.clone(), v.clone());
                    }
                }
            }
        }
        (time, critical)
    };

    let (first, _) = walk(0.0);
    let span = first.values().cloned().fold(0.0_f64, f64::max);
    let chain = (rank_of.values().cloned().max().unwrap_or(0) as f64).max(1.0);
    let eps = if span > 0.0 {
        span * EPS_BUDGET / chain
    } else {
        1.0
    };
    walk(eps)
}
