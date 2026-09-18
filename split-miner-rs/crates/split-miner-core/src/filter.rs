//! Algorithm 1 — Generate Filtered PDFG.
//!
//! The paper states three properties the filtered graph should have, and is
//! candid that they cannot all be met at once:
//!
//! 1. every node on a path from the single source to the single sink — this is
//!    what makes the eventual BPMN deadlock-free and able to complete;
//! 2. the number of arcs minimal — fewer arcs is lower control-flow
//!    complexity and higher precision;
//! 3. every source-to-sink path carrying the highest possible sum of
//!    frequencies — which is what fitness is.
//!
//! Algorithm 1 trades between (2) and (3): keep every arc above a frequency
//! threshold, and keep each task connected to its single most frequent
//! successor and predecessor whatever their frequency. Property (1) is then
//! restored afterwards, by dropping whatever the filter stranded — see
//! [`crate::dfg::Dfg::prune_unreachable`].
//!
//! ```text
//!  1  F_e := { most frequent outgoing arc of t } u { most frequent incoming arc of t }, for all t
//!  2  f_th := percentile(frequencies of F_e, eta)
//!  3  F_e := F_e u { e in E_p | freq(e) > f_th }
//!  4  E_f := {}
//!  5  while F_e is not empty:
//!  6      e_m := most frequent arc in F_e
//!  7      if freq(e_m) > f_th or source(e_m) has no outgoing arc in E_f
//!                             or target(e_m) has no incoming arc in E_f:
//!  8          E_f := E_f u { e_m }
//!          F_e := F_e \ { e_m }
//!  9  return (T, E_f)
//! ```
//!
//! Two things the pseudocode leaves open, decided here and stated rather than
//! buried:
//!
//! - **`getMostFrequentEdge` on a tie.** Arcs are ordered by frequency
//!   descending and then by `(source, target)` ascending. Any total order
//!   would do; having *an* order is what makes the output reproducible, and
//!   the ids it falls back to are the host's stable activity ids.
//! - **The percentile.** Linear interpolation over the sorted frequencies, so
//!   `eta = 0` is the minimum and `eta = 1` the maximum of `F_e`. Lower `eta`
//!   therefore retains more arcs, which is the direction the paper describes.

use crate::dfg::{Dfg, Node};
use std::collections::BTreeSet;

/// `(frequency, source, target)`, ordered so that `max()` is exactly
/// `getMostFrequentEdge`.
type Ranked = (u32, std::cmp::Reverse<Node>, std::cmp::Reverse<Node>);

fn rank(edge: (Node, Node), freq: u32) -> Ranked {
    (freq, std::cmp::Reverse(edge.0), std::cmp::Reverse(edge.1))
}

fn percentile(mut values: Vec<u32>, eta: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_unstable();
    let eta = eta.clamp(0.0, 1.0);
    let position = eta * (values.len() - 1) as f64;
    let low = position.floor() as usize;
    let high = position.ceil() as usize;
    let fraction = position - low as f64;
    f64::from(values[low]) * (1.0 - fraction) + f64::from(values[high]) * fraction
}

pub struct Filtered {
    pub dfg: Dfg,
    pub threshold: f64,
    /// Activities the a-posteriori connectedness pass had to drop.
    pub dropped: Vec<Node>,
}

pub fn filter(dfg: &Dfg, eta: f64) -> Filtered {
    let mut candidates: BTreeSet<(Node, Node)> = BTreeSet::new();
    for node in dfg.nodes() {
        if let Some((target, _)) =
            dfg.out_edges(node).into_iter().max_by_key(|&(t, f)| rank((node, t), f))
        {
            candidates.insert((node, target));
        }
        if let Some((source, _)) =
            dfg.in_edges(node).into_iter().max_by_key(|&(s, f)| rank((s, node), f))
        {
            candidates.insert((source, node));
        }
    }

    let threshold = percentile(candidates.iter().map(|&(a, b)| dfg.freq(a, b)).collect(), eta);
    for (&(a, b), &f) in &dfg.edges {
        if f64::from(f) > threshold {
            candidates.insert((a, b));
        }
    }

    let mut ordered: Vec<(Node, Node)> = candidates.into_iter().collect();
    ordered.sort_by_key(|&(a, b)| std::cmp::Reverse(rank((a, b), dfg.freq(a, b))));

    let mut kept: BTreeSet<(Node, Node)> = BTreeSet::new();
    for (a, b) in ordered {
        let source_unconnected = !kept.iter().any(|&(x, _)| x == a);
        let target_unconnected = !kept.iter().any(|&(_, y)| y == b);
        if f64::from(dfg.freq(a, b)) > threshold || source_unconnected || target_unconnected {
            kept.insert((a, b));
        }
    }

    let mut out = dfg.clone();
    out.edges.retain(|edge, _| kept.contains(edge));
    let dropped = out.prune_unreachable();
    Filtered { dfg: out, threshold, dropped }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dfg::{self, Relation};
    use crate::testing::scan_complete;

    #[test]
    fn every_activity_keeps_a_way_in_and_a_way_out() {
        // A rare path a -> x -> d among many a -> b -> d: whatever eta does
        // to the arc frequencies, x may not be left stranded.
        let mut traces: Vec<Vec<usize>> = vec![vec![0, 1, 3]; 50];
        traces.push(vec![0, 2, 3]);
        let refs: Vec<&[usize]> = traces.iter().map(|t| t.as_slice()).collect();
        let obs = scan_complete(&refs, 4);
        let g = dfg::build(&obs, Relation::Classic);
        for eta in [0.0, 0.25, 0.5, 0.75, 1.0] {
            let f = filter(&g, eta);
            for node in f.dfg.nodes() {
                if node == f.dfg.source() {
                    assert!(!f.dfg.successors(node).is_empty(), "eta {eta}: source is isolated");
                } else if node == f.dfg.sink() {
                    assert!(!f.dfg.predecessors(node).is_empty(), "eta {eta}: sink is isolated");
                } else {
                    assert!(!f.dfg.successors(node).is_empty(), "eta {eta}: node {node} has no way out");
                    assert!(!f.dfg.predecessors(node).is_empty(), "eta {eta}: node {node} has no way in");
                }
            }
        }
    }

    #[test]
    fn a_higher_eta_never_keeps_more_arcs() {
        let mut traces: Vec<Vec<usize>> = vec![vec![0, 1, 4]; 40];
        traces.extend(vec![vec![0, 2, 4]; 8]);
        traces.extend(vec![vec![0, 3, 4]; 2]);
        let refs: Vec<&[usize]> = traces.iter().map(|t| t.as_slice()).collect();
        let obs = scan_complete(&refs, 5);
        let g = dfg::build(&obs, Relation::Classic);
        let mut previous = usize::MAX;
        for step in 0..=10 {
            let kept = filter(&g, step as f64 / 10.0).dfg.edges.len();
            assert!(kept <= previous, "eta {step}: filtering kept more arcs than a lower eta");
            previous = kept;
        }
    }

    #[test]
    fn the_percentile_spans_the_frequencies() {
        assert_eq!(percentile(vec![1, 2, 3, 4], 0.0), 1.0);
        assert_eq!(percentile(vec![1, 2, 3, 4], 1.0), 4.0);
        assert_eq!(percentile(vec![1, 3], 0.5), 2.0);
        assert_eq!(percentile(vec![], 0.5), 0.0);
    }
}
