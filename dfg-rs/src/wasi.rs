//! Engine (Promenade Compute) build — a plain WASI cdylib, no wasm-bindgen.
//!
//! `lib.rs`'s wasm-bindgen glue only exists for `wasm32-unknown-unknown`
//! loaded through a JS module; Wasmtime hosts nothing that speaks that glue.
//! So the engine build exposes the *same* `DfgCore` through the smallest ABI
//! that can carry a whole job across the host/guest boundary in one call:
//! JSON in, JSON out, over the module's own linear memory.
//!
//! Wire contract (mirrored host-side in `compute/engine/src/kernel.rs`):
//!
//!   alloc(len) -> ptr                reserve `len` bytes for the host to write into
//!   run(in_ptr, in_len) -> u64        packed (out_ptr << 32 | out_len)
//!   dealloc(ptr, len)                 free a buffer this module allocated
//!
//! `run`'s input is `{ nActivities, cases: [i32], activities: [i32],
//! minFrequency }` — the whole scan in one shot rather than chunked, because
//! there is no AbortSignal to honour between chunks here: a job either
//! finishes or the host kills the whole Wasmtime instance. Its output is the
//! same `DfgFinalizeResult` shape `lib.rs`'s `finalize()` returns, so the
//! engine and the browser produce byte-identical JSON for the same log.

use crate::dfg_core::{DfgCore, DfgFinalizeResult};
use serde::{Deserialize, Serialize};
use std::mem;

#[derive(Deserialize)]
struct Input {
    #[serde(rename = "nActivities")]
    n_activities: usize,
    cases: Vec<i32>,
    activities: Vec<i32>,
    #[serde(rename = "activityNames", default)]
    activity_names: Vec<String>,
    #[serde(rename = "minFrequency", default = "default_min_frequency")]
    min_frequency: u32,
}

fn default_min_frequency() -> u32 {
    1
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    rows: u32,
    cases: u32,
    total_edges: u32,
    shown_edges: u32,
    heap_estimate: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    activities: Vec<String>,
    edges: Vec<u32>,
    starts: Vec<u32>,
    ends: Vec<u32>,
    counts: Vec<u32>,
    stats: Stats,
}

impl From<DfgFinalizeResult> for Output {
    fn from(r: DfgFinalizeResult) -> Self {
        Output {
            activities: r.activities,
            edges: r.edges,
            starts: r.starts,
            ends: r.ends,
            counts: r.counts,
            stats: Stats {
                rows: r.stats.rows,
                cases: r.stats.cases,
                total_edges: r.stats.total_edges,
                shown_edges: r.stats.shown_edges,
                heap_estimate: r.stats.heap_estimate,
            },
        }
    }
}

#[derive(Serialize)]
struct ErrorOutput<'a> {
    error: &'a str,
}

/// Reserves `len` bytes and returns a pointer the host may write into (via
/// `wasmtime`'s `Memory::write`) before calling `run`.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    mem::forget(buf);
    ptr
}

/// Frees a buffer previously returned by `alloc` or by `run`'s output.
#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        drop(Vec::from_raw_parts(ptr, len, len));
    }
}

/// Runs one whole discovery job. `in_ptr`/`in_len` name a UTF-8 JSON `Input`
/// the host already wrote via `alloc`. Returns `(out_ptr << 32) | out_len`
/// naming a UTF-8 JSON `Output` (or `{"error": "..."}`) the host must read
/// then `dealloc`.
#[no_mangle]
pub extern "C" fn run(in_ptr: *const u8, in_len: usize) -> u64 {
    let input_bytes = unsafe { std::slice::from_raw_parts(in_ptr, in_len) };
    // A genuine bug aborting mid-run (the crate builds with `panic = "abort"`
    // for a small module) traps the whole Wasmtime instance rather than
    // reaching this match; the host sees that as a `Trap` from `call()`, not
    // as one of these two graceful outcomes. Both are treated as one "job
    // failed" event — this JSON path exists for the *expected* failure modes
    // (bad input, bad output), which don't need to abort the sandbox.
    let json = match run_inner(input_bytes) {
        Ok(bytes) => bytes,
        Err(msg) => serde_json::to_vec(&ErrorOutput { error: &msg }).unwrap(),
    };
    // The input buffer was the host's allocation-on-our-behalf; it's done
    // with once decoded, so hand its memory back rather than leaking it.
    unsafe { drop(Vec::from_raw_parts(in_ptr as *mut u8, in_len, in_len)) };

    let mut out = json.into_boxed_slice();
    let out_ptr = out.as_mut_ptr();
    let out_len = out.len();
    mem::forget(out);
    ((out_ptr as u64) << 32) | (out_len as u64)
}

fn run_inner(input_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let input: Input = serde_json::from_slice(input_bytes).map_err(|e| format!("bad input: {e}"))?;
    let mut core = DfgCore::new(input.n_activities);
    if !input.activity_names.is_empty() {
        core.set_activity_names(input.activity_names);
    }
    core.push_chunk(&input.cases, &input.activities);
    core.finish();
    let out: Output = core.finalize(input.min_frequency).into();
    serde_json::to_vec(&out).map_err(|e| format!("bad output: {e}"))
}
