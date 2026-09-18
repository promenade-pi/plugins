//! The concurrency oracle, in both papers' versions, and the pruning it drives.
//!
//! # Split Miner (Augusto et al. 2017/2019)
//!
//! Two activities `a` and `b` are concurrent iff
//!
//! ```text
//! (1)  |a -> b| > 0  and  |b -> a| > 0
//! (2)  no trace contains <a, b, a>
//! (3)  no trace contains <b, a, b>
//! (4)  ( ||a -> b| - |b -> a|| ) / ( |a -> b| + |b -> a| )  <  eps
//! ```
//!
//! Condition (1) says the two can occur in either order, which is necessary
//! but not sufficient — a short loop produces the same two arcs, which is what
//! (2) and (3) rule out. Condition (4) is the discriminating one: genuinely
//! interleaved executions should be observed in both orders about equally
//! often, so the *smaller* `eps`, the more balanced the two directions must be
//! before concurrency is claimed.
//!
//! # Split Miner 2.0 (Augusto, Dumas & La Rosa 2021)
//!
//! When the log records when each activity *starts* and *ends*, concurrency
//! does not have to be inferred from interleaving at all — it can be observed:
//!
//! ```text
//! (5)  2 * |a >< b| / ( |a| + |b| )  >=  eps
//! ```
//!
//! where `|a >< b|` counts executions of the two whose life-cycles overlapped
//! and `|a|`, `|b|` count complete life-cycles. At `eps = 1` this is *strong
//! simultaneousness* — every execution of both overlaps; below that it is the
//! paper's parametrised weak form, which real logs need.
//!
//! Equation (5) **replaces** conditions (1)–(4) rather than joining them, and
//! that is not a liberty: under Split Miner 2.0's own refined directly-follows
//! relation (Definition 6) two truly concurrent activities have no
//! directly-follows arc in *either* direction, because neither ever starts
//! after the other has ended. Keeping condition (1) would therefore make the
//! variant incapable of finding the concurrency it exists to find.

use crate::dfg::{Dfg, Node};
use crate::observe::Observations;

/// A symmetric, irreflexive relation over activities.
#[derive(Clone)]
pub struct Concurrency {
    n: usize,
    bits: Vec<bool>,
}

impl Concurrency {
    pub fn empty(n: usize) -> Self {
        Self { n, bits: vec![false; n * n] }
    }

    pub fn get(&self, a: Node, b: Node) -> bool {
        if a >= self.n || b >= self.n {
            return false;
        }
        self.bits[a * self.n + b]
    }

    fn set(&mut self, a: usize, b: usize) {
        self.bits[a * self.n + b] = true;
        self.bits[b * self.n + a] = true;
    }

    pub fn pairs(&self) -> Vec<(usize, usize)> {
        let mut out = Vec::new();
        for a in 0..self.n {
            for b in (a + 1)..self.n {
                if self.get(a, b) {
                    out.push((a, b));
                }
            }
        }
        out
    }

    pub fn count(&self) -> usize {
        self.pairs().len()
    }
}

/// Split Miner's oracle, evaluated on the graph *after* self-loops and
/// short-loop back-arcs have been lifted out. Conditions (2) and (3) are still
/// checked against the raw pattern counts rather than left to that lifting:
/// they are the paper's conditions, and a relation that depended on an earlier
/// step's side effect would be a different algorithm that happens to agree.
pub fn discover_classic(obs: &Observations, dfg: &Dfg, epsilon: f64) -> Concurrency {
    let n = dfg.n;
    let mut conc = Concurrency::empty(n);
    for a in 0..n {
        for b in (a + 1)..n {
            if dfg.self_loops.contains_key(&a) || dfg.self_loops.contains_key(&b) {
                continue;
            }
            if obs.loop2(a, b) > 0 || obs.loop2(b, a) > 0 {
                continue;
            }
            let (forward, backward) = (obs.df(a, b), obs.df(b, a));
            if forward == 0 || backward == 0 {
                continue;
            }
            let total = f64::from(forward + backward);
            let imbalance = (f64::from(forward) - f64::from(backward)).abs() / total;
            if imbalance < epsilon {
                conc.set(a, b);
            }
        }
    }
    conc
}

/// Split Miner 2.0's oracle: measured life-cycle overlap, Equation (5).
pub fn discover_true(obs: &Observations, epsilon: f64) -> Concurrency {
    let n = obs.activity_count;
    let mut conc = Concurrency::empty(n);
    for a in 0..n {
        for b in (a + 1)..n {
            let executions = obs.complete_lifecycles[a] + obs.complete_lifecycles[b];
            if executions == 0 {
                continue;
            }
            let ratio = 2.0 * f64::from(obs.overlap(a, b)) / f64::from(executions);
            if ratio >= epsilon {
                conc.set(a, b);
            }
        }
    }
    conc
}

