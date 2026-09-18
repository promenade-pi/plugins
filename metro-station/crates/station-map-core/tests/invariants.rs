//! What a station map has to be true of, on fixtures and on randomised graphs.
//!
//! The randomised half matters more than the fixtures. A routing heuristic
//! that passes a hand-written example and fails on the next real log is the
//! normal outcome, so the generator deliberately produces the awkward cases:
//! several object types over the same activities, cycles, self-loops, long
//! hand-offs that skip ranks, and graphs with no timing at all.

use station_map_core::{
    build_station_map, violations, OcdfgEdge, OcdfgNode, OcdfgPayload, Params,
};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    fn unit(&mut self) -> f64 {
        (self.next() % 1_000_000) as f64 / 1_000_000.0
    }
}

/// A synthetic order-to-cash OC-DFG with the shape the view exists to show:
/// a shared spine, two object types that diverge and rejoin, one very long
/// wait before payment, and one rework loop.
fn fixture() -> OcdfgPayload {
    let flows: &[(&str, &str, &str, f64, f64)] = &[
        ("Order", "Create Order", "Add Item", 900.0, 60.0),
        ("Order", "Add Item", "Confirm Order", 900.0, 720.0),
        ("Order", "Confirm Order", "Receive Payment", 880.0, 207_360.0),
        ("Order", "Receive Payment", "Close Order", 880.0, 300.0),
        ("Item", "Add Item", "Pick Item", 2400.0, 720.0),
        ("Item", "Pick Item", "Confirm Order", 2400.0, 400.0),
        ("Item", "Confirm Order", "Pack Shipment", 2100.0, 5400.0),
        ("Invoice", "Confirm Order", "Issue Invoice", 700.0, 64_800.0),
        ("Invoice", "Issue Invoice", "Receive Payment", 700.0, 90_000.0),
        ("Shipment", "Confirm Order", "Pack Shipment", 640.0, 5400.0),
        ("Shipment", "Pack Shipment", "Ship Goods", 640.0, 10_800.0),
        ("Shipment", "Ship Goods", "Receive Payment", 640.0, 43_200.0),
        ("Shipment", "Pack Shipment", "Issue Invoice", 300.0, 10_800.0),
        // Rework: a shipment sent back to be packed again.
        ("Shipment", "Ship Goods", "Pack Shipment", 40.0, 7200.0),
    ];
    let mut nodes: Vec<OcdfgNode> = Vec::new();
    let mut edges: Vec<OcdfgEdge> = Vec::new();
    let mut seen: Vec<(String, String)> = Vec::new();
    for (ot, src, dst, freq, secs) in flows {
        edges.push(OcdfgEdge {
            object_type: (*ot).into(),
            src: (*src).into(),
            dst: (*dst).into(),
            freq: *freq,
            avg_secs: Some(*secs),
        });
        for activity in [src, dst] {
            let key = ((*ot).to_string(), (*activity).to_string());
            if !seen.contains(&key) {
                seen.push(key);
                nodes.push(OcdfgNode {
                    object_type: (*ot).into(),
                    activity: (*activity).into(),
                    count: *freq,
                    starts: if *activity == "Create Order" { 900.0 } else { 0.0 },
                    ends: if *activity == "Close Order" { 880.0 } else { 0.0 },
                });
            }
        }
    }
    OcdfgPayload {
        object_types: vec!["Order".into(), "Item".into(), "Invoice".into(), "Shipment".into()],
        nodes,
        edges,
    }
}

