//! Original cave fields, sampled on a world-aligned four-block lattice.
use jmath::mix_stafford13;
use noise::Fbm;
use world::{blocks, BlockState, Chunk, MIN_Y};

pub(crate) const CAVE_WATER_LEVEL: i32 = -41;
const STEP: i32 = 4;
const FLOOR: i32 = MIN_Y + 6;
const TUNNEL_RADIUS: f64 = 0.036;
const SALTS: [u64; 3] = [
    0x51ec_7a92_d304_b86f,
    0xb682_09fd_43ae_715c,
    0x3df0_c875_a169_2eb4,
];

pub(crate) struct Caves {
    fields: [Fbm; 3],
}

fn lerp(t: f64, a: f64, b: f64) -> f64 {
    a + t * (b - a)
}

fn replacement([a, b, c]: [f64; 3], y: i32, top: i32) -> Option<BlockState> {
    if y < FLOOR || y > top - 6 {
        return None;
    }
    // Chambers become rarer toward the surface; all values are original.
    let chamber_threshold = 0.25 + ((y + 56) as f64 / 160.0).clamp(0.0, 1.0) * 0.10;
    if a * a + b * b < TUNNEL_RADIUS * TUNNEL_RADIUS || c > chamber_threshold {
        Some(if y <= CAVE_WATER_LEVEL {
            blocks::WATER
        } else {
            blocks::AIR
        })
    } else {
        None
    }
}

impl Caves {
    pub(crate) fn new(seed: i64) -> Self {
        Self {
            fields: SALTS
                .map(|salt| Fbm::new(mix_stafford13(seed as u64 ^ salt) as i64, 1, 2.0, 0.5)),
        }
    }

    fn point(&self, x: i32, y: i32, z: i32) -> [f64; 3] {
        std::array::from_fn(|i| {
            let (xz_scale, y_scale) = if i == 2 { (37.0, 26.0) } else { (58.0, 29.0) };
            self.fields[i].sample3(x as f64 / xz_scale, y as f64 / y_scale, z as f64 / xz_scale)
        })
    }

    // Reference pure coordinate query: no chunk-local state or noise evaluated at blocks.
    #[cfg(test)]
    pub(crate) fn is_cave(&self, x: i32, y: i32, z: i32, top: i32) -> Option<BlockState> {
        if y < FLOOR || y > top - 6 {
            return None;
        }
        let [gx, gy, gz] = [x, y, z].map(|v| v.div_euclid(STEP) * STEP);
        let [tx, ty, tz] = [x - gx, y - gy, z - gz].map(|v| v as f64 / STEP as f64);
        let corners: [[f64; 3]; 8] = std::array::from_fn(|i| {
            self.point(
                gx + (i % 2) as i32 * STEP,
                gy + (i / 4) as i32 * STEP,
                gz + (i / 2 % 2) as i32 * STEP,
            )
        });
        replacement(
            std::array::from_fn(|i| {
                lerp(
                    ty,
                    lerp(
                        tz,
                        lerp(tx, corners[0][i], corners[1][i]),
                        lerp(tx, corners[2][i], corners[3][i]),
                    ),
                    lerp(
                        tz,
                        lerp(tx, corners[4][i], corners[5][i]),
                        lerp(tx, corners[6][i], corners[7][i]),
                    ),
                )
            }),
            y,
            top,
        )
    }

    pub(crate) fn carve(&self, chunk: &mut Chunk, cx: i32, cz: i32, heights: &[[i32; 18]; 18]) {
        let max_y = heights[1..17]
            .iter()
            .flat_map(|row| &row[1..17])
            .max()
            .unwrap()
            - 6;
        if max_y < FLOOR {
            return;
        }
        let base = FLOOR.div_euclid(STEP) * STEP;
        let count = ((max_y - base).div_euclid(STEP) + 2) as usize;
        let grid: Vec<[[f64; 3]; 25]> = (0..count)
            .map(|iy| {
                std::array::from_fn(|i| {
                    self.point(
                        cx * 16 + (i % 5) as i32 * STEP,
                        base + iy as i32 * STEP,
                        cz * 16 + (i / 5) as i32 * STEP,
                    )
                })
            })
            .collect();
        for z in 0..16 {
            for x in 0..16 {
                let top = heights[z + 1][x + 1];
                let corner = z / 4 * 5 + x / 4;
                let (tx, tz) = ((x % 4) as f64 / 4.0, (z % 4) as f64 / 4.0);
                let line: Vec<[f64; 3]> = grid
                    .iter()
                    .map(|plane| {
                        std::array::from_fn(|i| {
                            lerp(
                                tz,
                                lerp(tx, plane[corner][i], plane[corner + 1][i]),
                                lerp(tx, plane[corner + 5][i], plane[corner + 6][i]),
                            )
                        })
                    })
                    .collect();
                for y in FLOOR..=top - 6 {
                    let offset = (y - base) as usize;
                    let iy = offset / 4;
                    let values = std::array::from_fn(|i| {
                        lerp((offset % 4) as f64 / 4.0, line[iy][i], line[iy + 1][i])
                    });
                    if let Some(state) = replacement(values, y, top) {
                        let old = chunk.get(x, y, z);
                        if old != blocks::AIR && old != blocks::WATER {
                            chunk.set(x, y, z, state);
                        }
                    }
                }
            }
        }
    }
}
