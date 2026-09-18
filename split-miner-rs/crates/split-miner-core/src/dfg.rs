//! The directly-follows graph Split Miner works on, plus the loops it lifts
//! out of it before anything else looks at it.
//!
//! Beyond the activities the graph carries two artificial nodes, [`Dfg::source`]
//! and [`Dfg::sink`], standing for the BPMN start and end event. Split Miner's
//! filtering requires *"each node of the PDFG must be on a path from a single
//! start (source) to a single end (sink) node"* — a log with several start
//! activities has no such node of its own, so one is added rather than the
//! requirement being quietly weakened.
//!
//! # Loops
//!
//! > "Self-loops and short-loops are trivially removed from the DFG and
//! > restored in the output BPMN model at the end."
//! > — Augusto et al., §III.A
//!
//! Both are lifted out here, because both break the concurrency oracle: a
//! self-loop makes an activity look like it follows itself, and a short-loop
//! `a ↺ b` produces exactly the two mutual arcs the oracle reads as
//! concurrency. The paper's own conditions exclude short-loop pairs from
//! concurrency for that reason.
//!
//! **Interpretation, stated rather than hidden:** the paper does not say which
//! of a short loop's two arcs is removed, and removing both can disconnect `b`
//! from the graph — which would violate the very property the filtering step
//! then has to establish. So the *less frequent* of the two arcs is treated as
//! the loop-back edge and lifted; the more frequent one stays and carries the
//! path. That is the only reading under which "removed and restored" leaves a
//! connected graph, and it mirrors what happens to a self-loop exactly.

use crate::observe::Observations;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub type Node = usize;

#[derive(Clone)]
pub struct Dfg {
    /// Activity count; nodes `0..n` are activities.
    pub n: usize,
    pub edges: BTreeMap<(Node, Node), u32>,
    /// Activities with a `a -> a` arc, and how often.
    pub self_loops: BTreeMap<Node, u32>,
    /// Lifted short-loop arcs `(a, b)` with their frequency — the back edge of
    /// a detected `a ↺ b`.
    pub short_loops: BTreeMap<(Node, Node), u32>,
}

impl Dfg {
    pub fn source(&self) -> Node {
        self.n
    }
    pub fn sink(&self) -> Node {
        self.n + 1
    }
    pub fn node_count(&self) -> usize {
        self.n + 2
    }
    pub fn is_activity(&self, node: Node) -> bool {
        node < self.n
    }

    pub fn freq(&self, a: Node, b: Node) -> u32 {
        self.edges.get(&(a, b)).copied().unwrap_or(0)
    }

    pub fn successors(&self, a: Node) -> Vec<Node> {
        self.edges.keys().filter(|(x, _)| *x == a).map(|(_, y)| *y).collect()
    }

    pub fn predecessors(&self, b: Node) -> Vec<Node> {
        self.edges.keys().filter(|(_, y)| *y == b).map(|(x, _)| *x).collect()
    }

    pub fn out_edges(&self, a: Node) -> Vec<(Node, u32)> {
        self.edges.iter().filter(|((x, _), _)| *x == a).map(|((_, y), f)| (*y, *f)).collect()
    }

    pub fn in_edges(&self, b: Node) -> Vec<(Node, u32)> {
        self.edges.iter().filter(|((_, y), _)| *y == b).map(|((x, _), f)| (*x, *f)).collect()
    }

    /// Nodes still present: the two artificial ones, plus every activity that
    /// still has an arc.
    pub fn nodes(&self) -> BTreeSet<Node> {
        let mut nodes: BTreeSet<Node> = BTreeSet::from([self.source(), self.sink()]);
        for &(a, b) in self.edges.keys() {
            nodes.insert(a);
            nodes.insert(b);
        }
        nodes
    }

    /// Everything reachable from `from`, following arcs forwards or backwards.
    fn closure(&self, from: Node, forward: bool) -> BTreeSet<Node> {
        let mut seen = BTreeSet::from([from]);
        let mut queue = VecDeque::from([from]);
        while let Some(node) = queue.pop_front() {
            let next = if forward { self.successors(node) } else { self.predecessors(node) };
            for other in next {
                if seen.insert(other) {
                    queue.push_back(other);
                }
            }
        }
        seen
    }

    /// Drops every activity that is not on some source-to-sink path, and every
    /// arc touching one.
    ///
    /// The paper is explicit that the filtering algorithm does not itself
    /// guarantee the connectedness property, and that it "is guaranteed a
    /// posteriori by removing all the tasks that after the filtering are
    /// unreachable via a forward (or backward) exploration starting from the
    /// start (or end) task". Returns the activities it dropped.
    pub fn prune_unreachable(&mut self) -> Vec<Node> {
        let forward = self.closure(self.source(), true);
        let backward = self.closure(self.sink(), false);
        let keep: BTreeSet<Node> = forward.intersection(&backward).copied().collect();
        let dropped: Vec<Node> =
            self.nodes().into_iter().filter(|n| self.is_activity(*n) && !keep.contains(n)).collect();
        self.edges.retain(|(a, b), _| keep.contains(a) && keep.contains(b));
        for node in &dropped {
            self.self_loops.remove(node);
        }
        self.short_loops.retain(|(a, b), _| keep.contains(a) && keep.contains(b));
        dropped
    }
}

