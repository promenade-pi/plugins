//! Net constructors for tests and for the `check` harness.
//!
//! Public rather than `#[cfg(test)]` because `src/bin/check.rs` is a separate
//! compilation unit and needs the same builders the unit tests use — the
//! alternative is two drifting copies of "how you write a net down".

use crate::net::{Marking, Net};

/// `(label, input places, output places)`. A repeated place is an arc weight.
/// A label of `""` is a silent transition.
pub type TransitionSpec<'a> = (&'a str, &'a [usize], &'a [usize]);

pub fn build(
    place_count: usize,
    transitions: &[TransitionSpec<'_>],
    initial: &[usize],
    final_marking: &[usize],
) -> Net {
    let to_marking = |places: &[usize]| -> Marking {
        let mut marking = vec![0u32; place_count];
        for &p in places {
            marking[p] += 1;
        }
        marking
    };
    let weigh = |places: &[usize]| {
        let mut arcs: Vec<(usize, u32)> = Vec::new();
        for &p in places {
            match arcs.iter_mut().find(|(q, _)| *q == p) {
                Some((_, weight)) => *weight += 1,
                None => arcs.push((p, 1)),
            }
        }
        arcs.sort_unstable();
        arcs
    };
    Net {
        place_count,
        labels: transitions
            .iter()
            .map(|(label, _, _)| if label.is_empty() { None } else { Some((*label).to_string()) })
            .collect(),
        pre: transitions.iter().map(|(_, pre, _)| weigh(pre)).collect(),
        post: transitions.iter().map(|(_, _, post)| weigh(post)).collect(),
        initial: to_marking(initial),
        final_marking: to_marking(final_marking),
        warnings: Vec::new(),
    }
}

/// The two textbook unsound patterns, plus their sound counterparts. They are
/// the fixed points of the randomised harness: whatever else changes, these
/// four verdicts may not.
pub mod fixtures {
    use super::*;

    /// `i -> A -> p -> B -> o`. Sound.
    pub fn sequence() -> Net {
        build(3, &[("A", &[0], &[1]), ("B", &[1], &[2])], &[0], &[2])
    }

    /// AND-split, both branches, AND-join. Sound.
    pub fn parallel() -> Net {
        build(
            6,
            &[
                ("split", &[0], &[1, 2]),
                ("A", &[1], &[3]),
                ("B", &[2], &[4]),
                ("join", &[3, 4], &[5]),
            ],
            &[0],
            &[5],
        )
    }

    /// XOR-split, one branch taken, AND-join waiting for both. Deadlocks.
    pub fn xor_split_and_join() -> Net {
        build(
            6,
            &[
                ("A", &[0], &[1]),
                ("B", &[0], &[2]),
                ("join", &[3, 4], &[5]),
                ("a2", &[1], &[3]),
                ("b2", &[2], &[4]),
            ],
            &[0],
            &[5],
        )
    }

    /// AND-split, both branches run, XOR-join fires once. Completes improperly:
    /// the sink is marked while the other branch still holds a token.
    pub fn and_split_xor_join() -> Net {
        build(
            4,
            &[("split", &[0], &[1, 2]), ("a", &[1], &[3]), ("b", &[2], &[3])],
            &[0],
            &[3],
        )
    }

    /// A workflow net in every structural respect, whose `E` demands two
    /// tokens from a place that never holds more than one. `E` and the `F`
    /// behind it can never fire.
    pub fn dead_transition() -> Net {
        build(
            4,
            &[("A", &[0], &[1]), ("E", &[1, 1], &[2]), ("F", &[2], &[3]), ("B", &[1], &[3])],
            &[0],
            &[3],
        )
    }

    /// A workflow net whose `L` gives back its own input token and mints a
    /// second one elsewhere, so `p2` grows without limit.
    pub fn unbounded() -> Net {
        build(
            4,
            &[("A", &[0], &[1]), ("L", &[1], &[1, 2]), ("B", &[1], &[3]), ("C", &[2], &[3])],
            &[0],
            &[3],
        )
    }
}
