//! The six relations a log skeleton is made of.
//!
//! > Verbeek, H.M.W. & de Carvalho, R.M. (2018). *Log skeletons: a
//! > classification approach to process discovery.* arXiv:1806.08247.
//!
//! The skeleton is not a process model in the usual sense — there is nothing to
//! walk through. It is a list of facts that held in every trace of the log, and
//! its purpose is to *classify*: given a new trace, does it break any of them?
//! The paper entered it in the Process Discovery Contest on exactly that basis.
//!
//! Four of the six are DECLARE templates under another name, and are evaluated
//! by `declare-core` rather than restated here — two implementations of "every
//! `a` is eventually followed by `b`" is two chances to disagree:
//!
//! | Log skeleton | DECLARE |
//! |---|---|
//! | always after `(a, b)` | `response(a, b)` |
//! | always before `(a, b)` | `precedence(b, a)` |
//! | never together `(a, b)` | `notCoExistence(a, b)` |
//! | directly follows `(a, b)` | `chainResponse(a, b)` |
//!
//! The other two are the skeleton's own, and neither can be expressed in
//! DECLARE at all: **equivalence** counts occurrences, and **activity counts**
//! records the set of counts an activity was ever seen with.

use declare_core::templates::Template;
use declare_core::TraceIndex;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Relation {
    /// `a` and `b` occur the same number of times, in every trace.
    Equivalence,
    /// Every occurrence of `a` has a `b` somewhere before it.
    AlwaysBefore,
    /// Every occurrence of `a` has a `b` somewhere after it.
    AlwaysAfter,
    /// `a` and `b` never both occur in one trace.
    NeverTogether,
    /// Every `a` is immediately followed by `b`.
    DirectlyFollows,
}

pub const ALL: [Relation; 5] = [
    Relation::Equivalence,
    Relation::AlwaysBefore,
    Relation::AlwaysAfter,
    Relation::NeverTogether,
    Relation::DirectlyFollows,
];

