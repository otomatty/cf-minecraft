//! Xoroshiro128++, the generator behind modern world generation.
//!
//! The state transition is verified against the JDK's own
//! `jdk.random.Xoroshiro128PlusPlus` (see `tests/jdk_vectors.rs`).
//! `from_seed` follows the publicly documented 64 -> 128 bit seed upgrade and
//! still has to be confirmed against the game itself (M2 oracle work).

const GOLDEN_RATIO_64: u64 = 0x9E37_79B9_7F4A_7C15;
const SILVER_RATIO_64: u64 = 0x6A09_E667_F3BC_C909;

/// Stafford variant 13 of the 64-bit finalizer.
#[inline]
pub fn mix_stafford13(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Xoroshiro128PlusPlus {
    lo: u64,
    hi: u64,
}

impl Xoroshiro128PlusPlus {
    /// Raw state. An all-zero state is replaced, as the reference does.
    pub fn from_state(lo: i64, hi: i64) -> Self {
        let (lo, hi) = (lo as u64, hi as u64);
        if lo | hi == 0 {
            Self {
                lo: GOLDEN_RATIO_64,
                hi: SILVER_RATIO_64,
            }
        } else {
            Self { lo, hi }
        }
    }

    /// 64-bit seed upgraded to 128 bits and mixed. UNVERIFIED against the game.
    pub fn from_seed(seed: i64) -> Self {
        let lo = seed as u64 ^ SILVER_RATIO_64;
        let hi = lo.wrapping_add(GOLDEN_RATIO_64);
        Self::from_state(mix_stafford13(lo) as i64, mix_stafford13(hi) as i64)
    }

    #[inline]
    pub fn next_long(&mut self) -> i64 {
        let s0 = self.lo;
        let mut s1 = self.hi;
        let result = s0.wrapping_add(s1).rotate_left(17).wrapping_add(s0);
        s1 ^= s0;
        self.lo = s0.rotate_left(49) ^ s1 ^ (s1 << 21);
        self.hi = s1.rotate_left(28);
        result as i64
    }
}
