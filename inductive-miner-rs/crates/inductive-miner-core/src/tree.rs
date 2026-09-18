//! The process tree.
//!
//! Internally the loop is **ternary** — `(body, redo, exit)` — because that is
//! the shape the reduction rules are defined over: `LoopLoop` reads the nested
//! loop's exit child, and the flower-revert rule rewrites a `xor(tau, loop)`
//! into a loop whose body becomes tau. Modelling loops as `(body, redo)` and
//! re-deriving those rules would be a second translation of the same logic,
//! with a second chance to get it wrong.
//!
//! The **exit child is dropped at the output boundary** instead, where
//! `↺(B, R, τ) ≡ ↺(B, R)` makes it free, leaving the artifact with the standard
//! process-tree loop: first child body, remaining children redo branches.

use std::fmt::Write as _;

pub type ActivityId = u32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Tree {
    Activity(ActivityId),
    Tau,
    Xor(Vec<Tree>),
    Sequence(Vec<Tree>),
    Parallel(Vec<Tree>),
    /// Always exactly three children: body, redo, exit.
    Loop(Vec<Tree>),
}

impl Tree {
    pub fn loop_of(body: Tree, redo: Tree, exit: Tree) -> Tree {
        Tree::Loop(vec![body, redo, exit])
    }

    /// A self-loop on one subtree: `↺(body, τ, τ)`. The flower model, the
    /// semi-flower base case and both tau-loop fall-throughs all build this.
    pub fn self_loop(body: Tree) -> Tree {
        Tree::loop_of(body, Tree::Tau, Tree::Tau)
    }

    pub fn is_tau(&self) -> bool {
        matches!(self, Tree::Tau)
    }

    pub fn children(&self) -> &[Tree] {
        match self {
            Tree::Activity(_) | Tree::Tau => &[],
            Tree::Xor(c) | Tree::Sequence(c) | Tree::Parallel(c) | Tree::Loop(c) => c,
        }
    }

    pub fn children_mut(&mut self) -> Option<&mut Vec<Tree>> {
        match self {
            Tree::Activity(_) | Tree::Tau => None,
            Tree::Xor(c) | Tree::Sequence(c) | Tree::Parallel(c) | Tree::Loop(c) => Some(c),
        }
    }

    pub fn is_operator(&self) -> bool {
        !matches!(self, Tree::Activity(_) | Tree::Tau)
    }

    /// Can this subtree produce the empty trace?
    ///
    /// A loop can iff its body *and* its exit can — the redo branch is optional,
    /// the body and the exit are not.
    pub fn can_produce_tau(&self) -> bool {
        match self {
            Tree::Activity(_) => false,
            Tree::Tau => true,
            Tree::Xor(c) => c.iter().any(Tree::can_produce_tau),
            Tree::Sequence(c) | Tree::Parallel(c) => c.iter().all(Tree::can_produce_tau),
            Tree::Loop(c) => c[0].can_produce_tau() && c[2].can_produce_tau(),
        }
    }

    /// Can this subtree produce *nothing but* the empty trace?
    pub fn can_only_produce_tau(&self) -> bool {
        match self {
            Tree::Activity(_) => false,
            Tree::Tau => true,
            other => other.children().iter().all(Tree::can_only_produce_tau),
        }
    }

    pub fn node_count(&self) -> usize {
        1 + self.children().iter().map(Tree::node_count).sum::<usize>()
    }

    /// Renders the tree in the notation the differential harness compares on.
    ///
    /// `canonical` sorts the children of the commutative operators, so that an
    /// ordering ProM leaves to hash iteration does not read as a behavioural
    /// difference. It never reorders a sequence, and never moves a loop's body
    /// out of first position.
    pub fn render(&self, names: &[String], canonical: bool) -> String {
        let mut s = String::new();
        self.render_into(names, canonical, &mut s);
        s
    }

    fn render_into(&self, names: &[String], canonical: bool, out: &mut String) {
        match self {
            Tree::Tau => out.push_str("tau"),
            Tree::Activity(a) => {
                let name = names
                    .get(*a as usize)
                    .map(String::as_str)
                    .unwrap_or("<unknown>");
                let _ = write!(out, "'{}'", name.replace('\\', "\\\\").replace('\'', "\\'"));
            }
            _ => {
                let (op, commutative) = match self {
                    Tree::Xor(_) => ("xor", true),
                    Tree::Sequence(_) => ("seq", false),
                    Tree::Parallel(_) => ("and", true),
                    Tree::Loop(_) => ("loop", false),
                    _ => unreachable!(),
                };

                let mut kids: Vec<String> = self
                    .children()
                    .iter()
                    .map(|c| c.render(names, canonical))
                    .collect();

                // The exit child is always tau for IM/IMf, and ↺(B,R,τ) ≡ ↺(B,R);
                // rendering it would make every loop look different from the
                // standard two-child form for no semantic gain.
                if matches!(self, Tree::Loop(_)) && kids.len() == 3 && kids[2] == "tau" {
                    kids.truncate(2);
                }
                if commutative && canonical {
                    kids.sort();
                }

                out.push_str(op);
                out.push('(');
                for (i, k) in kids.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(k);
                }
                out.push(')');
            }
        }
    }
}
