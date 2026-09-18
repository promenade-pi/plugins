//! Turns the structural facts and the state graph into the report.
//!
//! The three classical requirements, as van der Aalst states them for a
//! workflow net with source `i` and sink `o` (*The application of Petri nets
//! to workflow management*, JCSC 8(1), 1998, and *Verification of workflow
//! nets*, ICATPN 1997):
//!
//! 1. **Option to complete** — from every marking reachable from `[i]`, the
//!    final marking `[o]` is still reachable.
//! 2. **Proper completion** — no reachable marking strictly covers `[o]`, i.e.
//!    nothing may be left over once the case is finished.
//! 3. **No dead transitions** — every transition fires in some reachable
//!    marking.
//!
//! Promenade's `AcceptingPetriNet` carries an explicit initial and final
//! marking rather than an implied `[i]`/`[o]`, so all three are evaluated
//! against the declared markings. On a genuine WF-net those coincide and this
//! is exactly the textbook property; on anything else the report says so
//! rather than refusing to look, because "your net is not a WF-net" and
//! "your net deadlocks" are different things to be told.
//!
//! What each requirement is allowed to conclude depends on how the search
//! ended, and that dependency is the whole reason `Outcome::Unknown` exists:
//!
//! | | complete | truncated / unbounded |
//! |---|---|---|
//! | a deadlock was reached | fail | fail — the state is genuinely reachable |
//! | a marking covering the final one was reached | fail | fail — same reason |
//! | no counterexample found | pass | unknown — the search stopped early |
//! | a transition never fired | fail | unknown — it may fire beyond the cap |

use crate::explore::{explore, Exploration};
use crate::net::Net;
use crate::report::*;
use crate::structure::{self, Node};
use std::collections::VecDeque;

/// How many witnesses of one kind travel in the report. A net with a hundred
/// deadlocks does not need a hundred traces to be actionable, and the payload
/// is inline JSON that the view holds in memory.
const MAX_WITNESSES: usize = 5;

pub struct Options {
    pub max_states: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self { max_states: 200_000 }
    }
}

fn tokens(marking: &[u32]) -> Vec<(usize, u32)> {
    marking.iter().enumerate().filter(|(_, &n)| n > 0).map(|(p, &n)| (p, n)).collect()
}

fn steps(net: &Net, trace: &[usize]) -> Vec<String> {
    trace.iter().map(|&t| net.name_of(t)).collect()
}

