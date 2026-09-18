//! The cut detectors, in the order they are tried.
//!
//! All five work on local activity indices and return a partition of them. A
//! cut is valid iff it has at least two parts and no part is empty — the same
//! test for every detector, applied by the caller.

use crate::graph::{connected_components, strongly_connected_components, Components, Reachability};
use crate::info::LogInfo;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operator {
    Xor,
    Sequence,
    Parallel,
    Loop,
}

#[derive(Debug, Clone)]
pub struct Cut {
    pub operator: Operator,
    pub parts: Vec<Vec<usize>>,
}

impl Cut {
    pub fn is_valid(&self) -> bool {
        self.parts.len() >= 2 && self.parts.iter().all(|p| !p.is_empty())
    }
}

fn edges_of(info: &LogInfo) -> impl Iterator<Item = (usize, usize)> + '_ {
    (0..info.n()).flat_map(move |s| info.out_adj[s].iter().map(move |&t| (s, t)))
}

/// The detector list, in ProM's order. `parallel_msd` before `parallel` is not
/// cosmetic: a loop whose directly-follows graph is indistinguishable from a
/// parallel construct is resolved in favour of the loop reading only because
/// the minimum-self-distance variant gets asked first.
pub fn find_cut(info: &LogInfo) -> Option<Cut> {
    let finders: [fn(&LogInfo) -> Option<Cut>; 5] = [
        xor_cut,
        sequence_cut,
        parallel_cut_msd,
        parallel_cut,
        loop_cut,
    ];
    for f in finders {
        if let Some(cut) = f(info) {
            if cut.is_valid() {
                return Some(cut);
            }
        }
    }
    None
}

// ------------------------------------------------------------------ xor

pub fn xor_cut(info: &LogInfo) -> Option<Cut> {
    Some(Cut {
        operator: Operator::Xor,
        parts: connected_components(info.n(), edges_of(info)),
    })
}

// ------------------------------------------------------------- sequence

pub fn sequence_cut(info: &LogInfo) -> Option<Cut> {
    let n = info.n();
    let sccs = strongly_connected_components(n, &info.out_adj);
    if sccs.len() <= 1 {
        return None;
    }

    // Condense: one node per strongly connected component.
    let mut scc_of = vec![0usize; n];
    for (i, scc) in sccs.iter().enumerate() {
        for &a in scc {
            scc_of[a] = i;
        }
    }
    let k = sccs.len();
    let mut cond_adj: Vec<Vec<usize>> = vec![Vec::new(); k];
    for (s, t) in edges_of(info) {
        let (cs, ct) = (scc_of[s], scc_of[t]);
        if cs != ct && !cond_adj[cs].contains(&ct) {
            cond_adj[cs].push(ct);
        }
    }

    // Merge condensed nodes that cannot reach each other in either direction:
    // those are alternatives, not consecutive steps, and leaving them apart
    // would cut a xor as if it were a sequence.
    let reach1 = Reachability::compute(k, &cond_adj);
    let mut groups = Components::new(k);
    for a in 0..k {
        for b in 0..k {
            if a != b && !reach1.related(a, b) {
                groups.merge(a, b);
            }
        }
    }
    let group_parts = groups.parts();
    let g = group_parts.len();
    if g <= 1 {
        return None;
    }

    let mut group_of = vec![0usize; k];
    for (i, part) in group_parts.iter().enumerate() {
        for &scc in part {
            group_of[scc] = i;
        }
    }
    let mut group_adj: Vec<Vec<usize>> = vec![Vec::new(); g];
    for cs in 0..k {
        for &ct in &cond_adj[cs] {
            let (gs, gt) = (group_of[cs], group_of[ct]);
            if gs != gt && !group_adj[gs].contains(&gt) {
                group_adj[gs].push(gt);
            }
        }
    }

    // Activity sets per group, ascending.
    let mut sets: Vec<Vec<usize>> = group_parts
        .iter()
        .map(|part| {
            let mut acts: Vec<usize> = part.iter().flat_map(|&s| sccs[s].iter().copied()).collect();
            acts.sort_unstable();
            acts
        })
        .collect();

    // Topological order. After the merge above the order should be total; where
    // it is not, the smallest activity goes first so the result stays
    // reproducible rather than depending on iteration order.
    let reach2 = Reachability::compute(g, &group_adj);
    let mut order: Vec<usize> = (0..g).collect();
    order.sort_by(|&a, &b| {
        if reach2.reaches(a, b) {
            std::cmp::Ordering::Less
        } else if reach2.reaches(b, a) {
            std::cmp::Ordering::Greater
        } else {
            sets[a][0].cmp(&sets[b][0])
        }
    });
    sets = order.into_iter().map(|i| sets[i].clone()).collect();

    if sets.len() <= 1 {
        return None;
    }

    // Optional sub-sequences are merged back in, so that {<a,b,c>, <c>} yields
    // {a,b}{c} rather than {a}{b}{c} — the same cut without the taus that the
    // finer one would need.
    let merged = merge_optional_subsequences(info, &sets);
    let candidate = Cut {
        operator: Operator::Sequence,
        parts: merged,
    };
    if candidate.is_valid() {
        Some(candidate)
    } else {
        Some(Cut {
            operator: Operator::Sequence,
            parts: sets,
        })
    }
}

