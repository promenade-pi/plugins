//! Object-Centric Inductive Miner (OCIM).
//!
//! The implementation keeps the object-centric information through the
//! recursion.  A node is not merely an activity label: every leaf carries the
//! object types related to it and the divergence/convergence/deficiency
//! predicates calculated on the original OCEL.  Cuts are detected over the
//! per-object lifecycle graphs, while splitting preserves one trace per
//! object.  This is the essential difference from mining a traditional log
//! once per object type and merging the resulting nets afterwards.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub type Activity = u32;

#[derive(Clone, Debug)]
pub struct ObjectTrace {
    pub object_type: String,
    pub events: Vec<Activity>,
}

#[derive(Clone, Debug, Default)]
pub struct Interaction {
    pub related: BTreeMap<Activity, BTreeSet<String>>,
    pub divergent: BTreeMap<Activity, BTreeSet<String>>,
    pub convergent: BTreeMap<Activity, BTreeSet<String>>,
    pub deficient: BTreeMap<Activity, BTreeSet<String>>,
}

impl Interaction {
    pub fn add(
        &mut self,
        activity: Activity,
        object_type: String,
        related: bool,
        divergent: bool,
        convergent: bool,
        deficient: bool,
    ) {
        if related {
            self.related
                .entry(activity)
                .or_default()
                .insert(object_type.clone());
        }
        if divergent {
            self.divergent
                .entry(activity)
                .or_default()
                .insert(object_type.clone());
        }
        if convergent {
            self.convergent
                .entry(activity)
                .or_default()
                .insert(object_type.clone());
        }
        if deficient {
            self.deficient
                .entry(activity)
                .or_default()
                .insert(object_type);
        }
    }
    fn types(&self, activity: Activity, kind: Kind) -> BTreeSet<String> {
        match kind {
            Kind::Related => self.related.get(&activity),
            Kind::Divergent => self.divergent.get(&activity),
            Kind::Convergent => self.convergent.get(&activity),
            Kind::Deficient => self.deficient.get(&activity),
        }
        .cloned()
        .unwrap_or_default()
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Related,
    Divergent,
    Convergent,
    Deficient,
}

#[derive(Clone, Debug)]
pub enum Tree {
    Tau,
    Activity(Activity),
    Sequence(Vec<Tree>),
    Xor(Vec<Tree>),
    Parallel(Vec<Tree>),
    Loop(Vec<Tree>),
}

#[derive(Clone, Debug)]
struct Local {
    traces: Vec<ObjectTrace>,
}

impl Local {
    fn initial(traces: Vec<ObjectTrace>) -> Self {
        Self { traces }
    }
    fn alphabet(&self) -> BTreeSet<Activity> {
        self.traces
            .iter()
            .flat_map(|t| t.events.iter().copied())
            .collect()
    }
    /// `drop_empty` mirrors the reference `split_log`: an XOR branch filters
    /// each object's rows directly, so an object with no surviving events
    /// silently disappears from that branch (`drop_empty: true`, matching
    /// `split_log`'s XOR case recomputing `expected_objects` from what's
    /// left). A sequence/parallel/loop branch instead keeps every object,
    /// including ones a filter emptied out entirely (`drop_empty: false`,
    /// matching those branches leaving `expected_objects` untouched) — that
    /// mix of empty- and non-empty-events traces for one object type is the
    /// raw material `missing_object_tau` reads to detect a partially-absent
    /// object type, in place of the reference's separate `expected_objects`
    /// vs `object_set` bookkeeping.
    fn filtered(&self, keep: &BTreeSet<Activity>, drop_empty: bool) -> Self {
        let traces: Vec<_> = self
            .traces
            .iter()
            .map(|t| ObjectTrace {
                object_type: t.object_type.clone(),
                events: t
                    .events
                    .iter()
                    .copied()
                    .filter(|a| keep.contains(a))
                    .collect(),
            })
            .filter(|t| !drop_empty || !t.events.is_empty())
            .collect();
        Self { traces }
    }
}

#[derive(Default)]
struct Graph {
    direct: BTreeSet<(Activity, Activity)>,
    start: BTreeSet<Activity>,
    end: BTreeSet<Activity>,
    closure: BTreeSet<(Activity, Activity)>,
}

fn graphs(local: &Local) -> BTreeMap<String, Graph> {
    let mut out: BTreeMap<String, Graph> = BTreeMap::new();
    for trace in &local.traces {
        let g = out.entry(trace.object_type.clone()).or_default();
        if let Some(a) = trace.events.first() {
            g.start.insert(*a);
        }
        if let Some(a) = trace.events.last() {
            g.end.insert(*a);
        }
        for edge in trace.events.windows(2) {
            g.direct.insert((edge[0], edge[1]));
        }
    }
    for g in out.values_mut() {
        let nodes: BTreeSet<_> = g
            .direct
            .iter()
            .flat_map(|(a, b)| [*a, *b])
            .chain(g.start.iter().copied())
            .chain(g.end.iter().copied())
            .collect();
        for source in &nodes {
            let mut seen = BTreeSet::new();
            let mut todo = vec![*source];
            while let Some(a) = todo.pop() {
                for (x, y) in &g.direct {
                    if *x == a && seen.insert(*y) {
                        todo.push(*y);
                    }
                }
            }
            // A source reached again through at least one edge is a genuine
            // reflexive closure edge. OCIM's loop predicate relies on that
            // distinction: `A B A` makes both A and B eventually follow
            // themselves, while a one-off activity does not.
            for target in seen {
                g.closure.insert((*source, target));
            }
        }
    }
    out
}

fn common_non_divergent(a: Activity, b: Activity, interaction: &Interaction) -> BTreeSet<String> {
    non_divergent_types(a, b, &BTreeSet::from([a, b]), interaction)
}

fn components(
    nodes: &[Activity],
    join: impl Fn(Activity, Activity) -> bool,
) -> Vec<BTreeSet<Activity>> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for &start in nodes {
        if !seen.insert(start) {
            continue;
        }
        let mut group = BTreeSet::from([start]);
        let mut todo = vec![start];
        while let Some(a) = todo.pop() {
            for &b in nodes {
                if seen.contains(&b) || !join(a, b) {
                    continue;
                }
                seen.insert(b);
                group.insert(b);
                todo.push(b);
            }
        }
        out.push(group);
    }
    out
}

// The reference miner classifies a type as non-divergent in the *current
// context*, rather than merely checking the two activities at either end of a
// candidate relation. This matters after a split: a type that is divergent (or
// absent) for every activity in a candidate block cannot establish ordering
// between two of its leaves. These helpers are direct translations of
// `auxillary_methods.py`.
fn non_divergent_types(
    a: Activity,
    b: Activity,
    context: &BTreeSet<Activity>,
    interaction: &Interaction,
) -> BTreeSet<String> {
    interaction
        .types(a, Kind::Related)
        .intersection(&interaction.types(b, Kind::Related))
        .filter(|typ| {
            context.iter().any(|c| {
                interaction.types(*c, Kind::Related).contains(*typ)
                    && !interaction.types(*c, Kind::Divergent).contains(*typ)
            })
        })
        .cloned()
        .collect()
}

