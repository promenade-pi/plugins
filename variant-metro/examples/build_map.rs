//! Builds a variant metro payload from a variant-attributed OC-DFG, offline.
//!
//! `cargo run --example build_map -- in.json out.json` — the same conversion
//! the wasm kernel runs in the browser, so the view's harness (and any manual
//! inspection) works on a real payload without needing the app.

use std::{env, fs};

use promenade_variant_metro::convert_json;
use metro_map_core::RankTiebreak;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let (input, output) = match args.as_slice() {
        [i, o] => (i.clone(), o.clone()),
        _ => {
            eprintln!("usage: build_map <variant-dfg.json> <metro-map.json>");
            std::process::exit(2);
        }
    };
    let text = fs::read_to_string(&input).expect("read input");
    let map = convert_json(&text, RankTiebreak::Frequency).expect("convert");
    fs::write(&output, &map).expect("write output");
    println!("wrote {output} ({} bytes)", map.len());
}
