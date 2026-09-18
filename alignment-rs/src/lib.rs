//! Conformance checking — replays a log against a Petri net, two ways.
//!
//! Both techniques answer "does this model explain this log", and both are
//! here rather than in two packages because they share everything that
//! matters: the same two inputs, the same one-pass scan into per-case
//! sequences, the same variant grouping, the same resolved model. What
//! differs is one loop body.
//!
//! # Alignments
//!
//! Given a trace and a model, an *alignment* is the cheapest way to explain
//! the trace in terms of the model: a sequence of moves that is simultaneously
//! a valid firing sequence of the net and, once its log-side is read off,
//! the trace itself. Three move kinds:
//!
//!   sync move   the next trace activity IS the label of a transition that is
//!               enabled right now — both advance together. Cost 0.
//!   log move    the next trace activity has no matching enabled transition —
//!               it is skipped, unexplained by the model. Cost 1.
//!   model move  a transition fires without a matching trace activity — the
//!               model needed a step the log does not show. Cost 1, or 0 if
//!               the transition is silent (unlabelled): a silent step is by
//!               definition never observed in a log, so it costs nothing to
//!               assume it happened.
//!
//! The search space is the *synchronous product*: states are (marking, how
//! much of the trace has been consumed). This is exactly Dijkstra's shortest
//! path from (initial marking, 0) to (final marking, |trace|) — not the
//! ILP-heuristic-accelerated A* the ProM/pm4py reference implementations use
//! (that needs a marking-equation LP solver, real additional machinery), but
//! it finds the same *optimal* alignment: Dijkstra with zero-weight edges
//! (every sync and silent move) is still exact, just potentially slower on
//! very large search spaces. See `docs/algorithm.md`.
//!
//! Alignment runs once per *distinct trace variant*, not once per case — on
//! a real log, hundreds of thousands of cases are typically only a few
//! hundred distinct activity sequences (see the Cases & Variants view), so
//! this is the difference between a search that finishes instantly and one
//! that redoes the same work hundreds of thousands of times.
//!
//! # Token-based replay
//!
//! The older, cheaper technique (Rozinat & van der Aalst 2008): fire the
//! trace through the net event by event, and when a transition is not
//! enabled, *force* it — put the tokens it needs into the empty input places
//! and count them as **missing**. Tokens still sitting in the net when the
//! trace ends are **remaining**. Fitness is how few of each there were,
//! against how many tokens the replay produced and consumed in total.
//!
//! It is a linear walk, not a search: no state space, no cap, no way to
//! hang. The price is that it is *optimistic* — it commits to a choice at
//! every step and never backtracks, so on a model with duplicate labels or
//! heavy concurrency it can report a better fitness than an alignment would.
//! What it gives back is a diagnosis an alignment does not: the deviation is
//! attributed to a *place*, not to a position in a move sequence, so the
//! answer to "where in the model does this log break" is a coordinate on the
//! net rather than something to be read off a table.
//!
//! Silent transitions are not force-fired. Before declaring a transition
//! un-enabled, a bounded breadth-first search fires *only* silent
//! transitions looking for a marking that enables it — without this, every
//! Inductive Miner model (which is mostly silent routing) would replay as
//! near-total deviation. The same search runs once more at the end, to reach
//! the final marking before counting what is left over.

use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use wasm_bindgen::prelude::*;

/// A marking is a bitmask over places — nets are assumed 1-safe, the same
/// convention `AcceptingPetriNet` already uses (`initial_marking` /
/// `final_marking` are place *index lists*, not (place, count) pairs).
/// 128 places is a generous cap for a discovered model; exceeding it is
/// reported rather than silently truncated (losing a place from the mask
/// would make the alignment wrong, not approximate).
const MAX_PLACES: usize = 128;
/// Safety valve against a pathologically large search space (heavy
/// concurrency in the model) — past this many explored states the search
/// gives up and reports the variant as unreachable rather than hanging the
/// worker.
const MAX_STATES: usize = 300_000;

// ------------------------------------------------------------- the model ---

/// One transition, as sent by the host: which log activity id it produces a
/// synchronous move for, or `None` for a silent (unlabelled) transition.
/// The host resolves this — a transition's label is a name, and names live
/// in the log's own activity id space, which only the host knows.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransitionIn {
    activity_id: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelIn {
    place_count: usize,
    transitions: Vec<TransitionIn>,
    /// (place, transition index)
    place_to_transition: Vec<(usize, usize)>,
    /// (transition index, place)
    transition_to_place: Vec<(usize, usize)>,
    initial_marking: Vec<usize>,
    final_marking: Vec<usize>,
}

struct Model {
    activity_of: Vec<Option<u32>>,
    /// Input/output place bitmasks, indexed by transition.
    inputs: Vec<u128>,
    outputs: Vec<u128>,
    initial: u128,
    final_marking: u128,
    /// The same arcs as `inputs`/`outputs`, as place index lists.
    ///
    /// Alignment wants a bitmask: its state is a marking, it is hashed into a
    /// Dijkstra frontier millions of times, and a 1-safe net makes that a
    /// single `u128` compare. Token-based replay wants the lists: it *counts*
    /// tokens per place (forcing a transition adds one, and a leftover token
    /// is a number, not a bit) and it walks a trace once rather than searching,
    /// so there is nothing to hash and nothing to make compact.
    in_places: Vec<Vec<usize>>,
    out_places: Vec<Vec<usize>>,
    place_count: usize,
    initial_places: Vec<usize>,
    final_places: Vec<usize>,
    /// Transitions bearing each log activity id. More than one is normal —
    /// a process tree that uses the same activity in two branches produces
    /// two transitions with the same label.
    by_activity: HashMap<u32, Vec<usize>>,
    /// Indices of the silent transitions, in order — the only ones the
    /// token replay is allowed to fire on its own initiative.
    silent: Vec<usize>,
}

/// Valid, distinct place indices, in the order given. Same reason as the arc
/// lists: the bitmask form of a marking cannot hold a place twice, so the
/// list form must not either.
fn dedup_places(places: &[usize], place_count: usize) -> Vec<usize> {
    let mut out: Vec<usize> = Vec::with_capacity(places.len());
    for &p in places {
        if p < place_count && !out.contains(&p) { out.push(p); }
    }
    out
}

impl Model {
    fn build(m: &ModelIn) -> Result<Model, String> {
        if m.place_count > MAX_PLACES {
            return Err(format!(
                "model has {} places; alignment is bounded to {MAX_PLACES}",
                m.place_count
            ));
        }
        let n = m.transitions.len();
        let mut inputs = vec![0u128; n];
        let mut outputs = vec![0u128; n];
        for &(p, t) in &m.place_to_transition {
            if t < n { inputs[t] |= 1u128 << p; }
        }
        for &(t, p) in &m.transition_to_place {
            if t < n { outputs[t] |= 1u128 << p; }
        }
        let mut initial = 0u128;
        for &p in &m.initial_marking { initial |= 1u128 << p; }
        let mut final_marking = 0u128;
        for &p in &m.final_marking { final_marking |= 1u128 << p; }

        // Deduplicated, unlike the bitmask above, which gets it for free: a
        // repeated arc would otherwise make the replay consume two tokens
        // from a place it only checked for one — an underflow, not a wrong
        // number. The two representations have to describe the same net, and
        // `|=` is idempotent while `push` is not.
        let mut in_places = vec![Vec::new(); n];
        let mut out_places = vec![Vec::new(); n];
        for &(p, t) in &m.place_to_transition {
            if t < n && p < m.place_count && !in_places[t].contains(&p) { in_places[t].push(p); }
        }
        for &(t, p) in &m.transition_to_place {
            if t < n && p < m.place_count && !out_places[t].contains(&p) { out_places[t].push(p); }
        }

        let activity_of: Vec<Option<u32>> = m.transitions.iter().map(|t| t.activity_id).collect();
        let mut by_activity: HashMap<u32, Vec<usize>> = HashMap::new();
        let mut silent = Vec::new();
        for (t, a) in activity_of.iter().enumerate() {
            match a {
                Some(a) => by_activity.entry(*a).or_default().push(t),
                None => silent.push(t),
            }
        }

        Ok(Model {
            activity_of,
            inputs,
            outputs,
            initial,
            final_marking,
            in_places,
            out_places,
            place_count: m.place_count,
            initial_places: dedup_places(&m.initial_marking, m.place_count),
            final_places: dedup_places(&m.final_marking, m.place_count),
            by_activity,
            silent,
        })
    }
}