/// Which directly-follows relation the graph is built from.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Relation {
    /// Definition 2 — consecutive complete events.
    Classic,
    /// Split Miner 2.0's Definition 6 — a start after an end, nothing ending
    /// in between.
    Refined,
}

pub fn build(obs: &Observations, relation: Relation) -> Dfg {
    let n = obs.activity_count;
    let mut dfg = Dfg { n, edges: BTreeMap::new(), self_loops: BTreeMap::new(), short_loops: BTreeMap::new() };
    let at = |a: usize, b: usize| match relation {
        Relation::Classic => obs.df(a, b),
        Relation::Refined => obs.refined_df(a, b),
    };

    for a in 0..n {
        for b in 0..n {
            let f = at(a, b);
            if f == 0 {
                continue;
            }
            if a == b {
                dfg.self_loops.insert(a, f);
            } else {
                dfg.edges.insert((a, b), f);
            }
        }
    }
    // The refined relation is silent about which activity opened a case, so
    // both variants take the start/end sets from the complete-event
    // projection — the one place in the log where "the case began here" is
    // unambiguous either way.
    for a in 0..n {
        if obs.starts[a] > 0 {
            dfg.edges.insert((dfg.source(), a), obs.starts[a]);
        }
        if obs.ends[a] > 0 {
            dfg.edges.insert((a, dfg.sink()), obs.ends[a]);
        }
    }

    lift_short_loops(&mut dfg, obs);
    dfg
}

/// A short loop `a ↺ b` exists iff neither `a` nor `b` is a self-loop
/// (condition 1) and the pattern ⟨a,b,a⟩ or ⟨b,a,b⟩ occurs (condition 2).
fn lift_short_loops(dfg: &mut Dfg, obs: &Observations) {
    let n = dfg.n;
    for a in 0..n {
        for b in (a + 1)..n {
            if dfg.self_loops.contains_key(&a) || dfg.self_loops.contains_key(&b) {
                continue;
            }
            if obs.loop2(a, b) + obs.loop2(b, a) == 0 {
                continue;
            }
            let (forward, backward) = (dfg.freq(a, b), dfg.freq(b, a));
            if forward == 0 || backward == 0 {
                continue;
            }
            // The weaker direction is the loop-back; see the module comment.
            let back = if forward >= backward { (b, a) } else { (a, b) };
            if let Some(f) = dfg.edges.remove(&back) {
                dfg.short_loops.insert(back, f);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::scan_complete;

    #[test]
    fn a_self_loop_is_lifted_out_of_the_edges() {
        let obs = scan_complete(&[&[0, 1, 1, 2]], 3);
        let dfg = build(&obs, Relation::Classic);
        assert_eq!(dfg.self_loops.get(&1), Some(&1));
        assert_eq!(dfg.freq(1, 1), 0);
        assert_eq!(dfg.freq(0, 1), 1);
    }

    #[test]
    fn a_short_loop_keeps_its_stronger_direction() {
        // <a, b, a, c> twice plus <a, c> once: a->b and b->a both occur, and
        // the pattern <a,b,a> makes it a short loop rather than concurrency.
        let obs = scan_complete(&[&[0, 1, 0, 2], &[0, 1, 0, 2]], 3);
        let dfg = build(&obs, Relation::Classic);
        assert_eq!(dfg.freq(0, 1), 2, "the forward arc stays");
        assert_eq!(dfg.freq(1, 0), 0, "the loop-back arc is lifted");
        assert_eq!(dfg.short_loops.get(&(1, 0)), Some(&2));
    }

    #[test]
    fn mutual_arcs_without_the_pattern_are_left_alone() {
        // <a,b> and <b,a> in different traces: no <a,b,a>, so not a short
        // loop — this is a concurrency candidate, and the oracle decides.
        let obs = scan_complete(&[&[0, 1], &[1, 0]], 2);
        let dfg = build(&obs, Relation::Classic);
        assert!(dfg.short_loops.is_empty());
        assert_eq!(dfg.freq(0, 1), 1);
        assert_eq!(dfg.freq(1, 0), 1);
    }

    #[test]
    fn source_and_sink_bracket_the_graph() {
        let obs = scan_complete(&[&[0, 1], &[2, 1]], 3);
        let dfg = build(&obs, Relation::Classic);
        assert_eq!(dfg.freq(dfg.source(), 0), 1);
        assert_eq!(dfg.freq(dfg.source(), 2), 1);
        assert_eq!(dfg.freq(1, dfg.sink()), 2);
    }

    #[test]
    fn pruning_drops_what_no_path_reaches() {
        let obs = scan_complete(&[&[0, 1]], 3);
        let mut dfg = build(&obs, Relation::Classic);
        // Activity 2 appears in no trace but gets an arc from nowhere.
        dfg.edges.insert((2, 1), 1);
        let dropped = dfg.prune_unreachable();
        assert_eq!(dropped, vec![2]);
        assert_eq!(dfg.freq(2, 1), 0);
    }
}
