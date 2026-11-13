// origin: FreeBSD /usr/src/lib/msun/src/e_rem_pio2.c
//
// ====================================================
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//
// Developed at SunPro, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================
//
// Optimized by Bruce D. Evans. */
use super::rem_pio2_large;

/// 53 bits of 2/pi
const INV_PIO2: f64 = 6.36619772367581382433e-01; /* 0x3FE45F30, 0x6DC9C883 */
/// first 33 bits of pi/2
const PIO2_1: f64 = 1.57079632673412561417e+00; /* 0x3FF921FB, 0x54400000 */
/// pi/2 - PIO2_1
const PIO2_1T: f64 = 6.07710050650619224932e-11; /* 0x3DD0B461, 0x1A626331 */
/// second 33 bits of pi/2
const PIO2_2: f64 = 6.07710050630396597660e-11; /* 0x3DD0B461, 0x1A600000 */
/// pi/2 - (PIO2_1+PIO2_2)
const PIO2_2T: f64 = 2.02226624879595063154e-21; /* 0x3BA3198A, 0x2E037073 */
/// third 33 bits of pi/2
const PIO2_3: f64 = 2.02226624871116645580e-21; /* 0x3BA3198A, 0x2E000000 */
/// pi/2 - (PIO2_1+PIO2_2+PIO2_3)
const PIO2_3T: f64 = 8.47842766036889956997e-32; /* 0x397B839A, 0x252049C1 */

// fdlibm 5.3 __ieee754_rem_pio2. The large reduction uses 24-bit
// chunks and the shared 2/pi table; it works for all finite binary64 inputs.
pub(super) fn rem_pio2(x: f64) -> (i32, f64, f64) {
    const NPIO2_HW: [u32; 32] = [
        0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB,
        0x402921FB, 0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C, 0x40346B9C, 0x4035FDBB,
        0x40378FDB, 0x403921FB, 0x403AB41B, 0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C,
        0x4041475C, 0x4042106C, 0x4042D97C, 0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB,
        0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB,
    ];
    let x1p24 = 16777216.0;
    let sign = (x.to_bits() >> 63) as i32;
    let ix = super::get_high_word(x) & 0x7fffffff;
    if ix <= 0x3fe921fb {
        return (0, x, 0.0);
    }
    if ix < 0x4002d97c {
        let (n, z, tail) = if sign == 0 {
            let z = x - PIO2_1;
            if ix != 0x3ff921fb {
                (1, z, PIO2_1T)
            } else {
                (1, z - PIO2_2, PIO2_2T)
            }
        } else {
            let z = x + PIO2_1;
            if ix != 0x3ff921fb {
                (-1, z, -PIO2_1T)
            } else {
                (-1, z + PIO2_2, -PIO2_2T)
            }
        };
        let y0 = z - tail;
        return (n, y0, (z - y0) - tail);
    }
    if ix <= 0x413921fb {
        let t = super::fabs(x);
        let n = (t * INV_PIO2 + 0.5) as i32;
        let fn_ = n as f64;
        let mut r = t - fn_ * PIO2_1;
        let mut w = fn_ * PIO2_1T;
        let mut y0 = r - w;
        if n >= 32 || ix == NPIO2_HW[n as usize - 1] {
            let j = (ix >> 20) as i32;
            let i = j - ((super::get_high_word(y0) >> 20) & 0x7ff) as i32;
            if i > 16 {
                let t = r;
                w = fn_ * PIO2_2;
                r = t - w;
                w = fn_ * PIO2_2T - ((t - r) - w);
                y0 = r - w;
                let i = j - ((super::get_high_word(y0) >> 20) & 0x7ff) as i32;
                if i > 49 {
                    let t = r;
                    w = fn_ * PIO2_3;
                    r = t - w;
                    w = fn_ * PIO2_3T - ((t - r) - w);
                    y0 = r - w;
                }
            }
        }
        let y1 = (r - y0) - w;
        return if sign != 0 {
            (-n, -y0, -y1)
        } else {
            (n, y0, y1)
        };
    }
    /*
     * all other (large) arguments
     */
    if ix >= 0x7ff00000 {
        /* x is inf or NaN */
        let y0 = x - x;
        let y1 = y0;
        return (0, y0, y1);
    }
    /* set z = scalbn(|x|,-ilogb(x)+23) */
    let mut ui = f64::to_bits(x);
    ui &= (!1) >> 12;
    ui |= (0x3ff + 23) << 52;
    let mut z = f64::from_bits(ui);
    let mut tx = [0.0; 3];
    for i in 0..2 {
        tx[i] = z as i32 as f64;
        z = (z - tx[i]) * x1p24;
    }
    tx[2] = z;
    /* skip zero terms, first term is non-zero */
    let mut i = 2;
    while i != 0 && tx[i] == 0.0 {
        i -= 1;
    }
    let mut ty = [0.0; 3];
    // fdlibm requests extended (prec=2) reduction before rounding to binary64.
    let n = rem_pio2_large(&tx[..=i], &mut ty, ((ix as i32) >> 20) - (0x3ff + 23), 2);
    if sign != 0 {
        return (-n, -ty[0], -ty[1]);
    }
    (n, ty[0], ty[1])
}
