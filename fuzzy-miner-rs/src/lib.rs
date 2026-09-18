//! Fuzzy Miner — Günther & van der Aalst's adaptive process simplification.
//!
//! The Fuzzy Miner does not discover a *model* in the sense the Alpha or
//! Inductive Miner do. It measures the log from several perspectives and
//! hands back a fully connected, weighted graph: every activity carries a
//! **unary significance**, every ordered activity pair carries a **binary
//! significance** and a **binary correlation**. Simplification — dropping
//! conflicting relations, thinning edges, folding low-significance activities
//! into clusters — is a separate, cheap, purely O(n²) transformation of that
//! graph, and in ProM it is what the sliders beside the diagram drive.
//!
//! This crate is the measuring half, and it is split along the host's two
//! stages:
//!
//!   scan (push_chunk/finish)   one ordered pass over the event stream,
//!                              accumulating every metric ingredient
//!                              *per look-back distance*. Expensive,
//!                              parameter-independent, cached by the host.
//!   finalize(params)           attenuation, normalisation, weighting, and
//!                              the two derivative metrics. Runs on n×n
//!                              matrices, so a metric slider can drive it.
//!
//! Keeping the per-distance slices separate rather than attenuating during the
//! scan is what makes the attenuation function, its radical and the maximal
//! event distance *cheap* parameters: the host's scan cache is keyed only by
//! the log and the activity limit, so anything that changed the scan's own
//! arithmetic would otherwise be silently ignored on re-run.
//!
//! The filter chain (conflict resolution, edge filter, node aggregation) lives
//! in the view — see `view-src/src/filters.ts` and `docs/algorithm.md`.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// A sanity cap on the O(n²) matrices, not a correctness bound. The host
/// filters to the most frequent activities before the scan starts.
pub const MAX_ACTIVITIES: usize = 300;

/// How far back the scan looks. Fixed at scan time — not derived from
/// `maximalDistance` — so that parameter can stay a *cheap* finalize one: the
/// scan is what's expensive and cached, and a parameter that changed what it
/// accumulates would have to invalidate that cache every time it moved.
///
/// ProM's own GUI lets this run from 0 to 100 (`FuzzyMinerOperator`'s
/// `ParameterTypeInt`), but every distance this scan is willing to reach adds
/// a full `n²` slice to three separate accumulators — at `MAX_ACTIVITIES`
/// that is ~700KB × 3 per distance. 100 would be ~210MB just for headroom
/// nobody asked for: the reference implementation's own default is 5, and
/// even ProM's batch operator (RapidProM) defaults to 1. 20 is four times
/// ProM's default — room to actually explore a wider window than 5 ever
/// allowed — while keeping worst-case scan memory (~42MB at 300 activities)
/// comfortably inside what a "medium"-memory action should use.
pub const SCAN_DISTANCE: usize = 20;