// --------------------------------------------------------- the algorithm ---

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct State {
    marking: u128,
    pos: u32,
}

#[derive(Clone, Serialize)]
struct Move {
    kind: &'static str, // "sync" | "log" | "model" | "silent"
    /// The log activity id — present for sync, log, and visible model moves;
    /// absent only for a silent model move (nothing to name).
    activity: Option<u32>,
    /// The marking reached once this move fires (unchanged for a log move,
    /// which does not touch the model side at all). Not meaningful to a
    /// caller outside this crate — kept out of the wire format — but this is
    /// what lets `align`'s precision pass replay a path's markings exactly,
    /// rather than re-deriving "which transition fired" from an activity id
    /// that, with duplicate labels, would not always identify one uniquely.
    #[serde(skip)]
    after: u128,
}

struct SearchResult {
    reached: bool,
    cost: u32,
    moves: Vec<Move>,
}

/// Dijkstra over the synchronous product. An empty `trace` finds the
/// cheapest way to reach the final marking from the initial one with no log
/// at all — used to normalise fitness (see `align`).
fn shortest_alignment(model: &Model, trace: &[u32]) -> SearchResult {
    let start = State { marking: model.initial, pos: 0 };
    let goal_pos = trace.len() as u32;

    let mut dist: HashMap<State, u32> = HashMap::new();
    let mut prev: HashMap<State, (State, Move)> = HashMap::new();
    let mut heap: BinaryHeap<Reverse<(u32, State)>> = BinaryHeap::new();

    dist.insert(start, 0);
    heap.push(Reverse((0, start)));

    let relax = |ns: State, nd: u32, s: State, mv: Move,
                 dist: &mut HashMap<State, u32>, prev: &mut HashMap<State, (State, Move)>,
                 heap: &mut BinaryHeap<Reverse<(u32, State)>>| {
        if nd < dist.get(&ns).copied().unwrap_or(u32::MAX) {
            dist.insert(ns, nd);
            prev.insert(ns, (s, mv));
            heap.push(Reverse((nd, ns)));
        }
    };

    while let Some(Reverse((d, s))) = heap.pop() {
        if dist.get(&s).copied().unwrap_or(u32::MAX) < d { continue; } // stale entry
        if s.marking == model.final_marking && s.pos == goal_pos {
            let mut moves = Vec::new();
            let mut cur = s;
            while let Some((p, mv)) = prev.get(&cur) {
                moves.push(mv.clone());
                cur = *p;
            }
            moves.reverse();
            return SearchResult { reached: true, cost: d, moves };
        }
        if dist.len() > MAX_STATES { break; }

        // Log move: the next trace event is skipped, unexplained by the model.
        if s.pos < goal_pos {
            let ns = State { marking: s.marking, pos: s.pos + 1 };
            let mv = Move { kind: "log", activity: Some(trace[s.pos as usize]), after: s.marking };
            relax(ns, d + 1, s, mv, &mut dist, &mut prev, &mut heap);
        }

        // Every enabled transition: a sync move if its label matches the next
        // trace event, a model move otherwise (visible costs 1, silent costs 0).
        for t in 0..model.activity_of.len() {
            if model.inputs[t] & s.marking != model.inputs[t] { continue; }
            let fired = (s.marking & !model.inputs[t]) | model.outputs[t];
            let act = model.activity_of[t];

            if s.pos < goal_pos && act == Some(trace[s.pos as usize]) {
                let ns = State { marking: fired, pos: s.pos + 1 };
                let mv = Move { kind: "sync", activity: act, after: fired };
                relax(ns, d, s, mv, &mut dist, &mut prev, &mut heap);
            } else {
                let ns = State { marking: fired, pos: s.pos };
                let cost = if act.is_none() { 0 } else { 1 };
                let mv = Move {
                    kind: if act.is_none() { "silent" } else { "model" }, activity: act, after: fired,
                };
                relax(ns, d + cost, s, mv, &mut dist, &mut prev, &mut heap);
            }
        }
    }

    SearchResult { reached: false, cost: u32::MAX, moves: Vec::new() }
}

/// Activity ids of every *visible* (labelled) transition enabled at a
/// marking — a silent transition is never something the log could have
/// chosen instead, so it is not a model option to be "more precise" about.
fn enabled_visible(model: &Model, marking: u128) -> Vec<u32> {
    let mut acts = Vec::new();
    for t in 0..model.activity_of.len() {
        if model.inputs[t] & marking != model.inputs[t] { continue; }
        if let Some(a) = model.activity_of[t] { acts.push(a); }
    }
    acts
}

// --------------------------------------------------- token-based replay ---

/// A counting marking: how many tokens sit in each place. Unlike the
/// alignment's bitmask this cannot be 1-safe — forcing a transition puts a
/// token into a place that may already hold one, and "two tokens left over"
/// is a strictly worse diagnosis than "one".
type Marking = Vec<u32>;

/// How many silent transitions a single detour may fire.
///
/// This is the bound that matters, and it is a statement about what silent
/// routing *is* rather than a resource limit: the unobserved steps between
/// two observed events are a handful of routing decisions — open a branch,
/// close a loop, join two threads. A net that needs a dozen of them in a row
/// to explain one event is not routing, it is being made to fit.
///
/// It is also what keeps the search affordable. Without a depth bound, the
/// expensive case is not the detour that exists but the one that does not:
/// proving "no silent firing can enable this" means exhausting the whole
/// silent-reachable marking space, which on a net with thirty-odd routing
/// transitions is enormous. Measured on BPI Challenge 2012 against a
/// Heuristics Miner net, an undepthed search with a 50,000-marking valve took
/// minutes and still gave up on most cases; bounded to this it is
/// milliseconds.
const MAX_TAU_DEPTH: usize = 12;
/// Secondary safety valve, in case a net branches so widely that even a
/// depth-bounded frontier grows unreasonably.
const MAX_TAU_STATES: usize = 20_000;

fn enabled_at(model: &Model, t: usize, m: &Marking) -> bool {
    model.in_places[t].iter().all(|&p| m[p] > 0)
}

/// Total tokens in a marking — the bound that keeps the silent search finite
/// on a net whose silent part can produce more tokens than it consumes.
fn token_sum(m: &Marking) -> u32 { m.iter().sum() }

/// What a silent-transition search found — and, when it found nothing, why.
///
/// The two failures are not the same thing and must not be reported as one.
/// `Unreachable` is the ordinary case: the search exhausted the silent
/// subnet and no sequence of silent transitions enables what was asked for,
/// which simply means the event really is a deviation. `Limited` means the
/// search stopped at a bound with markings still unexplored, so a longer
/// detour might have existed — only that one makes the fitness a lower
/// bound, and only that one is worth telling the user about.
enum SilentSearch {
    Found(Vec<usize>),
    Unreachable,
    /// The bound was reached with markings still unexplored — a longer detour
    /// might have existed.
    Limited,
}

