//! Original seeded gradient lattice noise, independent of terrain generation.
//! Arithmetic uses only IEEE-754 operations and floor; no fused operations.
use jmath::Xoroshiro128PlusPlus;

/// A seed-shuffled 256-cell lattice, periodic on every axis.
#[derive(Clone, Debug)]
pub struct GradientNoise {
    permutation: [u8; 256],
}

impl GradientNoise {
    pub fn new(seed: i64) -> Self {
        let mut rng = Xoroshiro128PlusPlus::from_seed(seed);
        let mut permutation = std::array::from_fn(|i| i as u8);
        for i in (1..256).rev() {
            let bound = (i + 1) as u64;
            // Rejection sampling avoids bias when the bound does not divide 2^64.
            let threshold = bound.wrapping_neg() % bound;
            let j = loop {
                let bits = rng.next_long() as u64;
                if bits >= threshold {
                    break (bits % bound) as usize;
                }
            };
            permutation.swap(i, j);
        }
        Self { permutation }
    }

    fn hash(&self, x: usize, y: usize, z: usize) -> usize {
        let p = &self.permutation;
        p[(p[(p[x & 255] as usize + y) & 255] as usize + z) & 255] as usize
    }

    /// Eight gradients: four axes and four diagonals of L1 length one.
    /// Finite coordinates with |coordinate| < 2^52 retain subcell precision.
    /// Values are in [-1, 1], and zero at all lattice points.
    pub fn sample2(&self, x: f64, y: f64) -> f64 {
        const G: [[f64; 2]; 8] = [
            [1.0, 0.0],
            [-1.0, 0.0],
            [0.0, 1.0],
            [0.0, -1.0],
            [0.5, 0.5],
            [-0.5, 0.5],
            [0.5, -0.5],
            [-0.5, -0.5],
        ];
        let (ix, x) = lattice(x);
        let (iy, y) = lattice(y);
        let dot = |dx: usize, dy: usize| {
            let g = G[self.hash(ix + dx, iy + dy, 0) % G.len()];
            g[0] * (x - dx as f64) + g[1] * (y - dy as f64)
        };
        let u = fade(x);
        let v = fade(y);
        lerp(
            v,
            lerp(u, dot(0, 0), dot(1, 0)),
            lerp(u, dot(0, 1), dot(1, 1)),
        )
    }

    /// Twelve edge gradients of L1 length one; range [-1, 1].
    pub fn sample3(&self, x: f64, y: f64, z: f64) -> f64 {
        const G: [[f64; 3]; 12] = [
            [0.5, 0.5, 0.0],
            [-0.5, 0.5, 0.0],
            [0.5, -0.5, 0.0],
            [-0.5, -0.5, 0.0],
            [0.5, 0.0, 0.5],
            [-0.5, 0.0, 0.5],
            [0.5, 0.0, -0.5],
            [-0.5, 0.0, -0.5],
            [0.0, 0.5, 0.5],
            [0.0, -0.5, 0.5],
            [0.0, 0.5, -0.5],
            [0.0, -0.5, -0.5],
        ];
        let (ix, x) = lattice(x);
        let (iy, y) = lattice(y);
        let (iz, z) = lattice(z);
        let dot = |dx: usize, dy: usize, dz: usize| {
            let g = G[self.hash(ix + dx, iy + dy, iz + dz) % G.len()];
            g[0] * (x - dx as f64) + g[1] * (y - dy as f64) + g[2] * (z - dz as f64)
        };
        let u = fade(x);
        let v = fade(y);
        let w = fade(z);
        let plane = |dz| {
            lerp(
                v,
                lerp(u, dot(0, 0, dz), dot(1, 0, dz)),
                lerp(u, dot(0, 1, dz), dot(1, 1, dz)),
            )
        };
        lerp(w, plane(0), plane(1))
    }
}

fn lattice(x: f64) -> (usize, f64) {
    let cell = x.floor();
    // Reduce before converting to integer, including for negative coordinates.
    ((cell - (cell / 256.0).floor() * 256.0) as usize, x - cell)
}
fn fade(t: f64) -> f64 {
    // Quintic smoothstep: zero first/second derivatives at both cell boundaries.
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}
fn lerp(t: f64, a: f64, b: f64) -> f64 {
    a + t * (b - a)
}

#[derive(Clone, Debug)]
struct Octave {
    noise: GradientNoise,
    offset: [f64; 3],
}
impl Octave {
    fn sample2(&self, x: f64, y: f64) -> f64 {
        self.noise.sample2(x + self.offset[0], y + self.offset[1])
    }
    fn sample3(&self, x: f64, y: f64, z: f64) -> f64 {
        self.noise
            .sample3(x + self.offset[0], y + self.offset[1], z + self.offset[2])
    }
}