/// Merges consecutive parts that a "skipping" edge shows to be optional.
///
/// Works entirely on slot positions: `edge_min_from[i]` is the earliest slot with
/// an edge into slot `i`, `edge_max_to[i]` the latest slot it has an edge to, and
/// a slot "has skipping edges" if some edge passes over it. Where those arrays
/// invert, consecutive slots are dependent and get merged.
fn merge_optional_subsequences(info: &LogInfo, sets: &[Vec<usize>]) -> Vec<Vec<usize>> {
    let k = sets.len();
    if k == 2 {
        return sets.to_vec();
    }

    let mut slot_of = vec![0usize; info.n()];
    for (i, s) in sets.iter().enumerate() {
        for &a in s {
            slot_of[a] = i;
        }
    }

    const BEFORE_ALL: i64 = i64::MIN;
    const AFTER_ALL: i64 = i64::MAX;
    let mut edge_min_from = vec![AFTER_ALL; k];
    let mut edge_max_to = vec![BEFORE_ALL; k];
    let mut skipping = vec![false; k];

    for a in info.start_indices() {
        let c = slot_of[a];
        edge_min_from[c] = BEFORE_ALL;
        for s in skipping.iter_mut().take(c) {
            *s = true;
        }
    }
    for a in info.end_indices() {
        let c = slot_of[a];
        edge_max_to[c] = AFTER_ALL;
        for s in skipping.iter_mut().take(k).skip(c + 1) {
            *s = true;
        }
    }
    for (u, v) in edges_of(info) {
        let (s, t) = (slot_of[u] as i64, slot_of[v] as i64);
        edge_min_from[t as usize] = edge_min_from[t as usize].min(s);
        edge_max_to[s as usize] = edge_max_to[s as usize].max(t);
        let mut i = s + 1;
        while i < t {
            skipping[i as usize] = true;
            i += 1;
        }
    }

    let inversion_start = (1..k).find(|&i| edge_max_to[i - 1] > edge_max_to[i]);
    let inversion_end = (1..k).rev().find(|&i| edge_min_from[i - 1] > edge_min_from[i]);
    if inversion_start.is_none() && inversion_end.is_none() {
        return sets.to_vec();
    }

    let mut slots = Components::new(k);
    for i in 0..k {
        // Backward pivot: everything up to `i` that cannot reach past it.
        if i >= 1 && skipping[i] && edge_max_to[i - 1] == i as i64 {
            let mut j = i as i64 - 1;
            while j >= 0 && edge_max_to[j as usize] <= i as i64 {
                j -= 1;
            }
            for kk in (j + 1) as usize..i {
                slots.merge(kk, kk + 1);
            }
        }
        // Forward pivot: everything after `i` that nothing before `i` reaches.
        if i + 1 < k && skipping[i] && edge_min_from[i + 1] == i as i64 {
            let mut j = i + 1;
            while j < k && edge_min_from[j] >= i as i64 {
                j += 1;
            }
            for kk in i..j.saturating_sub(1) {
                slots.merge(kk, kk + 1);
            }
        }
    }

    slots
        .parts()
        .into_iter()
        .map(|group| {
            let mut acts: Vec<usize> = group.iter().flat_map(|&s| sets[s].iter().copied()).collect();
            acts.sort_unstable();
            acts
        })
        .collect()
}

// ------------------------------------------------------------- parallel

pub fn parallel_cut(info: &LogInfo) -> Option<Cut> {
    parallel_cut_impl(info, false)
}

pub fn parallel_cut_msd(info: &LogInfo) -> Option<Cut> {
    parallel_cut_impl(info, true)
}