/// Definition 5 (Pruned DFG):
///
/// ```text
/// E_p = E \ { (a,b) in E | a||b  or  (not a||b and (b,a) in E and |a->b| < |b->a|) }
/// ```
///
/// Concurrency means there is no causality to draw, so both arcs go. A mutual
/// pair that is *not* concurrent is an ordering the log is merely inconsistent
/// about, and only the dominant direction survives. Ties keep both arcs: the
/// condition is a strict `<`, and inventing a tie-break would silently delete
/// an arc the definition keeps.
pub fn prune(dfg: &mut Dfg, conc: &Concurrency) {
    let mut drop = Vec::new();
    for &(a, b) in dfg.edges.keys() {
        if conc.get(a, b) {
            drop.push((a, b));
        } else if dfg.edges.contains_key(&(b, a)) && dfg.freq(a, b) < dfg.freq(b, a) {
            drop.push((a, b));
        }
    }
    for edge in drop {
        dfg.edges.remove(&edge);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dfg::{self, Relation};
    use crate::testing::scan_complete;

    #[test]
    fn balanced_interleaving_is_concurrency() {
        // b and c appear in both orders, equally often.
        let obs = scan_complete(&[&[0, 1, 2, 3], &[0, 2, 1, 3]], 4);
        let g = dfg::build(&obs, Relation::Classic);
        let conc = discover_classic(&obs, &g, 0.1);
        assert!(conc.get(1, 2));
        assert!(!conc.get(0, 1));
    }

    #[test]
    fn a_lopsided_pair_is_not_concurrency() {
        // b before c nine times, c before b once: |9-1|/10 = 0.8, not < 0.1.
        let mut traces: Vec<Vec<usize>> = vec![vec![0, 1, 2, 3]; 9];
        traces.push(vec![0, 2, 1, 3]);
        let refs: Vec<&[usize]> = traces.iter().map(|t| t.as_slice()).collect();
        let obs = scan_complete(&refs, 4);
        let g = dfg::build(&obs, Relation::Classic);
        assert!(!discover_classic(&obs, &g, 0.1).get(1, 2));
        // ...but it is, once eps is loosened past the imbalance.
        assert!(discover_classic(&obs, &g, 0.9).get(1, 2));
    }

    #[test]
    fn a_short_loop_is_never_concurrency_however_balanced() {
        // <a,b,a> makes the mutual arcs a loop, not concurrency, and the
        // frequencies are perfectly balanced so only conditions 2-3 can
        // reject it.
        let obs = scan_complete(&[&[0, 1, 0]], 2);
        let g = dfg::build(&obs, Relation::Classic);
        assert!(!discover_classic(&obs, &g, 1.0).get(0, 1));
    }

    #[test]
    fn pruning_removes_both_arcs_of_a_concurrent_pair() {
        let obs = scan_complete(&[&[0, 1, 2, 3], &[0, 2, 1, 3]], 4);
        let mut g = dfg::build(&obs, Relation::Classic);
        let conc = discover_classic(&obs, &g, 0.1);
        prune(&mut g, &conc);
        assert_eq!(g.freq(1, 2), 0);
        assert_eq!(g.freq(2, 1), 0);
        assert_eq!(g.freq(0, 1), 1, "the causal arcs are untouched");
    }

    #[test]
    fn pruning_keeps_only_the_dominant_direction_of_an_unbalanced_pair() {
        let mut traces: Vec<Vec<usize>> = vec![vec![0, 1, 2, 3]; 9];
        traces.push(vec![0, 2, 1, 3]);
        let refs: Vec<&[usize]> = traces.iter().map(|t| t.as_slice()).collect();
        let obs = scan_complete(&refs, 4);
        let mut g = dfg::build(&obs, Relation::Classic);
        let conc = discover_classic(&obs, &g, 0.1);
        prune(&mut g, &conc);
        assert_eq!(g.freq(1, 2), 9);
        assert_eq!(g.freq(2, 1), 0);
    }

    #[test]
    fn overlap_is_concurrency_without_any_interleaving() {
        use crate::observe::Phase::{Complete, Start};
        // b and c always overlap, and always in the same order, so the
        // classic oracle sees a plain sequence and the true one sees
        // concurrency. That difference is the whole of Split Miner 2.0.
        let trace = [
            (0, Start), (0, Complete),
            (1, Start), (2, Start), (1, Complete), (2, Complete),
            (3, Start), (3, Complete),
        ];
        let obs = crate::testing::scan(&[&trace], 4);
        let g = dfg::build(&obs, Relation::Classic);
        assert!(!discover_classic(&obs, &g, 0.5).get(1, 2));
        assert!(discover_true(&obs, 0.5).get(1, 2));
    }
}