fn random_graph(seed: u64) -> OcdfgPayload {
    let mut rng = Rng(seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1));
    let activities: Vec<String> = (0..(4 + rng.below(11)))
        .map(|i| format!("Activity {i}"))
        .collect();
    let type_count = 1 + rng.below(4);
    let types: Vec<String> = (0..type_count).map(|i| format!("Type {i}")).collect();
    // A third of the graphs carry no timing at all, which is the older OC-DFG
    // and the timestamp-free log; the map has to fall back rather than break.
    let timed = rng.below(3) > 0;

    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    for ot in &types {
        let mut mine: Vec<&String> = activities
            .iter()
            .filter(|_| rng.unit() < 0.75)
            .collect();
        if mine.len() < 2 {
            mine = activities.iter().take(2).collect();
        }
        for (i, activity) in mine.iter().enumerate() {
            nodes.push(OcdfgNode {
                object_type: ot.clone(),
                activity: (*activity).clone(),
                count: 10.0 + rng.unit() * 900.0,
                starts: if i == 0 { 10.0 } else { 0.0 },
                ends: if i + 1 == mine.len() { 10.0 } else { 0.0 },
            });
        }
        for i in 0..mine.len() {
            // The spine, plus skips and back-edges — the cases a router that
            // only ever sees rank r to rank r+1 would never meet.
            let mut targets: Vec<usize> = Vec::new();
            if i + 1 < mine.len() {
                targets.push(i + 1);
            }
            if rng.unit() < 0.30 && i + 3 < mine.len() {
                targets.push(i + 3);
            }
            if rng.unit() < 0.18 && i > 1 {
                targets.push(i - 2);
            }
            if rng.unit() < 0.08 {
                targets.push(i);
            }
            for j in targets {
                edges.push(OcdfgEdge {
                    object_type: ot.clone(),
                    src: mine[i].clone(),
                    dst: mine[j].clone(),
                    freq: 1.0 + rng.unit() * 500.0,
                    avg_secs: if timed {
                        Some(if rng.unit() < 0.25 { 0.0 } else { rng.unit() * 200_000.0 })
                    } else {
                        None
                    },
                });
            }
        }
    }
    OcdfgPayload { object_types: types, nodes, edges }
}

fn assert_clean(map: &station_map_core::StationMapPayload, what: &str) {
    let found = violations(map);
    assert!(
        found.is_empty(),
        "{what}: {} violation(s)\n  {}",
        found.len(),
        found
            .iter()
            .take(8)
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join("\n  ")
    );
}

#[test]
fn the_fixture_is_clean() {
    let map = build_station_map(&fixture(), &Params::default());
    assert_clean(&map, "fixture");
    assert!(map.stats.has_timing);
    assert_eq!(map.platforms.len(), 9);
    assert!(map.stats.max_time_secs > 200_000.0, "the payment wait should dominate the depth");
}

#[test]
fn the_deepest_platform_is_the_one_behind_the_longest_wait() {
    let map = build_station_map(&fixture(), &Params::default());
    let deepest = map
        .platforms
        .iter()
        .max_by(|a, b| a.t.partial_cmp(&b.t).unwrap())
        .unwrap();
    assert_eq!(deepest.activity, "Close Order");
    let payment = map
        .platforms
        .iter()
        .find(|p| p.activity == "Receive Payment")
        .unwrap();
    let confirm = map
        .platforms
        .iter()
        .find(|p| p.activity == "Confirm Order")
        .unwrap();
    // Payment is reached through the invoice branch (18h + 25h), not the
    // 2.4-day direct wait, so its depth is the *slower* of the two paths.
    assert!(payment.t - confirm.t >= 154_800.0);
}

#[test]
fn a_shared_activity_gets_a_larger_platform() {
    let map = build_station_map(&fixture(), &Params::default());
    let confirm = map.platforms.iter().find(|p| p.activity == "Confirm Order").unwrap();
    let ship = map.platforms.iter().find(|p| p.activity == "Ship Goods").unwrap();
    assert!(confirm.object_types.len() > ship.object_types.len());
    assert!(confirm.radius > ship.radius);
}

#[test]
fn an_untimed_graph_falls_back_instead_of_breaking() {
    let mut dfg = fixture();
    for edge in &mut dfg.edges {
        edge.avg_secs = None;
    }
    let map = build_station_map(&dfg, &Params::default());
    assert!(!map.stats.has_timing);
    assert_clean(&map, "untimed");
}

#[test]
fn abstraction_only_ever_removes() {
    let full = build_station_map(&fixture(), &Params::default());
    let terse = build_station_map(
        &fixture(),
        &Params { max_activities: 6, edge_coverage: 60.0, ..Params::default() },
    );
    assert!(terse.platforms.len() <= full.platforms.len());
    assert!(terse.platforms.len() >= 2);
    assert_clean(&terse, "abstracted");
}

#[test]
fn randomised_graphs_are_clean() {
    for seed in 1..=250u64 {
        let dfg = random_graph(seed);
        for params in [
            Params::default(),
            Params { max_activities: 8, edge_coverage: 70.0, ..Params::default() },
            Params { show_rework: false, ..Params::default() },
        ] {
            let map = build_station_map(&dfg, &params);
            assert_clean(&map, &format!("seed {seed}"));
        }
    }
}

#[test]
fn an_empty_graph_produces_an_empty_map() {
    let map = build_station_map(
        &OcdfgPayload { object_types: vec![], nodes: vec![], edges: vec![] },
        &Params::default(),
    );
    assert!(map.platforms.is_empty());
    assert_clean(&map, "empty");
}
