//! The recursion: base cases, cuts, fall-throughs.

use crate::cuts::{self, Cut, Operator};
use crate::graph::connected_components;
use crate::info::LogInfo;
use crate::log::{EventLog, Variant};
use crate::split;
use crate::tree::{ActivityId, Tree};
use crate::{DiscoveryError, Variant as MinerVariant};

pub struct Miner<'a> {
    pub variant: MinerVariant,
    pub noise: f64,
    pub cancelled: &'a dyn Fn() -> bool,
    pub progress: &'a dyn Fn(&str),
    /// Guards against a pathological log driving the recursion past the stack.
    pub max_depth: usize,
    pub nodes_visited: std::cell::Cell<u64>,
}

impl<'a> Miner<'a> {
    pub fn mine(&self, log: &EventLog, depth: usize) -> Result<Tree, DiscoveryError> {
        if (self.cancelled)() {
            return Err(DiscoveryError::Cancelled);
        }
        if depth > self.max_depth {
            return Err(DiscoveryError::RecursionLimit(self.max_depth));
        }
        self.nodes_visited.set(self.nodes_visited.get() + 1);

        let info = LogInfo::build(log);

        if let Some(tree) = self.base_case(log, &info, depth)? {
            return Ok(tree);
        }

        if let Some(cut) = self.find_cut(&info) {
            let sublogs = split::split(log, &info, &cut);
            (self.progress)(&format!(
                "{:?} cut into {} parts",
                cut.operator,
                sublogs.len()
            ));

            let mut children = Vec::with_capacity(sublogs.len());
            for sublog in &sublogs {
                children.push(self.mine(sublog, depth + 1)?);
            }

            return Ok(match cut.operator {
                Operator::Xor => Tree::Xor(children),
                Operator::Sequence => Tree::Sequence(children),
                Operator::Parallel => Tree::Parallel(children),
                Operator::Loop => {
                    // A process tree loop has one body and one redo; several
                    // redo parts become alternatives under a xor.
                    let mut it = children.into_iter();
                    let body = it.next().unwrap();
                    let redos: Vec<Tree> = it.collect();
                    let redo = if redos.len() == 1 {
                        redos.into_iter().next().unwrap()
                    } else {
                        Tree::Xor(redos)
                    };
                    Tree::loop_of(body, redo, Tree::Tau)
                }
            });
        }

        self.fall_through(log, &info, depth)
    }

    // ------------------------------------------------------------ cuts

    fn find_cut(&self, info: &LogInfo) -> Option<Cut> {
        if let Some(cut) = cuts::find_cut(info) {
            return Some(cut);
        }
        // IMf's noise filter is a *fallback*: the ordinary detectors have
        // already had their turn on the unfiltered graph, and only now is a
        // filtered copy tried. Filtering first would be a different algorithm.
        if self.variant == MinerVariant::IMf && self.noise > 0.0 {
            let filtered = info.filter_noise(self.noise);
            if let Some(cut) = cuts::find_cut(&filtered) {
                return Some(cut);
            }
        }
        None
    }

    // ------------------------------------------------------- base cases

    fn base_case(
        &self,
        log: &EventLog,
        info: &LogInfo,
        depth: usize,
    ) -> Result<Option<Tree>, DiscoveryError> {
        if self.variant == MinerVariant::IMf {
            // IMf settles the empty-log and empty-trace questions *before* it
            // looks at single activities — the opposite of IM's order.
            if let Some(t) = self.empty_log(info) {
                return Ok(Some(t));
            }
            if let Some(t) = self.empty_traces_as_noise(log, info, depth)? {
                return Ok(Some(t));
            }
            if let Some(t) = self.empty_traces(log, info, depth)? {
                return Ok(Some(t));
            }
            if let Some(t) = self.single_activity_filtering(info) {
                return Ok(Some(t));
            }
        }

        if let Some(t) = self.single_activity(info) {
            return Ok(Some(t));
        }
        if let Some(t) = self.semi_flower(info) {
            return Ok(Some(t));
        }
        if let Some(t) = self.empty_log(info) {
            return Ok(Some(t));
        }
        if let Some(t) = self.empty_traces(log, info, depth)? {
            return Ok(Some(t));
        }
        Ok(None)
    }

