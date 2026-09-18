//! Mirror of the host's `ProcessTreePayload` (`app/src/host/artifact/process-tree.ts`).
//!
//! Deserialize-only: this crate never produces a process tree, only reads
//! one that a miner already produced. Every other plugin that touches this
//! wire shape (e.g. `inductive-miner-rs`) defines its own small copy rather
//! than sharing a crate — the shape is three tiny structs, and a shared crate
//! would be more ceremony than the thing it shares.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct ProcessTreeNode {
    /// `None` for a leaf.
    pub operator: Option<String>,
    /// Activity name for a labelled leaf; `None` for an operator or a tau leaf.
    pub label: Option<String>,
    pub children: Vec<usize>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProcessTreePayload {
    pub root: usize,
    pub nodes: Vec<ProcessTreeNode>,
    #[allow(dead_code)]
    #[serde(default)]
    pub activities: Vec<String>,
}

impl ProcessTreeNode {
    /// A tau leaf: no operator, no label.
    pub fn is_tau(&self) -> bool {
        self.operator.is_none() && self.label.is_none()
    }
}
