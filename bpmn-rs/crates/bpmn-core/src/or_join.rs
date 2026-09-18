//! Replacing inclusive OR-joins with exclusive and parallel gateways.
//!
//! Favre, C. and Völzer, H. (2012). *The Difficulty of Replacing an Inclusive
//! OR-Join.* BPM 2012, LNCS 7481, 156–171 — the reference Split Miner points
//! at when it says its OR-joins "can be replaced with combinations of AND and
//! XOR gateways" so that Petri-net-based tools can read its models at all.
//!
//! # Why it is not just a relabelling
//!
//! An inclusive join is enabled when at least one of its incoming edges holds a
//! token *and no token may still arrive* on an empty one. That second clause is
//! not local: whether the join may fire depends on tokens nowhere near it. So a
//! replacement has to reconstruct, from the structure of the graph, which
//! combinations of its incoming edges can carry tokens together — and the paper
//! is titled the way it is because that is not always possible.
//!
//! # The local replacement
//!
//! What *is* always possible when it applies, and what this implements, is the
//! paper's **local** replacement: the join is replaced by a sub-graph over the
//! same incoming and outgoing edges, built only from exclusive and parallel
//! gateways, leaving the rest of the diagram untouched. Its shape is a
//! partition of the incoming edges into groups where
//!
//! - within a group, the edges are **mutually exclusive** — at most one of them
//!   ever carries a token, so one exclusive join merges them;
//! - across groups, the groups are **always concurrent** — each is active
//!   exactly when the others are, so one parallel join synchronises them.
//!
//! The two familiar cases fall out of that: every edge mutually exclusive is a
//! single group and a plain XOR-join; every edge always concurrent is one group
//! per edge and a plain AND-join.
//!
//! # How the relations are computed
//!
//! By symbolic execution over the loop-free skeleton. Each exclusive split is a
//! decision; every edge carries the condition under which a token reaches it, as
//! a disjunction of conjunctions of decision literals. Two edges are then
//! mutually exclusive when their conditions cannot both hold, and always
//! concurrent when each implies the other.
//!
//! Implication is tested by term subsumption, which is sound but not complete:
//! a pair this cannot prove concurrent is reported as "could not be replaced"
//! rather than replaced on a guess. An inclusive join left in place is a fact
//! about the model that the caller can act on; one replaced wrongly is a model
//! that means something else.
//!
//! # Loops
//!
//! The paper's semantics, and this analysis, are for acyclic graphs. A join fed
//! by a loop's back edge is still handled, because it is the one cyclic case
//! whose answer is not in doubt: in a safe process a token reaches a loop's
//! merge either from outside the loop or from the back edge, never both at
//! once, so its arrivals are mutually exclusive and it becomes a XOR-join —
//! provided its forward edges are mutually exclusive too, which is checked
//! rather than assumed.

use crate::{Bpmn, Flow, Node, NodeId, NodeKind};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

/// A conjunction of decision literals: exclusive gateway id -> which of its
/// outgoing flows was taken.
type Term = BTreeMap<NodeId, NodeId>;

/// A condition in disjunctive normal form. Empty means unsatisfiable; a single
/// empty term means "always".
#[derive(Clone, PartialEq, Debug)]
struct Condition(Vec<Term>);

/// Past this many terms a condition stops being analysed. Conditions that hit
/// it make their joins unreplaceable rather than silently approximate — and no
/// model this is aimed at comes close, because a discovered model's decisions
/// are shallow.
const MAX_TERMS: usize = 256;

impl Condition {
    fn always() -> Self {
        Condition(vec![Term::new()])
    }
    fn never() -> Self {
        Condition(Vec::new())
    }
    fn is_never(&self) -> bool {
        self.0.is_empty()
    }
    fn too_big(&self) -> bool {
        self.0.len() > MAX_TERMS
    }