    fn empty_log(&self, info: &LogInfo) -> Option<Tree> {
        (info.n() == 0).then_some(Tree::Tau)
    }

    /// One activity, once per trace, no empty traces — a plain leaf.
    fn single_activity(&self, info: &LogInfo) -> Option<Tree> {
        (info.n() == 1 && info.empty_traces == 0 && info.event_count == info.trace_count)
            .then(|| Tree::Activity(info.activities[0]))
    }

    /// One activity occurring more than once per trace: a self-loop.
    fn semi_flower(&self, info: &LogInfo) -> Option<Tree> {
        (info.n() == 1 && info.empty_traces == 0)
            .then(|| Tree::self_loop(Tree::Activity(info.activities[0])))
    }

    fn empty_traces(
        &self,
        log: &EventLog,
        info: &LogInfo,
        depth: usize,
    ) -> Result<Option<Tree>, DiscoveryError> {
        if info.empty_traces == 0 {
            return Ok(None);
        }
        let child = self.mine(&log.without_empty_traces(), depth + 1)?;
        Ok(Some(Tree::Xor(vec![child, Tree::Tau])))
    }

    /// IMf: too few empty traces to believe — drop them and carry on, *without*
    /// the `xor(·, τ)` that would make skipping the block part of the model.
    fn empty_traces_as_noise(
        &self,
        log: &EventLog,
        info: &LogInfo,
        depth: usize,
    ) -> Result<Option<Tree>, DiscoveryError> {
        if info.empty_traces == 0 {
            return Ok(None);
        }
        if (info.empty_traces as f64) < info.trace_count as f64 * self.noise {
            return Ok(Some(self.mine(&log.without_empty_traces(), depth + 1)?));
        }
        Ok(None)
    }

    /// IMf: one activity, and its repeat rate is close enough to "once" that
    /// the extra occurrences look like noise rather than a loop.
    ///
    /// Models the number of occurrences per trace as geometric and estimates
    /// the stop probability; at 0.5 the activity occurs about once per trace.
    fn single_activity_filtering(&self, info: &LogInfo) -> Option<Tree> {
        if info.n() != 1 {
            return None;
        }
        let p = info.trace_count as f64 / (info.event_count + info.trace_count) as f64;
        (0.5 - self.noise <= p && p <= 0.5 + self.noise).then(|| Tree::Activity(info.activities[0]))
    }

    // ----------------------------------------------------- fall-throughs

    fn fall_through(
        &self,
        log: &EventLog,
        info: &LogInfo,
        depth: usize,
    ) -> Result<Tree, DiscoveryError> {
        if let Some(t) = self.once_per_trace_parallel(log, info, depth)? {
            return Ok(t);
        }
        if let Some(t) = self.leave_out_activity(log, info, depth)? {
            return Ok(t);
        }
        if let Some(t) = self.tau_loop(log, info, depth, true)? {
            return Ok(t);
        }
        if let Some(t) = self.tau_loop(log, info, depth, false)? {
            return Ok(t);
        }
        Ok(self.flower(info))
    }

    /// An activity that happens exactly once in every trace can be pulled out
    /// in parallel without losing anything.
    ///
    /// Candidates are tried least-frequent first. ProM breaks ties by hash
    /// order; the lowest activity id wins here.
    fn once_per_trace_parallel(
        &self,
        log: &EventLog,
        info: &LogInfo,
        depth: usize,
    ) -> Result<Option<Tree>, DiscoveryError> {
        if info.n() <= 1 {
            return Ok(None);
        }
        let mut order: Vec<usize> = (0..info.n()).collect();
        order.sort_by_key(|&i| (info.counts[i], std::cmp::Reverse(i)));

        for i in order {
            if info.empty_traces == 0 && info.counts[i] == info.trace_count {
                return Ok(Some(self.parallel_on(log, info, i, depth)?));
            }
        }
        Ok(None)
    }

