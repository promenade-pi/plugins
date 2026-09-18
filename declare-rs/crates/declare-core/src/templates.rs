//! The DECLARE templates, and what each one means about one trace.
//!
//! > Pesic, M., Schonenberg, H. & van der Aalst, W.M.P. (2007). *DECLARE: Full
//! > Support for Loosely-Structured Processes.* EDOC 2007, 287–298.
//!
//! A declarative model does not say what a process *does*; it says what it may
//! never do. Each template is a rule over one or two activities, and a model is
//! the set of rules a log obeys. That is a different claim from an imperative
//! model's, and the reason this paradigm is worth having next to the others: a
//! flexible process with fifty ways through has no readable Petri net, but it
//! may have five rules everyone follows.
//!
//! Each template below is stated three ways: the English sentence, the trace
//! condition that has to hold, and — in `tests/invariants.rs` — an independent
//! brute-force evaluator that shares none of this code. The semantics are the
//! standard ones; where a definition is ambiguous in the usual prose (what
//! "alternating" means for the last occurrence, whether a constraint may relate
//! an activity to itself) the choice is stated here.

use serde::{Deserialize, Serialize};

/// Which activities a constraint mentions, and which of them can violate it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Activation {
    /// The trace itself: a unary template is activated by every trace, so its
    /// confidence and support are the same number.
    Always,
    /// The first activity occurring: `response(a, b)` can only be broken by a
    /// trace containing `a`.
    First,
    /// The second activity occurring: `precedence(a, b)` is about traces with `b`.
    Second,
    /// Either: a succession is broken by an unanswered `a` *or* an unheralded `b`.
    Either,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Template {
    // --- unary ---
    /// `a` occurs at least once.
    Existence,
    /// `a` never occurs.
    Absence,
    /// `a` occurs exactly once.
    ExactlyOne,
    /// The trace starts with `a`.
    Init,
    /// The trace ends with `a`.
    End,

    // --- positive relations ---
    /// If `a` occurs then `b` occurs, in either order.
    RespondedExistence,
    /// Every `a` is eventually followed by `b`.
    Response,
    /// Every `b` is preceded by `a`.
    Precedence,
    /// Both of the above.
    Succession,
    /// Every `a` is followed by `b` before the next `a`.
    AltResponse,
    /// Every `b` is preceded by `a`, with no other `b` in between.
    AltPrecedence,
    /// Both of the above.
    AltSuccession,
    /// Every `a` is *immediately* followed by `b`.
    ChainResponse,
    /// Every `b` is *immediately* preceded by `a`.
    ChainPrecedence,
    /// Both of the above.
    ChainSuccession,

    // --- negative relations ---
    /// `a` and `b` never both occur.
    NotCoExistence,
    /// `a` is never followed, at any distance, by `b`.
    NotSuccession,
    /// `a` is never *immediately* followed by `b`.
    NotChainSuccession,
}

/// The family a template belongs to, which is what the discovery parameters
/// switch on: a user wants "no chain constraints", not a list of nine names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Family {
    /// About one activity on its own.
    Unary,
    /// Ordering between two activities, at any distance.
    Relation,
    /// Ordering with nothing of the same kind in between.
    Alternating,
    /// Immediate succession.
    Chain,
    /// Rules about what must *not* happen.
    Negative,
}

pub const ALL: [Template; 18] = [
    Template::Existence,
    Template::Absence,
    Template::ExactlyOne,
    Template::Init,
    Template::End,
    Template::RespondedExistence,
    Template::Response,
    Template::Precedence,
    Template::Succession,
    Template::AltResponse,
    Template::AltPrecedence,
    Template::AltSuccession,
    Template::ChainResponse,
    Template::ChainPrecedence,
    Template::ChainSuccession,
    Template::NotCoExistence,
    Template::NotSuccession,
    Template::NotChainSuccession,
];

impl Template {
    pub fn is_binary(self) -> bool {
        !matches!(
            self,
            Template::Existence
                | Template::Absence
                | Template::ExactlyOne
                | Template::Init
                | Template::End
        )
    }

    pub fn family(self) -> Family {
        match self {
            Template::Existence
            | Template::Absence
            | Template::ExactlyOne
            | Template::Init
            | Template::End => Family::Unary,
            Template::RespondedExistence
            | Template::Response
            | Template::Precedence
            | Template::Succession => Family::Relation,
            Template::AltResponse | Template::AltPrecedence | Template::AltSuccession => {
                Family::Alternating
            }
            Template::ChainResponse | Template::ChainPrecedence | Template::ChainSuccession => {
                Family::Chain
            }
            Template::NotCoExistence
            | Template::NotSuccession
            | Template::NotChainSuccession => Family::Negative,
        }
    }

    pub fn activation(self) -> Activation {
        match self {
            Template::Existence
            | Template::Absence
            | Template::ExactlyOne
            | Template::Init
            | Template::End => Activation::Always,
            Template::RespondedExistence
            | Template::Response
            | Template::AltResponse
            | Template::ChainResponse
            | Template::NotSuccession
            | Template::NotChainSuccession => Activation::First,
            Template::Precedence | Template::AltPrecedence | Template::ChainPrecedence => {
                Activation::Second
            }
            Template::Succession
            | Template::AltSuccession
            | Template::ChainSuccession
            | Template::NotCoExistence => Activation::Either,
        }
    }