/// Breadth-first over *silent* transitions only, from `start`, looking for a
/// marking that satisfies `goal`. Returns the shortest firing sequence
/// (empty if `start` already satisfies it).
///
/// This is the one place the replay is allowed to move the model without the
/// log asking it to, and it is exactly what makes the technique usable on a
/// process-tree-derived net: the tau transitions that open an XOR branch or
/// close a loop are never observed in a log, so refusing to fire them would
/// report every such routing step as a missing token.
fn silent_path(model: &Model, start: &Marking, goal: &dyn Fn(&Marking) -> bool) -> SilentSearch {
    if goal(start) { return SilentSearch::Found(Vec::new()); }
    if model.silent.is_empty() { return SilentSearch::Unreachable; }

    let ceiling = token_sum(start) + model.place_count as u32;
    let mut seen: std::collections::HashSet<Marking> = std::collections::HashSet::new();
    let mut queue: std::collections::VecDeque<(Marking, Vec<usize>)> = std::collections::VecDeque::new();
    seen.insert(start.clone());
    queue.push_back((start.clone(), Vec::new()));

    while let Some((m, path)) = queue.pop_front() {
        if seen.len() > MAX_TAU_STATES { return SilentSearch::Limited; }
        // Breadth-first, so everything still in the queue is at least this
        // deep: reaching the depth bound means the rest of the frontier is
        // beyond it too, and the answer is "not within the bound" rather than
        // "not at all".
        if path.len() >= MAX_TAU_DEPTH { return SilentSearch::Limited; }
        for &t in &model.silent {
            if !enabled_at(model, t, &m) { continue; }
            let mut next = m.clone();
            for &p in &model.in_places[t] { next[p] -= 1; }
            for &p in &model.out_places[t] { next[p] += 1; }
            if token_sum(&next) > ceiling { continue; }
            let mut next_path = path.clone();
            next_path.push(t);
            if goal(&next) { return SilentSearch::Found(next_path); }
            if seen.insert(next.clone()) { queue.push_back((next, next_path)); }
        }
    }
    // The frontier emptied within both bounds: every marking silent firing
    // can reach from here was visited, and none satisfies the goal.
    SilentSearch::Unreachable
}

/// The four token counters, kept both as totals and per place.
///
/// Per place is the whole point: a fitness number says *how much* a model
/// disagrees with a log, and these say *where* — a place that keeps
/// accumulating missing tokens is the exact spot in the net where the log
/// does something the model did not allow.
#[derive(Clone, Serialize)]
struct Counters {
    produced: u64,
    consumed: u64,
    missing: u64,
    remaining: u64,
    #[serde(skip)]
    per_place: Vec<PlaceCounters>,
}

#[derive(Clone, Copy, Default, Serialize)]
struct PlaceCounters {
    produced: u64,
    consumed: u64,
    missing: u64,
    remaining: u64,
}

impl Counters {
    fn new(place_count: usize) -> Counters {
        Counters {
            produced: 0, consumed: 0, missing: 0, remaining: 0,
            per_place: vec![PlaceCounters::default(); place_count],
        }
    }

    fn fire(&mut self, model: &Model, t: usize, m: &mut Marking) {
        for &p in &model.in_places[t] {
            m[p] -= 1;
            self.consumed += 1;
            self.per_place[p].consumed += 1;
        }
        for &p in &model.out_places[t] {
            m[p] += 1;
            self.produced += 1;
            self.per_place[p].produced += 1;
        }
    }

    /// Weighted accumulation into an aggregate — every variant counts once
    /// per case it stands for, the same weighting `mean_fitness` uses.
    fn add_weighted(&mut self, other: &Counters, weight: u64) {
        self.produced += other.produced * weight;
        self.consumed += other.consumed * weight;
        self.missing += other.missing * weight;
        self.remaining += other.remaining * weight;
        for (p, c) in other.per_place.iter().enumerate() {
            self.per_place[p].produced += c.produced * weight;
            self.per_place[p].consumed += c.consumed * weight;
            self.per_place[p].missing += c.missing * weight;
            self.per_place[p].remaining += c.remaining * weight;
        }
    }
}

/// Rozinat & van der Aalst's formula: half the score is how little had to be
/// invented (missing against consumed), half is how little was left behind
/// (remaining against produced). A denominator of zero means nothing of that
/// kind ever happened, which is perfect agreement rather than a division to
/// guard around downstream.
fn token_fitness(c: &Counters) -> f64 {
    let m = if c.consumed == 0 { 0.0 } else { c.missing as f64 / c.consumed as f64 };
    let r = if c.produced == 0 { 0.0 } else { c.remaining as f64 / c.produced as f64 };
    (0.5 * (1.0 - m) + 0.5 * (1.0 - r)).clamp(0.0, 1.0)
}

struct TraceReplay {
    counters: Counters,
    /// Event positions in the trace that could only fire by inventing a
    /// token — the deviating steps, in trace order.
    forced_at: Vec<u32>,
    /// Event positions whose activity has no transition in the model at all.
    unmapped_at: Vec<u32>,
    /// How often the silent search stopped at a bound and the replay had to
    /// force a transition a longer detour might have enabled honestly.
    tau_limited: u32,
}

/// Replay one trace, once.
///
/// Every step is one of four things, in this order of preference: fire an
/// enabled transition; fire silent transitions until one is enabled; force an
/// un-enabled one, inventing the tokens it lacks; or — for an activity the
/// model has no transition for at all — charge one missing token and move on.
///
/// That last case is outside the textbook, which assumes every log activity
/// maps to some transition. Doing nothing would be worse than ad hoc: a model
/// missing half the log's activities would replay them as no events at all
/// and score a perfect fitness. Charging one missing token against one
/// consumed makes an unmappable event cost exactly what a forced one does,
/// and `unmapped_at` keeps it separately visible rather than folding it into
/// the deviations the model *does* have a place for.
fn replay_trace(model: &Model, seq: &[u32]) -> TraceReplay {
    let mut c = Counters::new(model.place_count);
    let mut m: Marking = vec![0; model.place_count];
    for &p in &model.initial_places {
        m[p] += 1;
        c.produced += 1;
        c.per_place[p].produced += 1;
    }

    let mut forced_at = Vec::new();
    let mut unmapped_at = Vec::new();
    let mut tau_limited = 0u32;

    for (i, activity) in seq.iter().enumerate() {
        let candidates = match model.by_activity.get(activity) {
            Some(ts) => ts,
            None => {
                unmapped_at.push(i as u32);
                c.missing += 1;
                c.consumed += 1;
                continue;
            }
        };

        if let Some(&t) = candidates.iter().find(|&&t| enabled_at(model, t, &m)) {
            c.fire(model, t, &mut m);
            continue;
        }

        // One search for the whole candidate set, not one per candidate: the
        // question is "can silent firing make *this activity* possible", and
        // asking it once per transition bearing the label re-walks the same
        // markings and multiplies the chance of hitting the bound by the
        // number of duplicate labels. Breadth-first already returns the
        // shortest path, and firing fewer unobserved steps is the more
        // conservative explanation of the same event.
        let can_fire = |mm: &Marking| candidates.iter().any(|&t| enabled_at(model, t, mm));
        match silent_path(model, &m, &can_fire) {
            SilentSearch::Found(path) => {
                for &tau in &path { c.fire(model, tau, &mut m); }
                let t = *candidates.iter().find(|&&t| enabled_at(model, t, &m))
                    .expect("the search stopped at a marking that enables one of them");
                c.fire(model, t, &mut m);
                continue;
            }
            SilentSearch::Limited => tau_limited += 1,
            SilentSearch::Unreachable => {}
        }

        // Force the candidate that has to invent the fewest tokens.
        let t = *candidates
            .iter()
            .min_by_key(|&&t| model.in_places[t].iter().filter(|&&p| m[p] == 0).count())
            .expect("by_activity never holds an empty list");
        for &p in &model.in_places[t] {
            if m[p] == 0 {
                m[p] = 1;
                c.missing += 1;
                c.per_place[p].missing += 1;
            }
        }
        forced_at.push(i as u32);
        c.fire(model, t, &mut m);
    }

    // Close the net: silent routing to the end is as unobservable as silent
    // routing in the middle, so the same search runs before the leftovers are
    // counted — otherwise every model whose last step is a tau would report a
    // remaining token in a place the log had no way to empty.
    let covers_final = |mm: &Marking| model.final_places.iter().all(|&p| mm[p] > 0);
    match silent_path(model, &m, &covers_final) {
        SilentSearch::Found(path) => { for &tau in &path { c.fire(model, tau, &mut m); } }
        SilentSearch::Limited => tau_limited += 1,
        SilentSearch::Unreachable => {}
    }
    for &p in &model.final_places {
        if m[p] > 0 {
            m[p] -= 1;
            c.consumed += 1;
            c.per_place[p].consumed += 1;
        } else {
            c.missing += 1;
            c.per_place[p].missing += 1;
        }
    }
    for p in 0..model.place_count {
        if m[p] > 0 {
            c.remaining += m[p] as u64;
            c.per_place[p].remaining += m[p] as u64;
        }
    }

    TraceReplay { counters: c, forced_at, unmapped_at, tau_limited }
}

