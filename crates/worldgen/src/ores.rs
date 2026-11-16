//! Original, bounded mineral walks in world-aligned 16³ plots.
//! Descriptions depend only on the seed, species and plot, never the recipient.
use jmath::mix_stafford13;
use world::{blocks, BlockState, Chunk, HEIGHT, MIN_Y};

pub(crate) const MAX_VEIN_REACH: i32 = 3;
const PLOT_SIZE: i32 = 16;
const ORE_SALT: u64 = 0x73f1_a9b4_825c_de06;
const _: () = assert!(MAX_VEIN_REACH < PLOT_SIZE);

#[derive(Clone, Copy)]
struct Ore {
    state: BlockState,
    low: i32,
    high: i32,
    attempts: u64,
    size: [usize; 2],
}
const ORES: [Ore; 4] = [
    Ore {
        state: blocks::COAL_ORE,
        low: 0,
        high: 140,
        attempts: 9,
        size: [6, 14],
    },
    Ore {
        state: blocks::COPPER_ORE,
        low: -20,
        high: 70,
        attempts: 5,
        size: [5, 10],
    },
    Ore {
        state: blocks::IRON_ORE,
        low: -50,
        high: 50,
        attempts: 4,
        size: [4, 8],
    },
    Ore {
        state: blocks::GOLD_ORE,
        low: -60,
        high: -5,
        attempts: 2,
        size: [3, 6],
    },
];

fn next(rng: &mut u64) -> u64 {
    *rng = rng.wrapping_add(0x9e37_79b9_7f4a_7c15);
    mix_stafford13(*rng)
}

#[derive(Debug)]
struct Vein {
    center: [i32; 3],
    rng: u64,
    size: usize,
    state: BlockState,
}

impl Vein {
    fn blocks(&self, mut emit: impl FnMut(i32, i32, i32, BlockState)) {
        let mut rng = self.rng;
        let mut points = [[0i32; 3]; 14];
        let mut count = 1;
        let mut position = [0i32; 3];
        // Revisits are legal steps but do not count toward the requested volume.
        // A fixed budget also bounds runtime for a walk trapped in its own path.
        for _ in 0..256 {
            if count == self.size {
                break;
            }
            let direction = next(&mut rng) % 6;
            let axis = (direction / 2) as usize;
            let mut candidate = position;
            candidate[axis] += if direction & 1 == 0 { -1 } else { 1 };
            if candidate[axis].abs() > MAX_VEIN_REACH {
                continue;
            }
            position = candidate;
            if !points[..count].contains(&position) {
                points[count] = position;
                count += 1;
            }
        }
        for [dx, dy, dz] in &points[..count] {
            debug_assert!([dx, dy, dz].iter().all(|v| v.abs() <= MAX_VEIN_REACH));
            emit(
                self.center[0] + dx,
                self.center[1] + dy,
                self.center[2] + dz,
                self.state,
            );
        }
    }
}

fn veins(seed: i64, ore: Ore, qx: i32, qy: i32, qz: i32, mut emit: impl FnMut(Vein)) {
    let mut h = mix_stafford13(seed as u64 ^ ORE_SALT ^ u64::from(ore.state));
    for (coordinate, salt) in [
        (qx, 0x9e37_79b9_7f4a_7c15u64),
        (qy, 0xd1b5_4a32_d192_ed03),
        (qz, 0xc2b2_ae3d_27d4_eb4f),
    ] {
        h = mix_stafford13(h ^ (coordinate as u64).wrapping_mul(salt));
    }
    for _ in 0..ore.attempts {
        let offsets = next(&mut h);
        let center = [
            qx * 16 + (offsets & 15) as i32,
            MIN_Y + qy * 16 + ((offsets >> 4) & 15) as i32,
            qz * 16 + ((offsets >> 8) & 15) as i32,
        ];
        let roll = next(&mut h);
        let shape = next(&mut h);
        if !(ore.low..=ore.high).contains(&center[1]) {
            continue;
        }
        // A triangular peak with a 35% floor: fewer veins near either endpoint.
        let span = ore.high - ore.low;
        let triangle = span - (2 * center[1] - ore.low - ore.high).abs();
        let probability = 0.35 + 0.65 * f64::from(triangle) / f64::from(span);
        if (roll >> 11) as f64 * (1.0 / (1u64 << 53) as f64) >= probability {
            continue;
        }
        emit(Vein {
            center,
            rng: shape,
            size: ore.size[0] + (shape % (ore.size[1] - ore.size[0] + 1) as u64) as usize,
            state: ore.state,
        });
    }
}

