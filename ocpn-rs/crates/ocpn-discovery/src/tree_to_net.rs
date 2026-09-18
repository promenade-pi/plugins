//! Process tree → per-object-type Petri net.
//!
//! No such conversion exists anywhere else in this repository's Rust code —
//! the only prior art is pm4py's `convert_to_petri_net`, reached today only
//! through Pyodide. This is the standard block-structured (WF-net)
//! construction: each operator gets a small gadget wired between an entry
//! and an exit place, recursively.
//!
//! ```text
//! Activity(a):  in --a--> out
//! Tau:          in --τ--> out
//! Sequence:     in -> c1 -> p1 -> c2 -> p2 -> ... -> out
//! Xor:          every child wired directly between the same in/out
//! Parallel:     in --τ(split)--> (ci between fresh places) --τ(join)--> out
//! Loop(body,redo,exit):
//!               in -> body -> mid -> exit -> out
//!                              mid -> redo -> in   (loop back)
//! ```
//!
//! # Why activities never collide within one object type
//!
//! Inductive Miner's cuts partition the *alphabet*, not just the trace set,
//! disjointly among a node's children at every recursion step — xor, sequence,
//! parallel and loop all split "which activities can appear here" before
//! splitting "which traces go where". The consequence used throughout this
//! module: **a discovered tree contains each activity in exactly one leaf**.
//! So converting one object type's tree never creates two arc pairs between
//! the same transition and that object type's places — each activity leaf
//! contributes exactly one (in, out) pair, and the only way a transition ends
//! up with more than one pair is by being shared across *different* object
//! types, which is the merge this whole crate exists to do. If a future miner
//! without this invariant were ever plugged in here, this assumption would
//! need re-checking.

use inductive_miner_core::tree::Tree;
use ocpn_core::{
    internal_place_id, silent_transition_id, source_place_id, sink_place_id,
    transition_id_for_activity, Arc, NodeRef, Place, PlaceKind, PlaceId, Transition, TransitionId,
};
use std::collections::BTreeMap;

struct Builder<'a> {
    object_type: &'a str,
    place_ordinal: usize,
    silent_ordinal: usize,
    arc_ordinal: usize,
    places: Vec<Place>,
    arcs: Vec<Arc>,
    transitions: &'a mut BTreeMap<TransitionId, Transition>,
}

impl<'a> Builder<'a> {
    fn fresh_place(&mut self) -> PlaceId {
        let id = internal_place_id(self.object_type, self.place_ordinal);
        self.place_ordinal += 1;
        self.places.push(Place {
            id: id.clone(),
            object_type: self.object_type.to_string(),
            kind: PlaceKind::Normal,
        });
        id
    }

    fn fresh_silent(&mut self) -> TransitionId {
        let id = silent_transition_id(self.object_type, self.silent_ordinal);
        self.silent_ordinal += 1;
        // Silent transitions are private to one object type by construction:
        // the id is namespaced, so this can never collide with an existing
        // entry from another type or another call.
        self.transitions.insert(
            id.clone(),
            Transition { id: id.clone(), activity: None, object_types: vec![self.object_type.to_string()] },
        );
        id
    }

    /// Looks up (or creates) the *shared* transition for a labelled activity,
    /// and records this object type's participation in it. This is the merge
    /// step: a second object type calling this with the same label reuses the
    /// first type's transition id and simply appends itself to `object_types`.
    fn shared_transition(&mut self, label: &str) -> TransitionId {
        let id = transition_id_for_activity(label);
        self.transitions
            .entry(id.clone())
            .and_modify(|t| {
                if !t.object_types.iter().any(|ot| ot == self.object_type) {
                    t.object_types.push(self.object_type.to_string());
                }
            })
            .or_insert_with(|| Transition {
                id: id.clone(),
                activity: Some(label.to_string()),
                object_types: vec![self.object_type.to_string()],
            });
        id
    }

    fn place_to_transition(&mut self, place: PlaceId, transition: TransitionId) {
        let id = format!("a:{}:{}", self.object_type, self.arc_ordinal);
        self.arc_ordinal += 1;
        self.arcs.push(Arc {
            id,
            source: NodeRef::Place { id: place },
            target: NodeRef::Transition { id: transition },
            object_type: self.object_type.to_string(),
            variable: false,
        });
    }

    fn transition_to_place(&mut self, transition: TransitionId, place: PlaceId) {
        let id = format!("a:{}:{}", self.object_type, self.arc_ordinal);
        self.arc_ordinal += 1;
        self.arcs.push(Arc {
            id,
            source: NodeRef::Transition { id: transition },
            target: NodeRef::Place { id: place },
            object_type: self.object_type.to_string(),
            variable: false,
        });
    }
}

