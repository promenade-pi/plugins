//! What one pass over the event log has to collect, for both variants at once.
//!
//! The host caches a scan per (log, activity limit) and re-runs only
//! `finalize(params)` when a parameter changes — so anything the *variant*
//! selects between has to be measured in that one shared pass, not decided
//! during it. Scanning twice would either break the cache or silently return a
//! stale graph when the variant is switched.
//!
//! Everything here is therefore collected unconditionally:
//!
//! - **`df`** — the classic directly-follows frequency (Definition 2 of both
//!   papers), over *complete* events only. On a log with no life-cycle
//!   attribute the host maps every event to `complete`, so this is simply "the
//!   log" and the projection costs nothing.
//! - **`refined_df`** — Split Miner 2.0's Definition 6: `B` directly-follows
//!   `A` when `B` *starts* after `A` *ends* with no other activity ending in
//!   between. Two activities whose executions overlap therefore have no
//!   directly-follows relation in either direction, which is the point.
//! - **`loop2`** — occurrences of the pattern ⟨a, b, a⟩, which is what decides
//!   both short-loops and the conditions that keep a short-loop out of the
//!   concurrency relation.
//! - **`overlap` / `complete_lifecycles`** — the ingredients of Split Miner
//!   2.0's true-concurrency oracle (Equation 5).
//! - **`both` / `only_one`** — per activity pair, the cases containing both
//!   and the cases containing exactly one. Split Miner 2.0's OR-split
//!   heuristic asks whether a pair is *sometimes* concurrent and *sometimes*
//!   mutually exclusive, which is a question about whole cases, not about
//!   adjacency.

/// One life-cycle state, as the host's `activityLifecycle` classifier reports
/// it. `enqueue` is recorded by some logs between the two that matter here and
/// is treated as neither a start nor an end.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Enqueue,
    Start,
    Complete,
}

#[derive(Clone)]
pub struct Observations {
    pub activity_count: usize,
    pub names: Vec<String>,
    /// `df[a * n + b]`: how often a *complete* `b` directly follows a
    /// *complete* `a` in the same case.
    pub df: Vec<u32>,
    /// `refined_df[a * n + b]`: Split Miner 2.0's Definition 6.
    pub refined_df: Vec<u32>,
    /// `loop2[a * n + b]`: occurrences of ⟨a, b, a⟩ over complete events.
    pub loop2: Vec<u32>,
    /// Cases whose first complete event is this activity.
    pub starts: Vec<u32>,
    /// Cases whose last complete event is this activity.
    pub ends: Vec<u32>,
    pub counts: Vec<u32>,
    /// Symmetric. `overlap[a * n + b]`: executions of `a` and `b` whose
    /// life-cycles overlapped.
    pub overlap: Vec<u32>,
    /// Executions with both a start and an end — the `|A|` of Equation 5.
    pub complete_lifecycles: Vec<u32>,
    /// Symmetric. Cases in which both activities occur.
    pub both: Vec<u32>,
    /// Symmetric. Cases in which exactly one of the two occurs.
    pub only_one: Vec<u32>,
    pub cases: u32,
    pub events: u32,
    /// True when the log actually distinguishes start from complete. Without
    /// it Split Miner 2.0 has nothing to measure, and the report says so
    /// rather than reporting "no concurrency found".
    pub has_lifecycle: bool,
}

impl Observations {
    pub fn new(activity_count: usize) -> Self {
        let n = activity_count;
        Self {
            activity_count: n,
            names: (0..n).map(|a| format!("activity {a}")).collect(),
            df: vec![0; n * n],
            refined_df: vec![0; n * n],
            loop2: vec![0; n * n],
            starts: vec![0; n],
            ends: vec![0; n],
            counts: vec![0; n],
            overlap: vec![0; n * n],
            complete_lifecycles: vec![0; n],
            both: vec![0; n * n],
            only_one: vec![0; n * n],
            cases: 0,
            events: 0,
            has_lifecycle: false,
        }
    }

    pub fn df(&self, a: usize, b: usize) -> u32 {
        self.df[a * self.activity_count + b]
    }
    pub fn refined_df(&self, a: usize, b: usize) -> u32 {
        self.refined_df[a * self.activity_count + b]
    }
    pub fn loop2(&self, a: usize, b: usize) -> u32 {
        self.loop2[a * self.activity_count + b]
    }
    pub fn overlap(&self, a: usize, b: usize) -> u32 {
        self.overlap[a * self.activity_count + b]
    }
    pub fn both(&self, a: usize, b: usize) -> u32 {
        self.both[a * self.activity_count + b]
    }
    pub fn only_one(&self, a: usize, b: usize) -> u32 {
        self.only_one[a * self.activity_count + b]
    }
    pub fn name(&self, a: usize) -> &str {
        self.names.get(a).map(String::as_str).unwrap_or("?")
    }
}