// ------------------------------------------------- the replay wire format ---

#[derive(Serialize)]
struct VariantReplay {
    seq: Vec<u32>,
    case_count: u32,
    /// This trace's own fitness, from its own four counters.
    fitness: f64,
    produced: u64,
    consumed: u64,
    missing: u64,
    remaining: u64,
    forced_at: Vec<u32>,
    unmapped_at: Vec<u32>,
}

/// One place's share of the deviation, with its index so a renderer can put
/// it back on the net it came from.
#[derive(Serialize)]
struct PlaceDiagnostic {
    place: u32,
    produced: u64,
    consumed: u64,
    missing: u64,
    remaining: u64,
}

/// One activity's share, case-weighted. `forced` is how many events of this
/// activity could only fire by inventing a token; `unmapped` how many had no
/// transition to fire at all.
#[derive(Serialize)]
struct ActivityDiagnostic {
    activity: u32,
    occurrences: u64,
    forced: u64,
    unmapped: u64,
}

#[derive(Serialize)]
struct ReplayStats {
    distinct_variants: usize,
    variant_limit_reached: bool,
    /// How many *cases* hit a bound of the silent-transition search at least
    /// once. Not zero means the reported fitness is a lower bound for them:
    /// a detour longer than `MAX_TAU_DEPTH` might have enabled honestly what
    /// was forced instead.
    tau_search_limited: u32,
    silent_transitions: usize,
}

#[derive(Serialize)]
struct ReplayDiagnostics {
    /// Token-based fitness over the pooled counters of every case — the
    /// number ProM's "Replay a Log on Petri Net for Conformance Analysis"
    /// reports, and the one to compare against a published figure.
    fitness: f64,
    /// Case-weighted mean of the per-trace fitness. Differs from `fitness`
    /// because a mean of ratios is not the ratio of sums: this one treats
    /// every case as an equal vote, so one long badly-fitting case cannot
    /// dominate it the way it dominates the pooled number. Both are reported
    /// because each answers a different question, and quietly picking one
    /// would make the plugin's output unreproducible against either.
    trace_fitness: f64,
    produced: u64,
    consumed: u64,
    missing: u64,
    remaining: u64,
    total_cases: u32,
    /// Cases whose replay completed without inventing a single token and
    /// without leaving one behind.
    perfect_cases: u32,
    places: Vec<PlaceDiagnostic>,
    activities: Vec<ActivityDiagnostic>,
    variants: Vec<VariantReplay>,
    stats: ReplayStats,
}

// ------------------------------------------------------------- the scan ----

#[derive(Serialize)]
struct VariantAlignment {
    seq: Vec<u32>,
    case_count: u32,
    cost: u32,
    /// 1 = perfectly fits, 0 = as bad as explaining nothing at all — see
    /// `align`'s doc comment for the normalisation.
    fitness: f64,
    moves: Vec<Move>,
}

#[derive(Serialize)]
struct Stats {
    distinct_variants: usize,
    variant_limit_reached: bool,
    /// Cheapest model-only path from initial to final marking, ignoring the
    /// log entirely — the other half of the fitness denominator.
    model_only_cost: u32,
}

#[derive(Serialize)]
struct AlignmentSet {
    variants: Vec<VariantAlignment>,
    total_cases: u32,
    aligned_cases: u32,
    /// Cases whose variant has no valid alignment at all — the final marking
    /// is unreachable from it within the state-space cap. Reported, not
    /// hidden: a model that cannot replay a trace even badly is real
    /// information, not a failure of this plugin.
    unreachable_cases: u32,
    /// Case-weighted mean of `variants[].fitness`, over aligned cases only.
    mean_fitness: f64,
    /// Escaping-edges precision — see `align`'s doc comment for exactly what
    /// this does and does not account for.
    precision: f64,
    stats: Stats,
}

/// One pass over the ordered event stream, building one sequence per case.
/// Same scan shape as every other miner here — `pushChunk`/`finish` — but the
/// per-case sequence is what conformance checking needs, not an aggregate.
///
/// Not exported itself: the host addresses a *kernel class* by name, and the
/// two actions this package ships need two names. Both are the same scan over
/// the same log with the same model resolved the same way; only `finalize`
/// differs, so the scan lives here once and the two exported classes below
/// are the thinnest possible wrappers around it.
#[derive(Default)]
struct TraceScan {
    n: usize,
    traces: Vec<Vec<u32>>,
    cur: Vec<u32>,
    last_case: i64,
    have_last: bool,
    rows: u32,
    cases: u32,
}

impl TraceScan {
    fn new(n_activities: usize) -> TraceScan {
        TraceScan { n: n_activities, last_case: i64::MIN, ..TraceScan::default() }
    }

    fn push_chunk(&mut self, cases: &[i32], activities: &[i32]) {
        let len = cases.len().min(activities.len());
        for i in 0..len {
            let case = cases[i] as i64;
            let act = activities[i];
            if act < 0 || act as usize >= self.n { continue; }

            if self.have_last && self.last_case == case {
                self.cur.push(act as u32);
            } else {
                if self.have_last {
                    self.traces.push(std::mem::take(&mut self.cur));
                }
                self.cur.push(act as u32);
                self.cases += 1;
            }
            self.last_case = case;
            self.have_last = true;
        }
        self.rows += len as u32;
    }

    fn finish(&mut self) {
        if self.have_last {
            self.traces.push(std::mem::take(&mut self.cur));
            self.have_last = false;
        }
    }

    /// Identical traces grouped into variants, deterministically ordered
    /// (frequency, then the sequence itself) so re-running produces the same
    /// output, not whatever order a hasher happened to visit. Both actions
    /// group the same way, which is what makes their variant tables line up
    /// row for row when someone runs them on the same pair.
    fn variants(&self, limit: usize) -> (Vec<(&Vec<u32>, u32)>, bool) {
        let mut groups: HashMap<&Vec<u32>, u32> = HashMap::new();
        for t in &self.traces {
            *groups.entry(t).or_insert(0) += 1;
        }
        let mut variants: Vec<(&Vec<u32>, u32)> = groups.into_iter().collect();
        variants.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        let limit_reached = variants.len() > limit;
        variants.truncate(limit);
        (variants, limit_reached)
    }
}

/// Reads the model out of `params` — the one thing both kernels need before
/// they can do anything, and the one thing the generic ABI has no slot for.
fn model_from(params: JsValue) -> Result<(Model, Params), JsValue> {
    let p: Params = serde_wasm_bindgen::from_value(params)
        .map_err(|e| JsValue::from_str(&format!("bad params: {e}")))?;
    let model_in = p.model.as_ref().ok_or_else(|| JsValue::from_str("no model selected"))?;
    let model = Model::build(model_in).map_err(|e| JsValue::from_str(&e))?;
    Ok((model, p))
}