    fn and(&self, other: &Condition) -> Condition {
        let mut terms = Vec::new();
        for a in &self.0 {
            'pairs: for b in &other.0 {
                let mut merged = a.clone();
                for (gateway, branch) in b {
                    match merged.get(gateway) {
                        // The same decision cannot have gone two ways, so this
                        // pair of terms describes no execution at all.
                        Some(taken) if taken != branch => continue 'pairs,
                        _ => {
                            merged.insert(gateway.clone(), branch.clone());
                        }
                    }
                }
                if !terms.contains(&merged) {
                    terms.push(merged);
                }
                if terms.len() > MAX_TERMS {
                    return Condition(terms);
                }
            }
        }
        Condition(terms)
    }

    fn or(&self, other: &Condition) -> Condition {
        let mut terms = self.0.clone();
        for b in &other.0 {
            if !terms.contains(b) {
                terms.push(b.clone());
            }
            if terms.len() > MAX_TERMS {
                break;
            }
        }
        Condition(terms)
    }

    /// One decision going one way.
    fn literal(gateway: &str, branch: &str) -> Condition {
        Condition(vec![Term::from([(gateway.to_string(), branch.to_string())])])
    }

    /// Collapses a decision that has been split every way it can go.
    ///
    /// `{x = left} or {x = right}` is simply "true" when `left` and `right` are
    /// all the branches `x` has — and without knowing that, the subsumption
    /// test below cannot see that a choice whose branches all reconverge is
    /// concurrent with anything outside it, which is the single most common
    /// shape a discovered model has. `branches` maps each exclusive gateway to
    /// all of its outgoing flows.
    fn simplify(&mut self, branches: &HashMap<String, Vec<String>>) {
        loop {
            let mut collapsed = None;
            'search: for index in 0..self.0.len() {
                // Every decision this term mentions is a candidate, not just
                // the first: a term like `{x = left, y = up}` may be part of a
                // complete split on `y` while `x` is still open. Giving up on
                // the term after `x` leaves the condition unsimplified, and an
                // unsimplified condition looks unrelated to every other one.
                for gateway in self.0[index].keys().cloned().collect::<Vec<_>>() {
                    let Some(all) = branches.get(&gateway) else { continue };
                    if all.len() < 2 {
                        continue;
                    }
                    let mut without = self.0[index].clone();
                    without.remove(&gateway);
                    let mut positions = Vec::new();
                    let mut every_branch = true;
                    for branch in all {
                        let mut probe = without.clone();
                        probe.insert(gateway.clone(), branch.clone());
                        match self.0.iter().position(|t| *t == probe) {
                            Some(at) => positions.push(at),
                            None => {
                                every_branch = false;
                                break;
                            }
                        }
                    }
                    if every_branch {
                        collapsed = Some((positions, without));
                        break 'search;
                    }
                }
            }
            let Some((mut positions, without)) = collapsed else { return };
            positions.sort_unstable_by(|a, b| b.cmp(a));
            for at in positions {
                self.0.remove(at);
            }
            if !self.0.contains(&without) {
                self.0.push(without);
            }
        }
    }

    /// Sound, deliberately incomplete: every term of `self` is subsumed by some
    /// term of `other`. A term implies another when it assigns at least
    /// everything that one does, identically.
    fn implies(&self, other: &Condition) -> bool {
        self.0.iter().all(|mine| {
            other.0.iter().any(|theirs| {
                theirs.iter().all(|(gateway, branch)| mine.get(gateway) == Some(branch))
            })
        })
    }

    fn equivalent(&self, other: &Condition) -> bool {
        self.implies(other) && other.implies(self)
    }

    fn excludes(&self, other: &Condition) -> bool {
        self.and(other).is_never()
    }
}

/// What [`replace`] did, and what it could not do.
pub struct Replacement {
    pub bpmn: Bpmn,
    /// `(join id, how)` for each inclusive join that was replaced.
    pub replaced: Vec<(NodeId, String)>,
    /// `(gateway id, why)` for each inclusive gateway still in the diagram.
    pub kept: Vec<(NodeId, String)>,
}

impl Replacement {
    pub fn is_complete(&self) -> bool {
        self.kept.is_empty()
    }
}

/// Edges whose target is an ancestor of their source in a depth-first walk from
/// the start event — the diagram's loops.
fn back_edges(bpmn: &Bpmn, start: &str) -> HashSet<String> {
    let mut back = HashSet::new();
    let mut on_stack: HashSet<String> = HashSet::from([start.to_string()]);
    let mut done: HashSet<String> = HashSet::new();
    let mut stack: Vec<(String, usize)> = vec![(start.to_string(), 0)];
    while let Some((node, cursor)) = stack.last().cloned() {
        let outgoing: Vec<&Flow> = bpmn.outgoing(&node).collect();
        if cursor < outgoing.len() {
            let flow = outgoing[cursor];
            stack.last_mut().unwrap().1 += 1;
            if on_stack.contains(&flow.target) {
                back.insert(flow.id.clone());
            } else if !done.contains(&flow.target) {
                on_stack.insert(flow.target.clone());
                stack.push((flow.target.clone(), 0));
            }
        } else {
            on_stack.remove(&node);
            done.insert(node);
            stack.pop();
        }
    }
    back
}

