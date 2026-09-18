//! A seeded random source.
//!
//! The same xoshiro256\*\* (seeded through SplitMix64) as
//! `plugins/playout-rs/crates/playout-core/src/rng.rs`, deliberately copied
//! rather than shared: a generator of models has no business depending on a
//! simulator of logs, and the alternative — a crate whose only export is forty
//! lines of arithmetic — is a dependency for its own sake. The reasons it is
//! not a library dependency either are the same two: a published benchmark's
//! seed must keep meaning the same thing across every version of everything,
//! and this has to compile to wasm with nothing behind it.

pub struct Rng {
    state: [u64; 4],
}

fn split_mix(seed: &mut u64) -> u64 {
    *seed = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *seed;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        // A seed of 0 is a perfectly ordinary thing for a user to type, and
        // xoshiro's all-zero state is the one state it cannot leave.
        let mut s = seed ^ 0x2545_F491_4F6C_DD1D;
        Self { state: [split_mix(&mut s), split_mix(&mut s), split_mix(&mut s), split_mix(&mut s)] }
    }

    pub fn next_u64(&mut self) -> u64 {
        let result = self.state[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.state[1] << 17;
        self.state[2] ^= self.state[0];
        self.state[3] ^= self.state[1];
        self.state[1] ^= self.state[2];
        self.state[0] ^= self.state[3];
        self.state[2] ^= t;
        self.state[3] = self.state[3].rotate_left(45);
        result
    }

    /// A uniform index below `n`. `n == 0` is a caller error and yields 0.
    pub fn below(&mut self, n: usize) -> usize {
        if n <= 1 {
            return 0;
        }
        (self.next_u64() % n as u64) as usize
    }

    /// Uniform in [0, 1).
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }

    /// A draw from the triangular distribution on `[low, high]` with its peak
    /// at `mode` — the distribution PTandLogGenerator draws a model's size
    /// from, and the reason its `min`/`mode`/`max` are three separate
    /// parameters rather than a range.
    ///
    /// Inverse-CDF, which needs one uniform draw and no rejection loop, so a
    /// seed maps to a size in a fixed number of steps.
    pub fn triangular(&mut self, low: f64, mode: f64, high: f64) -> f64 {
        if high <= low {
            return low;
        }
        let mode = mode.clamp(low, high);
        let u = self.unit();
        let split = (mode - low) / (high - low);
        if u < split {
            low + (u * (high - low) * (mode - low)).sqrt()
        } else {
            high - ((1.0 - u) * (high - low) * (high - mode)).sqrt()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_seed_gives_the_same_stream() {
        let mut a = Rng::new(7);
        let mut b = Rng::new(7);
        let from = |r: &mut Rng| (0..8).map(|_| r.next_u64()).collect::<Vec<_>>();
        assert_eq!(from(&mut a), from(&mut b));
        assert_ne!(from(&mut a), from(&mut Rng::new(8)));
    }

    #[test]
    fn triangular_draws_stay_in_range_and_peak_at_the_mode() {
        let mut rng = Rng::new(1);
        let draws: Vec<f64> = (0..20_000).map(|_| rng.triangular(10.0, 20.0, 30.0)).collect();
        assert!(draws.iter().all(|&v| (10.0..=30.0).contains(&v)));
        // The mean of a triangular distribution is (low + mode + high) / 3.
        let mean = draws.iter().sum::<f64>() / draws.len() as f64;
        assert!((mean - 20.0).abs() < 0.3, "mean was {mean}");
        // Skewed, too: a mode near the bottom has to pull the mean down.
        let mut rng = Rng::new(2);
        let skewed: f64 = (0..20_000).map(|_| rng.triangular(10.0, 12.0, 30.0)).sum::<f64>() / 20_000.0;
        assert!((skewed - 52.0 / 3.0).abs() < 0.3, "mean was {skewed}");
    }

    #[test]
    fn a_degenerate_range_is_its_own_answer() {
        let mut rng = Rng::new(3);
        assert_eq!(rng.triangular(12.0, 12.0, 12.0), 12.0);
        assert_eq!(rng.triangular(12.0, 3.0, 9.0), 12.0, "high below low collapses to low");
    }
}
