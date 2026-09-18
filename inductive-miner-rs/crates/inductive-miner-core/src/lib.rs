//! Inductive Miner — IM and IMf — over trace variants.
//!
//! An independent implementation of Leemans, Fahland & van der Aalst's
//! algorithm:
//!
//! - **IM** — *Discovering Block-Structured Process Models from Event Logs — A
//!   Constructive Approach*, Petri Nets 2013, doi:10.1007/978-3-642-38697-8_17
//! - **IMf** — *… Containing Infrequent Behaviour*, BPM Workshops 2014,
//!   doi:10.1007/978-3-319-06257-0_6
//!
//! Behaviour was verified against ProM's implementation as a black box (see
//! `docs/prom-reference.md`); no ProM source was translated.
//!
//! The crate is deliberately free of anything host-shaped: no wasm types, no
//! browser APIs, no Promenade artifacts, no XES. It takes activity ids and
//! returns a tree.

pub mod cuts;
pub mod graph;
pub mod info;
pub mod log;
pub mod miner;
pub mod reduce;
pub mod split;
pub mod tree;

pub use log::{EventLog, Variant as TraceVariant};
pub use tree::{ActivityId, Tree};

use std::cell::Cell;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    /// Fitness-guaranteeing; the noise threshold is forced to zero.
    IM,
    /// Infrequent-behaviour tolerant. ProM's default.
    IMf,
}

#[derive(Debug, Clone)]
pub struct Parameters {
    pub variant: Variant,
    /// `0..=1`. Ignored (treated as 0) for `IM`.
    pub noise_threshold: f64,
    /// Depth guard. The recursion is total, but a corrupt input should fail
    /// loudly rather than exhaust a WASM stack.
    pub max_depth: usize,
}

impl Default for Parameters {
    fn default() -> Self {
        Parameters {
            variant: Variant::IMf,
            noise_threshold: 0.2,
            max_depth: 4096,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryError {
    Cancelled,
    RecursionLimit(usize),
}

impl std::fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DiscoveryError::Cancelled => write!(f, "cancelled"),
            DiscoveryError::RecursionLimit(d) => {
                write!(f, "recursion deeper than {d} levels")
            }
        }
    }
}

impl std::error::Error for DiscoveryError {}

#[derive(Debug, Clone)]
pub struct Discovery {
    pub tree: Tree,
    /// Recursion nodes visited — the honest unit of work for this algorithm,
    /// and the one worth reporting instead of a made-up percentage.
    pub nodes_visited: u64,
}

pub fn discover(log: &EventLog, params: &Parameters) -> Result<Discovery, DiscoveryError> {
    discover_with(log, params, &|| false, &|_| {})
}

/// `cancelled` is polled at every recursion node and inside the one
/// fall-through that scans all activities, so a long run stays interruptible
/// without the caller having to guess where the time goes.
pub fn discover_with(
    log: &EventLog,
    params: &Parameters,
    cancelled: &dyn Fn() -> bool,
    progress: &dyn Fn(&str),
) -> Result<Discovery, DiscoveryError> {
    let noise = match params.variant {
        Variant::IM => 0.0,
        Variant::IMf => params.noise_threshold.clamp(0.0, 1.0),
    };
    let m = miner::Miner {
        variant: params.variant,
        noise,
        cancelled,
        progress,
        max_depth: params.max_depth,
        nodes_visited: Cell::new(0),
    };
    progress("building directly-follows relations");
    let tree = m.mine(log, 0)?;
    progress("reducing the tree");
    Ok(Discovery {
        tree: reduce::reduce(tree),
        nodes_visited: m.nodes_visited.get(),
    })
}