/// The condition under which a token reaches each flow, computed over the
/// skeleton with `back` removed. A flow with no entry could not be placed in
/// topological order and is treated as unknown by the callers.
fn conditions(
    bpmn: &Bpmn,
    back: &HashSet<String>,
    branches: &HashMap<String, Vec<String>>,
) -> HashMap<String, Condition> {
    let forward: Vec<&Flow> = bpmn.flows.iter().filter(|f| !back.contains(&f.id)).collect();
    let mut indegree: HashMap<&str, usize> = bpmn.nodes.iter().map(|n| (n.id.as_str(), 0)).collect();
    for flow in &forward {
        *indegree.entry(flow.target.as_str()).or_insert(0) += 1;
    }

    let mut ready: Vec<&str> =
        indegree.iter().filter(|(_, &d)| d == 0).map(|(&n, _)| n).collect();
    ready.sort_unstable();
    let mut order: Vec<&str> = Vec::new();
    while let Some(node) = ready.pop() {
        order.push(node);
        for flow in forward.iter().filter(|f| f.source == node) {
            let slot = indegree.get_mut(flow.target.as_str()).unwrap();
            *slot -= 1;
            if *slot == 0 {
                ready.push(flow.target.as_str());
            }
        }
    }

    let mut on_flow: HashMap<String, Condition> = HashMap::new();
    for node in order {
        let incoming: Vec<&Flow> =
            forward.iter().copied().filter(|f| f.target == node).collect();
        let kind = bpmn.node(node).map(|n| n.kind);

        let arrives = if incoming.is_empty() {
            // The start event, or a node the skeleton only reaches by a back
            // edge — in both cases there is nothing upstream to condition on.
            Condition::always()
        } else if incoming.len() == 1 {
            on_flow.get(&incoming[0].id).cloned().unwrap_or_else(Condition::never)
        } else {
            let mut combined = if kind == Some(NodeKind::ParallelGateway) {
                Condition::always()
            } else {
                Condition::never()
            };
            for flow in &incoming {
                let each = on_flow.get(&flow.id).cloned().unwrap_or_else(Condition::never);
                combined = if kind == Some(NodeKind::ParallelGateway) {
                    combined.and(&each)
                } else {
                    combined.or(&each)
                };
            }
            combined
        };

        let outgoing: Vec<&Flow> = forward.iter().copied().filter(|f| f.source == node).collect();
        let exclusive_split = kind == Some(NodeKind::ExclusiveGateway) && outgoing.len() > 1;
        for flow in outgoing {
            let mut condition = if exclusive_split {
                arrives.and(&Condition::literal(node, &flow.id))
            } else {
                arrives.clone()
            };
            condition.simplify(branches);
            on_flow.insert(flow.id.clone(), condition);
        }
    }
    on_flow
}

/// Every partition of `0..n` into non-empty groups. Only ever called for the
/// incoming edges of one join, and bounded by [`MAX_INPUTS`].
fn partitions(n: usize) -> Vec<Vec<Vec<usize>>> {
    if n == 0 {
        return vec![Vec::new()];
    }
    let mut out = Vec::new();
    for smaller in partitions(n - 1) {
        for slot in 0..smaller.len() {
            let mut next = smaller.clone();
            next[slot].push(n - 1);
            out.push(next);
        }
        let mut next = smaller;
        next.push(vec![n - 1]);
        out.push(next);
    }
    out
}

/// Beyond this many incoming edges the partition search is not attempted. The
/// count of partitions of 8 is 4,140; of 12 it is over four million, and a join
/// with twelve incoming edges is not a join anyone is reading anyway.
const MAX_INPUTS: usize = 8;

