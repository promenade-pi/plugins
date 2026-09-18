//! The tree under construction, and the flat payload it becomes.
//!
//! The payload shape is the host's `ProcessTree` contract, transcribed from
//! what the Inductive Miner emits (`plugins/inductive-miner-rs/src/lib.rs`):
//! a flat node array addressed by index, one `root`, and the sorted distinct
//! activity names alongside. Everything that reads a process tree in this
//! workspace — the tree view, the BPMN conversion, the Petri net behind it —
//! reads that shape, so a generated tree is indistinguishable from a
//! discovered one and every one of them works on it unchanged.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operator {
    Sequence,
    Xor,
    Parallel,
    /// Inclusive choice. The Inductive Miner never produces one, but the tree
    /// view draws it (∨) and the BPMN conversion maps it to an inclusive
    /// gateway, so a generator may produce one when asked.
    Or,
    /// Exactly two children: body, redo.
    Loop,
}

impl Operator {
    /// The name this operator carries in the artifact.
    pub fn wire(self) -> &'static str {
        match self {
            Operator::Sequence => "sequence",
            Operator::Xor => "xor",
            Operator::Parallel => "parallel",
            Operator::Or => "or",
            Operator::Loop => "loop",
        }
    }

    /// Whether nesting one of these inside another of the same kind means the
    /// same thing as one flat node — which is what `fold` rests on.
    ///
    /// True for the associative operators and false for the loop, whose
    /// children have distinct roles (body, redo) that flattening would mix up.
    pub fn associative(self) -> bool {
        !matches!(self, Operator::Loop)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Activity(String),
    Tau,
    Op(Operator, Vec<Node>),
}

impl Node {
    pub fn children(&self) -> &[Node] {
        match self {
            Node::Op(_, children) => children,
            _ => &[],
        }
    }

    pub fn depth(&self) -> usize {
        1 + self.children().iter().map(Node::depth).max().unwrap_or(0)
    }

    pub fn count<F: Fn(&Node) -> bool + Copy>(&self, predicate: F) -> usize {
        (predicate(self) as usize) + self.children().iter().map(|c| c.count(predicate)).sum::<usize>()
    }

    /// Splices a child into its parent when both are the same associative
    /// operator, so `seq(a, seq(b, c))` becomes `seq(a, b, c)`.
    ///
    /// The construction below is binary — it splits the activities it has to
    /// place in two and recurses — which is the simplest thing that respects
    /// the operator probabilities, but it leaves a tree of nested pairs where
    /// the model really has one sequence of five things. Folding changes no
    /// behaviour at all (that is what associativity means) and is the
    /// difference between a tree a person can read and a staircase.
    pub fn fold(self) -> Node {
        match self {
            Node::Op(operator, children) => {
                let mut folded = Vec::with_capacity(children.len());
                for child in children.into_iter().map(Node::fold) {
                    match child {
                        Node::Op(inner, grandchildren)
                            if inner == operator && operator.associative() =>
                        {
                            folded.extend(grandchildren)
                        }
                        other => folded.push(other),
                    }
                }
                Node::Op(operator, folded)
            }
            leaf => leaf,
        }
    }
}

// ------------------------------------------------------- the wire payload

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct TreeNode {
    pub operator: Option<&'static str>,
    pub label: Option<String>,
    pub children: Vec<u32>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ProcessTreePayload {
    pub root: u32,
    pub nodes: Vec<TreeNode>,
    /// Sorted distinct activity names, as the Inductive Miner's payload has.
    pub activities: Vec<String>,
}

fn flatten(node: &Node, out: &mut Vec<TreeNode>) -> u32 {
    let me = out.len() as u32;
    let (operator, label) = match node {
        Node::Tau => (None, None),
        Node::Activity(name) => (None, Some(name.clone())),
        Node::Op(operator, _) => (Some(operator.wire()), None),
    };
    out.push(TreeNode { operator, label, children: Vec::new() });
    let children: Vec<u32> = node.children().iter().map(|c| flatten(c, out)).collect();
    out[me as usize].children = children;
    me
}

pub fn to_payload(root: &Node) -> ProcessTreePayload {
    let mut nodes = Vec::new();
    let root_index = flatten(root, &mut nodes);
    let mut activities: Vec<String> = nodes.iter().filter_map(|n| n.label.clone()).collect();
    activities.sort();
    activities.dedup();
    ProcessTreePayload { root: root_index, nodes, activities }
}

/// Spreadsheet-style names: `a`…`z`, then `aa`, `ab`, …
///
/// Short, ordered and unambiguous, which is what a synthetic model's labels
/// are for — a generated activity called "Approve invoice" would invite
/// reading meaning into a model that has none.
pub fn activity_name(index: usize) -> String {
    let mut name = Vec::new();
    let mut n = index;
    loop {
        name.push(b'a' + (n % 26) as u8);
        if n < 26 {
            break;
        }
        n = n / 26 - 1;
    }
    name.reverse();
    String::from_utf8(name).expect("ascii")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(name: &str) -> Node {
        Node::Activity(name.into())
    }

    #[test]
    fn names_run_past_the_alphabet_without_repeating() {
        assert_eq!(activity_name(0), "a");
        assert_eq!(activity_name(25), "z");
        assert_eq!(activity_name(26), "aa");
        assert_eq!(activity_name(27), "ab");
        assert_eq!(activity_name(51), "az");
        assert_eq!(activity_name(52), "ba");
        let all: std::collections::HashSet<String> = (0..2000).map(activity_name).collect();
        assert_eq!(all.len(), 2000);
    }

    #[test]
    fn nested_associative_operators_fold_into_one() {
        let tree = Node::Op(
            Operator::Sequence,
            vec![a("a"), Node::Op(Operator::Sequence, vec![a("b"), a("c")])],
        );
        assert_eq!(
            tree.fold(),
            Node::Op(Operator::Sequence, vec![a("a"), a("b"), a("c")])
        );
    }

    #[test]
    fn a_different_operator_is_left_nested() {
        let tree = Node::Op(Operator::Sequence, vec![a("a"), Node::Op(Operator::Xor, vec![a("b"), a("c")])]);
        assert_eq!(tree.clone().fold(), tree);
    }

    #[test]
    fn a_loop_is_never_folded_into_its_parent_loop() {
        // ↺(↺(a, b), c) is not ↺(a, b, c): the first child is the body and
        // the rest are redo branches, so flattening would change which is
        // which — and with it what the model does.
        let inner = Node::Op(Operator::Loop, vec![a("a"), a("b")]);
        let tree = Node::Op(Operator::Loop, vec![inner, a("c")]);
        assert_eq!(tree.clone().fold(), tree);
    }

    #[test]
    fn the_payload_is_the_hosts_flat_shape() {
        let tree = Node::Op(Operator::Xor, vec![a("a"), Node::Tau]);
        let payload = to_payload(&tree);
        assert_eq!(payload.root, 0);
        assert_eq!(payload.nodes.len(), 3);
        assert_eq!(payload.nodes[0].operator, Some("xor"));
        assert_eq!(payload.nodes[0].children, vec![1, 2]);
        assert_eq!(payload.nodes[1].label.as_deref(), Some("a"));
        assert_eq!(payload.nodes[2].operator, None);
        assert_eq!(payload.nodes[2].label, None, "a tau leaf is the absence of both");
        assert_eq!(payload.activities, vec!["a".to_string()]);
    }
}
