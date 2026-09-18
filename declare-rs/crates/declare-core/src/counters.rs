//! What one pass over the log leaves behind.
//!
//! The scan sees each trace once and may never see it again — the host caches
//! the scan and calls `finalize` repeatedly as the thresholds move — so
//! everything discovery could ever ask has to be a number in here.
//!
//! The trick that makes that cheap is to count only what the *pairs present in
//! a trace* decide, and to derive the rest arithmetically. A trace containing
//! ten activities out of thirty says something about all 870 ordered pairs, but
//! for the 780 pairs with a missing activity it says the same thing every time:
//! `response(a, b)` with no `a` is vacuously satisfied, `precedence(a, b)` with
//! a `b` and no `a` is violated. Those follow from three per-activity totals, so
//! the inner loop runs over the 90 pairs actually present rather than all 870 —
//! and stays that size no matter how many activities the log has.

use crate::templates::Template;
use crate::trace::TraceIndex;

/// Templates whose violations among traces containing *both* activities cannot
/// be derived from counts alone, and so need a matrix of their own.
pub const COUNTED: [Template; 11] = [
    Template::Response,
    Template::Precedence,
    Template::Succession,
    Template::AltResponse,
    Template::AltPrecedence,
    Template::AltSuccession,
    Template::ChainResponse,
    Template::ChainPrecedence,
    Template::ChainSuccession,
    Template::NotSuccession,
    Template::NotChainSuccession,
];

fn counted_index(template: Template) -> Option<usize> {
    COUNTED.iter().position(|&t| t == template)
}

/// How a constraint fared over the whole log.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Assessment {
    /// Traces in which the constraint could have been broken.
    pub activated: u32,
    /// Traces in which it was.
    pub violated: u32,
    pub traces: u32,
}

impl Assessment {
    pub fn satisfied(&self) -> u32 {
        self.traces - self.violated
    }

    /// The share of *all* traces the constraint holds in — the classical
    /// support, and a number that a rule nobody ever triggers scores 1.0 on.
    pub fn support(&self) -> f64 {
        if self.traces == 0 {
            return 0.0;
        }
        self.satisfied() as f64 / self.traces as f64
    }

    /// The share of the traces that *could* have broken it in which it held.
    ///
    /// This is the vacuity-aware number, and the reason both are reported: a
    /// rule about an activity that occurs twice in a million-trace log has a
    /// support of 0.999998 and a confidence of whatever those two traces did.
    /// A rule never activated at all says nothing whatsoever, so it scores
    /// zero here rather than one, and the default threshold drops it.
    pub fn confidence(&self) -> f64 {
        if self.activated == 0 {
            return 0.0;
        }
        (self.activated - self.violated) as f64 / self.activated as f64
    }

    /// The share of traces the constraint has anything to say about.
    pub fn activation_rate(&self) -> f64 {
        if self.traces == 0 {
            return 0.0;
        }
        self.activated as f64 / self.traces as f64
    }
}

pub struct Counters {
    pub n: usize,
    pub traces: u32,
    pub events: u64,
    /// Traces containing each activity.
    with: Vec<u32>,
    /// Traces containing both, for every ordered pair (symmetric by construction).
    both: Vec<u32>,
    exactly_one: Vec<u32>,
    init: Vec<u32>,
    end: Vec<u32>,
    /// Per `COUNTED` template: violations among the traces containing both.
    violated: Vec<Vec<u32>>,
}

impl Counters {
    pub fn new(n: usize) -> Self {
        Self {
            n,
            traces: 0,
            events: 0,
            with: vec![0; n],
            both: vec![0; n * n],
            exactly_one: vec![0; n],
            init: vec![0; n],
            end: vec![0; n],
            violated: vec![vec![0; n * n]; COUNTED.len()],
        }
    }

    /// Folds one finished trace in.
    pub fn observe(&mut self, trace: &TraceIndex) {
        self.traces += 1;
        self.events += trace.len() as u64;
        if trace.is_empty() {
            return;
        }

        for &a in trace.present() {
            let i = a as usize;
            self.with[i] += 1;
            if trace.count(a) == 1 {
                self.exactly_one[i] += 1;
            }
            if trace.starts_with(a) {
                self.init[i] += 1;
            }
            if trace.ends_with(a) {
                self.end[i] += 1;
            }
        }

        for &a in trace.present() {
            for &b in trace.present() {
                if a == b {
                    // A constraint between an activity and itself is either
                    // trivial or unsatisfiable (nothing can be immediately
                    // followed by itself *and* be the last of its kind), so
                    // the whole diagonal is left out — of the counting here
                    // and of the candidates in `discover`.
                    continue;
                }
                let cell = a as usize * self.n + b as usize;
                self.both[cell] += 1;
                for (slot, &template) in COUNTED.iter().enumerate() {
                    if !trace.holds_when_both_present(template, a, b) {
                        self.violated[slot][cell] += 1;
                    }
                }
            }
        }
    }

    fn both_of(&self, a: u32, b: u32) -> u32 {
        self.both[a as usize * self.n + b as usize]
    }

    fn counted(&self, template: Template, a: u32, b: u32) -> u32 {
        match counted_index(template) {
            Some(slot) => self.violated[slot][a as usize * self.n + b as usize],
            None => 0,
        }
    }