fn parallel_cut_impl(info: &LogInfo, use_msd: bool) -> Option<Cut> {
    // Noise filtering can remove every start or end activity; without both
    // there is nothing to anchor the branches to.
    if !info.has_start_activities() || !info.has_end_activities() {
        return None;
    }

    let n = info.n();
    let mut components = Components::new(n);
    // Only a pair with edges in *both* directions may stay in separate
    // branches: a missing direction is evidence of order, not concurrency.
    for a in 0..n {
        for b in (a + 1)..n {
            if !components.same(a, b) && (!info.has_edge(a, b) || !info.has_edge(b, a)) {
                components.merge(a, b);
            }
        }
    }

    if use_msd {
        // Keeps a loop from being read as concurrency: activities that sit
        // between the closest repeat of an activity belong with it.
        for a in 0..n {
            for &b in &info.msd_between[a] {
                components.merge(a, b);
            }
        }
    }

    // ProM enumerates components in descending activity order (an observable
    // property of the collection it builds them in — see docs/prom-reference.md).
    // That order is invisible for xor, but here it decides which branch absorbs
    // the components that cannot start or end on their own, so it is worth
    // matching.
    let mut parts = components.parts();
    parts.sort_by_key(|p| std::cmp::Reverse(*p.last().unwrap_or(&0)));
    ensure_start_end_in_each(info, parts).map(|parts| Cut {
        operator: Operator::Parallel,
        parts,
    })
}

/// Every branch of a parallel cut has to be able to start and to finish.
///
/// Components that can do only one of the two are paired up; whatever is left
/// over is folded into the first complete branch. Which branch that is, is
/// arbitrary in ProM (hash order) and is the lowest-indexed one here.
fn ensure_start_end_in_each(info: &LogInfo, parts: Vec<Vec<usize>>) -> Option<Vec<Vec<usize>>> {
    let (mut both, mut start_only, mut end_only, mut neither) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for part in parts {
        let has_start = part.iter().any(|&a| info.is_start(a));
        let has_end = part.iter().any(|&a| info.is_end(a));
        match (has_start, has_end) {
            (true, true) => both.push(part),
            (true, false) => start_only.push(part),
            (false, true) => end_only.push(part),
            (false, false) => neither.push(part),
        }
    }

    if both.is_empty() {
        return None;
    }

    let mut result = both;
    let paired = start_only.len().min(end_only.len());
    for i in 0..paired {
        let mut merged = start_only[i].clone();
        merged.extend_from_slice(&end_only[i]);
        merged.sort_unstable();
        result.push(merged);
    }
    for leftover in start_only[paired..]
        .iter()
        .chain(end_only[paired..].iter())
        .chain(neither.iter())
    {
        result[0].extend_from_slice(leftover);
    }
    result[0].sort_unstable();

    Some(result)
}

// ----------------------------------------------------------------- loop

pub fn loop_cut(info: &LogInfo) -> Option<Cut> {
    if !info.has_start_activities() || !info.has_end_activities() {
        return None;
    }

    let n = info.n();
    let starts = info.start_indices();
    let ends = info.end_indices();
    let mut components = Components::new(n);

    // Every start and every end activity belongs to the body.
    let pivot = starts[0];
    for &a in starts.iter().chain(ends.iter()) {
        components.merge(pivot, a);
    }

    for (s, t) in edges_of(info).collect::<Vec<_>>() {
        if !info.is_start(s) {
            if !info.is_end(s) && !info.is_start(t) {
                components.merge(s, t);
            }
        } else if !info.is_end(s) {
            // A redo cannot be reachable from a start activity that never ends
            // a trace, so this edge is internal to the body.
            components.merge(s, t);
        }
    }

    // Activities at the ends of cross-component edges are where control leaves
    // and re-enters a part.
    let mut sub_start: Vec<usize> = Vec::new();
    let mut sub_end: Vec<usize> = Vec::new();
    for (s, t) in edges_of(info).collect::<Vec<_>>() {
        if !components.same(s, t) {
            sub_end.push(s);
            sub_start.push(t);
        }
    }
    sub_end.sort_unstable();
    sub_end.dedup();
    sub_start.sort_unstable();
    sub_start.dedup();

    // A redo branch has to hand control back to *every* start activity, and be
    // reachable from *every* end activity. Anything less and it is body.
    for &se in &sub_end {
        for &start in &starts {
            if components.same(se, start) {
                break;
            }
            if !info.has_edge(se, start) {
                components.merge(se, start);
                break;
            }
        }
    }
    for &ss in &sub_start {
        for &end in &ends {
            if components.same(ss, end) {
                break;
            }
            if !info.has_edge(end, ss) {
                components.merge(ss, end);
                break;
            }
        }
    }

    let mut parts = components.parts();
    // The body must be the first part; the rest are redo branches.
    if let Some(i) = parts.iter().position(|p| p.contains(&pivot)) {
        parts.swap(0, i);
    }

    Some(Cut {
        operator: Operator::Loop,
        parts,
    })
}