fn divergent_types(
    a: Activity,
    b: Activity,
    context: &BTreeSet<Activity>,
    interaction: &Interaction,
) -> BTreeSet<String> {
    interaction
        .types(a, Kind::Related)
        .intersection(&interaction.types(b, Kind::Related))
        .filter(|typ| {
            context.iter().all(|c| {
                !interaction.types(*c, Kind::Related).contains(*typ)
                    || interaction.types(*c, Kind::Divergent).contains(*typ)
            })
        })
        .cloned()
        .collect()
}

fn group_context(groups: &[BTreeSet<Activity>]) -> BTreeSet<Activity> {
    groups.iter().flat_map(|g| g.iter().copied()).collect()
}

fn projected_boundaries(
    local: &Local,
    keep: &BTreeSet<Activity>,
    start: bool,
) -> BTreeMap<String, BTreeSet<Activity>> {
    let mut out: BTreeMap<String, BTreeSet<Activity>> = BTreeMap::new();
    for trace in &local.traces {
        let event = if start {
            trace.events.iter().find(|a| keep.contains(a))
        } else {
            trace.events.iter().rev().find(|a| keep.contains(a))
        };
        if let Some(a) = event {
            out.entry(trace.object_type.clone()).or_default().insert(*a);
        }
    }
    out
}

fn coalesce_groups(
    groups: Vec<BTreeSet<Activity>>,
    join: impl Fn(&BTreeSet<Activity>, &BTreeSet<Activity>) -> bool,
) -> Vec<BTreeSet<Activity>> {
    let mut seen = vec![false; groups.len()];
    let mut out = Vec::new();
    for initial in 0..groups.len() {
        if seen[initial] {
            continue;
        }
        seen[initial] = true;
        let mut queue = vec![initial];
        let mut merged = BTreeSet::new();
        while let Some(i) = queue.pop() {
            merged.extend(groups[i].iter().copied());
            for j in 0..groups.len() {
                if !seen[j] && join(&groups[i], &groups[j]) {
                    seen[j] = true;
                    queue.push(j);
                }
            }
        }
        out.push(merged);
    }
    out
}

fn partition_follows(
    groups: &[BTreeSet<Activity>],
    gs: &BTreeMap<String, Graph>,
    interaction: &Interaction,
) -> BTreeSet<(usize, usize)> {
    let mut edges = BTreeSet::new();
    for i in 0..groups.len() {
        for j in 0..groups.len() {
            if i == j {
                continue;
            }
            let context = group_context(&[groups[i].clone(), groups[j].clone()]);
            if groups[i].iter().any(|a| {
                groups[j].iter().any(|b| {
                    non_divergent_types(*a, *b, &context, interaction)
                        .iter()
                        .any(|typ| gs.get(typ).is_some_and(|g| g.closure.contains(&(*a, *b))))
                })
            }) {
                edges.insert((i, j));
            }
        }
    }
    edges
}

fn transitive_edges(edges: &BTreeSet<(usize, usize)>, n: usize) -> BTreeSet<(usize, usize)> {
    let mut closure = edges.clone();
    for k in 0..n {
        for i in 0..n {
            for j in 0..n {
                if closure.contains(&(i, k)) && closure.contains(&(k, j)) {
                    closure.insert((i, j));
                }
            }
        }
    }
    closure
}

fn topo_groups(
    groups: Vec<BTreeSet<Activity>>,
    edges: &BTreeSet<(usize, usize)>,
) -> Option<Vec<BTreeSet<Activity>>> {
    let mut indegree = vec![0usize; groups.len()];
    for &(_, target) in edges {
        indegree[target] += 1;
    }
    let mut ready: BTreeSet<usize> = (0..groups.len()).filter(|i| indegree[*i] == 0).collect();
    let mut order = Vec::new();
    while let Some(i) = ready.pop_first() {
        order.push(i);
        for &(from, to) in edges {
            if from == i {
                indegree[to] -= 1;
                if indegree[to] == 0 {
                    ready.insert(to);
                }
            }
        }
    }
    (order.len() == groups.len()).then(|| order.into_iter().map(|i| groups[i].clone()).collect())
}

fn sequence_cut_valid(
    local: &Local,
    groups: &[BTreeSet<Activity>],
    gs: &BTreeMap<String, Graph>,
    interaction: &Interaction,
) -> bool {
    if groups.len() < 2 || group_context(groups) != local.alphabet() {
        return false;
    }
    for i in 0..groups.len() {
        for j in i + 1..groups.len() {
            let context = group_context(&groups[i..=j]);
            for a in &groups[i] {
                for b in &groups[j] {
                    for typ in divergent_types(*a, *b, &context, interaction) {
                        let Some(g) = gs.get(&typ) else {
                            return false;
                        };
                        if !g.direct.contains(&(*a, *b)) || !g.direct.contains(&(*b, *a)) {
                            return false;
                        }
                    }
                    for typ in non_divergent_types(*a, *b, &context, interaction) {
                        let Some(g) = gs.get(&typ) else {
                            return false;
                        };
                        if !g.closure.contains(&(*a, *b)) || g.closure.contains(&(*b, *a)) {
                            return false;
                        }
                    }
                }
            }
        }
    }
    (0..groups.len() - 1).all(|i| {
        let context = group_context(&[groups[i].clone(), groups[i + 1].clone()]);
        groups[i].iter().any(|a| {
            groups[i + 1]
                .iter()
                .any(|b| !non_divergent_types(*a, *b, &context, interaction).is_empty())
        })
    })
}

fn xor_cut_valid(
    local: &Local,
    groups: &[BTreeSet<Activity>],
    gs: &BTreeMap<String, Graph>,
    interaction: &Interaction,
) -> bool {
    if groups.len() < 2 || group_context(groups) != local.alphabet() {
        return false;
    }
    for group in groups {
        let starts = projected_boundaries(local, group, true);
        let ends = projected_boundaries(local, group, false);
        for a in group {
            for typ in interaction.types(*a, Kind::Related) {
                if starts.get(&typ).is_some_and(|s| s.contains(a))
                    && !gs.get(&typ).is_some_and(|g| g.start.contains(a))
                {
                    return false;
                }
                if ends.get(&typ).is_some_and(|e| e.contains(a))
                    && !gs.get(&typ).is_some_and(|g| g.end.contains(a))
                {
                    return false;
                }
            }
        }
    }
    for i in 0..groups.len() {
        for j in i + 1..groups.len() {
            let context = group_context(&[groups[i].clone(), groups[j].clone()]);
            let mut witness = false;
            for a in &groups[i] {
                for b in &groups[j] {
                    let non_div = non_divergent_types(*a, *b, &context, interaction);
                    witness |= !non_div.is_empty();
                    for typ in non_div {
                        let g = &gs[&typ];
                        if g.direct.contains(&(*a, *b)) || g.direct.contains(&(*b, *a)) {
                            return false;
                        }
                    }
                    for typ in divergent_types(*a, *b, &context, interaction) {
                        let g = &gs[&typ];
                        if !g.direct.contains(&(*a, *b)) || !g.direct.contains(&(*b, *a)) {
                            return false;
                        }
                    }
                }
            }
            if !witness {
                return false;
            }
        }
    }
    true
}

