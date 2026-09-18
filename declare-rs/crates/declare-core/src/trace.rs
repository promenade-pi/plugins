//! One trace, indexed so every template can be decided without re-reading it.
//!
//! The index is the positions of each activity, which is all any DECLARE
//! template needs: "eventually followed by" is a comparison of last positions,
//! "immediately followed by" a look at the next event, "alternating" a search
//! for one position inside an interval. Everything below is therefore
//! logarithmic or linear in the occurrences of the two activities involved,
//! never in the length of the trace.
//!
//! The index is reused across traces — `reset` clears only the activities the
//! last trace actually contained, so a log with 200 activities does not pay for
//! 200 empty vectors per case.

use crate::templates::Template;

pub struct TraceIndex {
    events: Vec<u32>,
    /// Ascending positions of each activity; meaningful only for `present`.
    positions: Vec<Vec<u32>>,
    present: Vec<u32>,
    seen: Vec<bool>,
}

/// `∃ p ∈ positions` with `lo < p < hi`. `lo` is signed so that "before the
/// first occurrence" can be expressed without a special case.
fn exists_between(positions: &[u32], lo: i64, hi: i64) -> bool {
    let start = positions.partition_point(|&p| (p as i64) <= lo);
    positions.get(start).is_some_and(|&p| (p as i64) < hi)
}

impl TraceIndex {
    pub fn new(activities: usize) -> Self {
        Self {
            events: Vec::new(),
            positions: vec![Vec::new(); activities],
            present: Vec::new(),
            seen: vec![false; activities],
        }
    }

    pub fn reset(&mut self) {
        self.events.clear();
        for &activity in &self.present {
            self.positions[activity as usize].clear();
            self.seen[activity as usize] = false;
        }
        self.present.clear();
    }

