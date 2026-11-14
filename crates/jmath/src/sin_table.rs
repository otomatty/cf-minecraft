//! Java float trigonometry using a deterministic 65,536-entry sine table.

use std::sync::LazyLock;

/// Initialized once with StrictMath arithmetic; never uses the host libm.
pub static SIN: LazyLock<[f32; 65536]> = LazyLock::new(|| {
    std::array::from_fn(|i| {
        // Preserve Java's left-to-right double evaluation before the float cast.
        crate::strict_math::sin(i as f64 * std::f64::consts::PI * 2.0 / 65536.0) as f32
    })
});

/// Rust's float-to-int cast matches Java: truncate toward zero, saturate on
/// overflow, and convert NaN to zero. Every arithmetic operation here is f32.
#[inline]
pub fn sin(x: f32) -> f32 {
    SIN[((x * 10430.378_f32) as i32 & 65535) as usize]
}

#[inline]
pub fn cos(x: f32) -> f32 {
    SIN[((x * 10430.378_f32 + 16384.0_f32) as i32 & 65535) as usize]
}