    /// How `template(a, b)` fared. `b` is ignored for a unary template.
    pub fn assess(&self, template: Template, a: u32, b: u32) -> Assessment {
        let traces = self.traces;
        let wa = self.with[a as usize];
        let (activated, violated) = if template.is_binary() {
            let wb = self.with[b as usize];
            let both = self.both_of(a, b);
            let counted = self.counted(template, a, b);
            // `wa - both` is "a occurred and b did not", and `wb - both` its
            // mirror; the two are disjoint from each other and from the
            // both-present traces `counted` is drawn from, so these sums never
            // count a trace twice.
            match template {
                Template::RespondedExistence => (wa, wa - both),
                Template::Response | Template::AltResponse | Template::ChainResponse => {
                    (wa, (wa - both) + counted)
                }
                Template::Precedence | Template::AltPrecedence | Template::ChainPrecedence => {
                    (wb, (wb - both) + counted)
                }
                Template::Succession | Template::AltSuccession | Template::ChainSuccession => {
                    (wa + wb - both, (wa - both) + (wb - both) + counted)
                }
                Template::NotCoExistence => (wa + wb - both, both),
                Template::NotSuccession | Template::NotChainSuccession => (wa, counted),
                _ => (0, 0),
            }
        } else {
            match template {
                Template::Existence => (traces, traces - wa),
                Template::Absence => (traces, wa),
                Template::ExactlyOne => (traces, traces - self.exactly_one[a as usize]),
                Template::Init => (traces, traces - self.init[a as usize]),
                Template::End => (traces, traces - self.end[a as usize]),
                _ => (0, 0),
            }
        };
        Assessment { activated, violated, traces }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::templates::ALL;

    fn log(traces: &[&str]) -> Counters {
        let mut counters = Counters::new(26);
        let mut index = TraceIndex::new(26);
        for trace in traces {
            index.reset();
            for letter in trace.chars() {
                index.push(letter as u32 - 'a' as u32);
            }
            counters.observe(&index);
        }
        counters
    }

    /// The same question asked the slow way: build each trace, decide the
    /// constraint directly from its English sentence, count. Shares nothing
    /// with `Counters`' arithmetic beyond `TraceIndex`, which is what makes
    /// the agreement worth something.
    fn reference(traces: &[&str], template: Template, a: u32, b: u32) -> Assessment {
        use crate::templates::Activation;
        use Template::*;

        let mut activated = 0;
        let mut violated = 0;
        for trace in traces {
            let mut index = TraceIndex::new(26);
            for letter in trace.chars() {
                index.push(letter as u32 - 'a' as u32);
            }
            let (has_a, has_b) = (index.contains(a), index.contains(b));

            let is_activated = match template.activation() {
                Activation::Always => true,
                Activation::First => has_a,
                Activation::Second => has_b,
                Activation::Either => has_a || has_b,
            };

            let holds = if !template.is_binary() {
                match template {
                    Existence => has_a,
                    Absence => !has_a,
                    ExactlyOne => index.count(a) == 1,
                    Init => index.starts_with(a),
                    End => index.ends_with(a),
                    _ => unreachable!(),
                }
            } else {
                match (has_a, has_b) {
                    (true, true) => index.holds_when_both_present(template, a, b),
                    // An `a` with no `b`: everything that demands a `b` is broken.
                    (true, false) => !matches!(
                        template,
                        RespondedExistence | Response | AltResponse | ChainResponse
                            | Succession | AltSuccession | ChainSuccession
                    ),
                    // A `b` with no `a`: everything that demands an `a` first is broken.
                    (false, true) => !matches!(
                        template,
                        Precedence | AltPrecedence | ChainPrecedence
                            | Succession | AltSuccession | ChainSuccession
                    ),
                    (false, false) => true,
                }
            };

            if is_activated {
                activated += 1;
            }
            if !holds {
                violated += 1;
            }
        }
        Assessment { activated, violated, traces: traces.len() as u32 }
    }

    #[test]
    fn the_counters_agree_with_a_direct_evaluation() {
        let traces = ["abc", "ba", "a", "cba", "abab", "b", "", "acb"];
        let counters = log(&traces);
        for template in ALL {
            for a in 0..3u32 {
                for b in 0..3u32 {
                    if template.is_binary() && a == b {
                        continue;
                    }
                    assert_eq!(
                        counters.assess(template, a, b),
                        reference(&traces, template, a, b),
                        "{} of {a},{b}", template.id()
                    );
                }
            }
        }
    }

    #[test]
    fn support_and_confidence_are_the_two_different_questions() {
        // `b` occurs in one trace of ten, answered. `response(a, b)` holds in
        // every trace — vacuously in nine of them.
        let mut traces = vec!["c"; 9];
        traces.push("ab");
        let counters = log(&traces);
        let response = counters.assess(Template::Response, 0, 1);
        assert_eq!(response.violated, 0);
        assert_eq!(response.support(), 1.0);
        assert_eq!(response.activated, 1, "only the trace with an a");
        assert_eq!(response.confidence(), 1.0);
        assert!((response.activation_rate() - 0.1).abs() < 1e-9);
    }

    #[test]
    fn a_rule_nothing_ever_triggers_has_no_confidence_rather_than_full_confidence() {
        let counters = log(&["cc", "cc"]);
        let response = counters.assess(Template::Response, 0, 1);
        assert_eq!(response.activated, 0);
        assert_eq!(response.support(), 1.0, "vacuously true everywhere");
        assert_eq!(response.confidence(), 0.0, "and worth nothing");
    }

    #[test]
    fn an_empty_trace_counts_against_existence_and_for_absence() {
        let counters = log(&["", "a"]);
        assert_eq!(counters.traces, 2);
        assert_eq!(counters.assess(Template::Existence, 0, 0).violated, 1);
        assert_eq!(counters.assess(Template::Absence, 0, 0).violated, 1);
        assert_eq!(counters.assess(Template::Init, 0, 0).violated, 1);
    }
}
