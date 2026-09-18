//! Dev aid: prints a station map's plan and any invariant violations.
//!
//! `cargo run --example dump -- [seed]` — no seed prints the worked
//! order-to-cash example; a seed prints the corresponding randomised graph
//! from the test generator, which is how a failing `randomised_graphs_are_clean`
//! case is looked at.
use station_map_core::*;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 }
    fn below(&mut self, n: usize) -> usize { (self.next() % n.max(1) as u64) as usize }
    fn unit(&mut self) -> f64 { (self.next() % 1_000_000) as f64 / 1_000_000.0 }
}

fn random_graph(seed: u64) -> OcdfgPayload {
    let mut rng = Rng(seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1));
    let activities: Vec<String> = (0..(4 + rng.below(11))).map(|i| format!("Activity {i}")).collect();
    let type_count = 1 + rng.below(4);
    let types: Vec<String> = (0..type_count).map(|i| format!("Type {i}")).collect();
    let timed = rng.below(3) > 0;
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    for ot in &types {
        let mut mine: Vec<&String> = activities.iter().filter(|_| rng.unit() < 0.75).collect();
        if mine.len() < 2 { mine = activities.iter().take(2).collect(); }
        for (i, activity) in mine.iter().enumerate() {
            nodes.push(OcdfgNode { object_type: ot.clone(), activity: (*activity).clone(),
                count: 10.0 + rng.unit() * 900.0, starts: if i == 0 { 10.0 } else { 0.0 },
                ends: if i + 1 == mine.len() { 10.0 } else { 0.0 } });
        }
        for i in 0..mine.len() {
            let mut targets: Vec<usize> = Vec::new();
            if i + 1 < mine.len() { targets.push(i + 1); }
            if rng.unit() < 0.30 && i + 3 < mine.len() { targets.push(i + 3); }
            if rng.unit() < 0.18 && i > 1 { targets.push(i - 2); }
            if rng.unit() < 0.08 { targets.push(i); }
            for j in targets {
                edges.push(OcdfgEdge { object_type: ot.clone(), src: mine[i].clone(), dst: mine[j].clone(),
                    freq: 1.0 + rng.unit() * 500.0,
                    avg_secs: if timed { Some(if rng.unit() < 0.25 { 0.0 } else { rng.unit() * 200_000.0 }) } else { None } });
            }
        }
    }
    OcdfgPayload { object_types: types, nodes, edges }
}

fn main() {
    let seed: Option<u64> = std::env::args().nth(1).and_then(|a| a.parse().ok());
    let dense_mode = std::env::args().any(|a| a == "dense");
    let dfg = if dense_mode { dense() } else { match seed { Some(s) => random_graph(s), None => worked_example() } };
    let map = build_station_map(&dfg, &Params::default());
    for p in &map.platforms {
        println!("PLATFORM {:<16} rank {:>2} lane {:>3} x {:8.3} z {:8.3} r {:.3} t {:.0}",
            p.activity, p.rank, p.lane, p.x, p.z, p.radius, p.t);
    }
    for l in &map.lines {
        println!("LINE {:<40} back={} drop={} {:?}", l.id, l.backward, l.drop_at,
            l.points.iter().map(|p| (r3(p.x), r3(p.z))).collect::<Vec<_>>());
    }
    for s in &map.shafts {
        println!("SHAFT {:<40} x {:7.3} z {:7.3} r {:.3}", s.id, s.x, s.z, s.radius);
    }
    println!("EXTENT x {:.2} z {:.2}", map.extent.x, map.extent.z);
    for v in violations(&map) { println!("VIOLATION {v}"); }
}

fn r3(v: f64) -> f64 { (v * 1000.0).round() / 1000.0 }

fn worked_example() -> OcdfgPayload {
    let flows: &[(&str, &str, &str, f64, f64)] = &[
        ("Order", "Create Order", "Add Item", 900.0, 55.0),
        ("Order", "Add Item", "Confirm Order", 900.0, 735.0),
        ("Order", "Confirm Order", "Receive Payment", 880.0, 207_360.0),
        ("Order", "Receive Payment", "Close Order", 880.0, 290.0),
        ("Item", "Add Item", "Pick Item", 2400.0, 720.0),
        ("Item", "Pick Item", "Confirm Order", 2400.0, 430.0),
        ("Item", "Confirm Order", "Pack Shipment", 2100.0, 5400.0),
        ("Invoice", "Confirm Order", "Issue Invoice", 700.0, 64_800.0),
        ("Invoice", "Issue Invoice", "Receive Payment", 700.0, 91_000.0),
        ("Shipment", "Confirm Order", "Pack Shipment", 640.0, 5400.0),
        ("Shipment", "Pack Shipment", "Ship Goods", 640.0, 10_800.0),
        ("Shipment", "Ship Goods", "Receive Payment", 640.0, 43_200.0),
        ("Shipment", "Pack Shipment", "Issue Invoice", 300.0, 10_800.0),
        ("Shipment", "Ship Goods", "Pack Shipment", 45.0, 7200.0),
    ];
    let mut nodes = vec![]; let mut edges = vec![]; let mut seen: Vec<(String, String)> = vec![];
    for (ot, src, dst, freq, secs) in flows {
        edges.push(OcdfgEdge { object_type: (*ot).into(), src: (*src).into(), dst: (*dst).into(), freq: *freq, avg_secs: Some(*secs) });
        for a in [src, dst] {
            let k = ((*ot).to_string(), (*a).to_string());
            if !seen.contains(&k) {
                seen.push(k);
                nodes.push(OcdfgNode { object_type: (*ot).into(), activity: (*a).into(), count: *freq,
                    starts: if *a == "Create Order" { 900.0 } else { 0.0 },
                    ends: if *a == "Close Order" { 880.0 } else { 0.0 } });
            }
        }
    }
    OcdfgPayload { object_types: vec!["Order".into(), "Item".into(), "Invoice".into(), "Shipment".into()], nodes, edges }
}

/// A density comparable to a real OCEL at ten activities and four object
/// types: every type visits most activities, with skips and a little rework.
#[allow(dead_code)]
fn dense() -> OcdfgPayload {
    let mut rng = Rng(0x5eed_1234);
    let activities: Vec<String> = (0..10).map(|i| format!("Activity {i}")).collect();
    let types: Vec<String> = (0..4).map(|i| format!("Type {i}")).collect();
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    for ot in &types {
        let mine: Vec<&String> = activities.iter().filter(|_| rng.unit() < 0.85).collect();
        for (i, a) in mine.iter().enumerate() {
            nodes.push(OcdfgNode { object_type: ot.clone(), activity: (*a).clone(),
                count: 100.0 + rng.unit() * 900.0, starts: if i == 0 { 10.0 } else { 0.0 },
                ends: if i + 1 == mine.len() { 10.0 } else { 0.0 } });
        }
        for i in 0..mine.len() {
            let mut targets = vec![];
            if i + 1 < mine.len() { targets.push(i + 1); }
            if i + 2 < mine.len() { targets.push(i + 2); }
            if rng.unit() < 0.4 && i + 4 < mine.len() { targets.push(i + 4); }
            if rng.unit() < 0.3 && i > 1 { targets.push(i - 2); }
            for j in targets {
                edges.push(OcdfgEdge { object_type: ot.clone(), src: mine[i].clone(), dst: mine[j].clone(),
                    freq: 10.0 + rng.unit() * 900.0, avg_secs: Some(rng.unit() * 900_000.0) });
            }
        }
    }
    OcdfgPayload { object_types: types, nodes, edges }
}