fn loop_cut_valid(
    local: &Local,
    body: &BTreeSet<Activity>,
    redo: &BTreeSet<Activity>,
    gs: &BTreeMap<String, Graph>,
    interaction: &Interaction,
) -> bool {
    let parts = vec![body.clone(), redo.clone()];
    if group_context(&parts) != local.alphabet() || body.is_empty() || redo.is_empty() {
        return false;
    }
    let context = group_context(&parts);
    let relevant: BTreeSet<_> = body
        .iter()
        .flat_map(|a| {
            redo.iter()
                .flat_map(|b| non_divergent_types(*a, *b, &context, interaction))
        })
        .collect();
    if relevant.is_empty() {
        return false;
    }
    for a in &context {
        for b in &context {
            for typ in non_divergent_types(*a, *b, &context, interaction) {
                let g = &gs[&typ];
                if !g.closure.contains(&(*a, *b)) || !g.closure.contains(&(*b, *a)) {
                    return false;
                }
            }
        }
    }
    for typ in &relevant {
        let g = &gs[typ];
        if g.start
            .iter()
            .any(|a| context.contains(a) && !body.contains(a))
            || g.end
                .iter()
                .any(|a| context.contains(a) && !body.contains(a))
        {
            return false;
        }
    }
    for a in body {
        for b in redo {
            for typ in non_divergent_types(*a, *b, &context, interaction) {
                if gs[&typ].direct.contains(&(*a, *b)) && !gs[&typ].end.contains(a) {
                    return false;
                }
            }
        }
    }
    for a in redo {
        for b in body {
            for typ in non_divergent_types(*a, *b, &context, interaction) {
                if gs[&typ].direct.contains(&(*a, *b)) && !gs[&typ].start.contains(b) {
                    return false;
                }
            }
        }
    }
    true
}

/// Exact staged shape of Algorithm 6 in the reference implementation. In
/// particular, incomparable partition parts are merged before sorting; an
/// empty follows graph can no longer become an arbitrary global sequence.
fn reference_sequence_cut(
    local: &Local,
    interaction: &Interaction,
) -> Option<Vec<BTreeSet<Activity>>> {
    let alphabet: Vec<_> = local.alphabet().into_iter().collect();
    if alphabet.len() < 2 {
        return None;
    }
    let gs = graphs(local);
    let initial = components(&alphabet, |a, b| {
        let context = BTreeSet::from([a, b]);
        non_divergent_types(a, b, &context, interaction)
            .iter()
            .any(|typ| {
                let Some(g) = gs.get(typ) else {
                    return false;
                };
                g.closure.contains(&(a, b)) == g.closure.contains(&(b, a))
            })
    });
    if initial.len() < 2 {
        return None;
    }

    let closure = transitive_edges(
        &partition_follows(&initial, &gs, interaction),
        initial.len(),
    );
    let mut groups = coalesce_groups(initial.clone(), |left, right| {
        let li = initial.iter().position(|g| g == left).unwrap();
        let ri = initial.iter().position(|g| g == right).unwrap();
        !closure.contains(&(li, ri)) || !closure.contains(&(ri, li))
    });
    if groups.len() < 2 {
        return None;
    }
    let follows = partition_follows(&groups, &gs, interaction);
    groups = topo_groups(groups, &follows)?;

    let snapshot = groups.clone();
    groups = coalesce_groups(groups, |left, right| {
        let li = snapshot.iter().position(|g| g == left).unwrap();
        let ri = snapshot.iter().position(|g| g == right).unwrap();
        let (lo, hi) = if li < ri { (li, ri) } else { (ri, li) };
        let context = group_context(&snapshot[lo..=hi]);
        left.iter().any(|a| {
            right.iter().any(|b| {
                divergent_types(*a, *b, &context, interaction)
                    .iter()
                    .any(|typ| {
                        let g = gs.get(typ).unwrap();
                        !g.direct.contains(&(*a, *b)) || !g.direct.contains(&(*b, *a))
                    })
            })
        })
    });
    if groups.len() < 2 {
        return None;
    }

    loop {
        let closure = transitive_edges(&partition_follows(&groups, &gs, interaction), groups.len());
        let snapshot = groups.clone();
        let next = coalesce_groups(groups, |left, right| {
            let li = snapshot.iter().position(|g| g == left).unwrap();
            let ri = snapshot.iter().position(|g| g == right).unwrap();
            closure.contains(&(li, ri)) && closure.contains(&(ri, li))
        });
        if next.len() == snapshot.len() {
            groups = next;
            break;
        }
        groups = next;
    }
    if groups.len() < 2 {
        return None;
    }
    let follows = partition_follows(&groups, &gs, interaction);
    let groups = topo_groups(groups, &follows)?;
    sequence_cut_valid(local, &groups, &gs, interaction).then_some(groups)
}

#[derive(Clone, Copy)]
enum FallthroughOperator {
    Xor,
    Parallel,
    Sequence,
    Loop,
}

fn binary_groups(groups: Vec<BTreeSet<Activity>>) -> Option<Vec<BTreeSet<Activity>>> {
    if groups.len() < 2 {
        return None;
    }
    let mut first = groups[0].clone();
    let mut second = BTreeSet::new();
    for group in groups.into_iter().skip(1) {
        second.extend(group);
    }
    (!first.is_empty() && !second.is_empty()).then(|| vec![std::mem::take(&mut first), second])
}

fn score_ratio(correct: usize, missing: usize) -> f64 {
    let total = correct + missing;
    if total == 0 {
        1.0
    } else {
        correct as f64 / total as f64
    }
}

fn score_parallel(
    parts: &[BTreeSet<Activity>],
    gs: &BTreeMap<String, Graph>,
    interaction: &Interaction,
) -> f64 {
    let (mut correct, mut missing) = (0, 0);
    for a in &parts[0] {
        for b in &parts[1] {
            for typ in interaction
                .types(*a, Kind::Related)
                .intersection(&interaction.types(*b, Kind::Related))
            {
                let g = &gs[typ];
                for edge in [(*a, *b), (*b, *a)] {
                    if g.direct.contains(&edge) {
                        correct += 1;
                    } else {
                        missing += 1;
                    }
                }
            }
        }
    }
    score_ratio(correct, missing)
}

fn score_xor(
    parts: &[BTreeSet<Activity>],
    gs: &BTreeMap<String, Graph>,
    interaction: &Interaction,
) -> f64 {
    let context = group_context(parts);
    let (mut correct, mut missing) = (0, 0);
    for a in &parts[0] {
        for b in &parts[1] {
            for typ in divergent_types(*a, *b, &context, interaction) {
                let g = &gs[&typ];
                for edge in [(*a, *b), (*b, *a)] {
                    if g.direct.contains(&edge) {
                        correct += 1;
                    } else {
                        missing += 1;
                    }
                }
            }
        }
    }
    score_ratio(correct, missing)
}

