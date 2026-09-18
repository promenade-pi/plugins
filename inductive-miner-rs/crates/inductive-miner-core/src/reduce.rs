//! Language-preserving tree reduction.
//!
//! ProM runs this over every discovered tree before handing it back, so the
//! reduced tree is what a user actually sees and what parity has to be measured
//! against. Skipping it would leave single-child operators and stray taus all
//! over the output.
//!
//! The rule set is ProM's "for Petri net" configuration: the `LoopTau` rule
//! that would rewrite `↺(τ, R, E)` into a longer form is **off**, and an extra
//! xor rule folds `xor(τ, ↺(A, τ, τ))` back into a flower.

use crate::tree::Tree;

pub fn reduce(tree: Tree) -> Tree {
    let mut t = collapse_tau_only(tree);
    t = drop_superfluous_taus(t);
    // Rules can expose each other: flattening a nested xor can leave a second
    // tau, removing which can leave a single child, and so on.
    loop {
        let (next, changed) = apply_rules(t);
        t = next;
        if !changed {
            return t;
        }
    }
}

/// An operator subtree that can produce nothing but the empty trace *is* the
/// empty trace.
fn collapse_tau_only(tree: Tree) -> Tree {
    if tree.is_operator() && tree.can_only_produce_tau() {
        return Tree::Tau;
    }
    match tree {
        Tree::Xor(c) => Tree::Xor(c.into_iter().map(collapse_tau_only).collect()),
        Tree::Sequence(c) => Tree::Sequence(c.into_iter().map(collapse_tau_only).collect()),
        Tree::Parallel(c) => Tree::Parallel(c.into_iter().map(collapse_tau_only).collect()),
        Tree::Loop(c) => Tree::Loop(c.into_iter().map(collapse_tau_only).collect()),
        leaf => leaf,
    }
}

/// A tau under a sequence or a parallel contributes nothing; under a xor, only
/// the first way of producing the empty trace is worth keeping.
fn drop_superfluous_taus(tree: Tree) -> Tree {
    let recurse = |c: Vec<Tree>| -> Vec<Tree> { c.into_iter().map(drop_superfluous_taus).collect() };
    match tree {
        Tree::Sequence(c) => {
            let mut c = recurse(c);
            c.retain(|k| !k.is_tau());
            Tree::Sequence(c)
        }
        Tree::Parallel(c) => {
            let mut c = recurse(c);
            c.retain(|k| !k.is_tau());
            Tree::Parallel(c)
        }
        Tree::Xor(c) => {
            let c = recurse(c);
            let mut epsilon_covered = c.iter().any(|k| !k.is_tau() && k.can_produce_tau());
            let mut kept = Vec::with_capacity(c.len());
            for k in c {
                if k.is_tau() {
                    if epsilon_covered {
                        continue;
                    }
                    epsilon_covered = true;
                }
                kept.push(k);
            }
            Tree::Xor(kept)
        }
        Tree::Loop(c) => Tree::Loop(recurse(c)),
        leaf => leaf,
    }
}

/// One pass, **root before children**.
///
/// The direction matters. ProM sweeps its node array from index 0, which is
/// pre-order, and that decides real outcomes: at a `xor(τ, ↺(↺(S,τ,τ),τ,τ))`
/// the root rule reverts the flower first and leaves the inner loop parked in
/// a redo position where nothing collapses it. Reducing children first would
/// collapse the nested loop and yield a different — equally correct, but
/// different — tree.
///
/// Rules are applied in ProM's per-operator order, all of them, not stopping at
/// the first that fires.
fn apply_rules(tree: Tree) -> (Tree, bool) {
    let mut changed = false;

    let tree = single_child(tree, &mut changed);

    let tree = match tree {
        Tree::Xor(c) => {
            let (c, ch) = drop_second_tau(c);
            changed |= ch;
            let (c, ch) = flatten_same_operator(c, |k| matches!(k, Tree::Xor(_)));
            changed |= ch;
            match flower_revert(c) {
                Ok(t) => {
                    changed = true;
                    t
                }
                Err(c) => Tree::Xor(c),
            }
        }
        Tree::Sequence(c) => {
            let (c, ch) = drop_taus_when_others_remain(c);
            changed |= ch;
            let (c, ch) = flatten_same_operator(c, |k| matches!(k, Tree::Sequence(_)));
            changed |= ch;
            Tree::Sequence(c)
        }
        Tree::Parallel(c) => {
            let (c, ch) = drop_taus_when_others_remain(c);
            changed |= ch;
            let (c, ch) = flatten_same_operator(c, |k| matches!(k, Tree::Parallel(_)));
            changed |= ch;
            Tree::Parallel(c)
        }
        Tree::Loop(c) => match collapse_nested_loop(c) {
            Ok(t) => {
                changed = true;
                t
            }
            Err(c) => Tree::Loop(c),
        },
        leaf => leaf,
    };

    let tree = match tree {
        Tree::Xor(c) => Tree::Xor(reduce_children(c, &mut changed)),
        Tree::Sequence(c) => Tree::Sequence(reduce_children(c, &mut changed)),
        Tree::Parallel(c) => Tree::Parallel(reduce_children(c, &mut changed)),
        Tree::Loop(c) => Tree::Loop(reduce_children(c, &mut changed)),
        leaf => leaf,
    };

    (tree, changed)
}

