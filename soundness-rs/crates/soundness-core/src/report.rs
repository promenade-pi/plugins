//! The `SoundnessReport` artifact payload.
//!
//! Types only — everything here is what crosses the wasm boundary and what the
//! view reads back. Transition and place ids are positions in `net`, which is
//! the *normalized* net echoed back alongside the diagnosis, so a finding's
//! `transitions: [3]` and the node the view draws are the same 3 whichever
//! wire shape the input arrived in.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// The net as analysed, in the shape every Petri-net renderer already
    /// reads. Carried in the report so the view can draw the diagnosis on the
    /// model itself without re-reading (or re-normalizing) the input artifact.
    pub net: NetEcho,
    pub summary: Summary,
    pub structure: StructureOut,
    pub behaviour: Behaviour,
    pub findings: Vec<Finding>,
    /// Anything about the *input* worth saying — a missing label table, a
    /// marking that had to be inferred, arcs that named nothing.
    pub warnings: Vec<String>,
}

/// Field names are `AcceptingPetriNet`'s, not this crate's, deliberately:
/// `promenade.artifact().value.net` can then be handed to the same renderer
/// code any other Petri-net view uses.
#[derive(Serialize)]
pub struct NetEcho {
    pub places: Vec<PlaceEcho>,
    pub activities: Vec<usize>,
    pub labels: Vec<Option<String>>,
    pub place_to_transition: Vec<(usize, usize)>,
    pub transition_to_place: Vec<(usize, usize)>,
    pub initial_marking: Vec<usize>,
    pub final_marking: Vec<usize>,
}

#[derive(Serialize)]
pub struct PlaceEcho {
    pub id: String,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Sound,
    Unsound,
    Inconclusive,
}

/// A single soundness requirement's outcome. `Unknown` is never a polite word
/// for `Fail` — it means the search did not get far enough to decide, and the
/// report says which requirement that was.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Pass,
    Fail,
    Unknown,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub verdict: Verdict,
    /// One sentence, already written for a human — the view shows it verbatim.
    pub headline: String,
    pub is_workflow_net: bool,
    pub bounded: Outcome,
    pub option_to_complete: Outcome,
    pub proper_completion: Outcome,
    pub no_dead_transitions: Outcome,
    pub errors: usize,
    pub warnings: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureOut {
    pub place_count: usize,
    pub transition_count: usize,
    pub silent_transition_count: usize,
    pub arc_count: usize,
    pub source_places: Vec<usize>,
    pub sink_places: Vec<usize>,
    pub disconnected_places: Vec<usize>,
    pub disconnected_transitions: Vec<usize>,
    pub free_choice: bool,
    pub state_machine: bool,
    pub marked_graph: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Behaviour {
    /// `complete` | `truncated` | `unbounded` — how the search ended, which is
    /// what decides whether an absent counterexample means anything.
    pub exploration: String,
    pub states: usize,
    pub final_reachable: Option<bool>,
    pub dead_transitions: Vec<usize>,
    pub deadlocks: Vec<Situation>,
    pub livelocks: Vec<Situation>,
    pub improper_completions: Vec<Situation>,
    pub unbounded: Option<Unbounded>,
}

/// A reachable marking that violates something, with the shortest firing
/// sequence that gets there. A witness is what turns "unsound" into a bug
/// report someone can act on.
#[derive(Serialize)]
pub struct Situation {
    /// `(place, tokens)` for every place holding at least one token.
    pub marking: Vec<(usize, u32)>,
    /// Transition ids, in firing order.
    pub trace: Vec<usize>,
    /// The same sequence as names, tau included — ready to print.
    pub steps: Vec<String>,
}

#[derive(Serialize)]
pub struct Unbounded {
    pub prefix: Vec<usize>,
    pub pump: Vec<usize>,
    pub steps: Vec<String>,
    pub growing_places: Vec<usize>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// Stable machine id, e.g. `WF-SINK` — safe to filter or link against.
    pub id: String,
    pub severity: Severity,
    pub title: String,
    pub detail: String,
    /// The places this finding is about; the view highlights them.
    pub places: Vec<usize>,
    pub transitions: Vec<usize>,
    pub witness: Option<Situation>,
}