fn score_sequence(
    parts: &[BTreeSet<Activity>],
    gs: &BTreeMap<String, Graph>,
    interaction: &Interaction,
) -> f64 {
    let context = group_context(parts);
    let (mut correct, mut missing) = (0, 0);
    for a in &parts[0] {
        for b in &parts[1] {
            for typ in divergent_types(*a, *b, &context, interaction) {
                let g = &gs[&typ];
                for edge in [(*a, *b), (*b, *a)] {
                    if g.direct.contains(&edge) {
                        correct += 1;
                    } else {
                        missing += 1;
                    }
                }
            }
            for typ in non_divergent_types(*a, *b, &context, interaction) {
                if gs[&typ].closure.contains(&(*a, *b)) {
                    correct += 1;
                } else {
                    missing += 1;
                }
            }
        }
    }
    score_ratio(correct, missing)
}

fn xor_fallthrough_valid(
    parts: &[BTreeSet<Activity>],
    gs: &BTreeMap<String, Graph>,
    interaction: &Interaction,
) -> bool {
    let context = group_context(parts);
    let mut witness = false;
    for a in &parts[0] {
        for b in &parts[1] {
            let non_div = non_divergent_types(*a, *b, &context, interaction);
            witness |= !non_div.is_empty();
            if non_div.iter().any(|typ| {
                let g = &gs[typ];
                g.direct.contains(&(*a, *b)) || g.direct.contains(&(*b, *a))
            }) {
                return false;
            }
        }
    }
    witness
}

fn sequence_fallthrough_valid(
    parts: &[BTreeSet<Activity>],
    gs: &BTreeMap<String, Graph>,
    interaction: &Interaction,
) -> bool {
    let context = group_context(parts);
    let mut witness = false;
    for a in &parts[0] {
        for b in &parts[1] {
            let non_div = non_divergent_types(*a, *b, &context, interaction);
            witness |= !non_div.is_empty();
            if non_div
                .iter()
                .any(|typ| gs[typ].closure.contains(&(*b, *a)))
            {
                return false;
            }
        }
    }
    witness
}

/// Faithful in spirit to the reference polynomial fall-through: derive
/// operator-specific two-way partitions, score all valid candidates, and pick
/// the best one. Crucially, a sequence is only a candidate with directional
/// evidence; it is never the unconditional final fallback.
fn fallthrough_cut(
    local: &Local,
    interaction: &Interaction,
) -> (Vec<BTreeSet<Activity>>, FallthroughOperator) {
    let alphabet: Vec<_> = local.alphabet().into_iter().collect();
    let gs = graphs(local);
    let mut candidates: Vec<(f64, Vec<BTreeSet<Activity>>, FallthroughOperator)> = Vec::new();

    // Concurrent fall-through is universally admissible in the reference;
    // its precision score decides whether a stronger candidate wins.
    if let Some(parts) = binary_groups(
        alphabet
            .iter()
            .copied()
            .map(|a| BTreeSet::from([a]))
            .collect(),
    ) {
        candidates.push((
            score_parallel(&parts, &gs, interaction),
            parts,
            FallthroughOperator::Parallel,
        ));
    }

    let xor_groups = components(&alphabet, |a, b| {
        let context = BTreeSet::from([a, b]);
        non_divergent_types(a, b, &context, interaction)
            .iter()
            .any(|typ| {
                let g = &gs[typ];
                g.direct.contains(&(a, b)) || g.direct.contains(&(b, a))
            })
    });
    if let Some(parts) = binary_groups(xor_groups) {
        if xor_fallthrough_valid(&parts, &gs, interaction) {
            candidates.push((
                score_xor(&parts, &gs, interaction),
                parts,
                FallthroughOperator::Xor,
            ));
        }
    }

    // Reference Algorithm 11 tries every ordered boundary. The same follows
    // relation gives us those deterministic candidate boundaries without the
    // Python implementation's KMeans dependency.
    let mutually_following = components(&alphabet, |a, b| {
        let context = BTreeSet::from([a, b]);
        non_divergent_types(a, b, &context, interaction)
            .iter()
            .any(|typ| {
                let g = &gs[typ];
                g.closure.contains(&(a, b)) && g.closure.contains(&(b, a))
            })
    });
    if mutually_following.len() > 1 {
        if let Some(ordered) = topo_groups(
            mutually_following.clone(),
            &partition_follows(&mutually_following, &gs, interaction),
        ) {
            for cut in 1..ordered.len() {
                let parts = vec![
                    group_context(&ordered[..cut]),
                    group_context(&ordered[cut..]),
                ];
                if sequence_fallthrough_valid(&parts, &gs, interaction) {
                    candidates.push((
                        score_sequence(&parts, &gs, interaction),
                        parts,
                        FallthroughOperator::Sequence,
                    ));
                }
            }
        }
    }

    // The strict loop detector supplies the same body/redo partition used by
    // the reference's loop fall-through whenever there is loop evidence.
    if let Some(parts) = loop_cut(local, interaction) {
        let parts = vec![parts.0, parts.1];
        candidates.push((
            score_parallel(&parts, &gs, interaction),
            parts,
            FallthroughOperator::Loop,
        ));
    }

    candidates
        .into_iter()
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, parts, op)| (parts, op))
        // Mirrors the reference concurrent fall-through's always-valid final
        // branch, rather than inventing an activity-order sequence.
        .unwrap_or_else(|| {
            (
                vec![
                    BTreeSet::from([alphabet[0]]),
                    alphabet.into_iter().skip(1).collect(),
                ],
                FallthroughOperator::Parallel,
            )
        })
}

fn xor_cut(local: &Local, interaction: &Interaction) -> Option<Vec<BTreeSet<Activity>>> {
    let alphabet: Vec<_> = local.alphabet().into_iter().collect();
    if alphabet.len() < 2 {
        return None;
    };
    let gs = graphs(local);
    let groups = components(&alphabet, |a, b| {
        common_non_divergent(a, b, interaction).iter().any(|t| {
            gs.get(t)
                .is_some_and(|g| g.direct.contains(&(a, b)) || g.direct.contains(&(b, a)))
        })
    });
    if groups.len() < 2 {
        return None;
    }
    // A choice branch must be selected per object trace; otherwise two
    // disconnected lifecycles would be incorrectly called a choice.
    if local.traces.iter().any(|t| {
        groups
            .iter()
            .filter(|g| t.events.iter().any(|a| g.contains(a)))
            .count()
            > 1
    }) {
        return None;
    }
    xor_cut_valid(local, &groups, &gs, interaction).then_some(groups)
}