/// Missing timestamp/resource sentinel, as delivered by the host.
const NONE: i32 = -1;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetricDetail {
    pub frequency_unary: Vec<f64>,
    pub routing_unary: Vec<f64>,
    pub frequency_binary: Vec<f64>,
    pub distance_binary: Vec<f64>,
    pub proximity: Vec<f64>,
    pub endpoint: Vec<f64>,
    pub originator: Vec<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FuzzyModel {
    /// Activity labels, in the host's activity-id order.
    pub activities: Vec<String>,
    /// Raw occurrence count per activity — the view labels nodes with it.
    pub counts: Vec<u32>,
    /// Unary significance, normalised so the most significant activity is 1.
    pub node_significance: Vec<f64>,
    /// Row-major n×n binary significance.
    pub edge_significance: Vec<f64>,
    /// Row-major n×n binary correlation.
    pub edge_correlation: Vec<f64>,
    /// Per-metric normalised values, only when `includeMetricDetail` asks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<MetricDetail>,
    /// Raw count of relation observations at each look-back distance —
    /// `distance_histogram[0]` is distance 1 (the direct successor),
    /// `[SCAN_DISTANCE - 1]` the farthest the scan ever looked. Unattenuated,
    /// summed over every activity pair, and independent of `maximalDistance`
    /// — it answers "how much is actually out there past the current cutoff"
    /// rather than merely restating what the cutoff already let through.
    pub distance_histogram: Vec<u64>,
    pub stats: Stats,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub activities: usize,
    /// Ordered pairs with a non-zero binary significance.
    pub relations: usize,
    pub events: u32,
    pub cases: u32,
    pub maximal_distance: usize,
    pub attenuation: String,
    pub radical: f64,
    /// True when the host's activity limit cut the log short.
    pub truncated: bool,
    /// False when the log carries no `org:resource` at all, which makes
    /// originator correlation uniformly meaningless rather than merely small.
    pub has_resources: bool,
    /// False when the log carries no usable timestamps.
    pub has_timestamps: bool,
}

/// The expensive stage. See the module comment for why the accumulators are
/// sliced by look-back distance.
#[wasm_bindgen]
pub struct FuzzyScan {
    n: usize,
    /// `df[d][a * n + b]`: how often `a` was followed by `b` at distance d+1.
    df: Vec<Vec<f64>>,
    /// Summed proximity correlation per pair and distance, un-attenuated.
    prox: Vec<Vec<f64>>,
    /// Summed originator correlation per pair and distance, un-attenuated.
    orig: Vec<Vec<f64>>,
    counts: Vec<u32>,
    names: Vec<String>,
    resources: Vec<String>,

    /// Look-back window for the case being read, most recent first.
    window: Vec<(u32, f64, i32)>,
    last_case: i64,
    have_last: bool,
    rows: u32,
    cases: u32,
    truncated: bool,
    saw_resource: bool,
    saw_timestamp: bool,
}

#[wasm_bindgen]
impl FuzzyScan {
    #[wasm_bindgen(constructor)]
    pub fn new(n_activities: usize) -> FuzzyScan {
        let truncated = n_activities > MAX_ACTIVITIES;
        let n = n_activities.min(MAX_ACTIVITIES);
        let slice = || vec![vec![0.0; n * n]; SCAN_DISTANCE];
        FuzzyScan {
            n,
            df: slice(),
            prox: slice(),
            orig: slice(),
            counts: vec![0; n],
            names: Vec::new(),
            resources: Vec::new(),
            window: Vec::with_capacity(SCAN_DISTANCE + 1),
            last_case: i64::MIN,
            have_last: false,
            rows: 0,
            cases: 0,
            truncated,
            saw_resource: false,
            saw_timestamp: false,
        }
    }

    #[wasm_bindgen(js_name = setActivityNames)]
    pub fn set_activity_names(&mut self, names: Vec<String>) {
        self.names = names;
    }

    /// The dictionary behind the resource column, delivered up front by the
    /// host because the scan sees only integer ids.
    #[wasm_bindgen(js_name = setResourceNames)]
    pub fn set_resource_names(&mut self, names: Vec<String>) {
        self.resources = names;
    }

    /// Ordered by (case, timestamp). `timestamps` is epoch-ms, `-1` for none;
    /// `resources` is a dictionary id, `-1` for none.
    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, cases: &[i32], activities: &[i32], timestamps: &[f64], resources: &[i32]) {
        let len = cases.len().min(activities.len());
        for i in 0..len {
            let case = cases[i] as i64;
            let act = activities[i];
            let ts = timestamps.get(i).copied().unwrap_or(-1.0);
            let res = resources.get(i).copied().unwrap_or(NONE);

            if !self.have_last || self.last_case != case {
                self.window.clear();
                self.cases += 1;
            }
            self.last_case = case;
            self.have_last = true;
            self.rows += 1;

            if act < 0 || act as usize >= self.n {
                continue; // an empty-trace marker, or filtered out by the host
            }
            let act = act as u32;
            self.counts[act as usize] += 1;
            if ts >= 0.0 {
                self.saw_timestamp = true;
            }
            if res >= 0 {
                self.saw_resource = true;
            }

            // ProM walks the look-back list from the most recent predecessor
            // outwards; index k in that list *is* the event distance.
            for k in 0..self.window.len() {
                let (ref_act, ref_ts, ref_res) = self.window[k];
                let idx = ref_act as usize * self.n + act as usize;
                self.df[k][idx] += 1.0;
                self.prox[k][idx] += proximity(ref_ts, ts);
                self.orig[k][idx] += self.originator(ref_res, res);
            }

            self.window.insert(0, (act, ts, res));
            self.window.truncate(SCAN_DISTANCE);
        }
    }

    pub fn finish(&mut self) {
        self.window.clear();
        self.have_last = false;
    }

    #[wasm_bindgen(js_name = rowCount)]
    pub fn row_count(&self) -> u32 {
        self.rows
    }

    #[wasm_bindgen(js_name = caseCount)]
    pub fn case_count(&self) -> u32 {
        self.cases
    }

    #[wasm_bindgen(js_name = finalize)]
    pub fn finalize(&self, params: JsValue) -> Result<JsValue, JsValue> {
        let p: Params = serde_wasm_bindgen::from_value(params)
            .map_err(|e| JsValue::from_str(&format!("bad params: {e}")))?;
        serde_wasm_bindgen::to_value(&self.mine(&p)).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

/// Levenshtein similarity, the way ProM's Fuzzy Miner measures string
/// distance: `(len - dist) / len` over the longer of the two, not the
/// edit-ratio most libraries return by default.
fn string_similarity(a: &str, b: &str) -> f64 {
    let x: Vec<char> = a.chars().collect();
    let y: Vec<char> = b.chars().collect();
    let big = x.len().max(y.len());
    if big == 0 {
        return 1.0;
    }
    let mut prev: Vec<usize> = (0..=y.len()).collect();
    let mut cur = vec![0usize; y.len() + 1];
    for i in 1..=x.len() {
        cur[0] = i;
        for j in 1..=y.len() {
            let cost = if x[i - 1] == y[j - 1] { 0 } else { 1 };
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    (big - prev[y.len()]) as f64 / big as f64
}

/// ProM's proximity correlation: the reciprocal of the gap in milliseconds,
/// 1.0 for two events sharing a timestamp. Deliberately not a smooth decay —
/// the raw values are tiny and the normalisation step is what gives them a
/// usable range.
fn proximity(t1: f64, t2: f64) -> f64 {
    if t1 < 0.0 || t2 < 0.0 {
        return 0.0;
    }
    if t1 == t2 {
        1.0
    } else {
        1.0 / (t2 - t1)
    }
}

impl FuzzyScan {
    fn originator(&self, a: i32, b: i32) -> f64 {
        let name = |i: i32| -> &str {
            if i < 0 {
                "<no resource>"
            } else {
                self.resources.get(i as usize).map(|s| s.as_str()).unwrap_or("<no resource>")
            }
        };
        string_similarity(name(a), name(b))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Params {
    pub maximal_distance: usize,
    /// `nRoot` (ProM's default) or `linear`.
    pub attenuation: String,
    /// ProM calls this the radical / number of echelons.
    pub radical: f64,
    pub frequency_significance_unary: f64,
    pub routing_significance_unary: f64,
    pub frequency_significance_binary: f64,
    pub distance_significance_binary: f64,
    pub proximity_correlation: f64,
    pub endpoint_correlation: f64,
    pub originator_correlation: f64,
    /// Each metric's own "invert" flag, ProM's `MetricConfig.invert`: instead
    /// of scaling the metric's own maximum up to its weight, scale the
    /// *minimum* up to it — turning "highly frequent" from most significant
    /// into least, say, for a metric where frequency reads as noise rather
    /// than importance. Independent per metric, and applied at exactly the
    /// point each metric is normalised to its own weight — which for the two
    /// derivative metrics (routing, distance significance) is *after* they
    /// are computed from other metrics' own (possibly already-inverted)
    /// normalised values, matching the reference's own layering.
    pub invert_frequency_significance_unary: bool,
    pub invert_routing_significance_unary: bool,
    pub invert_frequency_significance_binary: bool,
    pub invert_distance_significance_binary: bool,
    pub invert_proximity_correlation: bool,
    pub invert_endpoint_correlation: bool,
    pub invert_originator_correlation: bool,
    pub include_metric_detail: bool,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            maximal_distance: 5,
            attenuation: "nRoot".into(),
            radical: 2.7,
            frequency_significance_unary: 1.0,
            routing_significance_unary: 1.0,
            frequency_significance_binary: 1.0,
            distance_significance_binary: 1.0,
            proximity_correlation: 1.0,
            endpoint_correlation: 1.0,
            originator_correlation: 1.0,
            invert_frequency_significance_unary: false,
            invert_routing_significance_unary: false,
            invert_frequency_significance_binary: false,
            invert_distance_significance_binary: false,
            invert_proximity_correlation: false,
            invert_endpoint_correlation: false,
            invert_originator_correlation: false,
            include_metric_detail: false,
        }
    }
}

/// `create_attenuation_factor` from ProM, for a distance of at least 1.
fn attenuation_factor(kind: &str, radical: f64, distance: usize) -> f64 {
    if distance <= 1 {
        return 1.0;
    }
    if kind == "linear" {
        // Echelons below the distance attenuate to zero and stay there.
        ((radical - distance as f64 + 1.0) / radical).max(0.0)
    } else {
        1.0 / radical.powi(distance as i32 - 1)
    }
}

/// `weight_normalize1D`: scale so the maximum becomes `weight`. A weight of 0
/// is ProM's way of excluding a metric, and yields an all-zero vector.
///
/// `invert` mirrors every value around `weight` (`weight - x`, ProM's own
/// formula) *after* scaling — not around the pre-scaling maximum, and not
/// around 1.0. At weight 1 that is the ordinary "1 minus" inversion; at a
/// lower weight it keeps the inverted metric inside the same `[0, weight]`
/// band every other metric's contribution lives in, so summing several
/// weighted metrics together still behaves.
fn weight_normalize1(v: &[f64], weight: f64, invert: bool) -> Vec<f64> {
    if weight == 0.0 {
        return vec![0.0; v.len()];
    }
    let max = v.iter().cloned().fold(0.0f64, f64::max);
    if max > 0.0 {
        v.iter().map(|x| {
            let scaled = x * weight / max;
            if invert { weight - scaled } else { scaled }
        }).collect()
    } else if invert {
        // Every value is already 0; ProM's own formula (`weight - x`) still
        // applies uniformly rather than leaving an untouched all-zero vector.
        vec![weight; v.len()]
    } else {
        v.to_vec()
    }
}

fn weight_normalize2(v: &[f64], weight: f64, invert: bool) -> Vec<f64> {
    weight_normalize1(v, weight, invert)
}

/// `special_weight_normalize2D`: correlation sums are first divided by the
/// summed attenuation factors that produced them (ProM's "compensate
/// frequency" — otherwise a frequent pair would look more correlated purely
/// for being frequent), then normalised (and optionally inverted) to the
/// metric's weight, same as `weight_normalize1`.
fn compensated_normalize(v: &[f64], divisors: &[f64], weight: f64, invert: bool) -> Vec<f64> {
    if weight == 0.0 {
        return vec![0.0; v.len()];
    }
    let comp: Vec<f64> = v
        .iter()
        .zip(divisors)
        .map(|(x, d)| if *d > 0.0 { x / d } else { *x })
        .collect();
    let max = comp.iter().cloned().fold(0.0f64, f64::max);
    if max > 0.0 {
        comp.iter().map(|x| {
            let scaled = x * weight / max;
            if invert { weight - scaled } else { scaled }
        }).collect()
    } else if invert {
        vec![weight; comp.len()]
    } else {
        comp
    }
}

/// `normalize_matrix1D`/`normalize_matrix2D`: plain scale-to-one.
fn normalize_to_one(v: &[f64]) -> Vec<f64> {
    let max = v.iter().cloned().fold(0.0f64, f64::max);
    if max > 0.0 {
        v.iter().map(|x| x / max).collect()
    } else {
        v.to_vec()
    }
}

fn round6(v: &[f64]) -> Vec<f64> {
    v.iter().map(|x| (x * 1e6).round() / 1e6).collect()
}

impl FuzzyScan {
    /// The algorithm proper, free of wasm-bindgen types so it can be tested.
    pub fn mine(&self, p: &Params) -> FuzzyModel {
        let n = self.n;
        let nn = n * n;
        let d_max = p.maximal_distance.clamp(1, SCAN_DISTANCE);
        let att: Vec<f64> = (1..=d_max)
            .map(|k| attenuation_factor(&p.attenuation, p.radical, k))
            .collect();

        // Fold the per-distance slices down with the chosen attenuation. The
        // divisor matrix is the same sum as the edge frequency — every
        // observation contributes exactly its own attenuation factor to both —
        // which is precisely what makes it the right compensation term.
        let mut edge_freq = vec![0.0; nn];
        let mut prox_raw = vec![0.0; nn];
        let mut orig_raw = vec![0.0; nn];
        for (k, a) in att.iter().enumerate() {
            for i in 0..nn {
                edge_freq[i] += self.df[k][i] * a;
                prox_raw[i] += self.prox[k][i] * a;
                orig_raw[i] += self.orig[k][i] * a;
            }
        }
        let divisors = edge_freq.clone();

        // Endpoint correlation compares the two *activity names*, so its value
        // is constant per pair and the attenuated sum divided by the same
        // attenuated count is that constant again. Building it directly saves
        // an n×n×distance accumulator in the scan for no loss of fidelity.
        let mut endpoint_raw = vec![0.0; nn];
        if p.endpoint_correlation > 0.0 {
            let name = |i: usize| self.names.get(i).map(|s| s.as_str()).unwrap_or("<no name>");
            for a in 0..n {
                for b in 0..n {
                    if divisors[a * n + b] > 0.0 {
                        endpoint_raw[a * n + b] = string_similarity(name(a), name(b)) * divisors[a * n + b];
                    }
                }
            }
        }

        // Primary metrics, normalised to their weights.
        let freq_unary = weight_normalize1(
            &self.counts.iter().map(|c| *c as f64).collect::<Vec<_>>(),
            p.frequency_significance_unary,
            p.invert_frequency_significance_unary,
        );
        let freq_binary = weight_normalize2(
            &edge_freq, p.frequency_significance_binary, p.invert_frequency_significance_binary
        );
        let corr_prox = compensated_normalize(
            &prox_raw, &divisors, p.proximity_correlation, p.invert_proximity_correlation
        );
        let corr_end = compensated_normalize(
            &endpoint_raw, &divisors, p.endpoint_correlation, p.invert_endpoint_correlation
        );
        let corr_orig = compensated_normalize(
            &orig_raw, &divisors, p.originator_correlation, p.invert_originator_correlation
        );

        // Aggregates: the inputs the two derivative metrics are defined over.
        let unary_simple = normalize_to_one(&freq_unary);
        let binary_simple = normalize_to_one(&freq_binary);
        let mut multi = vec![0.0; nn];
        for src in [&corr_prox, &corr_end, &corr_orig] {
            for i in 0..nn {
                multi[i] += src[i];
            }
        }
        let binary_multi = normalize_to_one(&multi);

        // Routing significance: how lopsided an activity's weighted in- and
        // out-flow are. A pure fan-out or fan-in scores 1; a pass-through
        // scores 0. Self-loops are excluded, as in ProM.
        let mut routing = vec![0.0; n];
        if p.routing_significance_unary > 0.0 {
            for i in 0..n {
                let mut inv = 0.0;
                let mut outv = 0.0;
                for x in 0..n {
                    if x == i {
                        continue;
                    }
                    inv += binary_simple[x * n + i] * binary_multi[x * n + i];
                    outv += binary_simple[i * n + x] * binary_multi[i * n + x];
                }
                routing[i] = if inv == 0.0 && outv == 0.0 {
                    0.0
                } else {
                    ((inv - outv) / (inv + outv)).abs()
                };
            }
        }

        // Distance significance: an edge between two highly significant
        // activities that is itself weak is a *long-distance* relation, and
        // scores low. Zero wherever there is no relation at all.
        let mut distance = vec![0.0; nn];
        if p.distance_significance_binary > 0.0 {
            for i in 0..n {
                let sig_source = unary_simple[i];
                for j in 0..n {
                    let sig_target = unary_simple[j];
                    if sig_source + sig_target == 0.0 {
                        continue;
                    }
                    let sig_link = binary_simple[i * n + j];
                    distance[i * n + j] = 1.0
                        - ((sig_source - sig_link) + (sig_target - sig_link)) / (sig_source + sig_target);
                }
            }
        }
        let routing_norm = weight_normalize1(
            &routing, p.routing_significance_unary, p.invert_routing_significance_unary
        );
        let distance_norm = weight_normalize2(
            &distance, p.distance_significance_binary, p.invert_distance_significance_binary
        );

        // Final weighted values: sum the included metrics, then scale to one.
        let mut unary = vec![0.0; n];
        for (src, w) in [
            (&freq_unary, p.frequency_significance_unary),
            (&routing_norm, p.routing_significance_unary),
        ] {
            if w > 0.0 {
                for i in 0..n {
                    unary[i] += src[i];
                }
            }
        }
        let node_significance = normalize_to_one(&unary);

        let mut bsig = vec![0.0; nn];
        for (src, w) in [
            (&freq_binary, p.frequency_significance_binary),
            (&distance_norm, p.distance_significance_binary),
        ] {
            if w > 0.0 {
                for i in 0..nn {
                    bsig[i] += src[i];
                }
            }
        }
        let edge_significance = normalize_to_one(&bsig);

        let mut bcorr = vec![0.0; nn];
        for (src, w) in [
            (&corr_prox, p.proximity_correlation),
            (&corr_end, p.endpoint_correlation),
            (&corr_orig, p.originator_correlation),
        ] {
            if w > 0.0 {
                for i in 0..nn {
                    bcorr[i] += src[i];
                }
            }
        }
        let edge_correlation = normalize_to_one(&bcorr);

        let relations = edge_significance.iter().filter(|x| **x > 0.0).count();

        // Unattenuated, params-independent: exactly what the scan measured at
        // each look-back distance, before `maximalDistance`/attenuation ever
        // touch it.
        let distance_histogram: Vec<u64> =
            self.df.iter().map(|slice| slice.iter().sum::<f64>().round() as u64).collect();

        FuzzyModel {
            activities: if self.names.len() >= n {
                self.names[..n].to_vec()
            } else {
                (0..n).map(|i| self.names.get(i).cloned().unwrap_or_else(|| format!("a{i}"))).collect()
            },
            counts: self.counts.clone(),
            node_significance: round6(&node_significance),
            edge_significance: round6(&edge_significance),
            edge_correlation: round6(&edge_correlation),
            metrics: if p.include_metric_detail {
                Some(MetricDetail {
                    frequency_unary: round6(&freq_unary),
                    routing_unary: round6(&routing_norm),
                    frequency_binary: round6(&freq_binary),
                    distance_binary: round6(&distance_norm),
                    proximity: round6(&corr_prox),
                    endpoint: round6(&corr_end),
                    originator: round6(&corr_orig),
                })
            } else {
                None
            },
            distance_histogram,
            stats: Stats {
                activities: n,
                relations,
                events: self.rows,
                cases: self.cases,
                maximal_distance: d_max,
                attenuation: p.attenuation.clone(),
                radical: p.radical,
                truncated: self.truncated,
                has_resources: self.saw_resource,
                has_timestamps: self.saw_timestamp,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feeds one case at a time, the way the host's ordered scan would.
    fn scan(traces: &[&[u32]], names: &[&str]) -> FuzzyScan {
        let n = names.len();
        let mut s = FuzzyScan::new(n);
        s.set_activity_names(names.iter().map(|x| x.to_string()).collect());
        s.set_resource_names(vec![]);
        for (c, t) in traces.iter().enumerate() {
            let cases: Vec<i32> = vec![c as i32; t.len()];
            let acts: Vec<i32> = t.iter().map(|a| *a as i32).collect();
            let ts: Vec<f64> = (0..t.len()).map(|i| (i as f64) * 1000.0).collect();
            let res: Vec<i32> = vec![-1; t.len()];
            s.push_chunk(&cases, &acts, &ts, &res);
        }
        s.finish();
        s
    }

    #[test]
    fn string_similarity_matches_prom() {
        assert_eq!(string_similarity("abc", "abc"), 1.0);
        assert_eq!(string_similarity("", ""), 1.0);
        // one substitution over a length of 3
        assert!((string_similarity("abc", "abd") - 2.0 / 3.0).abs() < 1e-12);
    }

    #[test]
    fn attenuation_defaults() {
        assert_eq!(attenuation_factor("nRoot", 2.7, 1), 1.0);
        assert!((attenuation_factor("nRoot", 2.7, 2) - 1.0 / 2.7).abs() < 1e-12);
        assert!((attenuation_factor("linear", 2.7, 2) - (2.7 - 1.0) / 2.7).abs() < 1e-12);
        // A linear attenuation past its echelons floors at zero rather than
        // turning negative and inverting the relation.
        assert_eq!(attenuation_factor("linear", 2.0, 5), 0.0);
    }

    #[test]
    fn sequential_log_puts_the_weight_on_the_direct_successor() {
        // a -> b -> c, ten times.
        let traces: Vec<&[u32]> = vec![&[0, 1, 2]; 10];
        let s = scan(&traces, &["a", "b", "c"]);
        let m = s.mine(&Params::default());
        let n = 3;
        // Every activity occurs equally often, so with routing significance in
        // play the endpoints (pure fan-in/fan-out) outrank the middle.
        assert!(m.node_significance[0] >= m.node_significance[1]);
        // a→b is a distance-1 relation, a→c only distance-2: strictly weaker.
        assert!(m.edge_significance[0 * n + 1] > m.edge_significance[0 * n + 2]);
        // Nothing ever runs backwards.
        assert_eq!(m.edge_significance[1 * n + 0], 0.0);
        assert_eq!(m.stats.cases, 10);
        assert_eq!(m.stats.events, 30);
    }

    #[test]
    fn maximal_distance_of_one_drops_the_indirect_relation() {
        let traces: Vec<&[u32]> = vec![&[0, 1, 2]; 10];
        let s = scan(&traces, &["a", "b", "c"]);
        let p = Params { maximal_distance: 1, ..Default::default() };
        let m = s.mine(&p);
        assert_eq!(m.edge_significance[0 * 3 + 2], 0.0);
        assert!(m.edge_significance[0 * 3 + 1] > 0.0);
    }

    #[test]
    fn a_zero_weight_excludes_a_metric() {
        let traces: Vec<&[u32]> = vec![&[0, 1, 2]; 10];
        let s = scan(&traces, &["a", "b", "c"]);
        let p = Params {
            proximity_correlation: 0.0,
            endpoint_correlation: 0.0,
            originator_correlation: 0.0,
            ..Default::default()
        };
        let m = s.mine(&p);
        assert!(m.edge_correlation.iter().all(|x| *x == 0.0));
    }

    #[test]
    fn concurrency_shows_up_as_a_two_way_relation() {
        // b and c are concurrent: both orders occur.
        let traces: Vec<&[u32]> = vec![&[0, 1, 2, 3], &[0, 2, 1, 3]];
        let s = scan(&traces, &["a", "b", "c", "d"]);
        let m = s.mine(&Params::default());
        let n = 4;
        assert!(m.edge_significance[1 * n + 2] > 0.0);
        assert!(m.edge_significance[2 * n + 1] > 0.0);
    }

    #[test]
    fn case_boundaries_are_respected() {
        // The last event of case 0 must not become a predecessor of the first
        // event of case 1.
        let traces: Vec<&[u32]> = vec![&[0], &[1]];
        let s = scan(&traces, &["a", "b"]);
        let m = s.mine(&Params::default());
        assert!(m.edge_significance.iter().all(|x| *x == 0.0));
        assert_eq!(m.stats.cases, 2);
    }

    #[test]
    fn every_value_stays_in_the_unit_interval() {
        let traces: Vec<&[u32]> = vec![&[0, 1, 2, 1, 3], &[0, 2, 1, 3], &[0, 1, 3]];
        let s = scan(&traces, &["alpha", "beta", "gamma", "delta"]);
        for d in 1..=SCAN_DISTANCE {
            for att in ["nRoot", "linear"] {
                let p = Params { maximal_distance: d, attenuation: att.into(), ..Default::default() };
                let m = s.mine(&p);
                for v in m
                    .node_significance
                    .iter()
                    .chain(&m.edge_significance)
                    .chain(&m.edge_correlation)
                {
                    assert!(*v >= 0.0 && *v <= 1.0, "{att}/{d}: {v} out of range");
                }
            }
        }
    }

    #[test]
    fn scan_distance_was_raised_past_proms_own_default() {
        // ProM's GUI default (and the reference implementation's) is 5; this
        // is the whole point of #3 — the ceiling used to equal the default,
        // meaning the dial could never actually move. 20 is well above both
        // that default and RapidProM's own operator default (1).
        assert!(SCAN_DISTANCE > 5, "SCAN_DISTANCE should exceed ProM's own default of 5");
        assert_eq!(SCAN_DISTANCE, 20);
    }

    #[test]
    fn maximal_distance_can_now_reach_past_the_old_ceiling_of_five() {
        // a -> b -> ... a chain long enough that a relation at distance 12
        // only exists if the scan actually reached that far back.
        let chain: Vec<u32> = (0..14).collect();
        let names: Vec<String> = chain.iter().map(|i| format!("a{i}")).collect();
        let name_refs: Vec<&str> = names.iter().map(|s| s.as_str()).collect();
        let traces: Vec<&[u32]> = vec![&chain; 5];
        let s = scan(&traces, &name_refs);
        let n = chain.len();
        let p = Params { maximal_distance: 12, ..Default::default() };
        let m = s.mine(&p);
        assert_eq!(m.stats.maximal_distance, 12);
        // a0 -> a12 is a distance-12 relation: present only if the scan's
        // own window (SCAN_DISTANCE) is at least that long.
        assert!(m.edge_significance[0 * n + 12] > 0.0, "a distance-12 relation was not measured");
    }

    #[test]
    fn invert_reflects_a_metric_around_its_own_weight() {
        // Two activities with very different frequency: a is rare, b is
        // common. With frequency significance as the *only* contributing
        // unary metric, node_significance should rank by raw frequency
        // normally, and by the reverse of it once inverted.
        let traces: Vec<&[u32]> = {
            let mut t: Vec<&[u32]> = vec![&[0u32, 1]; 10]; // a once, b once, x10
            t.extend(vec![&[1u32] as &[u32]; 20]); // b alone x20 more
            t
        };
        let s = scan(&traces, &["a", "b"]);

        let base = Params {
            routing_significance_unary: 0.0, // isolate frequency significance alone
            proximity_correlation: 0.0, endpoint_correlation: 0.0, originator_correlation: 0.0,
            ..Default::default()
        };
        let normal = s.mine(&base);
        assert!(
            normal.node_significance[1] > normal.node_significance[0],
            "b (more frequent) should outrank a under normal (non-inverted) frequency significance"
        );

        let inverted = Params { invert_frequency_significance_unary: true, ..base };
        let flipped = s.mine(&inverted);
        assert!(
            flipped.node_significance[0] > flipped.node_significance[1],
            "a (less frequent) should outrank b once frequency significance is inverted"
        );
    }

    #[test]
    fn invert_stays_in_the_unit_interval_including_the_all_zero_case() {
        // A single activity with no relations at all exercises the all-zero
        // branch of weight_normalize1/compensated_normalize under invert.
        let s = scan(&[&[0u32]], &["solo"]);
        let p = Params {
            invert_frequency_significance_unary: true,
            invert_routing_significance_unary: true,
            invert_frequency_significance_binary: true,
            invert_distance_significance_binary: true,
            invert_proximity_correlation: true,
            invert_endpoint_correlation: true,
            invert_originator_correlation: true,
            ..Default::default()
        };
        let m = s.mine(&p);
        for v in m.node_significance.iter().chain(&m.edge_significance).chain(&m.edge_correlation) {
            assert!(*v >= 0.0 && *v <= 1.0, "inverted all-zero case out of range: {v}");
        }
    }

    #[test]
    fn distance_histogram_counts_raw_relation_observations() {
        // a -> b -> c, ten times: distance-1 relations are a->b and b->c (10
        // each, 20 total); the only distance-2 relation is a->c (10); nothing
        // is ever three steps apart in a chain this short.
        let traces: Vec<&[u32]> = vec![&[0, 1, 2]; 10];
        let s = scan(&traces, &["a", "b", "c"]);
        let m = s.mine(&Params::default());
        assert_eq!(m.distance_histogram.len(), SCAN_DISTANCE);
        assert_eq!(m.distance_histogram[0], 20); // distance 1
        assert_eq!(m.distance_histogram[1], 10); // distance 2
        assert!(m.distance_histogram[2..].iter().all(|c| *c == 0));
    }

    #[test]
    fn distance_histogram_is_independent_of_maximal_distance() {
        // The histogram reports what the scan actually saw, not what the
        // current maximalDistance cutoff lets through — raising or lowering
        // maximalDistance must not change it, or it could never answer
        // "would raising the cutoff capture more."
        let chain: Vec<u32> = (0..14).collect();
        let names: Vec<String> = chain.iter().map(|i| format!("a{i}")).collect();
        let name_refs: Vec<&str> = names.iter().map(|s| s.as_str()).collect();
        let traces: Vec<&[u32]> = vec![&chain; 5];
        let s = scan(&traces, &name_refs);
        let narrow = s.mine(&Params { maximal_distance: 1, ..Default::default() });
        let wide = s.mine(&Params { maximal_distance: 12, ..Default::default() });
        assert_eq!(narrow.distance_histogram, wide.distance_histogram);
        assert!(narrow.distance_histogram[11] > 0, "distance-12 observations should already be in the histogram");
    }

    #[test]
    fn invert_is_independent_per_metric() {
        // Inverting one metric must not perturb a sibling metric's own
        // ranking — each metric's invert flag only ever reaches its own
        // normalize call.
        let traces: Vec<&[u32]> = vec![&[0u32, 1], &[1u32, 0]]; // a<->b, symmetric frequency
        let s = scan(&traces, &["a", "b"]);
        let base = Params::default();
        let a = s.mine(&base);
        let b = s.mine(&Params { invert_proximity_correlation: true, ..base });
        // Frequency-derived values are untouched by inverting a correlation
        // metric that carries zero weight contribution to them here.
        assert_eq!(a.node_significance, b.node_significance);
    }
}