    /// The wire name, which is also what the view reads.
    pub fn id(self) -> &'static str {
        match self {
            Template::Existence => "existence",
            Template::Absence => "absence",
            Template::ExactlyOne => "exactlyOne",
            Template::Init => "init",
            Template::End => "end",
            Template::RespondedExistence => "respondedExistence",
            Template::Response => "response",
            Template::Precedence => "precedence",
            Template::Succession => "succession",
            Template::AltResponse => "altResponse",
            Template::AltPrecedence => "altPrecedence",
            Template::AltSuccession => "altSuccession",
            Template::ChainResponse => "chainResponse",
            Template::ChainPrecedence => "chainPrecedence",
            Template::ChainSuccession => "chainSuccession",
            Template::NotCoExistence => "notCoExistence",
            Template::NotSuccession => "notSuccession",
            Template::NotChainSuccession => "notChainSuccession",
        }
    }

    /// The rule in one sentence, with `{a}` and `{b}` for the activities.
    ///
    /// Carried in the artifact rather than in the view, because the sentence
    /// *is* the model: a constraint nobody can read is a constraint nobody can
    /// act on, and a view that invented its own wording would be a second,
    /// drifting statement of the semantics.
    pub fn sentence(self) -> &'static str {
        match self {
            Template::Existence => "{a} happens at least once",
            Template::Absence => "{a} never happens",
            Template::ExactlyOne => "{a} happens exactly once",
            Template::Init => "every case starts with {a}",
            Template::End => "every case ends with {a}",
            Template::RespondedExistence => "if {a} happens, {b} happens too (in either order)",
            Template::Response => "every {a} is eventually followed by {b}",
            Template::Precedence => "{b} only happens after {a}",
            Template::Succession => "{a} is always followed by {b}, and {b} only follows {a}",
            Template::AltResponse => "every {a} is followed by {b} before the next {a}",
            Template::AltPrecedence => "every {b} follows an {a} with no other {b} in between",
            Template::AltSuccession => "{a} and {b} alternate",
            Template::ChainResponse => "{a} is always immediately followed by {b}",
            Template::ChainPrecedence => "{b} is always immediately preceded by {a}",
            Template::ChainSuccession => "{a} and {b} always happen back to back",
            Template::NotCoExistence => "{a} and {b} never both happen",
            Template::NotSuccession => "{a} is never followed by {b}",
            Template::NotChainSuccession => "{a} is never immediately followed by {b}",
        }
    }

    pub fn from_id(id: &str) -> Option<Template> {
        ALL.iter().copied().find(|t| t.id() == id)
    }
}

/// Which templates are strictly stronger than which, over the same pair of
/// activities and in the same direction.
///
/// Used only for pruning a discovered model (`discover::prune`): if the log
/// obeys `chainResponse(a, b)` then it necessarily obeys `response(a, b)`, and
/// reporting both says the same thing twice. The relation is transitive, so
/// only the immediate steps are listed.
pub fn implies(stronger: Template, weaker: Template) -> bool {
    use Template::*;
    matches!(
        (stronger, weaker),
        (ChainResponse, AltResponse)
            | (AltResponse, Response)
            | (Response, RespondedExistence)
            | (ChainPrecedence, AltPrecedence)
            | (AltPrecedence, Precedence)
            | (ChainSuccession, AltSuccession)
            | (AltSuccession, Succession)
            | (Succession, Response)
            | (Succession, Precedence)
            | (AltSuccession, AltResponse)
            | (AltSuccession, AltPrecedence)
            | (ChainSuccession, ChainResponse)
            | (ChainSuccession, ChainPrecedence)
            | (NotCoExistence, NotSuccession)
            | (NotSuccession, NotChainSuccession)
            | (ExactlyOne, Existence)
            | (Init, Existence)
            | (End, Existence)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_template_round_trips_through_its_id() {
        for t in ALL {
            assert_eq!(Template::from_id(t.id()), Some(t), "{:?}", t);
        }
        assert_eq!(Template::from_id("nonsense"), None);
    }

    #[test]
    fn a_unary_template_is_activated_by_every_trace() {
        for t in ALL {
            if t.is_binary() {
                assert_ne!(t.activation(), Activation::Always, "{:?}", t);
            } else {
                assert_eq!(t.activation(), Activation::Always, "{:?}", t);
            }
        }
    }

    #[test]
    fn every_sentence_names_the_activities_its_template_has() {
        for t in ALL {
            let sentence = t.sentence();
            assert!(sentence.contains("{a}"), "{:?}", t);
            assert_eq!(sentence.contains("{b}"), t.is_binary(), "{:?}", t);
        }
    }

    #[test]
    fn implication_points_from_the_stronger_rule_to_the_weaker_one() {
        // Sanity in the one direction anyone can check by eye: a chain
        // response is a response, and never the other way round.
        assert!(implies(Template::ChainResponse, Template::AltResponse));
        assert!(!implies(Template::Response, Template::ChainResponse));
        assert!(!implies(Template::Response, Template::Response));
    }
}