/// Accumulates [`Observations`] one case at a time. The wasm kernel feeds it
/// chunks; the tests feed it literal traces, which is the whole reason it is a
/// type rather than a function over a whole log.
pub struct Scanner {
    obs: Observations,
    /// The last two complete events of the open case -- all `df` and `loop2`
    /// ever look at, so the window is two scalars rather than a growing
    /// buffer a 1,200-event trace would keep alive.
    previous: Option<usize>,
    before: Option<usize>,
    /// Activities started and not yet ended, in start order.
    open: Vec<usize>,
    /// Activities that have ended since the last start — the "no end in
    /// between" clause of Definition 6 is a one-element frontier, because an
    /// end resets which activity a later start directly-follows.
    last_end: Option<usize>,
    /// Which activities the open case has contained at all, and the list of
    /// them, so the pairwise tally at the end of a case costs
    /// `present x activities` rather than `activities squared`.
    present: Vec<bool>,
    present_list: Vec<usize>,
}

impl Scanner {
    pub fn new(activity_count: usize) -> Self {
        Self {
            obs: Observations::new(activity_count),
            previous: None,
            before: None,
            open: Vec::new(),
            last_end: None,
            present: vec![false; activity_count],
            present_list: Vec::new(),
        }
    }

    pub fn set_names(&mut self, names: Vec<String>) {
        for (i, name) in names.into_iter().enumerate() {
            if i < self.obs.names.len() {
                self.obs.names[i] = name;
            }
        }
    }

    /// Records that the log distinguishes life-cycle states. Set by the kernel
    /// from the classifier values it was given, not inferred from whether a
    /// start happened to appear.
    pub fn set_has_lifecycle(&mut self, has: bool) {
        self.obs.has_lifecycle = has;
    }

    pub fn begin_case(&mut self) {
        self.end_case();
        self.obs.cases += 1;
    }

    /// One event of the open case, in timestamp order.
    pub fn push(&mut self, activity: usize, phase: Phase) {
        if activity >= self.obs.activity_count {
            return;
        }
        let n = self.obs.activity_count;
        self.obs.events += 1;

        match phase {
            Phase::Enqueue => {}
            Phase::Start => {
                // Definition 6: this start directly-follows the most recent
                // end, provided no other end has intervened — which is what
                // `last_end` being consumed here expresses.
                if let Some(previous) = self.last_end {
                    if previous != activity {
                        self.obs.refined_df[previous * n + activity] += 1;
                    }
                }
                for &other in &self.open {
                    if other != activity {
                        self.obs.overlap[other * n + activity] += 1;
                        self.obs.overlap[activity * n + other] += 1;
                    }
                }
                self.open.push(activity);
            }
            Phase::Complete => {
                self.obs.counts[activity] += 1;
                if !self.present[activity] {
                    self.present[activity] = true;
                    self.present_list.push(activity);
                }
                if let Some(position) = self.open.iter().rposition(|&a| a == activity) {
                    self.open.remove(position);
                    self.obs.complete_lifecycles[activity] += 1;
                }
                self.last_end = Some(activity);

                match self.previous {
                    Some(previous) => {
                        self.obs.df[previous * n + activity] += 1;
                        // The pattern <a, b, a> closes here when the event
                        // before last was this same activity.
                        if self.before == Some(activity) && previous != activity {
                            self.obs.loop2[activity * n + previous] += 1;
                        }
                    }
                    None => self.obs.starts[activity] += 1,
                }
                self.before = self.previous;
                self.previous = Some(activity);
            }
        }
    }

    /// Closes the open case. Idempotent, so `finish` can simply call it.
    pub fn end_case(&mut self) {
        if let Some(last) = self.previous {
            self.obs.ends[last] += 1;
        }
        let n = self.obs.activity_count;
        for (i, &a) in self.present_list.iter().enumerate() {
            for &b in &self.present_list[i + 1..] {
                self.obs.both[a * n + b] += 1;
                self.obs.both[b * n + a] += 1;
            }
            for b in 0..n {
                if !self.present[b] {
                    self.obs.only_one[a * n + b] += 1;
                    self.obs.only_one[b * n + a] += 1;
                }
            }
        }
        for &a in &self.present_list {
            self.present[a] = false;
        }
        self.present_list.clear();
        self.previous = None;
        self.before = None;
        self.open.clear();
        self.last_end = None;
    }