/// Normalized fBm with independently seeded and translated octave lattices.
#[derive(Clone, Debug)]
pub struct Fbm {
    octaves: Vec<Octave>,
    lacunarity: f64,
    persistence: f64,
}
impl Fbm {
    /// Panics unless octaves is 1..=32, lacunarity is finite and >= 1,
    /// and persistence is in 0..=1. Coordinates are already in base frequency units.
    pub fn new(seed: i64, octaves: u8, lacunarity: f64, persistence: f64) -> Self {
        assert!((1..=32).contains(&octaves), "octaves must be 1..=32");
        assert!(
            lacunarity.is_finite() && lacunarity >= 1.0,
            "lacunarity must be finite and >= 1"
        );
        assert!(
            (0.0..=1.0).contains(&persistence),
            "persistence must be 0..=1"
        );
        let mut rng = Xoroshiro128PlusPlus::from_seed(seed);
        let octaves = (0..octaves)
            .map(|_| {
                let noise = GradientNoise::new(rng.next_long());
                let offset = std::array::from_fn(|_| {
                    let bits = rng.next_long() as u64;
                    // Exact binary fractions in [1/8, 5/8), at least 16 lattice periods away.
                    4096.0
                        + (bits & 0xffff) as f64
                        + 0.125
                        + ((bits >> 16) & 0xffff) as f64 / 131072.0
                });
                Octave { noise, offset }
            })
            .collect();
        Self {
            octaves,
            lacunarity,
            persistence,
        }
    }
    fn sum(&self, mut sample: impl FnMut(&Octave, f64) -> f64) -> f64 {
        let (mut frequency, mut amplitude, mut total, mut weight) = (1.0, 1.0, 0.0, 0.0);
        for octave in &self.octaves {
            total += amplitude * sample(octave, frequency);
            weight += amplitude;
            frequency *= self.lacunarity;
            amplitude *= self.persistence;
        }
        total / weight
    }
    pub fn sample2(&self, x: f64, y: f64) -> f64 {
        self.sum(|octave, f| octave.sample2(x * f, y * f))
    }
    pub fn sample3(&self, x: f64, y: f64, z: f64) -> f64 {
        self.sum(|octave, f| octave.sample3(x * f, y * f, z * f))
    }
}