/// The paper's grouping: mutually exclusive within a group, always concurrent
/// across groups. Returns the coarsest such partition — fewest groups, so
/// fewest gateways — or `None` when no grouping works.
fn group(
    conditions: &[&Condition],
    branches: &HashMap<String, Vec<String>>,
) -> Option<Vec<Vec<usize>>> {
    let mut best: Option<Vec<Vec<usize>>> = None;
    for partition in partitions(conditions.len()) {
        let internally_exclusive = partition.iter().all(|g| {
            g.iter().enumerate().all(|(i, &a)| {
                g[i + 1..].iter().all(|&b| conditions[a].excludes(conditions[b]))
            })
        });
        if !internally_exclusive {
            continue;
        }
        let merged: Vec<Condition> = partition
            .iter()
            .map(|g| {
                let mut union = g.iter().fold(Condition::never(), |acc, &i| acc.or(conditions[i]));
                union.simplify(branches);
                union
            })
            .collect();
        let groups_concurrent = merged
            .iter()
            .enumerate()
            .all(|(i, a)| merged[i + 1..].iter().all(|b| a.equivalent(b)));
        if !groups_concurrent {
            continue;
        }
        if best.as_ref().is_none_or(|b| partition.len() < b.len()) {
            best = Some(partition);
        }
    }
    best
}

/// Replaces every inclusive OR-join it can with exclusive and parallel
/// gateways, leaving the rest of the diagram untouched.
///
/// Errors only when the diagram has no start event to analyse from. An
/// inclusive gateway that cannot be replaced is reported in
/// [`Replacement::kept`], not raised — a partial replacement is still a better
/// diagram than none, and the caller is told exactly what is left.
pub fn replace(bpmn: &Bpmn) -> Result<Replacement, String> {
    let start = bpmn
        .nodes
        .iter()
        .find(|n| n.kind == NodeKind::StartEvent)
        .ok_or("no start event")?
        .id
        .clone();

    let back = back_edges(bpmn, &start);
    let branches = exclusive_branches(bpmn);
    let on_flow = conditions(bpmn, &back, &branches);

    let mut nodes: Vec<Node> = bpmn.nodes.clone();
    let mut flows: Vec<Flow> = bpmn.flows.clone();
    let mut replaced = Vec::new();
    let mut kept = Vec::new();
    let mut used_ids: HashSet<String> = bpmn.nodes.iter().map(|n| n.id.clone()).collect();
    let mut used_flow_ids: HashSet<String> = bpmn.flows.iter().map(|f| f.id.clone()).collect();

    let inclusive: Vec<String> = bpmn
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::InclusiveGateway)
        .map(|n| n.id.clone())
        .collect();

    for gateway in inclusive {
        let incoming: Vec<Flow> = bpmn.incoming(&gateway).cloned().collect();
        let outgoing = bpmn.outgoing(&gateway).count();

        if outgoing > 1 {
            kept.push((
                gateway,
                "an inclusive *split* — this replaces inclusive joins, and a split's \
                 subset-of-branches choice has no equivalent built from exclusive and \
                 parallel gateways of the same size"
                    .to_string(),
            ));
            continue;
        }
        if incoming.len() < 2 {
            // Routes one token to one place; exclusive says that exactly.
            set_kind(&mut nodes, &gateway, NodeKind::ExclusiveGateway);
            replaced.push((gateway, "exclusive (it merges nothing)".to_string()));
            continue;
        }
        if incoming.len() > MAX_INPUTS {
            kept.push((
                gateway,
                format!("{} incoming flows — beyond the {MAX_INPUTS} this analyses", incoming.len()),
            ));
            continue;
        }

        let loops: Vec<&Flow> = incoming.iter().filter(|f| back.contains(&f.id)).collect();
        let forward: Vec<&Flow> = incoming.iter().filter(|f| !back.contains(&f.id)).collect();

        let unknown = forward.iter().any(|f| {
            on_flow.get(&f.id).map(|c| c.too_big()).unwrap_or(true)
        });
        if unknown {
            kept.push((
                gateway,
                "the conditions reaching it were too large to analyse".to_string(),
            ));
            continue;
        }

        if !loops.is_empty() {
            // A loop's merge. In a safe process a token arrives from outside
            // the loop or from the back edge, never both at once — so the
            // arrivals are exclusive, provided the forward ones are too.
            let forward_conditions: Vec<&Condition> =
                forward.iter().map(|f| &on_flow[&f.id]).collect();
            let exclusive = forward_conditions.iter().enumerate().all(|(i, a)| {
                forward_conditions[i + 1..].iter().all(|b| a.excludes(b))
            });
            if exclusive {
                set_kind(&mut nodes, &gateway, NodeKind::ExclusiveGateway);
                replaced.push((gateway, "exclusive (a loop merge)".to_string()));
            } else {
                kept.push((
                    gateway,
                    "a loop merge whose forward flows are not mutually exclusive".to_string(),
                ));
            }
            continue;
        }

        let conditions: Vec<&Condition> = incoming.iter().map(|f| &on_flow[&f.id]).collect();
        let Some(groups) = group(&conditions, &branches) else {
            kept.push((
                gateway,
                "its incoming flows could not be grouped into mutually exclusive sets that are \
                 always concurrent with one another — this is the case the paper is named for"
                    .to_string(),
            ));
            continue;
        };

        if groups.len() == 1 {
            set_kind(&mut nodes, &gateway, NodeKind::ExclusiveGateway);
            replaced.push((gateway, "exclusive (every flow mutually exclusive)".to_string()));
            continue;
        }

        // Several groups: the gateway itself becomes the parallel join, and
        // every group holding more than one flow gets an exclusive join in
        // front of it. A single-flow group needs nothing — it already arrives.
        set_kind(&mut nodes, &gateway, NodeKind::ParallelGateway);
        let multi = groups.iter().filter(|g| g.len() > 1).count();
        for (index, members) in groups.iter().enumerate().filter(|(_, g)| g.len() > 1) {
            let merge = unique_id(&mut used_ids, &format!("{gateway}_or{index}"));
            nodes.push(Node { id: merge.clone(), kind: NodeKind::ExclusiveGateway, label: None });
            for &member in members {
                let flow_id = &incoming[member].id;
                if let Some(flow) = flows.iter_mut().find(|f| &f.id == flow_id) {
                    flow.target = merge.clone();
                }
            }
            let id = unique_id(&mut used_flow_ids, &format!("{merge}_to_{gateway}"));
            flows.push(Flow { id, source: merge, target: gateway.clone(), label: None });
        }
        replaced.push((
            gateway,
            format!(
                "parallel over {} group{}, {} of them merged by an exclusive join",
                groups.len(),
                if groups.len() == 1 { "" } else { "s" },
                multi
            ),
        ));
    }

    let mut metadata = bpmn.metadata.clone();
    for (gateway, how) in &replaced {
        metadata.warnings.push(format!("inclusive join {gateway} replaced: {how}"));
    }
    for (gateway, why) in &kept {
        metadata.warnings.push(format!("inclusive gateway {gateway} kept: {why}"));
    }

    let bpmn = Bpmn { nodes, flows, metadata };
    Ok(Replacement { bpmn, replaced, kept })
}

