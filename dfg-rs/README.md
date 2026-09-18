# Directly-Follows Graph (Rust)

Discovers a directly-follows graph (DFG) from an event log: for every pair of
activities that occur back-to-back within a case, the number of times it
happens — plus per-case start/end activities and per-activity frequency.

This is the same algorithm that has always powered the built-in
`core.discover.dfg` action, packaged as an ordinary installable plugin
(`run.promenade.dfg-rs`) instead. Two things follow from that:

- It runs through the host's **generic** wasm-plugin pipeline
  (`app/src/host/plugins/runtimeAdapters.ts` → `runner.ts` →
  `app/src/worker/wasm-plugin-worker.ts`), not a DFG-specific worker — the
  same driver Alignment, Alpha Miner, Heuristics Miner and every other Rust
  plugin use.
- It is Promenade's first **Promenade Compute** plugin: alongside the usual
  browser build (`promenade_dfg_bg.wasm`, `wasm32-unknown-unknown` +
  wasm-bindgen), the package also ships `compute/promenade_dfg_wasi.wasm` — a
  second build of the *same* algorithm (`src/dfg_core.rs`, which has no
  `wasm_bindgen` in it at all) for `wasm32-wasip1`, driven directly by
  Wasmtime inside a Promenade Compute engine container instead of a browser
  worker. See `docs/promenade-compute.md` at the repo root and
  `compute/README.md`.

## Building

```sh
./package.sh
```

Builds both targets (`wasm-pack build --target web` for the browser,
`cargo build --target wasm32-wasip1 --release` for the engine) and zips them
with `manifest.json` into `dist/run.promenade.dfg-rs-<version>.pmplugin`.

## Layout

- `src/dfg_core.rs` — the algorithm. No `wasm_bindgen`, no JS types.
- `src/lib.rs` — the browser build: a thin wasm-bindgen wrapper around
  `dfg_core`, compiled for `wasm32-unknown-unknown`.
- `src/wasi.rs` — the engine build: a plain WASI cdylib around the same
  `dfg_core`, compiled for `wasm32-wasip1`. See its own doc comment for the
  wire ABI Wasmtime drives it through.