    /// Leaving one activity out may let the rest fall apart into a cut.
    ///
    /// ProM reaches for four detectors here, but its exclusive-choice finder
    /// never declines, so the other three are unreachable: the real test is
    /// whether the graph *disconnects* without the activity. Reproduced as
    /// such, deliberately — parity, not tidiness.
    ///
    /// ProM also races the candidates on a thread pool and keeps whichever
    /// finishes first; candidates are tried in ascending id order here so the
    /// answer is the same every run.
    fn leave_out_activity(
        &self,
        log: &EventLog,
        info: &LogInfo,
        depth: usize,
    ) -> Result<Option<Tree>, DiscoveryError> {
        if info.n() < 3 {
            return Ok(None);
        }
        for i in (0..info.n()).rev() {
            if (self.cancelled)() {
                return Err(DiscoveryError::Cancelled);
            }
            let rest: Vec<usize> = (0..info.n()).filter(|&j| j != i).collect();
            let edges = rest.iter().flat_map(|&s| {
                info.out_adj[s]
                    .iter()
                    .filter(move |&&t| t != i)
                    .map(move |&t| (s, t))
            });
            // Components over the full index space; the left-out activity ends
            // up isolated, so it is discounted before counting.
            let parts = connected_components(info.n(), edges);
            let remaining = parts
                .iter()
                .filter(|p| !(p.len() == 1 && p[0] == i))
                .count();
            if remaining >= 2 {
                return Ok(Some(self.parallel_on(log, info, i, depth)?));
            }
        }
        Ok(None)
    }

    fn parallel_on(
        &self,
        log: &EventLog,
        info: &LogInfo,
        activity: usize,
        depth: usize,
    ) -> Result<Tree, DiscoveryError> {
        let rest: Vec<usize> = (0..info.n()).filter(|&j| j != activity).collect();
        let cut = Cut {
            operator: Operator::Parallel,
            parts: vec![vec![activity], rest],
        };
        let sublogs = split::split(log, info, &cut);
        let a = self.mine(&sublogs[0], depth + 1)?;
        let b = self.mine(&sublogs[1], depth + 1)?;
        Ok(Tree::Parallel(vec![a, b]))
    }

    /// Traces that look like several runs of the same block glued together.
    ///
    /// `strict` splits only where an end activity is immediately followed by a
    /// start activity; the loose form splits at every start activity that is
    /// not the first event of the trace, and applies only if that actually
    /// produced more traces than it started with.
    fn tau_loop(
        &self,
        log: &EventLog,
        info: &LogInfo,
        depth: usize,
        strict: bool,
    ) -> Result<Option<Tree>, DiscoveryError> {
        if info.n() <= 1 {
            return Ok(None);
        }

        let is_start = |a: ActivityId| {
            matches!(info.activities.binary_search(&a), Ok(i) if info.is_start(i))
        };
        let is_end = |a: ActivityId| {
            matches!(info.activities.binary_search(&a), Ok(i) if info.is_end(i))
        };

        let mut out = EventLog::new();
        let mut split_something = false;
        for v in &log.variants {
            let mut current: Vec<ActivityId> = Vec::new();
            let mut last_was_end = false;
            for (pos, &e) in v.events.iter().enumerate() {
                let cut_here = if strict {
                    last_was_end && is_start(e)
                } else {
                    pos > 0 && is_start(e)
                };
                if cut_here {
                    out.variants.push(Variant {
                        events: std::mem::take(&mut current),
                        count: v.count,
                    });
                    split_something = true;
                }
                current.push(e);
                last_was_end = is_end(e);
            }
            out.variants.push(Variant {
                events: current,
                count: v.count,
            });
        }

        let applies = if strict {
            split_something
        } else {
            out.trace_count() > log.trace_count()
        };
        if !applies {
            return Ok(None);
        }

        out.collapse();
        Ok(Some(Tree::self_loop(self.mine(&out, depth + 1)?)))
    }

    /// The model that fits anything: any activity, any number of times, any
    /// order. Always applies, which is what makes the recursion total.
    fn flower(&self, info: &LogInfo) -> Tree {
        match info.n() {
            0 => Tree::Tau,
            1 => Tree::self_loop(Tree::Activity(info.activities[0])),
            _ => Tree::self_loop(Tree::Xor(
                info.activities.iter().map(|&a| Tree::Activity(a)).collect(),
            )),
        }
    }
}
