//! The process-tree fragment an LPM candidate is built from.
//!
//! Five operators, ported from Tax, Sidorova, Haakma & van der Aalst's Local
//! Process Model search: `Seq`, `Xor` (exclusive choice), `And` (parallel),
//! `Or` (inclusive choice) and `XorLoop` (repeat-or-exit a single activity).
//! Every expansion step in `search.rs` replaces one `Task` leaf with a small
//! two-child subtree — `Seq(existing, Task(new))`, say — so a tree built by N
//! expansions is always a nested *binary* tree, never a flat n-ary one; that
//! is what the search actually produces; nothing here needs to represent a
//! wider fan-out.
//!
//! `XorLoop` is the odd one out: it does not add a new activity at all, it
//! just wraps the *existing* leaf's activity in "do it, then optionally do it
//! again" — `body` is always what used to be a bare `Task`, `redo` and `exit`
//! are implicit silent (tau) steps, so there is nothing to store for them.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LpmTree {
    /// One occurrence of one activity, identified by the scan's own
    /// dictionary id (matching `alignment-rs`'s `activity_id` convention).
    Task(u32),
    Seq(Box<LpmTree>, Box<LpmTree>),
    Xor(Box<LpmTree>, Box<LpmTree>),
    And(Box<LpmTree>, Box<LpmTree>),
    Or(Box<LpmTree>, Box<LpmTree>),
    /// Repeat-or-exit a single activity: fire `body`, then either exit or
    /// fire it again. No new activity is consumed.
    XorLoop(Box<LpmTree>),
}

impl LpmTree {
    /// Every activity id used, in tree order (duplicates included — with
    /// `duplicateTransitions` on, the same activity can appear in more than
    /// one leaf).
    pub fn activities(&self, out: &mut Vec<u32>) {
        match self {
            LpmTree::Task(a) => out.push(*a),
            LpmTree::Seq(l, r) | LpmTree::Xor(l, r) | LpmTree::And(l, r) | LpmTree::Or(l, r) => {
                l.activities(out);
                r.activities(out);
            }
            LpmTree::XorLoop(body) => body.activities(out),
        }
    }

    /// Number of `Task` leaves — the "fragment size" `numTransitions` caps.
    pub fn leaf_count(&self) -> usize {
        let mut acts = Vec::new();
        self.activities(&mut acts);
        acts.len()
    }

    /// A canonical string form: commutative operators (`Xor`/`And`/`Or`) sort
    /// their two children by *their own* canonical key first, so two trees
    /// that differ only in which order an expansion visited a commutative
    /// pair collapse to the same string. This is the whole de-duplication
    /// mechanism — ProM instead restricts *which* insertion points a
    /// commutative expansion is tried from (its "exp_1" symmetry-breaking
    /// rule) to avoid ever generating the duplicate in the first place; this
    /// port generates a few more candidates and lets this key catch the
    /// duplicates in one shared `HashSet`, which is simpler to get right and,
    /// with fragments this small, not meaningfully slower.
    pub fn canonical_key(&self) -> String {
        match self {
            LpmTree::Task(a) => format!("T{a}"),
            LpmTree::Seq(l, r) => format!("S({},{})", l.canonical_key(), r.canonical_key()),
            LpmTree::XorLoop(body) => format!("L({})", body.canonical_key()),
            LpmTree::Xor(l, r) => Self::commutative_key("X", l, r),
            LpmTree::And(l, r) => Self::commutative_key("A", l, r),
            LpmTree::Or(l, r) => Self::commutative_key("O", l, r),
        }
    }

    fn commutative_key(tag: &str, l: &LpmTree, r: &LpmTree) -> String {
        let (a, b) = (l.canonical_key(), r.canonical_key());
        if a <= b { format!("{tag}({a},{b})") } else { format!("{tag}({b},{a})") }
    }

    /// Applies `f` to every `Task` leaf, in left-to-right order, replacing it
    /// with whatever `f` returns and threading through whether that leaf's
    /// immediate parent is already an `XorLoop` (an `XorLoop` may not be
    /// nested directly on top of another one — the second wrap would be
    /// behaviourally redundant, always dominated by the single-wrap version).
    /// Returns one full tree per leaf substituted, i.e. `leaf_count()` trees.
    pub fn for_each_leaf_replacement(
        &self,
        mut f: impl FnMut(u32, bool) -> Vec<LpmTree>,
    ) -> Vec<LpmTree> {
        let mut out = Vec::new();
        self.replace_leaves(false, &mut f, &mut out);
        out
    }

    fn replace_leaves(
        &self,
        under_xorloop: bool,
        f: &mut impl FnMut(u32, bool) -> Vec<LpmTree>,
        out: &mut Vec<LpmTree>,
    ) {
        match self {
            LpmTree::Task(a) => {
                for replacement in f(*a, under_xorloop) {
                    out.push(replacement);
                }
            }
            LpmTree::Seq(l, r) => Self::replace_in_pair(l, r, under_xorloop, f, out, |a, b| {
                LpmTree::Seq(Box::new(a), Box::new(b))
            }),
            LpmTree::Xor(l, r) => Self::replace_in_pair(l, r, under_xorloop, f, out, |a, b| {
                LpmTree::Xor(Box::new(a), Box::new(b))
            }),
            LpmTree::And(l, r) => Self::replace_in_pair(l, r, under_xorloop, f, out, |a, b| {
                LpmTree::And(Box::new(a), Box::new(b))
            }),
            LpmTree::Or(l, r) => Self::replace_in_pair(l, r, under_xorloop, f, out, |a, b| {
                LpmTree::Or(Box::new(a), Box::new(b))
            }),
            LpmTree::XorLoop(body) => {
                let mut inner = Vec::new();
                body.replace_leaves(true, f, &mut inner);
                for replaced_body in inner {
                    out.push(LpmTree::XorLoop(Box::new(replaced_body)));
                }
            }
        }
    }

