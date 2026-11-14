// origin: FreeBSD /usr/src/lib/msun/src/k_cos.c
//
// ====================================================
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================

const C1: f64 = 4.16666666666666019037e-02; /* 0x3FA55555, 0x5555554C */
const C2: f64 = -1.38888888888741095749e-03; /* 0xBF56C16C, 0x16C15177 */
const C3: f64 = 2.48015872894767294178e-05; /* 0x3EFA01A0, 0x19CB1590 */
const C4: f64 = -2.75573143513906633035e-07; /* 0xBE927E4F, 0x809C52AD */
const C5: f64 = 2.08757232129817482790e-09; /* 0x3E21EE9E, 0xBDB4B1C4 */
const C6: f64 = -1.13596475577881948265e-11; /* 0xBDA8FAE9, 0xBE8838D4 */

// kernel cos function on [-pi/4, pi/4], pi/4 ~ 0.785398164
// Input x is assumed to be bounded by ~pi/4 in magnitude.
// Input y is the tail of x.
//
// Algorithm
//      1. Since cos(-x) = cos(x), we need only to consider positive x.
//      2. if x < 2^-27 (hx<0x3e400000 0), return 1 with inexact if x!=0.
//      3. cos(x) is approximated by a polynomial of degree 14 on
//         [0,pi/4]
//                                       4            14
//              cos(x) ~ 1 - x*x/2 + C1*x + ... + C6*x
//         where the remez error is
//
//      |              2     4     6     8     10    12     14 |     -58
//      |cos(x)-(1-.5*x +C1*x +C2*x +C3*x +C4*x +C5*x  +C6*x  )| <= 2
//      |                                                      |
//
//                     4     6     8     10    12     14
//      4. let r = C1*x +C2*x +C3*x +C4*x +C5*x  +C6*x  , then
//             cos(x) ~ 1 - x*x/2 + r
//         since cos(x+y) ~ cos(x) - sin(x)*y
//                        ~ cos(x) - x*y,
//         a correction term is necessary in cos(x) and hence
//              cos(x+y) = 1 - (x*x/2 - (r - x*y))
//         fdlibm splits off qx = |x|/4 (with a zero low word) for
//         |x| >= 0.3, or qx = 0.28125 for |x| > 0.78125. Then
//         (1-qx) - ((x*x/2-qx) - (r-x*y)) avoids cancellation.
pub(crate) fn k_cos(x: f64, y: f64) -> f64 {
    let ix = super::get_high_word(x) & 0x7fffffff;
    if ix < 0x3e400000 {
        return 1.0;
    }
    let z = x * x;
    let r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    if ix < 0x3fd33333 {
        1.0 - (0.5 * z - (z * r - x * y))
    } else {
        let qx = if ix > 0x3fe90000 {
            0.28125
        } else {
            f64::from_bits(((ix - 0x00200000) as u64) << 32)
        };
        let hz = 0.5 * z - qx;
        let a = 1.0 - qx;
        a - (hz - (z * r - x * y))
    }
}