fn visit(seed: i64, cx: i32, cz: i32, mut emit: impl FnMut(i32, i32, i32, BlockState)) {
    for ore in ORES {
        for qy in (ore.low - MIN_Y).div_euclid(16)..=(ore.high - MIN_Y).div_euclid(16) {
            for qz in cz - 1..=cz + 1 {
                for qx in cx - 1..=cx + 1 {
                    veins(seed, ore, qx, qy, qz, |vein| {
                        let x = vein.center[0] - cx * 16;
                        let z = vein.center[2] - cz * 16;
                        if (-MAX_VEIN_REACH..16 + MAX_VEIN_REACH).contains(&x)
                            && (-MAX_VEIN_REACH..16 + MAX_VEIN_REACH).contains(&z)
                        {
                            vein.blocks(&mut emit);
                        }
                    });
                }
            }
        }
    }
}

// All proposals are resolved before writing, so even existing ores are never
// replacement targets. Zero means no proposal; lower registry IDs win ties.
fn propose(winner: &mut u8, state: BlockState) {
    let state = state as u8;
    if *winner == 0 || state < *winner {
        *winner = state;
    }
}

pub(crate) fn place(seed: i64, chunk: &mut Chunk, cx: i32, cz: i32) {
    let mut winners = vec![0u8; HEIGHT as usize * 256];
    let mut touched = Vec::new();
    visit(seed, cx, cz, |x, y, z, state| {
        let (x, z) = (x - cx * 16, z - cz * 16);
        if !(0..16).contains(&x) || !(0..16).contains(&z) || !(MIN_Y..MIN_Y + HEIGHT).contains(&y) {
            return;
        }
        if chunk.get(x as usize, y, z as usize) != blocks::STONE {
            return;
        }
        let index = (y - MIN_Y) as usize * 256 + z as usize * 16 + x as usize;
        if winners[index] == 0 {
            touched.push(index);
        }
        propose(&mut winners[index], state);
    });
    for i in touched {
        chunk.set(
            i % 16,
            MIN_Y + (i / 256) as i32,
            i / 16 % 16,
            BlockState::from(winners[i]),
        );
    }
}