fn parallel_cut(local: &Local, interaction: &Interaction) -> Option<Vec<BTreeSet<Activity>>> {
    let alphabet: Vec<_> = local.alphabet().into_iter().collect();
    if alphabet.len() < 2 {
        return None;
    };
    let gs = graphs(local);
    let groups = components(&alphabet, |a, b| {
        // Activities belong to one sequential block whenever a shared
        // non-divergent lifecycle has not observed both local orderings.
        common_non_divergent(a, b, interaction).iter().any(|t| {
            !gs.get(t)
                .is_some_and(|g| g.direct.contains(&(a, b)) && g.direct.contains(&(b, a)))
        })
    });
    if groups.len() < 2 {
        return None;
    }
    // A body activity which is both a start and an end while another block is
    // wholly internal is loop evidence, not parallelism (A B A is the small
    // canonical example).  The reference concurrent-cut correction makes the
    // same distinction with projected start/end sets.
    for g in gs.values() {
        for &a in &g.start {
            if !g.end.contains(&a) {
                continue;
            }
            let Some(body_group) = groups.iter().position(|part| part.contains(&a)) else {
                continue;
            };
            if groups.iter().enumerate().any(|(i, part)| {
                i != body_group
                    && part
                        .iter()
                        .any(|b| !g.start.contains(b) && !g.end.contains(b))
            }) {
                return None;
            }
        }
    }
    Some(groups)
}

/// Object-centric loop cut.  Like the reference algorithm, it first rejects
/// lifecycles whose non-divergent activities cannot mutually eventually
/// follow, then keeps activities in the same candidate block when their
/// local directly-follows/start/end evidence rules out a body/redo boundary.
fn loop_cut(
    local: &Local,
    interaction: &Interaction,
) -> Option<(BTreeSet<Activity>, BTreeSet<Activity>)> {
    let alphabet: Vec<_> = local.alphabet().into_iter().collect();
    if alphabet.len() < 2 {
        return None;
    }
    let gs = graphs(local);
    for &a in &alphabet {
        for &b in &alphabet {
            for typ in common_non_divergent(a, b, interaction) {
                let g = gs.get(&typ)?;
                if !g.closure.contains(&(a, b)) || !g.closure.contains(&(b, a)) {
                    return None;
                }
            }
        }
    }
    let groups = components(&alphabet, |a, b| {
        common_non_divergent(a, b, interaction).iter().any(|typ| {
            let Some(g) = gs.get(typ) else { return false };
            let both = g.direct.contains(&(a, b)) && g.direct.contains(&(b, a));
            let boundary_a = g.start.contains(&a) || g.end.contains(&a);
            let boundary_b = g.start.contains(&b) || g.end.contains(&b);
            !both
                || (boundary_a && boundary_b)
                || (g.direct.contains(&(a, b)) && !g.end.contains(&a) && !g.start.contains(&b))
        })
    });
    if groups.len() < 2 {
        return None;
    }
    for body in &groups {
        let can_be_body = gs.values().any(|g| {
            body.iter()
                .any(|a| g.start.contains(a) || g.end.contains(a))
        });
        if !can_be_body {
            continue;
        }
        let redo: BTreeSet<_> = alphabet
            .iter()
            .copied()
            .filter(|a| !body.contains(a))
            .collect();
        if !redo.is_empty() && loop_cut_valid(local, body, &redo, &gs, interaction) {
            return Some((body.clone(), redo));
        }
    }
    None
}

fn loop_leaf(local: &Local, activity: Activity) -> bool {
    local
        .traces
        .iter()
        .any(|t| t.events.iter().filter(|&&a| a == activity).count() > 1)
}

/// Reference `detect_tau_cases`, part A: an object type is only *partially*
/// absent from this recursion when an ancestor XOR/loop split let some of
/// its objects skip this branch while others still engaged with it — that's
/// optional participation, not "this type doesn't belong here". The
/// reference tracks it as `len(expected_objects) > len(object_set)`, keyed
/// off object identity; here the same fact is directly visible as one
/// object type having both an empty- and a non-empty-events trace, so no
/// separate identity bookkeeping is needed. Squashing every empty trace
/// (not only the triggering type's) before recursing mirrors the
/// reference's unconditional `expected_objects = object_set` reset.
fn missing_object_tau(local: &Local) -> Option<Local> {
    let mut present: BTreeSet<&str> = BTreeSet::new();
    let mut missing: BTreeSet<&str> = BTreeSet::new();
    for t in &local.traces {
        if t.events.is_empty() {
            missing.insert(&t.object_type);
        } else {
            present.insert(&t.object_type);
        }
    }
    if !missing.iter().any(|ot| present.contains(ot)) {
        return None;
    }
    Some(Local {
        traces: local
            .traces
            .iter()
            .filter(|t| !t.events.is_empty())
            .cloned()
            .collect(),
    })
}

/// Reference `detect_tau_cases`, parts B/C: when every non-divergent pair in
/// the *whole* current alphabet is mutually closure-reachable (a stronger,
/// whole-alphabet version of `loop_cut`'s own pairwise precondition) and
/// every end-to-start crossing for a type is backed by a real direct-follow
/// edge, ordinary cut/fallthrough search would either fail outright or
/// invent structure across what's actually repeated iterations glued
/// together. The reference re-enters the miner on the same (still cyclic)
/// data, relying on its dataframe-level loop-iteration splitting elsewhere
/// to make progress; that splitting is done directly here — every trace is
/// cut at its end-activity-to-start-activity crossings and at any divergent
/// type between consecutive activities, matching `split_log`'s LOOP-branch
/// edge filter — so the recursive call sees one iteration per trace instead
/// of a block with no valid cut. `None` is returned, same as the reference's
/// `return None, None`, whenever a guard fails or fragmentation would make
/// no progress (nothing to split on), so this can't recurse forever on
/// identical data.
fn stuck_loop_tau(local: &Local, interaction: &Interaction) -> Option<Local> {
    let alphabet = local.alphabet();
    let gs = graphs(local);

    for &a in &alphabet {
        for &b in &alphabet {
            for typ in non_divergent_types(a, b, &alphabet, interaction) {
                let g = gs.get(&typ)?;
                if !g.closure.contains(&(a, b)) || !g.closure.contains(&(b, a)) {
                    return None;
                }
            }
        }
    }
    for g in gs.values() {
        for &a in &g.end {
            for &b in &g.start {
                if !g.direct.contains(&(a, b)) {
                    return None;
                }
            }
        }
    }
    let grounded = alphabet.iter().any(|&a| {
        interaction
            .types(a, Kind::Related)
            .iter()
            .any(|t| !interaction.types(a, Kind::Divergent).contains(t))
    });
    if !grounded {
        return None;
    }

    let mut traces = Vec::new();
    let mut progressed = false;
    for t in &local.traces {
        let Some(g) = gs.get(&t.object_type) else {
            traces.push(t.clone());
            continue;
        };
        let mut start = 0;
        for i in 0..t.events.len().saturating_sub(1) {
            let (a, b) = (t.events[i], t.events[i + 1]);
            let boundary = (g.end.contains(&a) && g.start.contains(&b))
                || !divergent_types(a, b, &alphabet, interaction).is_empty();
            if boundary {
                traces.push(ObjectTrace {
                    object_type: t.object_type.clone(),
                    events: t.events[start..=i].to_vec(),
                });
                start = i + 1;
                progressed = true;
            }
        }
        traces.push(ObjectTrace {
            object_type: t.object_type.clone(),
            events: t.events[start..].to_vec(),
        });
    }
    progressed.then_some(Local { traces })
}

