//! `java.util.Random`: the 48-bit linear congruential generator.
//!
//! Verified against a real JDK, see `tests/jdk_vectors.rs`.

const MULTIPLIER: i64 = 0x5_DEEC_E66D;
const ADDEND: i64 = 0xB;
const MASK: i64 = (1 << 48) - 1;
const DOUBLE_UNIT: f64 = 1.0 / ((1u64 << 53) as f64);
const FLOAT_UNIT: f32 = 1.0 / ((1u32 << 24) as f32);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JavaRandom {
    seed: i64,
    // Store raw bits to retain the existing Eq implementation.
    next_next_gaussian: Option<u64>,
}

impl JavaRandom {
    pub fn new(seed: i64) -> Self {
        Self {
            seed: (seed ^ MULTIPLIER) & MASK,
            next_next_gaussian: None,
        }
    }

    pub fn set_seed(&mut self, seed: i64) {
        self.seed = (seed ^ MULTIPLIER) & MASK;
        self.next_next_gaussian = None;
    }

    /// `Random.next(int bits)`.
    #[inline]
    pub fn next(&mut self, bits: u32) -> i32 {
        self.seed = self.seed.wrapping_mul(MULTIPLIER).wrapping_add(ADDEND) & MASK;
        (self.seed >> (48 - bits)) as i32
    }

    #[inline]
    pub fn next_int(&mut self) -> i32 {
        self.next(32)
    }

    /// `Random.nextInt(int bound)`. Panics when `bound <= 0`, where Java throws.
    pub fn next_int_bound(&mut self, bound: i32) -> i32 {
        assert!(bound > 0, "bound must be positive");
        let mut r = self.next(31);
        let m = bound - 1;
        if bound & m == 0 {
            return ((bound as i64).wrapping_mul(r as i64) >> 31) as i32;
        }
        let mut u = r;
        loop {
            r = u % bound;
            if u.wrapping_sub(r).wrapping_add(m) >= 0 {
                return r;
            }
            u = self.next(31);
        }
    }

    /// `Random.nextGaussian()`: polar Box–Muller with a cached second sample.
    /// `set_seed` discards the cache, just as `Random.setSeed` does.
    pub fn next_gaussian(&mut self) -> f64 {
        if let Some(bits) = self.next_next_gaussian.take() {
            return f64::from_bits(bits);
        }
        loop {
            let v1 = 2.0 * self.next_double() - 1.0;
            let v2 = 2.0 * self.next_double() - 1.0;
            let s = v1 * v1 + v2 * v2;
            if s >= 1.0 || s == 0.0 {
                continue;
            }
            let multiplier = (-2.0 * crate::strict_math::log(s) / s).sqrt();
            self.next_next_gaussian = Some((v2 * multiplier).to_bits());
            return v1 * multiplier;
        }
    }

    pub fn next_long(&mut self) -> i64 {
        let hi = (self.next(32) as i64) << 32;
        hi.wrapping_add(self.next(32) as i64)
    }

    pub fn next_boolean(&mut self) -> bool {
        self.next(1) != 0
    }

    pub fn next_float(&mut self) -> f32 {
        self.next(24) as f32 * FLOAT_UNIT
    }

    pub fn next_double(&mut self) -> f64 {
        let hi = (self.next(26) as i64) << 27;
        (hi + self.next(27) as i64) as f64 * DOUBLE_UNIT
    }
}