/// Cross-host FNV-1a fingerprint of raw f64 bits, separate from the world scenario.
/// Covers two seeds, both dimensions, negative/boundary coordinates and fBm.
pub fn fingerprint(seed: i64) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for seed in [seed, seed.wrapping_add(1)] {
        let noise = GradientNoise::new(seed);
        let fbm = Fbm::new(seed, 5, 1.9, 0.55);
        for i in -128..128 {
            let x = i as f64 * 0.137;
            let y = (i * i - 71) as f64 * 0.019;
            let z = i as f64 * -0.317 + 0.5;
            for value in [
                noise.sample2(x, y),
                noise.sample3(x, y, z),
                fbm.sample2(x, y),
                fbm.sample3(x, y, z),
            ] {
                for byte in value.to_bits().to_le_bytes() {
                    hash ^= byte as u64;
                    hash = hash.wrapping_mul(0x100000001b3);
                }
            }
        }
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_reference_bits() {
        // Captured on native before adding WASM host comparison.
        let vectors: [(i64, [f64; 3], [u64; 4]); 9] = [
            (
                0,
                [0.125, 0.25, 0.5],
                [
                    0xbfc05598d0000000,
                    0xbfc36ce538000000,
                    0xbf87ab24f76f5204,
                    0xbfc1d51a322b22ab,
                ],
            ),
            (
                0,
                [-13.37, 4.125, -0.01],
                [
                    0x3f916c6359537146,
                    0xbfd15bcfe039f1d1,
                    0x3fad4b8a01c25193,
                    0x3fa51b8ebeb20f63,
                ],
            ),
            (
                0,
                [255.999, 256.001, -256.5],
                [
                    0x3da5fd531a54b200,
                    0x3fbfef9d9767a72e,
                    0xbfcbf7ca8ce5914e,
                    0xbfa9ad6c6b2d4900,
                ],
            ),
            (
                2026,
                [0.125, 0.25, 0.5],
                [
                    0x3fb7468d00000000,
                    0x3fbdac1fd0000000,
                    0x3f97892bc882e4ce,
                    0x3fb935724e2c9b15,
                ],
            ),
            (
                2026,
                [-13.37, 4.125, -0.01],
                [
                    0x3fd01748eed4c28a,
                    0x3fb08ff4a1c09686,
                    0x3fc41b3eb5e4e6dc,
                    0xbfbfdf412e8bfb01,
                ],
            ),
            (
                2026,
                [255.999, 256.001, -256.5],
                [
                    0xbf506258835e66ed,
                    0xbfbfced936b6a426,
                    0x3fbb8191480165cd,
                    0xbf96f3b9f4d4e617,
                ],
            ),
            (
                -71,
                [0.125, 0.25, 0.5],
                [
                    0xbfb1ff47e0000000,
                    0x3fac94f5c0000000,
                    0x3fc09fc6a784c098,
                    0xbf9ed95267f99e52,
                ],
            ),
            (
                -71,
                [-13.37, 4.125, -0.01],
                [
                    0xbfd20441f24105c2,
                    0xbfa2996ed7f39de4,
                    0x3f8153d3b5a49c6e,
                    0x3fa278bc9302ee83,
                ],
            ),
            (
                -71,
                [255.999, 256.001, -256.5],
                [
                    0x3f506253244ba404,
                    0x3f40625327094400,
                    0x3fc59a39536f75fd,
                    0xbf804a2bd2a1153a,
                ],
            ),
        ];
        for (seed, [x, y, z], expected) in vectors {
            let n = GradientNoise::new(seed);
            let f = Fbm::new(seed, 5, 1.9, 0.55);
            assert_eq!(
                [
                    n.sample2(x, y),
                    n.sample3(x, y, z),
                    f.sample2(x, y),
                    f.sample3(x, y, z)
                ]
                .map(f64::to_bits),
                expected
            );
        }
        assert_eq!(fingerprint(2026), 0xd5166400c68a1c45);
    }
    #[test]
    fn range_lattice_continuity_and_seeds() {
        for seed in [0, 2026, -793, i64::MIN] {
            let n = GradientNoise::new(seed);
            let f = Fbm::new(seed, 6, 2.0, 0.5);
            for i in -100..100 {
                let x = i as f64 * 0.163;
                let y = i as f64 * -0.317;
                let z = i as f64 * 0.713;
                for value in [
                    n.sample2(x, y),
                    n.sample3(x, y, z),
                    f.sample2(x, y),
                    f.sample3(x, y, z),
                ] {
                    assert!((-1.0..=1.0).contains(&value));
                }
                assert_eq!(n.sample2(i as f64, -3.0), 0.0);
                assert_eq!(n.sample3(i as f64, -3.0, 5.0), 0.0);
                for x in [x, i as f64] {
                    assert!((n.sample2(x - 1e-7, y) - n.sample2(x + 1e-7, y)).abs() < 1e-5);
                    assert!((n.sample3(x, y - 1e-7, z) - n.sample3(x, y + 1e-7, z)).abs() < 1e-5);
                    assert!((n.sample3(x, y, z - 1e-7) - n.sample3(x, y, z + 1e-7)).abs() < 1e-5);
                }
            }
        }
        assert_ne!(fingerprint(2026), fingerprint(2027));
        assert_eq!(fingerprint(2026), fingerprint(2026));
    }
    #[test]
    fn fbm_integer_coordinates_are_not_locked_to_zero() {
        for seed in [0, 2026, -793, i64::MIN] {
            let f = Fbm::new(seed, 6, 2.0, 0.5);
            for [x, y, z] in [
                [0.0, 0.0, 0.0],
                [1.0, 2.0, 3.0],
                [-7.0, -13.0, -29.0],
                [256.0, -256.0, 512.0],
            ] {
                assert!(f.sample2(x, y).abs() > 1e-8, "2D seed={seed}, ({x}, {y})");
                assert!(
                    f.sample3(x, y, z).abs() > 1e-8,
                    "3D seed={seed}, ({x}, {y}, {z})"
                );
            }
        }
    }

    #[test]
    fn octave_lattices_and_samples_are_independent_at_equal_frequency() {
        for seed in [0, 2026, -793, i64::MIN] {
            let f = Fbm::new(seed, 8, 2.0, 0.5);
            for (i, a) in f.octaves.iter().enumerate() {
                for offset in a.offset {
                    assert!((4096.0..69632.0).contains(&offset));
                    assert!((0.125..0.625).contains(&(offset - offset.floor())));
                }
                for b in &f.octaves[i + 1..] {
                    assert_ne!(a.noise.permutation, b.noise.permutation);
                    assert_ne!(a.offset, b.offset);
                    // Same coordinates and frequency: isolate each octave's field.
                    for [x, y, z] in [[0.0, 0.0, 0.0], [-0.3, 1.7, 2.1]] {
                        assert_ne!(a.sample2(x, y).to_bits(), b.sample2(x, y).to_bits());
                        assert_ne!(a.sample3(x, y, z).to_bits(), b.sample3(x, y, z).to_bits());
                    }
                }
            }
        }
    }

    #[test]
    fn fbm_one_octave_and_zero_persistence() {
        let one = Fbm::new(71, 1, 2.0, 0.5);
        let n = &one.octaves[0];
        for f in [one.clone(), Fbm::new(71, 8, 2.0, 0.0)] {
            assert_eq!(f.sample2(-0.3, 1.7), n.sample2(-0.3, 1.7));
            assert_eq!(f.sample3(-0.3, 1.7, 2.1), n.sample3(-0.3, 1.7, 2.1));
        }
    }
}
