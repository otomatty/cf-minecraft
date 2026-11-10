//! Java-compatible numerics.
//!
//! Everything in this crate must reproduce the JVM bit for bit: 32/64-bit
//! wrapping integer arithmetic, IEEE 754 floats without fused operations, and
//! the exact pseudo random sequences of the JDK.
//!
//! Rule for the whole core: never call `f64::sin`, `cos`, `ln`, `powf` and
//! friends. Natively they resolve to the platform libm, in WebAssembly to the
//! bundled one, and the two are not guaranteed to agree. Transcendental
//! functions get their own ports here (planned for M1).

pub mod java_random;
pub mod xoroshiro;

pub use java_random::JavaRandom;
pub use xoroshiro::{mix_stafford13, Xoroshiro128PlusPlus};