/// The host's WASM kernel ABI:
///
///   new Kernel(nActivities)
///   .pushChunk(Int32Array cases, Int32Array activities)
///   .finish()
///   .finalize(params) -> result
///   .free()
///
/// Unlike every other plugin here, `params` carries the *model* as well as
/// the usual small UI values — conformance checking is inherently a two-input
/// action (log + model), and the generic ABI has only one data channel into
/// the kernel besides the scanned log. The host resolves the model's
/// transition labels into the log's own activity id space before sending it,
/// so nothing in this file ever sees an activity name.
#[wasm_bindgen]
pub struct AlignmentScan { inner: TraceScan }

#[wasm_bindgen]
impl AlignmentScan {
    #[wasm_bindgen(constructor)]
    pub fn new(n_activities: usize) -> AlignmentScan {
        AlignmentScan { inner: TraceScan::new(n_activities) }
    }

    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, cases: &[i32], activities: &[i32]) {
        self.inner.push_chunk(cases, activities);
    }

    pub fn finish(&mut self) { self.inner.finish(); }

    #[wasm_bindgen(js_name = rowCount)]
    pub fn row_count(&self) -> u32 { self.inner.rows }

    #[wasm_bindgen(js_name = caseCount)]
    pub fn case_count(&self) -> u32 { self.inner.cases }

    /// The cheap stage: group into variants, align each once.
    #[wasm_bindgen(js_name = finalize)]
    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let (model, p) = model_from(params)?;
        let limit = p.variant_limit.unwrap_or(1000).max(1) as usize;
        serde_wasm_bindgen::to_value(&self.inner.align(&model, limit))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

/// Token-based replay over the same scan. See the module header for what it
/// does differently and why it is worth having beside the alignment.
#[wasm_bindgen]
pub struct TokenReplayScan { inner: TraceScan }

#[wasm_bindgen]
impl TokenReplayScan {
    #[wasm_bindgen(constructor)]
    pub fn new(n_activities: usize) -> TokenReplayScan {
        TokenReplayScan { inner: TraceScan::new(n_activities) }
    }

    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, cases: &[i32], activities: &[i32]) {
        self.inner.push_chunk(cases, activities);
    }

    pub fn finish(&mut self) { self.inner.finish(); }

    #[wasm_bindgen(js_name = rowCount)]
    pub fn row_count(&self) -> u32 { self.inner.rows }

    #[wasm_bindgen(js_name = caseCount)]
    pub fn case_count(&self) -> u32 { self.inner.cases }

    #[wasm_bindgen(js_name = finalize)]
    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let (model, p) = model_from(params)?;
        let limit = p.variant_limit.unwrap_or(5000).max(1) as usize;
        serde_wasm_bindgen::to_value(&self.inner.token_replay(&model, limit))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Params {
    model: Option<ModelIn>,
    variant_limit: Option<u32>,
}

impl TraceScan {
    fn align(&self, model: &Model, variant_limit: usize) -> AlignmentSet {
        let (variants, variant_limit_reached) = self.variants(variant_limit);

        let model_only = shortest_alignment(model, &[]);
        let model_only_cost = if model_only.reached { model_only.cost } else { 0 };

        let mut out = Vec::with_capacity(variants.len());
        let mut weighted_fitness = 0f64;
        let mut aligned_cases = 0u32;
        let mut unreachable_cases = 0u32;
        // Escaping-edges precision (see doc comment below), accumulated
        // across every variant's optimal path in the same pass as fitness —
        // the alignment is already computed here, so a second Dijkstra run
        // per variant just to re-derive it would be pure waste.
        let mut used_at: HashMap<u128, std::collections::HashSet<u32>> = HashMap::new();

        for (seq, count) in &variants {
            let r = shortest_alignment(model, seq);
            if !r.reached {
                unreachable_cases += count;
                continue;
            }
            // Worst case (upper bound, always achievable): skip every log
            // event, then take the cheapest model-only path to the end.
            // Dijkstra can never do worse than that, so this keeps fitness in
            // [0, 1] without needing a second, different upper-bound proof.
            let max_cost = seq.len() as u32 + model_only_cost;
            let fitness = if max_cost == 0 { 1.0 } else { 1.0 - (r.cost as f64 / max_cost as f64) };
            weighted_fitness += fitness * (*count as f64);
            aligned_cases += count;

            // Precision: for every marking the alignment passes through
            // immediately before a sync move — a marking the log's own
            // replay genuinely stood at, not one only a model move reached —
            // record which activity the log actually took from there. Which
            // *transition* fired is read off `after` rather than matched by
            // activity id, since two transitions can share a label.
            let mut current = model.initial;
            for mv in &r.moves {
                if mv.kind == "sync" {
                    used_at.entry(current).or_default().insert(mv.activity.unwrap());
                }
                current = mv.after;
            }

            out.push(VariantAlignment {
                seq: (*seq).clone(),
                case_count: *count,
                cost: r.cost,
                fitness,
                moves: r.moves,
            });
        }

        // Sum, don't average per marking: a marking with more escaping edges
        // is a bigger precision leak than one with few, and this weighting
        // reflects that directly rather than treating every visited marking
        // as an equally-sized vote regardless of how much behaviour it adds.
        let mut sum_used = 0usize;
        let mut sum_enabled = 0usize;
        for (marking, acts) in &used_at {
            sum_used += acts.len();
            sum_enabled += enabled_visible(model, *marking).len();
        }
        let precision = if sum_enabled == 0 { 1.0 } else { sum_used as f64 / sum_enabled as f64 };

        AlignmentSet {
            variants: out,
            total_cases: self.cases,
            aligned_cases,
            unreachable_cases,
            mean_fitness: if aligned_cases > 0 { weighted_fitness / aligned_cases as f64 } else { 0.0 },
            precision,
            stats: Stats {
                distinct_variants: variants.len(),
                variant_limit_reached,
                model_only_cost,
            },
        }
    }