    pub fn push(&mut self, activity: u32) {
        let index = activity as usize;
        if index >= self.positions.len() {
            return; // outside the host's activity selection
        }
        if !self.seen[index] {
            self.seen[index] = true;
            self.present.push(activity);
        }
        self.positions[index].push(self.events.len() as u32);
        self.events.push(activity);
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    /// The activities this trace contains, in order of first appearance.
    pub fn present(&self) -> &[u32] {
        &self.present
    }

    pub fn contains(&self, activity: u32) -> bool {
        self.seen.get(activity as usize).copied().unwrap_or(false)
    }

    pub fn count(&self, activity: u32) -> usize {
        self.positions.get(activity as usize).map_or(0, Vec::len)
    }

    pub fn starts_with(&self, activity: u32) -> bool {
        self.events.first() == Some(&activity)
    }

    pub fn ends_with(&self, activity: u32) -> bool {
        self.events.last() == Some(&activity)
    }

    fn first(&self, activity: u32) -> i64 {
        self.positions[activity as usize][0] as i64
    }

    fn last(&self, activity: u32) -> i64 {
        *self.positions[activity as usize].last().unwrap() as i64
    }

    /// Whether the constraint holds in this trace, for activities that may or
    /// may not occur in it — and may not exist in the log's alphabet at all
    /// (`None`, which is the same thing as never occurring).
    ///
    /// The general form, used when checking a model that was written
    /// elsewhere. Discovery does not go through it: the counters decide the
    /// "one of them is missing" cases arithmetically over the whole log rather
    /// than trace by trace, which is what keeps the scan's inner loop over the
    /// pairs actually present. The two agree by construction here and by an
    /// invariant in `tests/invariants.rs`.
    pub fn holds(&self, template: Template, a: Option<u32>, b: Option<u32>) -> bool {
        let has = |activity: Option<u32>| activity.is_some_and(|x| self.contains(x));
        let (has_a, has_b) = (has(a), has(b));

        if !template.is_binary() {
            let Some(a) = a else {
                // An activity the log never records: it did not occur, so a
                // rule that demands it is broken and one that forbids it holds.
                return matches!(template, Template::Absence);
            };
            return match template {
                Template::Existence => has_a,
                Template::Absence => !has_a,
                Template::ExactlyOne => self.count(a) == 1,
                Template::Init => self.starts_with(a),
                Template::End => self.ends_with(a),
                _ => true,
            };
        }

        match (has_a, has_b) {
            (true, true) => self.holds_when_both_present(template, a.unwrap(), b.unwrap()),
            // An `a` and no `b`: every rule that demands a `b` is broken.
            (true, false) => !matches!(
                template,
                Template::RespondedExistence
                    | Template::Response
                    | Template::AltResponse
                    | Template::ChainResponse
                    | Template::Succession
                    | Template::AltSuccession
                    | Template::ChainSuccession
            ),
            // A `b` and no `a`: every rule that demands an `a` first is broken.
            (false, true) => !matches!(
                template,
                Template::Precedence
                    | Template::AltPrecedence
                    | Template::ChainPrecedence
                    | Template::Succession
                    | Template::AltSuccession
                    | Template::ChainSuccession
            ),
            (false, false) => true,
        }
    }

    /// Whether this trace could have broken the constraint — what separates a
    /// rule that held from a rule that was never put to the test.
    pub fn activates(&self, template: Template, a: Option<u32>, b: Option<u32>) -> bool {
        let has = |activity: Option<u32>| activity.is_some_and(|x| self.contains(x));
        match template.activation() {
            crate::templates::Activation::Always => true,
            crate::templates::Activation::First => has(a),
            crate::templates::Activation::Second => has(b),
            crate::templates::Activation::Either => has(a) || has(b),
        }
    }

    /// Whether the constraint holds in this trace, **given that both `a` and
    /// `b` occur in it**.
    ///
    /// The caller establishes that (`counters` only ever asks about pairs it
    /// found present), which is what keeps this free of the "one of them is
    /// missing" cases — those are decided by counting, not by looking at
    /// traces one at a time. Calling it otherwise panics rather than returning
    /// a plausible answer.
    pub fn holds_when_both_present(&self, template: Template, a: u32, b: u32) -> bool {
        debug_assert!(self.contains(a) && self.contains(b));
        let pa = &self.positions[a as usize];
        let pb = &self.positions[b as usize];

        match template {
            Template::RespondedExistence => true,
            Template::Response => self.last(b) > self.last(a),
            Template::Precedence => self.first(a) < self.first(b),
            Template::Succession => {
                self.last(b) > self.last(a) && self.first(a) < self.first(b)
            }
            Template::AltResponse => pa.iter().enumerate().all(|(i, &at)| {
                let next_a = pa.get(i + 1).map_or(i64::MAX, |&p| p as i64);
                exists_between(pb, at as i64, next_a)
            }),
            Template::AltPrecedence => pb.iter().enumerate().all(|(i, &at)| {
                let previous_b = if i == 0 { -1 } else { pb[i - 1] as i64 };
                exists_between(pa, previous_b, at as i64)
            }),
            Template::AltSuccession => {
                self.holds_when_both_present(Template::AltResponse, a, b)
                    && self.holds_when_both_present(Template::AltPrecedence, a, b)
            }
            Template::ChainResponse => pa
                .iter()
                .all(|&at| self.events.get(at as usize + 1) == Some(&b)),
            Template::ChainPrecedence => pb.iter().all(|&at| {
                at > 0 && self.events[at as usize - 1] == a
            }),
            Template::ChainSuccession => {
                self.holds_when_both_present(Template::ChainResponse, a, b)
                    && self.holds_when_both_present(Template::ChainPrecedence, a, b)
            }
            // Both occur, so the rule that they never both occur is broken.
            Template::NotCoExistence => false,
            Template::NotSuccession => !(self.first(a) < self.last(b)),
            Template::NotChainSuccession => pa
                .iter()
                .all(|&at| self.events.get(at as usize + 1) != Some(&b)),
            // A unary template says nothing about a pair.
            Template::Existence
            | Template::Absence
            | Template::ExactlyOne
            | Template::Init
            | Template::End => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::templates::Template::*;

    /// `"aba"` -> the trace a, b, a with activity ids by letter.
    fn trace(letters: &str) -> TraceIndex {
        let mut index = TraceIndex::new(26);
        for letter in letters.chars() {
            index.push(letter as u32 - 'a' as u32);
        }
        index
    }
    const A: u32 = 0;
    const B: u32 = 1;

    fn holds(letters: &str, template: Template) -> bool {
        trace(letters).holds_when_both_present(template, A, B)
    }

    #[test]
    fn response_asks_only_that_some_b_comes_after_the_last_a() {
        assert!(holds("ab", Response));
        assert!(holds("aab", Response));
        assert!(holds("abab", Response));
        assert!(holds("baab", Response), "a b before the first a is harmless");
        assert!(!holds("aba", Response), "the last a is never answered");
        assert!(!holds("ba", Response));
    }

    #[test]
    fn precedence_asks_only_that_some_a_comes_before_the_first_b() {
        assert!(holds("ab", Precedence));
        assert!(holds("abb", Precedence));
        assert!(holds("aba", Precedence));
        assert!(!holds("ba", Precedence));
        assert!(!holds("bab", Precedence), "the first b has no a before it");
    }

    #[test]
    fn succession_is_both_and_no_more() {
        assert!(holds("ab", Succession));
        assert!(holds("aabb", Succession));
        assert!(!holds("aba", Succession));
        assert!(!holds("bab", Succession));
    }

    #[test]
    fn alternating_forbids_two_of_the_same_in_a_row() {
        assert!(holds("abab", AltResponse));
        assert!(holds("ab", AltResponse));
        assert!(!holds("aab", AltResponse), "two a's with no b between them");
        assert!(holds("abb", AltResponse), "two b's are the other template's business");

        assert!(holds("abab", AltPrecedence));
        assert!(!holds("abb", AltPrecedence), "the second b has no a of its own");
        assert!(holds("aab", AltPrecedence));

        assert!(holds("abab", AltSuccession));
        assert!(!holds("aab", AltSuccession));
        assert!(!holds("abb", AltSuccession));
    }

    #[test]
    fn chain_means_immediately() {
        assert!(holds("ab", ChainResponse));
        assert!(holds("abab", ChainResponse));
        assert!(!holds("acb", ChainResponse));
        assert!(!holds("aba", ChainResponse), "the last a is followed by nothing");

        assert!(holds("ab", ChainPrecedence));
        assert!(!holds("acb", ChainPrecedence));
        assert!(!holds("bab", ChainPrecedence), "the first b has nothing before it");

        assert!(holds("abab", ChainSuccession));
        assert!(holds("abcab", ChainSuccession), "the c is between a b and an a, which nothing forbids");
        assert!(!holds("abac", ChainSuccession), "the second a is followed by c");
    }

    #[test]
    fn the_negative_templates_are_the_complements_they_claim_to_be() {
        assert!(!holds("ab", NotCoExistence), "both occur");
        assert!(!holds("ba", NotCoExistence));

        assert!(holds("ba", NotSuccession), "b before a is not a followed by b");
        assert!(!holds("ab", NotSuccession));
        assert!(!holds("acb", NotSuccession), "at any distance");

        assert!(holds("acb", NotChainSuccession), "not *immediately*");
        assert!(!holds("ab", NotChainSuccession));
        assert!(holds("ba", NotChainSuccession));
    }

    #[test]
    fn the_index_reports_the_facts_the_unary_templates_need() {
        let t = trace("abca");
        assert_eq!(t.count(A), 2);
        assert_eq!(t.count(B), 1);
        assert_eq!(t.count(3), 0);
        assert!(t.contains(2));
        assert!(!t.contains(4));
        assert!(t.starts_with(A));
        assert!(t.ends_with(A));
        assert!(!t.ends_with(B));
        assert_eq!(t.present().len(), 3, "in order of first appearance");
        assert_eq!(t.present()[0], A);
    }

    #[test]
    fn a_reused_index_forgets_the_previous_trace_completely() {
        let mut index = TraceIndex::new(26);
        for letter in "abc".chars() {
            index.push(letter as u32 - 'a' as u32);
        }
        index.reset();
        assert!(index.is_empty());
        assert!(index.present().is_empty());
        for letter in "ba".chars() {
            index.push(letter as u32 - 'a' as u32);
        }
        assert!(!index.contains(2), "c belonged to the previous trace");
        assert_eq!(index.count(B), 1);
        assert!(index.starts_with(B));
        assert!(!index.holds_when_both_present(Response, A, B));
    }

    #[test]
    fn an_activity_outside_the_selection_is_dropped_rather_than_panicking() {
        let mut index = TraceIndex::new(2);
        index.push(0);
        index.push(7);
        index.push(1);
        assert_eq!(index.len(), 2);
        assert!(index.holds_when_both_present(ChainResponse, 0, 1), "the dropped event leaves no gap");
    }
}