impl Relation {
    pub fn id(self) -> &'static str {
        match self {
            Relation::Equivalence => "equivalence",
            Relation::AlwaysBefore => "alwaysBefore",
            Relation::AlwaysAfter => "alwaysAfter",
            Relation::NeverTogether => "neverTogether",
            Relation::DirectlyFollows => "directlyFollows",
        }
    }

    pub fn from_id(id: &str) -> Option<Relation> {
        ALL.iter().copied().find(|r| r.id() == id)
    }

    /// The rule in one sentence, with `{a}` and `{b}` for the activities.
    pub fn sentence(self) -> &'static str {
        match self {
            Relation::Equivalence => "{a} and {b} happen the same number of times",
            Relation::AlwaysBefore => "{a} never happens before {b} has happened",
            Relation::AlwaysAfter => "{a} is always followed by {b} later on",
            Relation::NeverTogether => "{a} and {b} never both happen",
            Relation::DirectlyFollows => "{a} is always immediately followed by {b}",
        }
    }

    /// The DECLARE template this relation *is*, and the order of its
    /// activities, for the four that have one.
    ///
    /// `AlwaysBefore(a, b)` is `precedence(b, a)`: "every `a` has a `b` before
    /// it" and "`a` only happens after `b`" are the same sentence read from
    /// opposite ends, which is exactly the kind of thing worth having a test
    /// for rather than a comment.
    pub fn as_template(self) -> Option<(Template, bool)> {
        match self {
            Relation::AlwaysAfter => Some((Template::Response, false)),
            Relation::AlwaysBefore => Some((Template::Precedence, true)),
            Relation::NeverTogether => Some((Template::NotCoExistence, false)),
            Relation::DirectlyFollows => Some((Template::ChainResponse, false)),
            Relation::Equivalence => None,
        }
    }

    /// Whether the relation holds for `(a, b)` in this trace, **given that both
    /// activities occur in it**.
    ///
    /// The one-is-missing cases are decided by counting over the whole log
    /// rather than trace by trace — see `counters` — which is what keeps the
    /// scan's inner loop over the pairs actually present.
    pub fn holds_when_both_present(self, trace: &TraceIndex, a: u32, b: u32) -> bool {
        match self.as_template() {
            Some((template, swapped)) => {
                let (x, y) = if swapped { (b, a) } else { (a, b) };
                trace.holds_when_both_present(template, x, y)
            }
            None => trace.count(a) == trace.count(b),
        }
    }

    /// Whether the relation holds when exactly one of the two occurs.
    ///
    /// Stated here rather than derived, because this is where the six
    /// definitions genuinely differ and where a wrong answer is invisible: a
    /// log in which `b` never occurs makes "`a` is always followed by `b`"
    /// false and "`a` and `b` never both happen" true, and both of those are
    /// facts about the log worth recording.
    pub fn holds_with_one_missing(self, has_a: bool) -> bool {
        match self {
            // One occurs, the other does not: the counts differ.
            Relation::Equivalence => false,
            // "Every a has a b before it" is broken by an a with no b, and
            // vacuously true when there is no a at all.
            Relation::AlwaysBefore | Relation::AlwaysAfter | Relation::DirectlyFollows => !has_a,
            // They cannot both happen if only one of them did.
            Relation::NeverTogether => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trace(letters: &str) -> TraceIndex {
        let mut index = TraceIndex::new(26);
        for letter in letters.chars() {
            index.push(letter as u32 - 'a' as u32);
        }
        index
    }
    const A: u32 = 0;
    const B: u32 = 1;

    fn holds(letters: &str, relation: Relation) -> bool {
        relation.holds_when_both_present(&trace(letters), A, B)
    }

    #[test]
    fn equivalence_counts_rather_than_orders() {
        assert!(holds("ab", Relation::Equivalence));
        assert!(holds("ba", Relation::Equivalence), "order is not its business");
        assert!(holds("abab", Relation::Equivalence));
        assert!(!holds("aab", Relation::Equivalence));
    }

    #[test]
    fn always_after_is_response_and_always_before_is_precedence_reversed() {
        assert!(holds("ab", Relation::AlwaysAfter));
        assert!(!holds("ba", Relation::AlwaysAfter));
        assert!(!holds("aba", Relation::AlwaysAfter), "the last a has no b after it");

        assert!(holds("ba", Relation::AlwaysBefore));
        assert!(!holds("ab", Relation::AlwaysBefore));
        assert!(holds("bab", Relation::AlwaysBefore), "the one a still has a b before it");
    }

    #[test]
    fn never_together_and_directly_follows_are_the_other_two() {
        assert!(!holds("ab", Relation::NeverTogether), "both occur");
        assert!(holds("ab", Relation::DirectlyFollows));
        assert!(!holds("acb", Relation::DirectlyFollows));
    }

    #[test]
    fn one_missing_activity_decides_each_relation_differently() {
        // `a` occurred, `b` did not.
        assert!(!Relation::Equivalence.holds_with_one_missing(true));
        assert!(!Relation::AlwaysAfter.holds_with_one_missing(true));
        assert!(!Relation::AlwaysBefore.holds_with_one_missing(true));
        assert!(!Relation::DirectlyFollows.holds_with_one_missing(true));
        assert!(Relation::NeverTogether.holds_with_one_missing(true));

        // `b` occurred, `a` did not: nothing demands anything of `b`.
        assert!(!Relation::Equivalence.holds_with_one_missing(false));
        assert!(Relation::AlwaysAfter.holds_with_one_missing(false));
        assert!(Relation::AlwaysBefore.holds_with_one_missing(false));
        assert!(Relation::DirectlyFollows.holds_with_one_missing(false));
        assert!(Relation::NeverTogether.holds_with_one_missing(false));
    }

    #[test]
    fn every_relation_round_trips_through_its_id() {
        for relation in ALL {
            assert_eq!(Relation::from_id(relation.id()), Some(relation));
        }
        assert_eq!(Relation::from_id("nonsense"), None);
    }
}