    fn replace_in_pair(
        l: &LpmTree,
        r: &LpmTree,
        under_xorloop: bool,
        f: &mut impl FnMut(u32, bool) -> Vec<LpmTree>,
        out: &mut Vec<LpmTree>,
        rebuild: impl Fn(LpmTree, LpmTree) -> LpmTree,
    ) {
        let mut left_variants = Vec::new();
        l.replace_leaves(under_xorloop, f, &mut left_variants);
        for lv in left_variants {
            out.push(rebuild(lv, r.clone()));
        }
        let mut right_variants = Vec::new();
        r.replace_leaves(under_xorloop, f, &mut right_variants);
        for rv in right_variants {
            out.push(rebuild(l.clone(), rv));
        }
    }
}

/// Wire form for the artifact's `tree` field — a plain nested JSON shape,
/// independent of the Rust enum's representation.
#[derive(Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum LpmTreeJson {
    Task { activity: String },
    Seq { children: Vec<LpmTreeJson> },
    Xor { children: Vec<LpmTreeJson> },
    And { children: Vec<LpmTreeJson> },
    Or { children: Vec<LpmTreeJson> },
    XorLoop { body: Box<LpmTreeJson> },
}

impl LpmTree {
    pub fn to_json(&self, names: &[String]) -> LpmTreeJson {
        let label = |a: u32| names.get(a as usize).cloned().unwrap_or_else(|| format!("activity {a}"));
        match self {
            LpmTree::Task(a) => LpmTreeJson::Task { activity: label(*a) },
            LpmTree::Seq(l, r) => LpmTreeJson::Seq { children: vec![l.to_json(names), r.to_json(names)] },
            LpmTree::Xor(l, r) => LpmTreeJson::Xor { children: vec![l.to_json(names), r.to_json(names)] },
            LpmTree::And(l, r) => LpmTreeJson::And { children: vec![l.to_json(names), r.to_json(names)] },
            LpmTree::Or(l, r) => LpmTreeJson::Or { children: vec![l.to_json(names), r.to_json(names)] },
            LpmTree::XorLoop(body) => LpmTreeJson::XorLoop { body: Box::new(body.to_json(names)) },
        }
    }

    /// Compact operator notation for debugging/tests/table display, e.g.
    /// `→( 'a', ×('b', 'c') )` — mirrors the pretty-printer convention already
    /// used by `inductive-miner-rs/tools/wasmcheck.mjs`.
    pub fn pretty(&self, names: &[String]) -> String {
        let label = |a: u32| names.get(a as usize).map(|s| s.as_str()).unwrap_or("?").to_string();
        match self {
            LpmTree::Task(a) => format!("'{}'", label(*a)),
            LpmTree::Seq(l, r) => format!("\u{2192}( {}, {} )", l.pretty(names), r.pretty(names)),
            LpmTree::Xor(l, r) => format!("\u{d7}( {}, {} )", l.pretty(names), r.pretty(names)),
            LpmTree::And(l, r) => format!("\u{2227}( {}, {} )", l.pretty(names), r.pretty(names)),
            LpmTree::Or(l, r) => format!("\u{2228}( {}, {} )", l.pretty(names), r.pretty(names)),
            LpmTree::XorLoop(body) => format!("\u{21bb}( {} )", body.pretty(names)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_key_is_order_independent_for_commutative_ops() {
        let a = LpmTree::And(Box::new(LpmTree::Task(1)), Box::new(LpmTree::Task(2)));
        let b = LpmTree::And(Box::new(LpmTree::Task(2)), Box::new(LpmTree::Task(1)));
        assert_eq!(a.canonical_key(), b.canonical_key());
    }

    #[test]
    fn canonical_key_distinguishes_seq_order() {
        let a = LpmTree::Seq(Box::new(LpmTree::Task(1)), Box::new(LpmTree::Task(2)));
        let b = LpmTree::Seq(Box::new(LpmTree::Task(2)), Box::new(LpmTree::Task(1)));
        assert_ne!(a.canonical_key(), b.canonical_key());
    }

    #[test]
    fn leaf_count_matches_number_of_activities() {
        let t = LpmTree::Seq(
            Box::new(LpmTree::Task(0)),
            Box::new(LpmTree::And(Box::new(LpmTree::Task(1)), Box::new(LpmTree::Task(2)))),
        );
        assert_eq!(t.leaf_count(), 3);
    }

    #[test]
    fn for_each_leaf_replacement_visits_every_leaf() {
        let t = LpmTree::Seq(Box::new(LpmTree::Task(0)), Box::new(LpmTree::Task(1)));
        // Replace each leaf with a Seq(leaf, Task(99)) — one output tree per leaf.
        let variants = t.for_each_leaf_replacement(|a, _under_loop| {
            vec![LpmTree::Seq(Box::new(LpmTree::Task(a)), Box::new(LpmTree::Task(99)))]
        });
        assert_eq!(variants.len(), 2);
    }

    #[test]
    fn xorloop_marks_its_body_leaf_as_under_loop() {
        let t = LpmTree::XorLoop(Box::new(LpmTree::Task(0)));
        let mut seen_under_loop = false;
        t.for_each_leaf_replacement(|_a, under_loop| {
            seen_under_loop = under_loop;
            vec![LpmTree::Task(0)]
        });
        assert!(seen_under_loop);
    }
}
