//! Local Process Model discovery: a subset of activities' recurring
//! behaviour, mined as a small Petri-net fragment that may fire several
//! times within one trace. Ported from Tax, Sidorova, Haakma & van der
//! Aalst's `LocalProcessModelDiscovery` ProM package — see `docs/algorithm.md`
//! for what is and isn't a literal port.
//!
//! No wasm, no browser: this crate is pure algorithm, unit-testable on
//! native Rust. `plugins/lpm-rs/src/lib.rs` is the wasm-bindgen glue that
//! drives it from the host's `scan-finalize/1` ABI.

pub mod align;
pub mod evaluator;
pub mod net;
pub mod params;
pub mod search;
pub mod tree;

pub use evaluator::{reweight, LogStats, Scores};
pub use params::{LpmParams, Weights};
pub use search::{search, Candidate, SearchOutput};
pub use tree::{LpmTree, LpmTreeJson};