fn mine(local: Local, interaction: &Interaction, depth: usize) -> Tree {
    let alphabet = local.alphabet();
    if alphabet.is_empty() {
        return Tree::Tau;
    }
    // Reference OCIM's `detect_tau_cases` runs before any cut or even the
    // single-activity base case: a partially-absent or terminally-stuck
    // object type needs to be modeled as optional (Xor+Tau) or repeating
    // without a distinguishable redo body (Loop+Tau), not folded into
    // ordinary cut/fallthrough search.
    if let Some(squashed) = missing_object_tau(&local) {
        return Tree::Xor(vec![mine(squashed, interaction, depth + 1), Tree::Tau]);
    }
    if depth <= 256 {
        if let Some(iterated) = stuck_loop_tau(&local, interaction) {
            return Tree::Loop(vec![mine(iterated, interaction, depth + 1), Tree::Tau]);
        }
    }
    if depth > 256 {
        return Tree::Sequence(alphabet.into_iter().map(Tree::Activity).collect());
    }
    if alphabet.len() == 1 {
        let a = *alphabet.first().unwrap();
        return if loop_leaf(&local, a) {
            Tree::Loop(vec![Tree::Activity(a), Tree::Tau])
        } else {
            Tree::Activity(a)
        };
    }
    if let Some(parts) = reference_sequence_cut(&local, interaction) {
        return Tree::Sequence(
            parts
                .into_iter()
                .map(|p| mine(local.filtered(&p, false), interaction, depth + 1))
                .collect(),
        );
    }
    if let Some(parts) = xor_cut(&local, interaction) {
        return Tree::Xor(
            parts
                .into_iter()
                .map(|p| mine(local.filtered(&p, true), interaction, depth + 1))
                .collect(),
        );
    }
    if let Some(parts) = parallel_cut(&local, interaction) {
        return Tree::Parallel(
            parts
                .into_iter()
                .map(|p| mine(local.filtered(&p, false), interaction, depth + 1))
                .collect(),
        );
    }
    if let Some((body, redo)) = loop_cut(&local, interaction) {
        return Tree::Loop(vec![
            mine(local.filtered(&body, false), interaction, depth + 1),
            mine(local.filtered(&redo, false), interaction, depth + 1),
        ]);
    }
    // Reference OCIM does not default to a sequence. It evaluates the
    // operator-specific fall-through candidates and recurses over the best
    // partition; this is what prevents disconnected activity sets becoming a
    // synthetic global order.
    let (parts, operator) = fallthrough_cut(&local, interaction);
    let children = parts
        .into_iter()
        .map(|part| mine(local.filtered(&part, false), interaction, depth + 1))
        .collect();
    match operator {
        FallthroughOperator::Xor => Tree::Xor(children),
        FallthroughOperator::Parallel => Tree::Parallel(children),
        FallthroughOperator::Sequence => Tree::Sequence(children),
        FallthroughOperator::Loop => Tree::Loop(children),
    }
}

pub fn discover(traces: Vec<ObjectTrace>, interaction: Interaction) -> Tree {
    mine(Local::initial(traces), &interaction, 0)
}

// ---------------------------------------------------------------- payload

#[derive(Serialize, Deserialize, Clone)]
pub struct TreeNode {
    pub operator: Option<String>,
    pub label: Option<String>,
    pub children: Vec<u32>,
    #[serde(default)]
    pub related: Vec<String>,
    #[serde(default)]
    pub divergent: Vec<String>,
    #[serde(default)]
    pub convergent: Vec<String>,
    #[serde(default)]
    pub deficient: Vec<String>,
}
#[derive(Serialize, Deserialize, Clone)]
pub struct OcptPayload {
    pub root: u32,
    pub nodes: Vec<TreeNode>,
    #[serde(default)]
    pub activities: Vec<String>,
    #[serde(default, rename = "objectTypes")]
    pub object_types: Vec<String>,
    pub stats: TreeStats,
}
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct TreeStats {
    pub nodes: usize,
    pub leaves: usize,
    pub silent: usize,
    pub operators: usize,
    #[serde(rename = "objectTypes")]
    pub object_types: usize,
    #[serde(rename = "activitiesDropped")]
    pub activities_dropped: usize,
}

fn op_name(t: &Tree) -> Option<&'static str> {
    match t {
        Tree::Sequence(_) => Some("sequence"),
        Tree::Xor(_) => Some("xor"),
        Tree::Parallel(_) => Some("parallel"),
        Tree::Loop(_) => Some("loop"),
        _ => None,
    }
}
fn children(t: &Tree) -> &[Tree] {
    match t {
        Tree::Sequence(c) | Tree::Xor(c) | Tree::Parallel(c) | Tree::Loop(c) => c,
        _ => &[],
    }
}
fn flatten(t: &Tree, names: &[String], i: &Interaction, out: &mut Vec<TreeNode>) -> u32 {
    let me = out.len() as u32;
    let (label, a) = match t {
        Tree::Activity(a) => (
            Some(
                names
                    .get(*a as usize)
                    .cloned()
                    .unwrap_or_else(|| format!("activity {a}")),
            ),
            Some(*a),
        ),
        Tree::Tau => (None, None),
        _ => (None, None),
    };
    let types = |k| {
        a.map(|x| i.types(x, k).into_iter().collect())
            .unwrap_or_default()
    };
    out.push(TreeNode {
        operator: op_name(t).map(str::to_string),
        label,
        children: Vec::new(),
        related: types(Kind::Related),
        divergent: types(Kind::Divergent),
        convergent: types(Kind::Convergent),
        deficient: types(Kind::Deficient),
    });
    let cs: Vec<_> = children(t)
        .iter()
        .map(|c| flatten(c, names, i, out))
        .collect();
    out[me as usize].children = cs;
    me
}
pub fn payload(
    tree: &Tree,
    names: &[String],
    interaction: &Interaction,
    dropped: usize,
) -> OcptPayload {
    let mut nodes = Vec::new();
    let root = flatten(tree, names, interaction, &mut nodes);
    let mut activities: Vec<_> = nodes.iter().filter_map(|n| n.label.clone()).collect();
    activities.sort();
    activities.dedup();
    let mut types: BTreeSet<String> = BTreeSet::new();
    for n in &nodes {
        types.extend(n.related.iter().cloned());
        types.extend(n.divergent.iter().cloned());
        types.extend(n.convergent.iter().cloned());
        types.extend(n.deficient.iter().cloned());
    }
    let leaves = nodes.iter().filter(|n| n.operator.is_none()).count();
    let silent = nodes
        .iter()
        .filter(|n| n.operator.is_none() && n.label.is_none())
        .count();
    let node_count = nodes.len();
    OcptPayload {
        root,
        nodes,
        activities,
        object_types: types.iter().cloned().collect(),
        stats: TreeStats {
            nodes: node_count,
            leaves,
            silent,
            operators: node_count - leaves,
            object_types: types.len(),
            activities_dropped: dropped,
        },
    }
}