/// An operator with one child *is* that child. Loops are ternary and never
/// qualify.
fn single_child(tree: Tree, changed: &mut bool) -> Tree {
    if matches!(tree, Tree::Loop(_)) || !tree.is_operator() || tree.children().len() != 1 {
        return tree;
    }
    *changed = true;
    let mut t = tree;
    t.children_mut().unwrap().pop().unwrap()
}

fn reduce_children(children: Vec<Tree>, changed: &mut bool) -> Vec<Tree> {
    children
        .into_iter()
        .map(|k| {
            let (k, ch) = apply_rules(k);
            *changed |= ch;
            k
        })
        .collect()
}

/// `op(a, op(b, c), d)` → `op(a, b, c, d)`, in place, for the associative
/// operators.
fn flatten_same_operator(children: Vec<Tree>, same: impl Fn(&Tree) -> bool) -> (Vec<Tree>, bool) {
    if !children.iter().any(&same) {
        return (children, false);
    }
    let mut out = Vec::with_capacity(children.len());
    for k in children {
        if same(&k) {
            let mut k = k;
            out.append(k.children_mut().unwrap());
        } else {
            out.push(k);
        }
    }
    (out, true)
}

/// A xor needs at most one way of producing the empty trace.
fn drop_second_tau(children: Vec<Tree>) -> (Vec<Tree>, bool) {
    let mut tau_seen = children.iter().any(|k| !k.is_tau() && k.can_produce_tau());
    let mut removed = false;
    let mut out = Vec::with_capacity(children.len());
    for k in children {
        if k.is_tau() && !removed {
            if tau_seen {
                removed = true;
                continue;
            }
            tau_seen = true;
        }
        out.push(k);
    }
    (out, removed)
}

/// A tau under a sequence or a parallel is a no-op, as long as something else
/// remains to be the node's content.
fn drop_taus_when_others_remain(children: Vec<Tree>) -> (Vec<Tree>, bool) {
    if children.len() <= 1 || !children.iter().any(Tree::is_tau) {
        return (children, false);
    }
    let mut out: Vec<Tree> = children.into_iter().filter(|k| !k.is_tau()).collect();
    if out.is_empty() {
        out.push(Tree::Tau);
    }
    (out, true)
}

/// `xor(τ, ↺(A, τ, τ))` → `↺(τ, A, τ)`.
///
/// Both describe "any number of A, including none", but the loop form is the
/// one that converts to a compact Petri net, which is why ProM's
/// for-Petri-net rule set reverts to it.
fn flower_revert(children: Vec<Tree>) -> Result<Tree, Vec<Tree>> {
    if children.len() != 2 || !children.iter().any(Tree::is_tau) {
        return Err(children);
    }
    let loop_at = children.iter().position(|k| match k {
        Tree::Loop(c) => c[1].is_tau() && c[2].is_tau(),
        _ => false,
    });
    match loop_at {
        Some(i) => {
            let body = match &children[i] {
                Tree::Loop(c) => c[0].clone(),
                _ => unreachable!(),
            };
            Ok(Tree::loop_of(Tree::Tau, body, Tree::Tau))
        }
        None => Err(children),
    }
}

/// `↺(↺(A, B, τ), C, D)` → `↺(A, xor(B, C), D)`.
fn collapse_nested_loop(children: Vec<Tree>) -> Result<Tree, Vec<Tree>> {
    let nested_ok = matches!(&children[0], Tree::Loop(inner) if inner[2].is_tau());
    if !nested_ok {
        return Err(children);
    }
    let mut children = children;
    let inner = match children[0].children_mut() {
        Some(c) => std::mem::take(c),
        None => unreachable!(),
    };
    let mut it = inner.into_iter();
    let a = it.next().unwrap();
    let b = it.next().unwrap();
    let c = children.remove(1);
    let d = children.remove(1);
    Ok(Tree::loop_of(a, Tree::Xor(vec![b, c]), d))
}
