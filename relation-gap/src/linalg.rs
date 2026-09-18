//! Dense f32 matrix primitives, row-major, no dependencies.
//!
//! The network is three layers of two `d × d` transforms per relation over
//! roughly 24,000 nodes, so these four routines are where essentially all of
//! the training time goes. They are written in the `axpy` form — accumulate a
//! scalar times a row into an output row — rather than the textbook
//! dot-product form, because that is the shape a compiler can turn into
//! straight-line SIMD over contiguous memory. The dot-product form reads more
//! naturally and runs several times slower.

/// A row-major `rows × cols` matrix.
#[derive(Clone, Debug)]
pub struct Mat {
    pub rows: usize,
    pub cols: usize,
    pub data: Vec<f32>,
}

impl Mat {
    pub fn zeros(rows: usize, cols: usize) -> Self {
        Mat { rows, cols, data: vec![0.0; rows * cols] }
    }

    #[inline]
    pub fn row(&self, i: usize) -> &[f32] {
        &self.data[i * self.cols..(i + 1) * self.cols]
    }

    #[inline]
    pub fn row_mut(&mut self, i: usize) -> &mut [f32] {
        let c = self.cols;
        &mut self.data[i * c..(i + 1) * c]
    }

}

/// `out += a · bᵀ`, where `a` is `m × k` and `b` is `n × k` (so `out` is `m × n`).
///
/// `b` is stored transposed relative to the mathematical product because every
/// weight matrix here is applied as `x · Wᵀ` — the row of `W` for output unit
/// `j` is then contiguous, which is what makes the inner loop a contiguous
/// accumulate.
pub fn matmul_bt_add(out: &mut Mat, a: &Mat, b: &Mat) {
    debug_assert_eq!(a.cols, b.cols);
    debug_assert_eq!(out.rows, a.rows);
    debug_assert_eq!(out.cols, b.rows);
    let k = a.cols;
    for i in 0..a.rows {
        let arow = &a.data[i * k..(i + 1) * k];
        let orow = &mut out.data[i * b.rows..(i + 1) * b.rows];
        for (j, orow_j) in orow.iter_mut().enumerate() {
            let brow = &b.data[j * k..(j + 1) * k];
            let mut acc = 0.0f32;
            for t in 0..k {
                acc += arow[t] * brow[t];
            }
            *orow_j += acc;
        }
    }
}

/// `out += a · b`, where `a` is `m × k` and `b` is `k × n`.
///
/// The `i, t, j` loop order keeps `b`'s row and `out`'s row contiguous in the
/// innermost loop while `a[i][t]` stays in a register.
pub fn matmul_add(out: &mut Mat, a: &Mat, b: &Mat) {
    debug_assert_eq!(a.cols, b.rows);
    debug_assert_eq!(out.rows, a.rows);
    debug_assert_eq!(out.cols, b.cols);
    let n = b.cols;
    let k = a.cols;
    for i in 0..a.rows {
        let arow = &a.data[i * k..(i + 1) * k];
        let orow = &mut out.data[i * n..(i + 1) * n];
        for t in 0..k {
            let scale = arow[t];
            if scale == 0.0 {
                continue;
            }
            let brow = &b.data[t * n..(t + 1) * n];
            for j in 0..n {
                orow[j] += scale * brow[j];
            }
        }
    }
}

/// `out += aᵀ · b`, where `a` is `m × p` and `b` is `m × q` (so `out` is `p × q`).
///
/// This is the weight-gradient shape: `p` and `q` are both the hidden width,
/// while `m` is the node count, so the result stays small however large the
/// graph is.
pub fn matmul_at_b_add(out: &mut Mat, a: &Mat, b: &Mat) {
    debug_assert_eq!(a.rows, b.rows);
    debug_assert_eq!(out.rows, a.cols);
    debug_assert_eq!(out.cols, b.cols);
    let p = a.cols;
    let q = b.cols;
    for i in 0..a.rows {
        let arow = &a.data[i * p..(i + 1) * p];
        let brow = &b.data[i * q..(i + 1) * q];
        for t in 0..p {
            let scale = arow[t];
            if scale == 0.0 {
                continue;
            }
            let orow = &mut out.data[t * q..(t + 1) * q];
            for j in 0..q {
                orow[j] += scale * brow[j];
            }
        }
    }
}

/// Adds `src`'s row `from` into `dst`'s row `to`. The scatter/gather step of
/// message passing, which is memory-bound rather than arithmetic-bound.
#[inline]
pub fn add_row(dst: &mut Mat, to: usize, src: &Mat, from: usize) {
    let c = dst.cols;
    debug_assert_eq!(c, src.cols);
    let (d, s) = (to * c, from * c);
    for j in 0..c {
        dst.data[d + j] += src.data[s + j];
    }
}

/// L2-normalises one row into `out`, returning the norm actually divided by.
///
/// The floor is not cosmetic: an all-zero embedding is reachable — three ReLUs
/// can kill every unit of a node the graph never reaches — and dividing by its
/// norm would put NaN into the weights on the next backward pass, from which
/// training never returns.
#[inline]
pub fn normalize_row(out: &mut [f32], src: &[f32]) -> f32 {
    let mut sum = 0.0f32;
    for v in src {
        sum += v * v;
    }
    let norm = sum.sqrt().max(1e-12);
    let inv = 1.0 / norm;
    for (o, s) in out.iter_mut().zip(src) {
        *o = s * inv;
    }
    norm
}

/// xorshift64*, so a run is reproducible from its seed on any machine.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        // A zero state is absorbing for xorshift; any nonzero constant avoids it.
        Rng(seed ^ 0x9E3779B97F4A7C15)
    }

    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }

    #[inline]
    pub fn next_f32(&mut self) -> f32 {
        // 24 bits is the full mantissa of an f32; taking the high bits keeps
        // the better-mixed end of the word.
        ((self.next_u64() >> 40) as f32) / ((1u32 << 24) as f32)
    }

    #[inline]
    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next_u64() % n as u64) as usize
        }
    }

    /// Box–Muller, used only to initialise embeddings the way `nn.Embedding` does.
    pub fn normal(&mut self) -> f32 {
        let u1 = self.next_f32().max(1e-7);
        let u2 = self.next_f32();
        (-2.0 * u1.ln()).sqrt() * (std::f32::consts::TAU * u2).cos()
    }
}