// ---------------------------------------------------------- OCPT -> OCPN

#[derive(Clone)]
enum Plain {
    Tau,
    Activity(String),
    Sequence(Vec<Plain>),
    Xor(Vec<Plain>),
    Parallel(Vec<Plain>),
    Loop(Vec<Plain>),
}
// A leaf has to know whether the selected type participates. This projection
// therefore starts from the annotated OCPT rather than a plain tree.
fn typed_project(p: &OcptPayload, at: u32, ot: &str) -> Option<Plain> {
    let n = p.nodes.get(at as usize)?;
    if n.operator.is_none() {
        return match &n.label {
            Some(a) if n.related.iter().any(|x| x == ot) => Some(Plain::Activity(a.clone())),
            Some(_) => None,
            None => Some(Plain::Tau),
        };
    };
    let c: Vec<_> = n
        .children
        .iter()
        .filter_map(|&x| typed_project(p, x, ot))
        .collect();
    if c.is_empty() {
        return None;
    };
    let one = c.len() == 1;
    match n.operator.as_deref()? {
        "sequence" => {
            if one {
                Some(c.into_iter().next().unwrap())
            } else {
                Some(Plain::Sequence(c))
            }
        }
        "xor" => {
            if one {
                Some(c.into_iter().next().unwrap())
            } else {
                Some(Plain::Xor(c))
            }
        }
        "parallel" => {
            if one {
                Some(c.into_iter().next().unwrap())
            } else {
                Some(Plain::Parallel(c))
            }
        }
        "loop" => Some(Plain::Loop(c)),
        _ => None,
    }
}