/// Every exclusive split, with all the flows it can take.
fn exclusive_branches(bpmn: &Bpmn) -> HashMap<String, Vec<String>> {
    bpmn.nodes
        .iter()
        .filter(|n| n.kind == NodeKind::ExclusiveGateway)
        .filter_map(|n| {
            let out: Vec<String> = bpmn.outgoing(&n.id).map(|f| f.id.clone()).collect();
            (out.len() > 1).then(|| (n.id.clone(), out))
        })
        .collect()
}

fn set_kind(nodes: &mut [Node], id: &str, kind: NodeKind) {
    if let Some(node) = nodes.iter_mut().find(|n| n.id == id) {
        node.kind = kind;
    }
}

fn unique_id(used: &mut HashSet<String>, wanted: &str) -> String {
    let mut candidate = wanted.to_string();
    let mut suffix = 1;
    while used.contains(&candidate) {
        candidate = format!("{wanted}_{suffix}");
        suffix += 1;
    }
    used.insert(candidate.clone());
    candidate
}

/// The inclusive gateways still in a diagram, for a caller that needs to say
/// which ones blocked it.
pub fn inclusive_gateways(bpmn: &Bpmn) -> BTreeSet<NodeId> {
    bpmn.nodes
        .iter()
        .filter(|n| n.kind == NodeKind::InclusiveGateway)
        .map(|n| n.id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Metadata;

    fn n(id: &str, kind: NodeKind) -> Node {
        Node { id: id.into(), kind, label: if kind == NodeKind::Task { Some(id.into()) } else { None } }
    }
    fn f(id: &str, source: &str, target: &str) -> Flow {
        Flow { id: id.into(), source: source.into(), target: target.into(), label: None }
    }
    fn diagram(nodes: Vec<Node>, flows: Vec<Flow>) -> Bpmn {
        Bpmn { nodes, flows, metadata: Metadata { source_type: None, structured: false, warnings: Vec::new() } }
    }
    fn kind_of(bpmn: &Bpmn, id: &str) -> NodeKind {
        bpmn.node(id).unwrap().kind
    }

    /// start -> split(X) -> {a, b} -> join(O) -> end
    fn exclusive_diamond() -> Bpmn {
        diagram(
            vec![
                n("start", NodeKind::StartEvent), n("s", NodeKind::ExclusiveGateway),
                n("a", NodeKind::Task), n("b", NodeKind::Task),
                n("j", NodeKind::InclusiveGateway), n("end", NodeKind::EndEvent),
            ],
            vec![
                f("f0", "start", "s"), f("f1", "s", "a"), f("f2", "s", "b"),
                f("f3", "a", "j"), f("f4", "b", "j"), f("f5", "j", "end"),
            ],
        )
    }

    /// The same shape with a parallel split.
    fn parallel_diamond() -> Bpmn {
        let mut bpmn = exclusive_diamond();
        bpmn.nodes.iter_mut().find(|x| x.id == "s").unwrap().kind = NodeKind::ParallelGateway;
        bpmn
    }

    #[test]
    fn mutually_exclusive_inputs_become_an_exclusive_join() {
        let out = replace(&exclusive_diamond()).unwrap();
        assert_eq!(kind_of(&out.bpmn, "j"), NodeKind::ExclusiveGateway);
        assert!(out.is_complete());
        assert_eq!(out.bpmn.nodes.len(), 6, "no gateway had to be added");
        assert_eq!(out.bpmn.validate(), Ok(()));
    }

    #[test]
    fn always_concurrent_inputs_become_a_parallel_join() {
        let out = replace(&parallel_diamond()).unwrap();
        assert_eq!(kind_of(&out.bpmn, "j"), NodeKind::ParallelGateway);
        assert!(out.is_complete());
        assert_eq!(out.bpmn.nodes.len(), 6);
    }

    #[test]
    fn a_group_of_exclusive_flows_concurrent_with_another_becomes_both() {
        // start -> AND -> { XOR -> {a, b} ; c } -> inclusive join -> end.
        // a and b are exclusive; either is concurrent with c. The replacement
        // is a XOR join over {a, b}, feeding an AND join with c.
        let bpmn = diagram(
            vec![
                n("start", NodeKind::StartEvent), n("and", NodeKind::ParallelGateway),
                n("xor", NodeKind::ExclusiveGateway), n("a", NodeKind::Task),
                n("b", NodeKind::Task), n("c", NodeKind::Task),
                n("j", NodeKind::InclusiveGateway), n("end", NodeKind::EndEvent),
            ],
            vec![
                f("f0", "start", "and"), f("f1", "and", "xor"), f("f2", "and", "c"),
                f("f3", "xor", "a"), f("f4", "xor", "b"),
                f("f5", "a", "j"), f("f6", "b", "j"), f("f7", "c", "j"),
                f("f8", "j", "end"),
            ],
        );
        let out = replace(&bpmn).unwrap();
        assert!(out.is_complete(), "kept: {:?}", out.kept);
        assert_eq!(kind_of(&out.bpmn, "j"), NodeKind::ParallelGateway);
        assert_eq!(out.bpmn.nodes.len(), 9, "one exclusive join was added");
        assert_eq!(out.bpmn.validate(), Ok(()));

        // a and b now merge at the new gateway, and c still reaches the join.
        let merge = out.bpmn.node("j_or0").expect("the added gateway keeps a derived id");
        assert_eq!(merge.kind, NodeKind::ExclusiveGateway);
        assert_eq!(out.bpmn.incoming("j_or0").count(), 2);
        assert_eq!(out.bpmn.incoming("j").count(), 2, "the merge and c");
        assert!(out.bpmn.outgoing("c").any(|x| x.target == "j"));
    }

    #[test]
    fn a_loop_merge_becomes_exclusive() {
        // start -> j(O) -> a -> xor -> { back to j, end }
        let bpmn = diagram(
            vec![
                n("start", NodeKind::StartEvent), n("j", NodeKind::InclusiveGateway),
                n("a", NodeKind::Task), n("x", NodeKind::ExclusiveGateway),
                n("end", NodeKind::EndEvent),
            ],
            vec![
                f("f0", "start", "j"), f("f1", "j", "a"), f("f2", "a", "x"),
                f("f3", "x", "j"), f("f4", "x", "end"),
            ],
        );
        let out = replace(&bpmn).unwrap();
        assert_eq!(kind_of(&out.bpmn, "j"), NodeKind::ExclusiveGateway);
        assert!(out.is_complete());
        assert_eq!(out.replaced[0].1, "exclusive (a loop merge)");
    }

    #[test]
    fn an_inclusive_split_is_reported_rather_than_guessed_at() {
        let mut bpmn = exclusive_diamond();
        bpmn.nodes.iter_mut().find(|x| x.id == "s").unwrap().kind = NodeKind::InclusiveGateway;
        let out = replace(&bpmn).unwrap();
        assert!(!out.is_complete());
        assert!(out.kept.iter().any(|(id, why)| id == "s" && why.contains("inclusive *split*")));
        // The join is still replaced: what can be done, is.
        assert_eq!(kind_of(&out.bpmn, "j"), NodeKind::ParallelGateway);
    }

    #[test]
    fn a_join_that_cannot_be_grouped_is_left_alone() {
        // Two exclusive splits feeding one join: whether the two flows arrive
        // together depends on two independent decisions, so they are neither
        // mutually exclusive nor always concurrent.
        let bpmn = diagram(
            vec![
                n("start", NodeKind::StartEvent), n("and", NodeKind::ParallelGateway),
                n("x1", NodeKind::ExclusiveGateway), n("x2", NodeKind::ExclusiveGateway),
                n("a", NodeKind::Task), n("b", NodeKind::Task),
                n("skip1", NodeKind::Task), n("skip2", NodeKind::Task),
                n("j", NodeKind::InclusiveGateway), n("t", NodeKind::ParallelGateway),
                n("end", NodeKind::EndEvent),
            ],
            vec![
                f("f0", "start", "and"), f("f1", "and", "x1"), f("f2", "and", "x2"),
                f("f3", "x1", "a"), f("f4", "x1", "skip1"),
                f("f5", "x2", "b"), f("f6", "x2", "skip2"),
                f("f7", "a", "j"), f("f8", "b", "j"),
                f("f9", "j", "t"), f("f10", "skip1", "t"), f("f11", "skip2", "t"),
                f("f12", "t", "end"),
            ],
        );
        let out = replace(&bpmn).unwrap();
        assert!(!out.is_complete());
        assert!(out.kept.iter().any(|(id, why)| id == "j" && why.contains("the paper is named for")));
        assert_eq!(kind_of(&out.bpmn, "j"), NodeKind::InclusiveGateway, "left as it was");
    }

    #[test]
    fn conditions_track_which_branch_was_taken() {
        let bpmn = exclusive_diamond();
        let back = back_edges(&bpmn, "start");
        assert!(back.is_empty());
        let on_flow = conditions(&bpmn, &back, &exclusive_branches(&bpmn));
        assert!(on_flow["f3"].excludes(&on_flow["f4"]), "the two branches cannot both run");
        assert!(!on_flow["f3"].equivalent(&on_flow["f4"]));
        assert!(on_flow["f0"].equivalent(&Condition::always()));
    }

    #[test]
    fn conditions_see_parallel_branches_as_concurrent() {
        let bpmn = parallel_diamond();
        let on_flow = conditions(&bpmn, &HashSet::new(), &exclusive_branches(&bpmn));
        assert!(on_flow["f3"].equivalent(&on_flow["f4"]));
        assert!(!on_flow["f3"].excludes(&on_flow["f4"]));
    }

    #[test]
    fn partitions_of_three_are_the_five_bell_partitions() {
        assert_eq!(partitions(3).len(), 5);
        assert_eq!(partitions(1).len(), 1);
        assert_eq!(partitions(4).len(), 15);
    }

    #[test]
    fn a_diagram_without_inclusive_gateways_is_returned_unchanged() {
        let mut bpmn = exclusive_diamond();
        bpmn.nodes.iter_mut().find(|x| x.id == "j").unwrap().kind = NodeKind::ExclusiveGateway;
        let out = replace(&bpmn).unwrap();
        assert!(out.replaced.is_empty() && out.kept.is_empty());
        assert_eq!(out.bpmn.nodes, bpmn.nodes);
        assert_eq!(out.bpmn.flows, bpmn.flows);
    }
}