#[cfg(test)]
fn plot_blocks(seed: i64, qx: i32, qy: i32, qz: i32) -> Vec<(i32, i32, i32, BlockState)> {
    let mut result = Vec::new();
    for ore in ORES {
        veins(seed, ore, qx, qy, qz, |v| {
            v.blocks(|x, y, z, s| result.push((x, y, z, s)))
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TerrainGenerator;
    use std::collections::BTreeMap;

    #[test]
    fn plots_match_chunks_in_both_orders_and_only_replace_original_stone() {
        let mut crossed = 0;
        let mut overlaps = 0;
        let mut changed = 0;
        for seed in [2026, 0, -71] {
            let t = TerrainGenerator::new(seed);
            let mut proposals = BTreeMap::new();
            // A whole extra chunk halo, independent of production center culling.
            for qz in -2..=2 {
                for qx in -2..=2 {
                    for qy in 0..HEIGHT / 16 {
                        for (x, y, z, state) in plot_blocks(seed, qx, qy, qz).into_iter().rev() {
                            if !(-16..32).contains(&x) || !(-16..32).contains(&z) {
                                continue;
                            }
                            crossed +=
                                usize::from(x.div_euclid(16) != qx || z.div_euclid(16) != qz);
                            let old = proposals.entry((x, y, z)).or_insert(state);
                            overlaps += usize::from(*old != state);
                            *old = (*old).min(state);
                        }
                    }
                }
            }
            let mut generated = Vec::new();
            for cz in -1..=1 {
                for cx in -1..=1 {
                    let before = t.generate_features(cx, cz, true, true, false);
                    let actual = t.generate(cx, cz);
                    for y in MIN_Y..MIN_Y + HEIGHT {
                        for z in 0..16 {
                            for x in 0..16 {
                                let original = before.get(x, y, z);
                                let expected = if original == blocks::STONE {
                                    proposals
                                        .get(&(cx * 16 + x as i32, y, cz * 16 + z as i32))
                                        .copied()
                                        .unwrap_or(original)
                                } else {
                                    original
                                };
                                assert_eq!(
                                    actual.get(x, y, z),
                                    expected,
                                    "seed={seed} at {cx},{cz}/{x},{y},{z}"
                                );
                                changed += usize::from(expected != original);
                            }
                        }
                    }
                    generated.push((cx, cz, actual));
                }
            }
            for (cx, cz, actual) in generated.into_iter().rev() {
                assert_eq!(actual, t.generate(cx, cz));
            }
        }
        assert!(crossed > 100 && overlaps > 0 && changed > 1000);
    }

    #[test]
    fn conflict_resolution_is_commutative_and_non_stone_is_protected() {
        let mut ascending = 0;
        let mut descending = 0;
        for ore in ORES {
            propose(&mut ascending, ore.state);
        }
        for ore in ORES.into_iter().rev() {
            propose(&mut descending, ore.state);
        }
        assert_eq!(ascending, blocks::COAL_ORE as u8);
        assert_eq!(ascending, descending);
        let t = TerrainGenerator::new(2026);
        let mut chunk = t.generate_features(0, 0, false, true, false);
        let protected = [
            blocks::AIR,
            blocks::WATER,
            blocks::DIRT,
            blocks::BEDROCK,
            blocks::SANDSTONE,
            blocks::GRAVEL,
            blocks::COAL_ORE,
            blocks::GOLD_ORE,
        ];
        let mut positions = Vec::new();
        visit(2026, 0, 0, |x, y, z, _| {
            if (0..16).contains(&x) && (0..16).contains(&z) && (MIN_Y..MIN_Y + HEIGHT).contains(&y)
            {
                positions.push((x as usize, y, z as usize));
            }
        });
        positions.sort_unstable();
        positions.dedup();
        for (i, &(x, y, z)) in positions.iter().enumerate() {
            chunk.set(x, y, z, protected[i % protected.len()]);
        }
        let before = chunk.clone();
        place(2026, &mut chunk, 0, 0);
        assert_eq!(chunk, before);
    }

    #[test]
    fn vein_centers_heights_sizes_and_triangular_density() {
        let mut low = [0usize; 4];
        let mut middle = [0usize; 4];
        let mut high = [0usize; 4];
        for seed in [2026, 0, -71] {
            for (i, ore) in ORES.into_iter().enumerate() {
                for qz in -8..=8 {
                    for qx in -8..=8 {
                        for qy in 0..HEIGHT / 16 {
                            veins(seed, ore, qx, qy, qz, |v| {
                                assert!((ore.low..=ore.high).contains(&v.center[1]));
                                let mut points = Vec::new();
                                v.blocks(|x, y, z, s| {
                                    assert_eq!(s, ore.state);
                                    for (p, c) in [x, y, z].into_iter().zip(v.center) {
                                        assert!((p - c).abs() <= MAX_VEIN_REACH);
                                    }
                                    if s == blocks::GOLD_ORE {
                                        assert!(y < 0);
                                    }
                                    if s == blocks::COAL_ORE {
                                        assert!(y >= -3);
                                    }
                                    points.push((x, y, z));
                                });
                                points.sort_unstable();
                                points.dedup();
                                assert!((ore.size[0]..=ore.size[1]).contains(&points.len()));
                                let band = (v.center[1] - ore.low) * 3 / (ore.high - ore.low + 1);
                                match band {
                                    0 => low[i] += 1,
                                    1 => middle[i] += 1,
                                    _ => high[i] += 1,
                                }
                            });
                        }
                    }
                }
            }
        }
        for i in 0..4 {
            assert!(middle[i] > low[i] && middle[i] > high[i]);
        }
    }

    #[test]
    fn measured_ore_ratios() {
        for seed in [2026, 0, -71] {
            let t = TerrainGenerator::new(seed);
            let mut stone = 0u64;
            let mut counts = [0u64; 4];
            // Same broad sampling grid as caves: 81 chunks over roughly 1 km².
            for cz in -4..=4 {
                for cx in -4..=4 {
                    let (cx, cz) = (cx * 8, cz * 8);
                    let before = t.generate_features(cx, cz, false, true, false);
                    let mut after = before.clone();
                    place(seed, &mut after, cx, cz);
                    for z in 0..16 {
                        for x in 0..16 {
                            let top = t.surface_y(cx * 16 + x as i32, cz * 16 + z as i32);
                            for y in MIN_Y..=top {
                                if before.get(x, y, z) != blocks::STONE {
                                    continue;
                                }
                                stone += 1;
                                for (i, ore) in ORES.iter().enumerate() {
                                    counts[i] += u64::from(after.get(x, y, z) == ore.state);
                                }
                            }
                        }
                    }
                }
            }
            let ratios = counts.map(|n| n as f64 / stone as f64);
            eprintln!(
                "ores seed={seed}: stone={stone}, counts={counts:?}, percent={:?}",
                ratios.map(|r| r * 100.0)
            );
            for (ratio, target) in ratios.into_iter().zip([0.008, 0.004, 0.003, 0.0005]) {
                assert!(
                    (target * 0.5..=target * 2.0).contains(&ratio),
                    "seed={seed}, ratio={ratio}, target={target}"
                );
            }
        }
    }
}