pub fn analyse(net: &Net, options: &Options) -> Report {
    let shape = structure::analyse(net);
    let exploration = explore(net, options.max_states);
    let graph = exploration.graph();
    let complete = matches!(exploration, Exploration::Complete(_));

    let final_state = graph.state_of(&net.final_marking);
    let situation = |state: usize| -> Situation {
        let trace = graph.trace_to(state);
        Situation { marking: tokens(&graph.markings[state]), steps: steps(net, &trace), trace }
    };

    // Backward closure from the final marking: every state outside it has lost
    // the option to complete. Only meaningful once the graph is complete.
    let mut completes = vec![false; graph.markings.len()];
    if let Some(final_state) = final_state {
        let mut incoming: Vec<Vec<usize>> = vec![Vec::new(); graph.markings.len()];
        for (from, edges) in graph.out.iter().enumerate() {
            for &(_, to) in edges {
                incoming[to].push(from);
            }
        }
        completes[final_state] = true;
        let mut queue = VecDeque::from([final_state]);
        while let Some(state) = queue.pop_front() {
            for &previous in &incoming[state] {
                if !completes[previous] {
                    completes[previous] = true;
                    queue.push_back(previous);
                }
            }
        }
    }

    // A state that was never expanded has no successors *yet*; calling that a
    // deadlock is the one mistake a truncated search invites.
    let deadlock_states: Vec<usize> = (0..graph.markings.len())
        .filter(|&s| graph.expanded[s] && graph.out[s].is_empty() && graph.markings[s] != net.final_marking)
        .collect();
    let improper_states: Vec<usize> = (0..graph.markings.len())
        .filter(|&s| {
            let m = &graph.markings[s];
            m != &net.final_marking
                && m.iter().zip(net.final_marking.iter()).all(|(a, b)| a >= b)
                && net.final_marking.iter().any(|&b| b > 0)
        })
        .collect();
    // Only meaningful when the final marking IS reachable from somewhere. When
    // it is reachable from nowhere, every state trivially "can never finish"
    // and listing them all buries the one finding that says why.
    let livelock_states: Vec<usize> = if complete && final_state.is_some() {
        (0..graph.markings.len())
            .filter(|&s| !completes[s] && !graph.out[s].is_empty())
            .collect()
    } else {
        Vec::new()
    };
    let dead_transitions: Vec<usize> =
        (0..net.transition_count()).filter(|&t| !graph.fired[t]).collect();

    let bounded = match &exploration {
        Exploration::Complete(_) => Outcome::Pass,
        Exploration::Unbounded { .. } => Outcome::Fail,
        Exploration::Truncated(_) => Outcome::Unknown,
    };
    let option_to_complete = if !deadlock_states.is_empty() || !livelock_states.is_empty() {
        Outcome::Fail
    } else if complete {
        // With a complete graph, "no deadlock and no livelock" is exactly
        // "every reachable marking still reaches the final one".
        if completes.iter().all(|&c| c) { Outcome::Pass } else { Outcome::Fail }
    } else {
        Outcome::Unknown
    };
    let proper_completion = if !improper_states.is_empty() {
        Outcome::Fail
    } else if complete {
        Outcome::Pass
    } else {
        Outcome::Unknown
    };
    let no_dead_transitions = if !complete {
        Outcome::Unknown
    } else if dead_transitions.is_empty() {
        Outcome::Pass
    } else {
        Outcome::Fail
    };

    let mut findings = Vec::new();

    // --- structure ------------------------------------------------------
    if shape.sources.len() != 1 {
        findings.push(Finding {
            id: "WF-SOURCE".into(),
            severity: Severity::Error,
            title: match shape.sources.len() {
                0 => "No source place".into(),
                n => format!("{n} source places"),
            },
            detail: if shape.sources.is_empty() {
                "A workflow net starts at exactly one place with no incoming arc. Every place here has one, so the net has no unambiguous point of entry — usually a loop that closes back onto the start."
                    .into()
            } else {
                "A workflow net starts at exactly one place with no incoming arc. Several places qualify, so which one a case begins in is ambiguous."
                    .into()
            },
            places: shape.sources.clone(),
            transitions: Vec::new(),
            witness: None,
        });
    }
    if shape.sinks.len() != 1 {
        findings.push(Finding {
            id: "WF-SINK".into(),
            severity: Severity::Error,
            title: match shape.sinks.len() {
                0 => "No sink place".into(),
                n => format!("{n} sink places"),
            },
            detail: if shape.sinks.is_empty() {
                "A workflow net ends at exactly one place with no outgoing arc. No place here qualifies, so no marking represents a finished case."
                    .into()
            } else {
                "A workflow net ends at exactly one place with no outgoing arc. Several places qualify, so 'finished' has more than one meaning in this model."
                    .into()
            },
            places: shape.sinks.clone(),
            transitions: Vec::new(),
            witness: None,
        });
    }
    if !shape.disconnected.is_empty() {
        let places: Vec<usize> = shape
            .disconnected
            .iter()
            .filter_map(|n| match n {
                Node::Place(p) => Some(*p),
                _ => None,
            })
            .collect();
        let transitions: Vec<usize> = shape
            .disconnected
            .iter()
            .filter_map(|n| match n {
                Node::Transition(t) => Some(*t),
                _ => None,
            })
            .collect();
        findings.push(Finding {
            id: "WF-CONNECTED".into(),
            severity: Severity::Error,
            title: format!(
                "{} node(s) off every path from start to end",
                places.len() + transitions.len()
            ),
            detail: "In a workflow net every place and transition lies on some path from the source place to the sink place. These do not, so no case can ever involve them."
                .into(),
            places,
            transitions,
            witness: None,
        });
    }
    if !shape.no_input_transitions.is_empty() {
        findings.push(Finding {
            id: "NET-NO-INPUT".into(),
            severity: Severity::Warning,
            title: format!("{} transition(s) with no input place", shape.no_input_transitions.len()),
            detail: "A transition with an empty preset is enabled in every marking and can fire without limit — it is the usual cause of an unbounded net."
                .into(),
            places: Vec::new(),
            transitions: shape.no_input_transitions.clone(),
            witness: None,
        });
    }
    if !shape.no_output_transitions.is_empty() {
        findings.push(Finding {
            id: "NET-NO-OUTPUT".into(),
            severity: Severity::Warning,
            title: format!("{} transition(s) with no output place", shape.no_output_transitions.len()),
            detail: "A transition with an empty postset consumes tokens and produces none. Whatever flows into it leaves the net.".into(),
            places: Vec::new(),
            transitions: shape.no_output_transitions.clone(),
            witness: None,
        });
    }
    if !shape.isolated_places.is_empty() {
        findings.push(Finding {
            id: "NET-ISOLATED-PLACE".into(),
            severity: Severity::Warning,
            title: format!("{} place(s) with no arcs", shape.isolated_places.len()),
            detail: "These places are connected to nothing. They are usually left over from an edit or a lossy conversion.".into(),
            places: shape.isolated_places.clone(),
            transitions: Vec::new(),
            witness: None,
        });
    }

    // --- behaviour ------------------------------------------------------
    if let Exploration::Unbounded { witness, .. } = &exploration {
        let mut trace = witness.prefix.clone();
        trace.extend(witness.pump.iter().copied());
        findings.push(Finding {
            id: "SND-UNBOUNDED".into(),
            severity: Severity::Error,
            title: "Unbounded: tokens accumulate without limit".into(),
            detail: format!(
                "{} {} returns the net to a marking that covers the one it started from, while adding tokens to {}. Repeating that sequence adds more every round, so the number of tokens in the net has no bound \u{2014} and an unbounded workflow net is never sound.",
                if witness.prefix.is_empty() {
                    "Firing".to_string()
                } else {
                    format!("Once {} has run, firing", steps(net, &witness.prefix).join(" \u{2192} "))
                },
                steps(net, &witness.pump).join(" \u{2192} "),
                witness
                    .growing
                    .iter()
                    .map(|p| format!("place {p}"))
                    .collect::<Vec<_>>()
                    .join(", "),
            ),
            places: witness.growing.clone(),
            transitions: witness.pump.clone(),
            witness: Some(Situation {
                marking: Vec::new(),
                steps: steps(net, &trace),
                trace,
            }),
        });
    }
    if !deadlock_states.is_empty() {
        let first = deadlock_states[0];
        findings.push(Finding {
            id: "SND-DEADLOCK".into(),
            severity: Severity::Error,
            title: format!("{} reachable deadlock(s)", deadlock_states.len()),
            detail: "A marking is reachable in which no transition is enabled and the case is not finished. The shortest firing sequence that gets there is attached; the highlighted places are the ones still holding tokens when everything stops."
                .into(),
            places: graph.markings[first].iter().enumerate().filter(|(_, &n)| n > 0).map(|(p, _)| p).collect(),
            transitions: Vec::new(),
            witness: Some(situation(first)),
        });
    }
    if !livelock_states.is_empty() {
        let first = livelock_states[0];
        findings.push(Finding {
            id: "SND-LIVELOCK".into(),
            severity: Severity::Error,
            title: format!("{} marking(s) that can never finish", livelock_states.len()),
            detail: "From these markings the net keeps running — transitions stay enabled — but the final marking is no longer reachable from any of them. The case is live and lost at the same time."
                .into(),
            places: graph.markings[first].iter().enumerate().filter(|(_, &n)| n > 0).map(|(p, _)| p).collect(),
            transitions: Vec::new(),
            witness: Some(situation(first)),
        });
    }
    // `complete` and nothing else: an unbounded search stops at the covering
    // pair, so the final marking being absent from the states it happened to
    // enumerate says nothing about whether it is reachable.
    if final_state.is_none() && complete {
        findings.push(Finding {
            id: "SND-FINAL-UNREACHABLE".into(),
            severity: Severity::Error,
            title: "The final marking is never reached".into(),
            detail: "No firing sequence from the initial marking produces the declared final marking, so no case can ever complete.".into(),
            places: net.final_marking.iter().enumerate().filter(|(_, &n)| n > 0).map(|(p, _)| p).collect(),
            transitions: Vec::new(),
            witness: None,
        });
    }
    if !improper_states.is_empty() {
        let first = improper_states[0];
        findings.push(Finding {
            id: "SND-IMPROPER".into(),
            severity: Severity::Error,
            title: format!("{} marking(s) complete with tokens left over", improper_states.len()),
            detail: "A reachable marking holds everything the final marking asks for and more. The case looks finished while work is still pending somewhere else in the net — the classic symptom of an AND-split whose branches are joined by an XOR."
                .into(),
            places: graph.markings[first]
                .iter()
                .zip(net.final_marking.iter())
                .enumerate()
                .filter(|(_, (a, b))| a > b)
                .map(|(p, _)| p)
                .collect(),
            transitions: Vec::new(),
            witness: Some(situation(first)),
        });
    }
    if !dead_transitions.is_empty() && complete {
        findings.push(Finding {
            id: "SND-DEAD-TRANSITION".into(),
            severity: Severity::Error,
            title: format!("{} dead transition(s)", dead_transitions.len()),
            detail: format!(
                "These transitions are enabled in no reachable marking, so they can never fire: {}. In a discovered model they are behaviour the miner put in the net that the net itself forbids.",
                dead_transitions.iter().map(|&t| net.name_of(t)).collect::<Vec<_>>().join(", ")
            ),
            places: Vec::new(),
            transitions: dead_transitions.clone(),
            witness: None,
        });
    }
    if matches!(exploration, Exploration::Truncated(_)) {
        findings.push(Finding {
            id: "SND-TRUNCATED".into(),
            severity: Severity::Warning,
            title: format!("Search stopped after {} states", graph.markings.len()),
            detail: "The state space did not fit in the configured budget, so the requirements below are reported only where a counterexample was actually found. Raise the state limit to decide the rest."
                .into(),
            places: Vec::new(),
            transitions: Vec::new(),
            witness: None,
        });
    }

    let verdict = if [bounded, option_to_complete, proper_completion, no_dead_transitions]
        .iter()
        .any(|o| *o == Outcome::Fail)
        || findings.iter().any(|f| f.severity == Severity::Error)
    {
        Verdict::Unsound
    } else if [bounded, option_to_complete, proper_completion, no_dead_transitions]
        .iter()
        .all(|o| *o == Outcome::Pass)
    {
        Verdict::Sound
    } else {
        Verdict::Inconclusive
    };

    // `Verdict::Sound` implies the net is a workflow net: the three structural
    // requirements are the three `WF-*` findings, and any of them being raised
    // is an error, which forces `Unsound`. That is pm4py's reading too — a net
    // that is not a WF-net is not a sound WF-net — and the per-requirement
    // outcomes below still say exactly how it behaves.
    let headline = match verdict {
        Verdict::Sound => {
            "This is a sound workflow net: every case can finish, finishes cleanly, and every transition can fire.".into()
        }
        Verdict::Unsound => {
            let errors = findings.iter().filter(|f| f.severity == Severity::Error).count();
            format!("Not sound: {errors} problem(s) below, each with the place, transition or firing sequence that shows it.")
        }
        Verdict::Inconclusive => {
            "No problem was found, but the search did not finish, so soundness is undecided rather than established.".into()
        }
    };

    let arc_count: usize = (0..net.transition_count())
        .map(|t| {
            net.pre[t].iter().map(|&(_, w)| w as usize).sum::<usize>()
                + net.post[t].iter().map(|&(_, w)| w as usize).sum::<usize>()
        })
        .sum();

    for finding in &mut findings {
        finding.places.sort_unstable();
        finding.places.dedup();
        finding.transitions.sort_unstable();
        finding.transitions.dedup();
    }
    let errors = findings.iter().filter(|f| f.severity == Severity::Error).count();
    let warnings = findings.iter().filter(|f| f.severity == Severity::Warning).count();

    Report {
        net: echo(net),
        summary: Summary {
            verdict,
            headline,
            is_workflow_net: shape.is_workflow_net,
            bounded,
            option_to_complete,
            proper_completion,
            no_dead_transitions,
            errors,
            warnings,
        },
        structure: StructureOut {
            place_count: net.place_count,
            transition_count: net.transition_count(),
            silent_transition_count: net.labels.iter().filter(|l| l.is_none()).count(),
            arc_count,
            source_places: shape.sources,
            sink_places: shape.sinks,
            disconnected_places: shape
                .disconnected
                .iter()
                .filter_map(|n| match n {
                    Node::Place(p) => Some(*p),
                    _ => None,
                })
                .collect(),
            disconnected_transitions: shape
                .disconnected
                .iter()
                .filter_map(|n| match n {
                    Node::Transition(t) => Some(*t),
                    _ => None,
                })
                .collect(),
            free_choice: shape.free_choice,
            state_machine: shape.state_machine,
            marked_graph: shape.marked_graph,
        },
        behaviour: Behaviour {
            exploration: match &exploration {
                Exploration::Complete(_) => "complete".into(),
                Exploration::Truncated(_) => "truncated".into(),
                Exploration::Unbounded { .. } => "unbounded".into(),
            },
            states: graph.markings.len(),
            final_reachable: if complete || final_state.is_some() {
                Some(final_state.is_some())
            } else {
                None
            },
            dead_transitions: if complete { dead_transitions } else { Vec::new() },
            deadlocks: deadlock_states.iter().take(MAX_WITNESSES).map(|&s| situation(s)).collect(),
            livelocks: livelock_states.iter().take(MAX_WITNESSES).map(|&s| situation(s)).collect(),
            improper_completions: improper_states
                .iter()
                .take(MAX_WITNESSES)
                .map(|&s| situation(s))
                .collect(),
            unbounded: match &exploration {
                Exploration::Unbounded { witness, .. } => {
                    let mut trace = witness.prefix.clone();
                    trace.extend(witness.pump.iter().copied());
                    Some(Unbounded {
                        prefix: witness.prefix.clone(),
                        pump: witness.pump.clone(),
                        steps: steps(net, &trace),
                        growing_places: witness.growing.clone(),
                    })
                }
                _ => None,
            },
        },
        findings,
        warnings: net.warnings.clone(),
    }
}

/// The net in `AcceptingPetriNet`'s own field names, with arc weights expanded
/// back into repeated pairs so an existing renderer reads it unchanged.
fn echo(net: &Net) -> NetEcho {
    let mut place_to_transition = Vec::new();
    let mut transition_to_place = Vec::new();
    for t in 0..net.transition_count() {
        for &(place, weight) in &net.pre[t] {
            for _ in 0..weight {
                place_to_transition.push((place, t));
            }
        }
        for &(place, weight) in &net.post[t] {
            for _ in 0..weight {
                transition_to_place.push((t, place));
            }
        }
    }
    let expand = |marking: &[u32]| -> Vec<usize> {
        marking
            .iter()
            .enumerate()
            .flat_map(|(p, &n)| std::iter::repeat(p).take(n as usize))
            .collect()
    };
    NetEcho {
        places: (0..net.place_count).map(|p| PlaceEcho { id: format!("p{p}") }).collect(),
        activities: (0..net.transition_count()).collect(),
        labels: net.labels.clone(),
        place_to_transition,
        transition_to_place,
        initial_marking: expand(&net.initial),
        final_marking: expand(&net.final_marking),
    }
}