    /// Token-based replay of every variant, folded into one diagnosis.
    ///
    /// Two passes' worth of work in one: each variant is replayed once, its
    /// own counters kept for the variant table, and the same counters folded
    /// case-weighted into the totals the fitness and the per-place decoration
    /// are read off. Nothing here searches, so unlike `align` there is no
    /// state cap and no variant that can come back unreplayable.
    fn token_replay(&self, model: &Model, variant_limit: usize) -> ReplayDiagnostics {
        let (variants, variant_limit_reached) = self.variants(variant_limit);

        let mut totals = Counters::new(model.place_count);
        let mut weighted_fitness = 0f64;
        let mut counted_cases = 0u32;
        let mut perfect_cases = 0u32;
        let mut tau_search_limited = 0u32;
        // Per activity, case-weighted: occurrences, and the two ways an
        // occurrence can go wrong.
        let mut occurrences: HashMap<u32, u64> = HashMap::new();
        let mut forced: HashMap<u32, u64> = HashMap::new();
        let mut unmapped: HashMap<u32, u64> = HashMap::new();
        let mut out = Vec::with_capacity(variants.len());

        for (seq, count) in &variants {
            let r = replay_trace(model, seq);
            let weight = *count as u64;
            let fitness = token_fitness(&r.counters);

            totals.add_weighted(&r.counters, weight);
            weighted_fitness += fitness * *count as f64;
            counted_cases += count;
            if r.counters.missing == 0 && r.counters.remaining == 0 { perfect_cases += count; }
            if r.tau_limited > 0 { tau_search_limited += count; }

            for a in seq.iter() { *occurrences.entry(*a).or_insert(0) += weight; }
            for &i in &r.forced_at { *forced.entry(seq[i as usize]).or_insert(0) += weight; }
            for &i in &r.unmapped_at { *unmapped.entry(seq[i as usize]).or_insert(0) += weight; }

            out.push(VariantReplay {
                seq: (*seq).clone(),
                case_count: *count,
                fitness,
                produced: r.counters.produced,
                consumed: r.counters.consumed,
                missing: r.counters.missing,
                remaining: r.counters.remaining,
                forced_at: r.forced_at,
                unmapped_at: r.unmapped_at,
            });
        }

        // Only places that carry a diagnosis are sent. A net's quiet places
        // are the majority and say nothing; a renderer that needs a full
        // per-place array has the net itself to size one from.
        let places = totals.per_place.iter().enumerate()
            .filter(|(_, c)| c.missing > 0 || c.remaining > 0)
            .map(|(place, c)| PlaceDiagnostic {
                place: place as u32,
                produced: c.produced, consumed: c.consumed,
                missing: c.missing, remaining: c.remaining,
            })
            .collect();

        let mut activities: Vec<ActivityDiagnostic> = occurrences.into_iter()
            .map(|(activity, n)| ActivityDiagnostic {
                activity,
                occurrences: n,
                forced: forced.get(&activity).copied().unwrap_or(0),
                unmapped: unmapped.get(&activity).copied().unwrap_or(0),
            })
            .collect();
        // Worst first, then most frequent — the order the question "what
        // should I look at" is actually asked in.
        activities.sort_by(|a, b| (b.forced + b.unmapped).cmp(&(a.forced + a.unmapped))
            .then_with(|| b.occurrences.cmp(&a.occurrences))
            .then_with(|| a.activity.cmp(&b.activity)));

        ReplayDiagnostics {
            fitness: token_fitness(&totals),
            trace_fitness: if counted_cases > 0 { weighted_fitness / counted_cases as f64 } else { 0.0 },
            produced: totals.produced,
            consumed: totals.consumed,
            missing: totals.missing,
            remaining: totals.remaining,
            total_cases: self.cases,
            perfect_cases,
            places,
            activities,
            variants: out,
            stats: ReplayStats {
                distinct_variants: variants.len(),
                variant_limit_reached,
                tau_search_limited,
                silent_transitions: model.silent.len(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(traces: &[Vec<u32>], n: usize) -> TraceScan {
        let mut s = TraceScan::new(n);
        for (case, tr) in traces.iter().enumerate() {
            let cases: Vec<i32> = vec![case as i32; tr.len()];
            let acts: Vec<i32> = tr.iter().map(|&a| a as i32).collect();
            s.push_chunk(&cases, &acts);
        }
        s.finish();
        s
    }

    /// Builds both of `Model`'s arc representations from one description, so
    /// a test can never accidentally state the bitmask and the place lists
    /// differently — which would make the alignment and the replay disagree
    /// about the same net for a reason that exists nowhere but the test.
    fn model(
        activity_of: Vec<Option<u32>>,
        arcs: &[(&[usize], &[usize])],
        place_count: usize,
        initial: &[usize],
        final_places: &[usize],
    ) -> Model {
        let transitions: Vec<TransitionIn> =
            activity_of.iter().map(|a| TransitionIn { activity_id: *a }).collect();
        let mut place_to_transition = Vec::new();
        let mut transition_to_place = Vec::new();
        for (t, (ins, outs)) in arcs.iter().enumerate() {
            for &p in *ins { place_to_transition.push((p, t)); }
            for &p in *outs { transition_to_place.push((t, p)); }
        }
        Model::build(&ModelIn {
            place_count,
            transitions,
            place_to_transition,
            transition_to_place,
            initial_marking: initial.to_vec(),
            final_marking: final_places.to_vec(),
        })
        .expect("test model is within bounds")
    }

    /// a -> b -> c: p0 -[a]-> p1 -[b]-> p2 -[c]-> p3.
    fn sequential_model() -> Model {
        model(
            vec![Some(0), Some(1), Some(2)],
            &[(&[0], &[1]), (&[1], &[2]), (&[2], &[3])],
            4, &[0], &[3],
        )
    }

    #[test]
    fn perfectly_fitting_trace_costs_nothing() {
        let model = sequential_model();
        let r = shortest_alignment(&model, &[0, 1, 2]);
        assert!(r.reached);
        assert_eq!(r.cost, 0);
        assert_eq!(r.moves.len(), 3);
        assert!(r.moves.iter().all(|m| m.kind == "sync"));
    }

    #[test]
    fn extra_log_event_is_one_log_move() {
        let model = sequential_model();
        // a, x, b, c -- "x" (activity 9, unknown to the model) has to be a log move.
        let r = shortest_alignment(&model, &[0, 9, 1, 2]);
        assert!(r.reached);
        assert_eq!(r.cost, 1);
        let kinds: Vec<&str> = r.moves.iter().map(|m| m.kind).collect();
        assert_eq!(kinds, vec!["sync", "log", "sync", "sync"]);
    }

    #[test]
    fn missing_log_event_is_one_model_move() {
        let model = sequential_model();
        // a, c -- "b" never happened in the log, the model still has to fire it.
        let r = shortest_alignment(&model, &[0, 2]);
        assert!(r.reached);
        assert_eq!(r.cost, 1);
        let kinds: Vec<&str> = r.moves.iter().map(|m| m.kind).collect();
        assert_eq!(kinds, vec!["sync", "model", "sync"]);
    }

    #[test]
    fn silent_transition_is_free() {
        // p0 -[a]-> p1 -[tau]-> p2 -[b]-> p3 ; trace is just a, b (the tau step
        // is never observed, by definition, so it must not cost anything).
        let model = model(
            vec![Some(0), None, Some(1)],
            &[(&[0], &[1]), (&[1], &[2]), (&[2], &[3])],
            4, &[0], &[3],
        );
        let r = shortest_alignment(&model, &[0, 1]);
        assert!(r.reached);
        assert_eq!(r.cost, 0);
        let kinds: Vec<&str> = r.moves.iter().map(|m| m.kind).collect();
        assert_eq!(kinds, vec!["sync", "silent", "sync"]);
    }

    #[test]
    fn unreachable_final_marking_is_reported_not_panicked() {
        // A model whose final marking can never be reached from the initial one.
        let model = model(
            vec![Some(0)],
            &[(&[0], &[1])],
            3, &[0], &[2], // nothing ever produces a token in p2
        );
        let r = shortest_alignment(&model, &[0]);
        assert!(!r.reached);
    }

    /// p0 -[a]-> p1, then an XOR choice out of p1: -[b]-> p2 or -[c]-> p2.
    fn choice_model() -> Model {
        model(
            vec![Some(0), Some(1), Some(2)], // a, b, c
            &[(&[0], &[1]), (&[1], &[2]), (&[1], &[2])],
            3, &[0], &[2],
        )
    }

    #[test]
    fn precision_penalises_an_unused_model_choice() {
        let model = choice_model();
        // The log only ever takes the "b" branch, never "c". Two markings are
        // visited: before "a" (1 enabled, 1 used — no escaping edge) and
        // before the choice (2 enabled, 1 used — one escaping edge), summing
        // to 2 used out of 3 enabled.
        let s = scan(&[vec![0, 1], vec![0, 1]], 10);
        let result = s.align(&model, 100);
        assert!((result.precision - (2.0 / 3.0)).abs() < 1e-9);
    }

    #[test]
    fn precision_is_perfect_when_every_choice_is_used() {
        let model = choice_model();
        let s = scan(&[vec![0, 1], vec![0, 2]], 10);
        let result = s.align(&model, 100);
        assert!((result.precision - 1.0).abs() < 1e-9);
    }

    #[test]
    fn align_groups_identical_traces_into_one_variant() {
        let model = sequential_model();
        let traces = vec![
            vec![0, 1, 2],
            vec![0, 1, 2],
            vec![0, 9, 1, 2], // one deviating case
        ];
        let s = scan(&traces, 10);
        let result = s.align(&model, 100);
        assert_eq!(result.total_cases, 3);
        assert_eq!(result.stats.distinct_variants, 2);
        assert_eq!(result.aligned_cases, 3);
        let perfect = result.variants.iter().find(|v| v.case_count == 2).unwrap();
        assert_eq!(perfect.cost, 0);
        assert_eq!(perfect.fitness, 1.0);
        let deviating = result.variants.iter().find(|v| v.case_count == 1).unwrap();
        assert_eq!(deviating.cost, 1);
        assert!(deviating.fitness < 1.0);
        // Case-weighted: (1.0*2 + deviating.fitness*1) / 3
        let expected = (1.0 * 2.0 + deviating.fitness) / 3.0;
        assert!((result.mean_fitness - expected).abs() < 1e-9);
    }

    // ------------------------------------------------- token-based replay ---

    #[test]
    fn perfect_trace_replays_without_missing_or_remaining_tokens() {
        let model = sequential_model();
        let r = replay_trace(&model, &[0, 1, 2]);
        assert_eq!(r.counters.missing, 0);
        assert_eq!(r.counters.remaining, 0);
        assert!(r.forced_at.is_empty());
        assert_eq!(token_fitness(&r.counters), 1.0);
    }

    #[test]
    fn skipped_event_leaves_a_missing_and_a_remaining_token() {
        let model = sequential_model();
        // a, c -- "b" never fired, so p2 has no token when c wants one (one
        // missing) and p1 keeps the token b would have taken (one remaining).
        let r = replay_trace(&model, &[0, 2]);
        assert_eq!(r.counters.missing, 1);
        assert_eq!(r.counters.remaining, 1);
        assert_eq!(r.forced_at, vec![1]);
        // Produced: p0 at the start, then a, then c. Consumed: a, c, and the
        // final marking. Both 3, so fitness is 0.5*(2/3) + 0.5*(2/3).
        assert_eq!(r.counters.produced, 3);
        assert_eq!(r.counters.consumed, 3);
        assert!((token_fitness(&r.counters) - 2.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn the_missing_token_is_attributed_to_the_place_that_lacked_it() {
        let model = sequential_model();
        let r = replay_trace(&model, &[0, 2]);
        assert_eq!(r.counters.per_place[2].missing, 1, "c's input place is the one that was empty");
        assert_eq!(r.counters.per_place[1].remaining, 1, "b's input place is the one left holding a token");
        for p in [0usize, 3] {
            assert_eq!(r.counters.per_place[p].missing, 0);
            assert_eq!(r.counters.per_place[p].remaining, 0);
        }
    }

    #[test]
    fn an_activity_the_model_does_not_have_costs_one_missing_token() {
        let model = sequential_model();
        // a, x, b, c -- x (activity 9) has no transition at all.
        let r = replay_trace(&model, &[0, 9, 1, 2]);
        assert_eq!(r.unmapped_at, vec![1]);
        assert!(r.forced_at.is_empty(), "an unmappable event forces no transition");
        assert_eq!(r.counters.missing, 1);
        assert_eq!(r.counters.remaining, 0);
        assert!(token_fitness(&r.counters) < 1.0, "it must cost something, or a model \
            missing every activity would score perfectly");
    }

    #[test]
    fn silent_transitions_are_fired_rather_than_forced() {
        // p0 -[a]-> p1 -[tau]-> p2 -[b]-> p3. The tau is never in the log, so
        // without the silent search this trace would force b and report a
        // missing token — which is what would happen to every Inductive Miner
        // model, whose routing is almost entirely silent.
        let model = model(
            vec![Some(0), None, Some(1)],
            &[(&[0], &[1]), (&[1], &[2]), (&[2], &[3])],
            4, &[0], &[3],
        );
        let r = replay_trace(&model, &[0, 1]);
        assert_eq!(r.counters.missing, 0);
        assert_eq!(r.counters.remaining, 0);
        assert_eq!(token_fitness(&r.counters), 1.0);
    }

    #[test]
    fn a_trailing_silent_transition_leaves_nothing_behind() {
        // p0 -[a]-> p1 -[tau]-> p2(final). Nothing in the log can empty p1;
        // only the closing silent search can.
        let model = model(
            vec![Some(0), None],
            &[(&[0], &[1]), (&[1], &[2])],
            3, &[0], &[2],
        );
        let r = replay_trace(&model, &[0]);
        assert_eq!(r.counters.remaining, 0);
        assert_eq!(r.counters.missing, 0);
    }

    #[test]
    fn concurrency_replays_in_either_observed_order() {
        // p0 -[split(tau)]-> {p1,p2}; p1 -[a]-> p3, p2 -[b]-> p4;
        // {p3,p4} -[join(tau)]-> p5(final).
        let model = model(
            vec![None, Some(0), Some(1), None],
            &[(&[0], &[1, 2]), (&[1], &[3]), (&[2], &[4]), (&[3, 4], &[5])],
            6, &[0], &[5],
        );
        for trace in [vec![0u32, 1], vec![1, 0]] {
            let r = replay_trace(&model, &trace);
            assert_eq!(r.counters.missing, 0, "trace {trace:?}");
            assert_eq!(r.counters.remaining, 0, "trace {trace:?}");
        }
    }

    #[test]
    fn replay_weights_variants_by_case_count() {
        let model = sequential_model();
        // Two perfect cases, one that skips "b".
        let s = scan(&[vec![0, 1, 2], vec![0, 1, 2], vec![0, 2]], 10);
        let d = s.token_replay(&model, 100);
        assert_eq!(d.total_cases, 3);
        assert_eq!(d.perfect_cases, 2);
        assert_eq!(d.stats.distinct_variants, 2);
        // Exactly the one deviating case contributes its missing/remaining.
        assert_eq!(d.missing, 1);
        assert_eq!(d.remaining, 1);
        // trace_fitness is the case-weighted mean of the per-trace numbers.
        let expected = (1.0 * 2.0 + 2.0 / 3.0) / 3.0;
        assert!((d.trace_fitness - expected).abs() < 1e-9);
        // The pooled fitness is computed from pooled counters, so it is a
        // different (higher, here) number — the two perfect cases dilute the
        // ratio rather than each casting one vote.
        assert!(d.fitness > d.trace_fitness);
        assert!(d.fitness <= 1.0);
    }

    #[test]
    fn replay_attributes_deviation_to_the_right_activity() {
        let model = sequential_model();
        let s = scan(&[vec![0, 1, 2], vec![0, 2], vec![0, 2]], 10);
        let d = s.token_replay(&model, 100);
        let by_activity: HashMap<u32, &ActivityDiagnostic> =
            d.activities.iter().map(|a| (a.activity, a)).collect();
        assert_eq!(by_activity[&2].forced, 2, "c is the activity that had to be forced");
        assert_eq!(by_activity[&0].forced, 0);
        // Worst-first ordering puts it at the top of the list.
        assert_eq!(d.activities[0].activity, 2);
        // And the place diagnostics only list places that actually deviated.
        let places: Vec<u32> = d.places.iter().map(|p| p.place).collect();
        assert_eq!(places, vec![1, 2]);
    }

    #[test]
    fn a_repeated_arc_does_not_consume_the_same_token_twice() {
        // A net whose PNML listed p0 -> t twice. The bitmask form cannot
        // represent that at all, so the list form must not either; without
        // deduplication the replay consumes two tokens from a place it only
        // required one in, which underflows rather than scoring badly.
        let m = Model::build(&ModelIn {
            place_count: 2,
            transitions: vec![TransitionIn { activity_id: Some(0) }],
            place_to_transition: vec![(0, 0), (0, 0)],
            transition_to_place: vec![(0, 1), (0, 1)],
            initial_marking: vec![0, 0],
            final_marking: vec![1],
        }).unwrap();
        assert_eq!(m.in_places[0], vec![0]);
        assert_eq!(m.out_places[0], vec![1]);
        assert_eq!(m.initial_places, vec![0]);
        let r = replay_trace(&m, &[0]);
        assert_eq!(r.counters.missing, 0);
        assert_eq!(r.counters.remaining, 0);
        assert_eq!(token_fitness(&r.counters), 1.0);
    }

    #[test]
    fn an_ordinary_deviation_is_not_reported_as_a_limited_search() {
        // p0 -[a]-> p1 -[tau]-> p2 -[b]-> p3, replayed with b before a. No
        // silent firing from the initial marking can enable b, so the search
        // empties its frontier and answers "unreachable" — the ordinary case,
        // and not something to warn the user their fitness is a lower bound
        // over. Only stopping at a bound means that.
        let model = model(
            vec![Some(0), None, Some(1)],
            &[(&[0], &[1]), (&[1], &[2]), (&[2], &[3])],
            4, &[0], &[3],
        );
        let r = replay_trace(&model, &[1, 0]);
        assert!(r.counters.missing > 0, "the trace really does deviate");
        assert_eq!(r.tau_limited, 0, "a completed search that finds nothing is not a search that gave up");
    }

    #[test]
    fn a_net_with_no_silent_transitions_never_searches() {
        let model = sequential_model();
        let s = scan(&[vec![0, 2]], 10);
        let d = s.token_replay(&model, 100);
        assert_eq!(d.stats.silent_transitions, 0);
        assert_eq!(d.stats.tau_search_limited, 0);
    }

    // ---------------------------------------------- randomised invariants ---

    /// xorshift64*, so the generated cases are reproducible from a seed
    /// without pulling in a dependency for it.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: usize) -> usize { (self.next() % n as u64) as usize }
    }

    /// Builds a random workflow net *and* a trace that is by construction a
    /// valid firing sequence of it.
    ///
    /// The construction keeps a set of "open" places — the marking reached so
    /// far — and only ever adds a transition whose inputs are open right now,
    /// replacing them with fresh output places. So the transitions in creation
    /// order are a firing sequence from {p0} to the single place left open at
    /// the end, which becomes the final marking. Reading the visible labels
    /// off that sequence gives a trace the model demonstrably produced.
    ///
    /// Every visible transition gets its own activity id. Duplicate labels
    /// are exactly where a greedy, non-backtracking replay may commit to the
    /// wrong transition, so putting them in this generator would be testing
    /// that the technique is something it openly is not.
    fn random_net(rng: &mut Rng, steps: usize) -> (Model, Vec<u32>) {
        let mut open: Vec<usize> = vec![0];
        let mut next_place = 1usize;
        let mut activity_of: Vec<Option<u32>> = Vec::new();
        let mut arcs: Vec<(Vec<usize>, Vec<usize>)> = Vec::new();
        let mut trace: Vec<u32> = Vec::new();
        let mut next_activity = 0u32;

        for _ in 0..steps {
            // A silent step is a plain sequence step; the branching ones stay
            // visible so a trace always shows where the net forked or merged.
            let choice = rng.below(10);
            let (ins, outs): (Vec<usize>, Vec<usize>) = if choice < 2 && open.len() >= 2 {
                // Join two concurrent branches.
                let i = rng.below(open.len());
                let a = open.remove(i);
                let j = rng.below(open.len());
                let b = open.remove(j);
                let q = next_place; next_place += 1;
                (vec![a, b], vec![q])
            } else if choice < 5 && open.len() < 4 {
                // Split into two concurrent branches.
                let i = rng.below(open.len());
                let p = open.remove(i);
                let (q, r) = (next_place, next_place + 1); next_place += 2;
                (vec![p], vec![q, r])
            } else {
                let i = rng.below(open.len());
                let p = open.remove(i);
                let q = next_place; next_place += 1;
                (vec![p], vec![q])
            };
            for &p in &outs { open.push(p); }

            let silent = ins.len() == 1 && outs.len() == 1 && rng.below(3) == 0;
            if silent {
                activity_of.push(None);
            } else {
                activity_of.push(Some(next_activity));
                trace.push(next_activity);
                next_activity += 1;
            }
            arcs.push((ins, outs));
        }

        // Fold whatever is still open into one final place, so the net has a
        // single end the way a workflow net is supposed to.
        while open.len() > 1 {
            let a = open.remove(0);
            let b = open.remove(0);
            let q = next_place; next_place += 1;
            arcs.push((vec![a, b], vec![q]));
            activity_of.push(None);
            open.push(q);
        }

        let arc_refs: Vec<(&[usize], &[usize])> =
            arcs.iter().map(|(i, o)| (i.as_slice(), o.as_slice())).collect();
        let final_place = open[0];
        let m = model(activity_of, &arc_refs, next_place, &[0], &[final_place]);
        (m, trace)
    }

    #[test]
    fn a_trace_the_model_produced_always_replays_perfectly() {
        for seed in 1..200u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
            let (model, trace) = random_net(&mut rng, 4 + (seed as usize % 12));
            let r = replay_trace(&model, &trace);
            assert_eq!(r.counters.missing, 0, "seed {seed}: trace {trace:?} needed an invented token");
            assert_eq!(r.counters.remaining, 0, "seed {seed}: trace {trace:?} left a token behind");
            assert_eq!(token_fitness(&r.counters), 1.0, "seed {seed}");
        }
    }

    #[test]
    fn fitness_stays_in_range_however_wrong_the_log_is() {
        for seed in 1..200u64 {
            let mut rng = Rng(seed.wrapping_mul(0x2545_F491_4F6C_DD1D));
            let (model, trace) = random_net(&mut rng, 4 + (seed as usize % 12));
            // Mangle the trace every way a real log can disagree with a model:
            // drop events, repeat them, reorder them, and invent unknown ones.
            let mut mangled = trace.clone();
            for _ in 0..4 {
                if mangled.is_empty() { break; }
                match rng.below(4) {
                    0 => { let i = rng.below(mangled.len()); mangled.remove(i); }
                    1 => { let i = rng.below(mangled.len()); let v = mangled[i]; mangled.insert(i, v); }
                    2 => { let i = rng.below(mangled.len()); let j = rng.below(mangled.len()); mangled.swap(i, j); }
                    _ => { let i = rng.below(mangled.len()); mangled.insert(i, 9_000); }
                }
            }
            let r = replay_trace(&model, &mangled);
            let f = token_fitness(&r.counters);
            assert!((0.0..=1.0).contains(&f), "seed {seed}: fitness {f} out of range");
            // Every counter has to stay consistent with what a replay can do:
            // a token can only be consumed if it was produced or invented.
            assert!(
                r.counters.consumed <= r.counters.produced + r.counters.missing,
                "seed {seed}: consumed {} > produced {} + missing {}",
                r.counters.consumed, r.counters.produced, r.counters.missing,
            );
            // And nothing can be left over that was never put there.
            assert!(
                r.counters.remaining <= r.counters.produced + r.counters.missing,
                "seed {seed}: remaining more tokens than ever existed",
            );
        }
    }

    #[test]
    fn per_place_counters_always_sum_to_the_totals() {
        for seed in 1..100u64 {
            let mut rng = Rng(seed.wrapping_mul(0xD1B5_4A32_D192_ED03));
            let (model, trace) = random_net(&mut rng, 4 + (seed as usize % 10));
            let mut mangled = trace.clone();
            if !mangled.is_empty() { mangled.remove(rng.below(mangled.len())); }
            let r = replay_trace(&model, &mangled);
            let sum = |f: fn(&PlaceCounters) -> u64| r.counters.per_place.iter().map(f).sum::<u64>();
            assert_eq!(sum(|c| c.produced), r.counters.produced, "seed {seed}");
            assert_eq!(sum(|c| c.consumed), r.counters.consumed, "seed {seed}");
            assert_eq!(sum(|c| c.missing), r.counters.missing, "seed {seed}");
            assert_eq!(sum(|c| c.remaining), r.counters.remaining, "seed {seed}");
        }
    }
}