    pub fn finish(mut self) -> Observations {
        self.end_case();
        self.obs
    }

    /// A copy of what has been accumulated so far. `finalize` may run more
    /// than once against one cached scan — that is the whole point of the
    /// host's two stages — so the kernel reads the observations rather than
    /// consuming the scanner with [`Scanner::finish`].
    pub fn observations(&self) -> Observations {
        self.obs.clone()
    }

    /// A case with no events at all still counted as a case; this reports what
    /// the kernel needs for `caseCount`.
    pub fn case_count(&self) -> u32 {
        self.obs.cases
    }
    pub fn event_count(&self) -> u32 {
        self.obs.events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(traces: &[&[(usize, Phase)]], n: usize) -> Observations {
        let mut s = Scanner::new(n);
        for trace in traces {
            s.begin_case();
            for &(a, p) in *trace {
                s.push(a, p);
            }
        }
        s.finish()
    }

    fn complete(trace: &[usize]) -> Vec<(usize, Phase)> {
        trace.iter().map(|&a| (a, Phase::Complete)).collect()
    }

    #[test]
    fn directly_follows_counts_consecutive_completes() {
        let t = complete(&[0, 1, 2]);
        let obs = scan(&[&t], 3);
        assert_eq!(obs.df(0, 1), 1);
        assert_eq!(obs.df(1, 2), 1);
        assert_eq!(obs.df(0, 2), 0);
        assert_eq!(obs.starts[0], 1);
        assert_eq!(obs.ends[2], 1);
    }

    #[test]
    fn a_short_loop_pattern_is_counted_once_per_occurrence() {
        // <a, b, a, b, a>: the pattern <a,b,a> occurs twice, <b,a,b> once.
        let t = complete(&[0, 1, 0, 1, 0]);
        let obs = scan(&[&t], 2);
        assert_eq!(obs.loop2(0, 1), 2, "a-b-a");
        assert_eq!(obs.loop2(1, 0), 1, "b-a-b");
    }

    #[test]
    fn a_self_loop_is_not_a_short_loop() {
        let t = complete(&[0, 0, 0]);
        let obs = scan(&[&t], 1);
        assert_eq!(obs.df(0, 0), 2);
        assert_eq!(obs.loop2(0, 0), 0);
    }

    #[test]
    fn overlapping_lifecycles_are_counted_and_suppress_directly_follows() {
        // a starts, b starts while a runs, both end: they overlap, and by
        // Definition 6 neither directly-follows the other.
        let t = [
            (0, Phase::Start),
            (1, Phase::Start),
            (0, Phase::Complete),
            (1, Phase::Complete),
        ];
        let obs = scan(&[&t], 2);
        assert_eq!(obs.overlap(0, 1), 1);
        assert_eq!(obs.overlap(1, 0), 1);
        assert_eq!(obs.complete_lifecycles[0], 1);
        assert_eq!(obs.complete_lifecycles[1], 1);
        assert_eq!(obs.refined_df(0, 1), 0, "b started before a ended");
        assert_eq!(obs.refined_df(1, 0), 0);
        // The classic relation still sees them in sequence, which is exactly
        // the difference the two variants are about.
        assert_eq!(obs.df(0, 1), 1);
    }

    #[test]
    fn a_strictly_sequential_pair_keeps_its_refined_relation() {
        let t = [
            (0, Phase::Start),
            (0, Phase::Complete),
            (1, Phase::Start),
            (1, Phase::Complete),
        ];
        let obs = scan(&[&t], 2);
        assert_eq!(obs.refined_df(0, 1), 1);
        assert_eq!(obs.overlap(0, 1), 0);
    }

    #[test]
    fn cases_do_not_bleed_into_each_other() {
        let first = complete(&[0, 1]);
        let second = complete(&[1, 0]);
        let obs = scan(&[&first, &second], 2);
        assert_eq!(obs.df(0, 1), 1);
        assert_eq!(obs.df(1, 0), 1);
        assert_eq!(obs.cases, 2);
        assert_eq!(obs.starts[0], 1);
        assert_eq!(obs.starts[1], 1);
    }
}
