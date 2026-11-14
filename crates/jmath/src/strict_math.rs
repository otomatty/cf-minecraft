//! Java `StrictMath`, using fdlibm 5.3 arithmetic and evaluation order.
//!
//! Sources: <https://netlib.org/fdlibm/> and the Java SE StrictMath specification.
//! Mechanical Rust transcription adapted from rust-lang/libm commit
//! a0a5bd85c913fe5f6c42bc11ef292e575f97ca6d (Sun notices in each source).
//! The later msun polynomial/reduction changes are restored to fdlibm 5.3.
//! No fused operations, platform libm calls, or floating exception flags.
/* Rust transcription portions from rust-lang/libm:
Copyright (c) 2018 Jorge Aparicio

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
// Reference constants, variable declarations, and indexed loops deliberately
// follow the published code. x-x and 0/0 preserve its NaN handling.
#![allow(
    clippy::excessive_precision,
    clippy::approx_constant,
    clippy::needless_range_loop,
    clippy::needless_late_init,
    clippy::eq_op,
    clippy::explicit_counter_loop
)]

macro_rules! i {
    ($a:ident, $index:expr) => { $a[$index] };
    ($a:ident, $index:expr, $op:tt, $value:expr) => { $a[$index] $op $value };
}

mod acos;
mod asin;
mod atan;
mod atan2;
mod cos;
mod exp;
mod fabs;
mod floor;
mod k_cos;
mod k_sin;
mod k_tan;
mod log;
mod log10;
mod pow;
mod rem_pio2;
mod rem_pio2_large;
mod scalbn;
mod sin;
mod tan;

pub use self::{
    acos::acos, asin::asin, atan::atan, atan2::atan2, cos::cos, exp::exp, log::log, log10::log10,
    pow::pow, sin::sin, tan::tan,
};
use self::{
    fabs::fabs, floor::floor, k_cos::k_cos, k_sin::k_sin, k_tan::k_tan, rem_pio2::rem_pio2,
    rem_pio2_large::rem_pio2_large, scalbn::scalbn,
};

#[inline]
fn get_high_word(x: f64) -> u32 {
    (x.to_bits() >> 32) as u32
}
#[inline]
fn get_low_word(x: f64) -> u32 {
    x.to_bits() as u32
}
#[inline]
fn with_set_high_word(x: f64, high: u32) -> f64 {
    f64::from_bits(((high as u64) << 32) | (x.to_bits() & 0xffff_ffff))
}
#[inline]
fn with_set_low_word(x: f64, low: u32) -> f64 {
    f64::from_bits((x.to_bits() & 0xffff_ffff_0000_0000) | low as u64)
}
#[inline]
fn sqrt(x: f64) -> f64 {
    x.sqrt()
}
