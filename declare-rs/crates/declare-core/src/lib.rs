//! DECLARE: a declarative process model, discovered from a log and checked
//! against one.
//!
//! > Pesic, M., Schonenberg, H. & van der Aalst, W.M.P. (2007). *DECLARE: Full
//! > Support for Loosely-Structured Processes.* EDOC 2007, 287–298.
//!
//! > Maggi, F.M., Bose, R.P.J.C. & van der Aalst, W.M.P. (2012). *Efficient
//! > Discovery of Understandable Declarative Process Models from Event Logs.*
//! > CAiSE 2012, LNCS 7328, 270–285.
//!
//! Every other miner in this workspace answers "what does this process do?"
//! with a model you can walk through. A flexible process — a hospital, a
//! helpdesk, anything where the order is up to the person doing the work — has
//! no such model worth reading: the imperative answer is a spaghetti net that
//! allows almost everything. The declarative answer is the other way round.
//! It says nothing about what happens; it lists the rules that were never
//! broken, and the interesting ones are the rules that *could* have been.
//!
//! Pure Rust: no wasm, no host types, no JSON boundary. `../../src/lib.rs` is
//! the thin kernel that feeds this the event stream and serialises the model
//! back.

pub mod conformance;
pub mod counters;
pub mod discover;
pub mod templates;
pub mod trace;

pub use counters::{Assessment, Counters};
pub use discover::{discover, Constraint, Model, Options};
pub use templates::{Family, Template};
pub use trace::TraceIndex;