fn convert(tree: &Tree, in_place: &PlaceId, out_place: &PlaceId, b: &mut Builder, names: &[String]) {
    match tree {
        Tree::Tau => {
            let t = b.fresh_silent();
            b.place_to_transition(in_place.clone(), t.clone());
            b.transition_to_place(t, out_place.clone());
        }
        Tree::Activity(a) => {
            let label = names
                .get(*a as usize)
                .cloned()
                .unwrap_or_else(|| format!("activity {a}"));
            let t = b.shared_transition(&label);
            b.place_to_transition(in_place.clone(), t.clone());
            b.transition_to_place(t, out_place.clone());
        }
        Tree::Sequence(children) => {
            let mut cur = in_place.clone();
            for (i, child) in children.iter().enumerate() {
                let next = if i + 1 == children.len() { out_place.clone() } else { b.fresh_place() };
                convert(child, &cur, &next, b, names);
                cur = next;
            }
        }
        Tree::Xor(children) => {
            for child in children {
                convert(child, in_place, out_place, b, names);
            }
        }
        Tree::Parallel(children) => {
            let split = b.fresh_silent();
            let join = b.fresh_silent();
            b.place_to_transition(in_place.clone(), split.clone());
            b.transition_to_place(join.clone(), out_place.clone());
            for child in children {
                let p_start = b.fresh_place();
                let p_end = b.fresh_place();
                b.transition_to_place(split.clone(), p_start.clone());
                b.place_to_transition(p_end.clone(), join.clone());
                convert(child, &p_start, &p_end, b, names);
            }
        }
        Tree::Loop(children) => {
            // Match pm4py's process-tree converter: a loop has its own
            // private entry place, reached through an `init_loop` tau. This
            // is distinct from a root loop's boundary tau (installed below),
            // so source -> τ -> place -> τ -> place -> body stays visible and
            // structurally equivalent to pm4py's OCPN conversion.
            let loop_entry = b.fresh_place();
            let init_loop = b.fresh_silent();
            b.place_to_transition(in_place.clone(), init_loop.clone());
            b.transition_to_place(init_loop, loop_entry.clone());

            // Always [body, redo, exit] from `inductive-miner-core`; exit is
            // always tau for IM/IMf, but the recursion does not special-case
            // that — a tau exit just produces one silent transition.
            let mid = b.fresh_place();
            convert(&children[0], &loop_entry, &mid, b, names);
            if let Some(redo) = children.get(1) {
                convert(redo, &mid, &loop_entry, b, names);
            }
            if let Some(exit) = children.get(2) {
                convert(exit, &mid, out_place, b, names);
            } else {
                let t = b.fresh_silent();
                b.place_to_transition(mid, t.clone());
                b.transition_to_place(t, out_place.clone());
            }
        }
    }
}

/// Converts one object type's process tree into places/arcs tagged with that
/// object type, inserting into (and merging with) the shared global
/// transition map. Returns this object type's own places and arcs; the
/// transitions live in `transitions`, shared across every call.
pub fn tree_to_subnet(
    object_type: &str,
    tree: &Tree,
    names: &[String],
    transitions: &mut BTreeMap<TransitionId, Transition>,
) -> (Vec<Place>, Vec<Arc>) {
    let src = source_place_id(object_type);
    let snk = sink_place_id(object_type);
    let mut b = Builder {
        object_type,
        place_ordinal: 0,
        silent_ordinal: 0,
        arc_ordinal: 0,
        places: vec![
            Place { id: src.clone(), object_type: object_type.to_string(), kind: PlaceKind::Source },
            Place { id: snk.clone(), object_type: object_type.to_string(), kind: PlaceKind::Sink },
        ],
        arcs: Vec::new(),
        transitions,
    };
    // pm4py wraps a root loop with distinct initial/final markings. Keep both
    // boundaries strict (source is entry-only; sink is exit-only), while the
    // loop itself owns its own private entry tau/place above. This yields the
    // same two τ/place stages between a root source and its first activity.
    let (entry, exit) = if matches!(tree, Tree::Loop(_)) {
        let entry = b.fresh_place();
        let exit = b.fresh_place();
        let start = b.fresh_silent();
        let finish = b.fresh_silent();
        b.place_to_transition(src.clone(), start.clone());
        b.transition_to_place(start, entry.clone());
        b.place_to_transition(exit.clone(), finish.clone());
        b.transition_to_place(finish, snk.clone());
        (entry, exit)
    } else {
        (src.clone(), snk.clone())
    };
    convert(tree, &entry, &exit, &mut b, names);
    (b.places, b.arcs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_loop_keeps_the_source_place_entry_only() {
        let tree = Tree::Loop(vec![Tree::Activity(0), Tree::Tau, Tree::Tau]);
        let mut transitions = BTreeMap::new();
        let (_places, arcs) = tree_to_subnet("Forklift", &tree, &["Weigh".to_string()], &mut transitions);
        let source = source_place_id("Forklift");

        assert!(arcs.iter().any(|arc| matches!(
            &arc.source,
            NodeRef::Place { id } if id == &source
        )));
        assert!(!arcs.iter().any(|arc| matches!(
            &arc.target,
            NodeRef::Place { id } if id == &source
        )));

        // PM4Py conversion deliberately has two τ/place stages before the
        // root loop body: initial marking -> τ -> place -> init_loop τ ->
        // loop-entry place -> first activity.
        let silent_after_source = arcs.iter().find_map(|arc| match (&arc.source, &arc.target) {
            (NodeRef::Place { id }, NodeRef::Transition { id: transition }) if id == &source => Some(transition.clone()),
            _ => None,
        }).expect("source must have an outgoing boundary tau");
        let first_place = arcs.iter().find_map(|arc| match (&arc.source, &arc.target) {
            (NodeRef::Transition { id }, NodeRef::Place { id: place }) if id == &silent_after_source => Some(place.clone()),
            _ => None,
        }).expect("boundary tau must reach a private entry place");
        let init_loop = arcs.iter().find_map(|arc| match (&arc.source, &arc.target) {
            (NodeRef::Place { id }, NodeRef::Transition { id: transition }) if id == &first_place => Some(transition.clone()),
            _ => None,
        }).expect("private entry place must reach the loop-entry tau");
        assert!(arcs.iter().any(|arc| matches!(
            &arc.source,
            NodeRef::Transition { id } if id == &init_loop
        )));
    }
}
