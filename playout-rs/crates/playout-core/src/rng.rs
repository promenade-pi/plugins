//! A seeded random source, in the crate rather than from a dependency.
//!
//! Two properties matter here and neither needs a library. The first is that a
//! simulation is reproducible: the same seed must give the same log, on every
//! machine and every build, or a simulated benchmark cannot be cited. A
//! dependency that changes its algorithm in a minor release would break that
//! silently, and `rand`'s own documentation is explicit that its distributions
//! are not stable across versions. The second is that this compiles to wasm
//! with nothing pulled in behind it.
//!
//! xoshiro256** for the stream, SplitMix64 to seed it — the standard pairing,
//! and far better distributed than the xorshift64* the invariant harnesses
//! use to *generate* nets (a test fixture generator can be rough; the sampler
//! that decides which branch a simulated case takes cannot).

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
        // 53 bits is the whole mantissa: taking fewer would quantise the
        // exponential draws below into visible steps.
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }

    /// An exponential draw with the given mean — the inter-arrival time of a
    /// Poisson process, which is what case arrivals and service times are
    /// modelled as (see `docs/algorithm.md`).
    pub fn exponential(&mut self, mean: f64) -> f64 {
        if mean <= 0.0 {
            return 0.0;
        }
        // 1 - u rather than u: `unit()` can return exactly 0, and ln(0) is
        // infinite. It can never return exactly 1.
        -mean * (1.0 - self.unit()).ln()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_seed_gives_the_same_stream() {
        let mut a = Rng::new(7);
        let mut b = Rng::new(7);
        let mut c = Rng::new(8);
        let from = |r: &mut Rng| (0..8).map(|_| r.next_u64()).collect::<Vec<_>>();
        let first = from(&mut a);
        assert_eq!(first, from(&mut b));
        assert_ne!(first, from(&mut c));
    }

    #[test]
    fn a_zero_seed_still_produces_a_stream() {
        let mut r = Rng::new(0);
        let values: Vec<u64> = (0..4).map(|_| r.next_u64()).collect();
        assert!(values.iter().any(|&v| v != 0));
    }

    #[test]
    fn exponential_draws_average_out() {
        let mut r = Rng::new(1);
        let n = 20_000;
        let mean: f64 = (0..n).map(|_| r.exponential(10.0)).sum::<f64>() / n as f64;
        assert!((mean - 10.0).abs() < 0.5, "mean was {mean}");
        assert!((0..1000).map(|_| r.exponential(10.0)).all(|v| v >= 0.0));
    }

    #[test]
    fn indices_stay_in_range() {
        let mut r = Rng::new(3);
        assert!((0..1000).map(|_| r.below(5)).all(|i| i < 5));
        assert_eq!(r.below(1), 0);
        assert_eq!(r.below(0), 0);
    }
}