#[derive(Serialize)]
pub struct Ocpn {
    #[serde(rename = "objectTypes")]
    pub object_types: Vec<String>,
    pub places: Vec<Place>,
    pub transitions: Vec<Transition>,
    pub arcs: Vec<Arc>,
    pub metadata: OcpnMeta,
}
#[derive(Serialize)]
pub struct Place {
    pub id: String,
    #[serde(rename = "objectType")]
    pub object_type: String,
    pub kind: String,
}
#[derive(Serialize)]
pub struct Transition {
    pub id: String,
    pub activity: Option<String>,
    #[serde(rename = "objectTypes")]
    pub object_types: Vec<String>,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NodeRef {
    Place { id: String },
    Transition { id: String },
}
#[derive(Serialize)]
pub struct Arc {
    pub id: String,
    pub source: NodeRef,
    pub target: NodeRef,
    #[serde(rename = "objectType")]
    pub object_type: String,
    pub variable: bool,
}
#[derive(Serialize)]
pub struct OcpnMeta {
    #[serde(rename = "perObjectType")]
    pub per: BTreeMap<String, OcpnStats>,
    #[serde(rename = "skippedObjectTypes")]
    pub skipped: Vec<OcpnSkipped>,
    pub parameters: OcpnParams,
    #[serde(rename = "activitiesDropped")]
    pub dropped: usize,
}
#[derive(Serialize, Default)]
pub struct OcpnStats {
    pub places: usize,
    pub transitions: usize,
    pub arcs: usize,
    #[serde(rename = "silentTransitions")]
    pub silent: usize,
    #[serde(rename = "variableArcs")]
    pub variable: usize,
    pub traces: u64,
    pub events: u64,
}
#[derive(Serialize)]
pub struct OcpnSkipped {
    #[serde(rename = "objectType")]
    pub object_type: String,
    pub reason: String,
}
#[derive(Serialize)]
pub struct OcpnParams {
    pub variant: &'static str,
    #[serde(rename = "noiseThreshold")]
    pub noise: f64,
    #[serde(rename = "objectTypes")]
    pub object_types: Vec<String>,
}

struct NetBuilder {
    ot: String,
    place: usize,
    silent: usize,
    arc: usize,
    places: Vec<Place>,
    arcs: Vec<Arc>,
    transitions: BTreeMap<String, Transition>,
    variable: BTreeSet<(String, String)>,
}
impl NetBuilder {
    fn fresh_place(&mut self) -> String {
        let id = format!("p:{}:{}", self.ot, self.place);
        self.place += 1;
        self.places.push(Place {
            id: id.clone(),
            object_type: self.ot.clone(),
            kind: "normal".into(),
        });
        id
    }
    fn tau(&mut self) -> String {
        let id = format!("t:silent:{}:{}", self.ot, self.silent);
        self.silent += 1;
        self.transitions.insert(
            id.clone(),
            Transition {
                id: id.clone(),
                activity: None,
                object_types: vec![self.ot.clone()],
            },
        );
        id
    }
    fn activity(&mut self, a: &str) -> String {
        let id = format!("t:{a}");
        self.transitions
            .entry(id.clone())
            .and_modify(|t| {
                if !t.object_types.contains(&self.ot) {
                    t.object_types.push(self.ot.clone())
                }
            })
            .or_insert(Transition {
                id: id.clone(),
                activity: Some(a.into()),
                object_types: vec![self.ot.clone()],
            });
        id
    }
    fn arc(&mut self, source: NodeRef, target: NodeRef, activity: Option<&str>) {
        let id = format!("a:{}:{}", self.ot, self.arc);
        self.arc += 1;
        let variable =
            activity.is_some_and(|a| self.variable.contains(&(self.ot.clone(), a.into())));
        self.arcs.push(Arc {
            id,
            source,
            target,
            object_type: self.ot.clone(),
            variable,
        });
    }
    fn p2t(&mut self, p: String, t: String, a: Option<&str>) {
        self.arc(NodeRef::Place { id: p }, NodeRef::Transition { id: t }, a)
    }
    fn t2p(&mut self, t: String, p: String, a: Option<&str>) {
        self.arc(NodeRef::Transition { id: t }, NodeRef::Place { id: p }, a)
    }
}
fn convert_plain(t: &Plain, input: &str, output: &str, b: &mut NetBuilder) {
    match t {
        Plain::Tau => {
            let x = b.tau();
            b.p2t(input.into(), x.clone(), None);
            b.t2p(x, output.into(), None)
        }
        Plain::Activity(a) => {
            let x = b.activity(a);
            b.p2t(input.into(), x.clone(), Some(a));
            b.t2p(x, output.into(), Some(a))
        }
        Plain::Sequence(c) => {
            let mut cur: String = input.into();
            for (i, x) in c.iter().enumerate() {
                let next: String = if i + 1 == c.len() {
                    output.into()
                } else {
                    b.fresh_place()
                };
                convert_plain(x, &cur, &next, b);
                cur = next
            }
        }
        Plain::Xor(c) => {
            for x in c {
                convert_plain(x, input, output, b)
            }
        }
        Plain::Parallel(c) => {
            let split = b.tau();
            let join = b.tau();
            b.p2t(input.into(), split.clone(), None);
            b.t2p(join.clone(), output.into(), None);
            for x in c {
                let s = b.fresh_place();
                let e = b.fresh_place();
                b.t2p(split.clone(), s.clone(), None);
                b.p2t(e.clone(), join.clone(), None);
                convert_plain(x, &s, &e, b)
            }
        }
        Plain::Loop(c) => {
            let entry = b.fresh_place();
            let init = b.tau();
            b.p2t(input.into(), init.clone(), None);
            b.t2p(init, entry.clone(), None);
            let mid = b.fresh_place();
            convert_plain(&c[0], &entry, &mid, b);
            if let Some(redo) = c.get(1) {
                convert_plain(redo, &mid, &entry, b)
            }
            let exit = b.tau();
            b.p2t(mid, exit.clone(), None);
            b.t2p(exit, output.into(), None)
        }
    }
}
pub fn to_ocpn(p: &OcptPayload) -> Result<Ocpn, String> {
    let mut types: BTreeSet<String> = p.object_types.iter().cloned().collect();
    for n in &p.nodes {
        types.extend(n.related.iter().cloned())
    }
    let mut all_places = Vec::new();
    let mut all_arcs = Vec::new();
    let mut transitions = BTreeMap::new();
    let mut per = BTreeMap::new();
    let mut skipped = Vec::new();
    let mut vars = BTreeSet::new();
    for n in &p.nodes {
        if let Some(a) = &n.label {
            for ot in &n.convergent {
                vars.insert((ot.clone(), a.clone()));
            }
        }
    }
    for ot in &types {
        let Some(tree) = typed_project(p, p.root, ot) else {
            skipped.push(OcpnSkipped {
                object_type: ot.clone(),
                reason: "no related activities".into(),
            });
            continue;
        };
        let src = format!("p:{ot}:src");
        let snk = format!("p:{ot}:snk");
        let mut b = NetBuilder {
            ot: ot.clone(),
            place: 0,
            silent: 0,
            arc: 0,
            places: vec![
                Place {
                    id: src.clone(),
                    object_type: ot.clone(),
                    kind: "source".into(),
                },
                Place {
                    id: snk.clone(),
                    object_type: ot.clone(),
                    kind: "sink".into(),
                },
            ],
            arcs: Vec::new(),
            transitions: BTreeMap::new(),
            variable: vars.clone(),
        };
        convert_plain(&tree, &src, &snk, &mut b);
        for (tid, t) in b.transitions {
            transitions
                .entry(tid)
                .and_modify(|old: &mut Transition| {
                    for typ in &t.object_types {
                        if !old.object_types.contains(typ) {
                            old.object_types.push(typ.clone())
                        }
                    }
                })
                .or_insert(t);
        }
        let st = OcpnStats {
            places: b.places.len(),
            arcs: b.arcs.len(),
            variable: b.arcs.iter().filter(|a| a.variable).count(),
            ..Default::default()
        };
        per.insert(ot.clone(), st);
        all_places.extend(b.places);
        all_arcs.extend(b.arcs);
    }
    for t in transitions.values() {
        for ot in &t.object_types {
            if let Some(s) = per.get_mut(ot) {
                s.transitions += 1;
                if t.activity.is_none() {
                    s.silent += 1;
                }
            }
        }
    }
    Ok(Ocpn {
        object_types: per.keys().cloned().collect(),
        places: all_places,
        transitions: transitions.into_values().collect(),
        arcs: all_arcs,
        metadata: OcpnMeta {
            per,
            skipped,
            parameters: OcpnParams {
                variant: "OCIM",
                noise: 0.0,
                object_types: types.into_iter().collect(),
            },
            dropped: p.stats.activities_dropped,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sequence_and_typed_payload() {
        let mut i = Interaction::default();
        i.add(0, "Order".into(), true, false, false, false);
        i.add(1, "Order".into(), true, false, false, false);
        let t = discover(
            vec![ObjectTrace {
                object_type: "Order".into(),
                events: vec![0, 1],
            }],
            i.clone(),
        );
        assert!(matches!(t, Tree::Sequence(_)));
        let p = payload(&t, &["Create".into(), "Close".into()], &i, 0);
        assert_eq!(p.activities.len(), 2);
        assert!(to_ocpn(&p).is_ok());
    }
    #[test]
    fn xor_is_detected() {
        let mut i = Interaction::default();
        for a in 0..2 {
            i.add(a, "Order".into(), true, false, false, false)
        }
        let t = discover(
            vec![
                ObjectTrace {
                    object_type: "Order".into(),
                    events: vec![0],
                },
                ObjectTrace {
                    object_type: "Order".into(),
                    events: vec![1],
                },
            ],
            i,
        );
        assert!(matches!(t, Tree::Xor(_)));
    }
    #[test]
    fn body_redo_loop_is_detected() {
        let mut i = Interaction::default();
        for a in 0..2 {
            i.add(a, "Order".into(), true, false, false, false)
        }
        let t = discover(
            vec![ObjectTrace {
                object_type: "Order".into(),
                events: vec![0, 1, 0],
            }],
            i,
        );
        assert!(matches!(t, Tree::Loop(_)));
    }
    #[test]
    fn missing_object_becomes_optional_xor_tau() {
        // Container c2 never performs activity 1 - only Order and Container
        // c1 do. Reference OCIM's `detect_tau_cases` (tau_cases.py) models
        // this as optional participation, Xor(subtree, Tau), rather than
        // silently dropping the object from the discovered model.
        let mut i = Interaction::default();
        i.add(0, "Order".into(), true, false, false, false);
        i.add(1, "Order".into(), true, false, false, false);
        i.add(0, "Container".into(), true, false, false, false);
        i.add(1, "Container".into(), true, false, false, false);
        let t = discover(
            vec![
                ObjectTrace {
                    object_type: "Order".into(),
                    events: vec![0, 1],
                },
                ObjectTrace {
                    object_type: "Order".into(),
                    events: vec![0, 1],
                },
                ObjectTrace {
                    object_type: "Container".into(),
                    events: vec![0, 1],
                },
                ObjectTrace {
                    object_type: "Container".into(),
                    events: vec![0],
                },
            ],
            i,
        );
        let Tree::Sequence(parts) = &t else {
            panic!("expected a sequence root, got {t:?}")
        };
        assert_eq!(parts.len(), 2);
        assert!(matches!(parts[0], Tree::Activity(0)));
        let Tree::Xor(children) = &parts[1] else {
            panic!("expected activity 1 to be wrapped as optional, got {:?}", parts[1])
        };
        assert!(matches!(children.as_slice(), [Tree::Activity(1), Tree::Tau]));
    }
    #[test]
    fn disconnected_lifecycles_are_not_invented_as_a_global_sequence() {
        // This is the regression behind the Logistics symptom. With no shared
        // non-divergent evidence, the old `topo` function returned activity
        // id order and wrapped it in a Sequence. Reference OCIM rejects that
        // strict sequence cut and its concurrent fall-through remains the
        // admissible model.
        let t = discover(
            vec![
                ObjectTrace {
                    object_type: "Order".into(),
                    events: vec![0],
                },
                ObjectTrace {
                    object_type: "Container".into(),
                    events: vec![1],
                },
            ],
            Interaction::default(),
        );
        assert!(matches!(t, Tree::Parallel(_)), "got {t:?}");
    }
}
