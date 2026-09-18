//! Reads `AcceptingPetriNet`'s own two wire shapes, permissively — the same
//! split `app/src/ingest/pnml.ts`'s `normalize()` performs in TypeScript
//! (see its doc comment: "Reads either of this codebase's two
//! `AcceptingPetriNet` shapes"). There is no canonical Rust struct for this
//! artifact type anywhere in the codebase to depend on instead (confirmed:
//! only two near-duplicate, non-canonical `AcceptingPetriNetPayload` copies
//! exist, in `plugins/petrinet-layered` and `plugins/inductive-visual-miner`,
//! and neither is a dependency this crate could reuse) — retrofitting one
//! is a real, separate cleanup, out of scope here.
//!
//! - **Inductive/Heuristics Miner shape**: a `labels: Array<string | null>`
//!   field, self-sufficient — a label of `null` at index `i` means
//!   transition `i` is genuinely silent (tau).
//! - **Alpha Miner shape**: no `labels` field, only bare `activities: number[]`
//!   ids that `place_to_transition`/`transition_to_place` reference directly
//!   (not by compacted position). Its name table lives in `artifact.meta`,
//!   a sibling of this action's own `inputValue` that never crosses the wasm
//!   boundary — so a transition's real name genuinely cannot be recovered
//!   here. This falls back to `#<id>`, the exact same placeholder
//!   `heuristics-miner-rs` itself uses for an unresolved name, and records
//!   one warning (not one per transition).

use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize)]
pub struct RawAcceptingPetriNet {
    #[serde(default)]
    pub places: Vec<serde::de::IgnoredAny>,
    #[serde(default)]
    pub activities: Vec<i64>,
    #[serde(default)]
    pub labels: Option<Vec<Option<String>>>,
    #[serde(rename = "place_to_transition", default)]
    pub place_to_transition: Vec<(i64, i64)>,
    #[serde(rename = "transition_to_place", default)]
    pub transition_to_place: Vec<(i64, i64)>,
}

/// The two wire shapes collapsed into one normalized, compact-indexed form:
/// place ids `0..place_count`, transition ids `0..transition_labels.len()`.
pub struct NormalizedPetriNet {
    pub place_count: usize,
    /// `None` means genuinely silent (tau) -- only possible via the
    /// Inductive/Heuristics Miner shape's own `labels`. The Alpha Miner
    /// shape never contributes a `None` here; every one of its transitions
    /// gets an (unresolvable-name) placeholder label instead.
    pub transition_labels: Vec<Option<String>>,
    pub place_to_transition: Vec<(usize, usize)>,
    pub transition_to_place: Vec<(usize, usize)>,
    pub warnings: Vec<String>,
}

pub fn normalize(raw: RawAcceptingPetriNet) -> NormalizedPetriNet {
    let place_count = raw.places.len();
    let mut warnings = Vec::new();

    if let Some(labels) = raw.labels {
        return NormalizedPetriNet {
            place_count,
            transition_labels: labels,
            place_to_transition: raw.place_to_transition.iter().map(|&(p, t)| (p as usize, t as usize)).collect(),
            transition_to_place: raw.transition_to_place.iter().map(|&(t, p)| (t as usize, p as usize)).collect(),
            warnings,
        };
    }

    if !raw.activities.is_empty() {
        warnings.push(
            "activity names weren't available in this net's own data (Alpha Miner shape) -- tasks are labelled by id".into(),
        );
    }
    let index_of: HashMap<i64, usize> = raw.activities.iter().enumerate().map(|(i, &a)| (a, i)).collect();
    let transition_labels = raw.activities.iter().map(|&a| Some(format!("#{a}"))).collect();
    let place_to_transition = raw
        .place_to_transition
        .iter()
        .filter_map(|&(p, t)| index_of.get(&t).map(|&ti| (p as usize, ti)))
        .collect();
    let transition_to_place = raw
        .transition_to_place
        .iter()
        .filter_map(|&(t, p)| index_of.get(&t).map(|&ti| (ti, p as usize)))
        .collect();

    NormalizedPetriNet { place_count, transition_labels, place_to_transition, transition_to_place, warnings }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inductive_miner_shape_is_self_sufficient() {
        let raw = RawAcceptingPetriNet {
            places: vec![serde::de::IgnoredAny, serde::de::IgnoredAny],
            activities: vec![0],
            labels: Some(vec![Some("A".into())]),
            place_to_transition: vec![(0, 0)],
            transition_to_place: vec![(0, 1)],
        };
        let n = normalize(raw);
        assert_eq!(n.place_count, 2);
        assert_eq!(n.transition_labels, vec![Some("A".to_string())]);
        assert!(n.warnings.is_empty());
    }

    #[test]
    fn alpha_miner_shape_falls_back_to_id_placeholder() {
        // Real transition id 7 referenced directly, not by compacted position.
        let raw = RawAcceptingPetriNet {
            places: vec![serde::de::IgnoredAny, serde::de::IgnoredAny],
            activities: vec![7],
            labels: None,
            place_to_transition: vec![(0, 7)],
            transition_to_place: vec![(7, 1)],
        };
        let n = normalize(raw);
        assert_eq!(n.transition_labels, vec![Some("#7".to_string())]);
        assert_eq!(n.place_to_transition, vec![(0, 0)]);
        assert_eq!(n.transition_to_place, vec![(0, 1)]);
        assert_eq!(n.warnings.len(), 1);
    }
}
