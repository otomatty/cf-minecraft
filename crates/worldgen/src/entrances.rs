//! Original sloping entrance passages, owned by world-aligned plots.
use jmath::mix_stafford13;
use world::{blocks, BlockState, Chunk, MIN_Y};

use crate::{caves::ENTRANCE_THRESHOLD, TerrainGenerator, SEA_LEVEL};

const PLOT_SIZE: i32 = 32;
pub(crate) const MAX_ENTRANCE_REACH: i32 = 40;
const SALT: u64 = 0x6e31_a954_b807_2dda;
const CHANCE: f64 = 0.65;
const MAX_STEPS: i32 = 36;
const MIN_ENTRANCE_Y: i32 = crate::caves::CAVE_WATER_LEVEL + 1;
const _: () = assert!(MIN_ENTRANCE_Y >= MIN_Y + 6);
const _: () = assert!((MAX_STEPS + 3).pow(2) + 4 * 4 <= MAX_ENTRANCE_REACH.pow(2));

pub(crate) struct Entrance {
    pub(crate) root: [i32; 3],
    centers: Vec<[f64; 3]>,
    radius: f64,
}

impl Entrance {
    pub(crate) fn contains(&self, x: i32, y: i32, z: i32) -> bool {
        let [rx, top, rz] = self.root;
        if y < top - 30 || y > top + 3 || (x - rx).abs() > 39 || (z - rz).abs() > 39 {
            return false;
        }
        self.centers.iter().any(|&[cx, cy, cz]| {
            let dx = x as f64 - cx;
            let dy = y as f64 - cy;
            let dz = z as f64 - cz;
            dx * dx + dy * dy + dz * dz <= self.radius * self.radius
        })
    }

    fn blocks(&self, mut emit: impl FnMut(i32, i32, i32)) {
        for &[cx, cy, cz] in &self.centers {
            let min_y = -((-(cy - self.radius)).floor());
            let min_z = -((-(cz - self.radius)).floor());
            let min_x = -((-(cx - self.radius)).floor());
            for y in min_y as i32..=(cy + self.radius).floor() as i32 {
                for z in min_z as i32..=(cz + self.radius).floor() as i32 {
                    for x in min_x as i32..=(cx + self.radius).floor() as i32 {
                        let dx = x as f64 - cx;
                        let dy = y as f64 - cy;
                        let dz = z as f64 - cz;
                        if dx * dx + dy * dy + dz * dz <= self.radius * self.radius {
                            debug_assert!(
                                (x - self.root[0]).pow(2) + (z - self.root[2]).pow(2)
                                    <= MAX_ENTRANCE_REACH.pow(2)
                            );
                            emit(x, y, z);
                        }
                    }
                }
            }
        }
    }

    #[cfg(test)]
    fn block_list(&self) -> Vec<[i32; 3]> {
        let mut result = Vec::new();
        self.blocks(|x, y, z| result.push([x, y, z]));
        result.sort_unstable();
        result.dedup();
        result
    }
}

pub(crate) fn removable(state: BlockState, y: i32, lowest_neighbor: i32) -> bool {
    y >= MIN_ENTRANCE_Y
        && !(lowest_neighbor < y && y <= SEA_LEVEL)
        && [
            blocks::STONE,
            blocks::GRASS_BLOCK,
            blocks::DIRT,
            blocks::SAND,
            blocks::SNOW_BLOCK,
            blocks::SANDSTONE,
            blocks::GRAVEL,
            blocks::COARSE_DIRT,
        ]
        .contains(&state)
}

impl TerrainGenerator {
    pub(crate) fn entrance(&self, qx: i32, qz: i32) -> Option<Entrance> {
        let h = mix_stafford13(self.seed as u64 ^ SALT);
        let h = mix_stafford13(h ^ (qx as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15));
        let h = mix_stafford13(h ^ (qz as u64).wrapping_mul(0xc2b2_ae3d_27d4_eb4f));
        if (h >> 11) as f64 / (1u64 << 53) as f64 >= CHANCE {
            return None;
        }
        let shape = mix_stafford13(h);
        let x = qx * PLOT_SIZE + (shape & 31) as i32;
        let z = qz * PLOT_SIZE + ((shape >> 5) & 31) as i32;
        if self.caves.entrance_value(x, z) <= ENTRANCE_THRESHOLD {
            return None;
        }
        let top = self.surface_y(x, z);
        if top <= SEA_LEVEL + 2 {
            return None;
        }
        let (dx, dz) = [(1, 0), (0, 1), (-1, 0), (0, -1)][((shape >> 10) & 3) as usize];
        let slope = 0.75 + ((shape >> 12) % 3) as f64 * 0.025;
        let depth = 24 + ((shape >> 14) % 4) as i32;
        let radius = 1.75 + ((shape >> 16) % 3) as f64 * 0.25;
        let steps = -((-(depth as f64 / slope)).floor());
        let steps = (steps as i32).min(MAX_STEPS);
        let centers = (0..=steps)
            .map(|step| {
                // A one-block side sway every eight steps, with continuous interpolation.
                let sign = if shape & (1 << 20) == 0 { -1.0 } else { 1.0 };
                let phase = (step % 16) as f64 / 8.0;
                let side = sign * if phase <= 1.0 { phase } else { 2.0 - phase };
                [
                    x as f64 + (dx * step) as f64 - dz as f64 * side,
                    top as f64 - slope * step as f64,
                    z as f64 + (dz * step) as f64 + dx as f64 * side,
                ]
            })
            .collect();
        Some(Entrance {
            root: [x, top, z],
            centers,
            radius,
        })
    }

    pub(crate) fn entrances_for_chunk(&self, cx: i32, cz: i32, halo: i32) -> Vec<Entrance> {
        let reach = MAX_ENTRANCE_REACH + halo;
        let mut result = Vec::new();
        for qz in
            (cz * 16 - reach).div_euclid(PLOT_SIZE)..=(cz * 16 + 15 + reach).div_euclid(PLOT_SIZE)
        {
            for qx in (cx * 16 - reach).div_euclid(PLOT_SIZE)
                ..=(cx * 16 + 15 + reach).div_euclid(PLOT_SIZE)
            {
                if let Some(entrance) = self.entrance(qx, qz) {
                    result.push(entrance);
                }
            }
        }
        result
    }
}

pub(crate) fn carve(
    entrances: &[Entrance],
    chunk: &mut Chunk,
    cx: i32,
    cz: i32,
    heights: &[[i32; 18]; 18],
) {
    for entrance in entrances {
        entrance.blocks(|x, y, z| {
            let (x, z) = (x - cx * 16, z - cz * 16);
            if !(0..16).contains(&x) || !(0..16).contains(&z) {
                return;
            }
            let (x, z) = (x as usize, z as usize);
            let lowest = [
                heights[z + 1][x],
                heights[z + 1][x + 2],
                heights[z][x + 1],
                heights[z + 2][x + 1],
            ]
            .into_iter()
            .min()
            .unwrap();
            if removable(chunk.get(x, y, z), y, lowest) {
                chunk.set(x, y, z, blocks::AIR);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    // Split off the fraction before rounding: adding 0.5 first can round an
    // almost-half value up, or change an already-integral large value.
    fn round_ties_away(value: f64) -> f64 {
        let magnitude = if value < 0.0 { -value } else { value };
        let integral = magnitude.floor();
        let rounded = if magnitude - integral >= 0.5 {
            integral + 1.0
        } else {
            integral
        };
        if value < 0.0 {
            -rounded
        } else {
            rounded
        }
    }

    #[test]
    fn floor_round_matches_rust_round_including_ties_and_signed_zero() {
        for value in [
            0.0_f64,
            -0.0,
            0.1,
            -0.1,
            0.5,
            -0.5,
            1.4,
            -1.4,
            1.5,
            -1.5,
            1.6,
            -1.6,
            2.5,
            -2.5,
            12.0,
            -12.0,
            f64::from_bits(0.5_f64.to_bits() - 1),
            -f64::from_bits(0.5_f64.to_bits() - 1),
            f64::from_bits(0.5_f64.to_bits() + 1),
            -f64::from_bits(0.5_f64.to_bits() + 1),
            4_503_599_627_370_497.0,
            -4_503_599_627_370_497.0,
        ] {
            assert_eq!(
                round_ties_away(value).to_bits(),
                value.round().to_bits(),
                "{value}"
            );
        }
    }

    #[test]
    fn plot_geometry_has_bounded_reach_and_walkable_spheres() {
        let mut found = 0;
        let mut crossed = 0;
        for seed in [2026, 0, -71] {
            let t = TerrainGenerator::new(seed);
            for qz in -13..=12 {
                for qx in -13..=12 {
                    let Some(e) = t.entrance(qx, qz) else {
                        continue;
                    };
                    found += 1;
                    let [x, top, z] = e.root;
                    assert_eq!((x.div_euclid(32), z.div_euclid(32)), (qx, qz));
                    assert!(top > SEA_LEVEL + 2);
                    assert!(t.caves.entrance_value(x, z) > ENTRANCE_THRESHOLD);
                    assert!(e.centers.len() <= MAX_STEPS as usize + 1);
                    let drop = top as f64 - e.centers.last().unwrap()[1];
                    assert!((24.0..28.0).contains(&drop));
                    let list: BTreeSet<_> = e.block_list().into_iter().collect();
                    for &[bx, by, bz] in &list {
                        assert!((bx - x).pow(2) + (bz - z).pow(2) <= MAX_ENTRANCE_REACH.pow(2));
                        assert!(e.contains(bx, by, bz));
                        crossed += usize::from(
                            (bx.div_euclid(16), bz.div_euclid(16))
                                != (x.div_euclid(16), z.div_euclid(16)),
                        );
                    }
                    // Each sampled center has a vertical pair of air voxels for headroom.
                    for &[cx, cy, cz] in &e.centers {
                        let (bx, by, bz) = (
                            round_ties_away(cx) as i32,
                            cy.floor() as i32,
                            round_ties_away(cz) as i32,
                        );
                        assert!(list.contains(&[bx, by, bz]) && list.contains(&[bx, by + 1, bz]));
                    }
                }
            }
        }
        assert!(found > 20 && crossed > 100);
    }

    #[test]
    fn independent_plot_lists_match_generate_across_borders_and_orders() {
        for seed in [2026, 0, -71] {
            let t = TerrainGenerator::new(seed);
            let root = (-13..=12)
                .flat_map(|z| (-13..=12).map(move |x| (x, z)))
                .find_map(|(x, z)| t.entrance(x, z))
                .unwrap()
                .root;
            let mut actuals = Vec::new();
            for cz in root[2].div_euclid(16) - 1..=root[2].div_euclid(16) + 1 {
                for cx in root[0].div_euclid(16) - 1..=root[0].div_euclid(16) + 1 {
                    let mut reference = t.generate_features(cx, cz, false, false, false);
                    let heights: [[i32; 18]; 18] = std::array::from_fn(|z| {
                        std::array::from_fn(|x| {
                            t.surface_y(cx * 16 + x as i32 - 1, cz * 16 + z as i32 - 1)
                        })
                    });
                    t.caves.carve(&mut reference, cx, cz, &heights);
                    let mut plots = Vec::new();
                    // Deliberately wider than production's reach and reversed ownership order.
                    for qz in ((cz * 16 - 96).div_euclid(32)..=(cz * 16 + 111).div_euclid(32)).rev()
                    {
                        for qx in
                            ((cx * 16 - 96).div_euclid(32)..=(cx * 16 + 111).div_euclid(32)).rev()
                        {
                            if let Some(e) = t.entrance(qx, qz) {
                                plots.push(e);
                            }
                        }
                    }
                    for e in &plots {
                        for [wx, y, wz] in e.block_list().into_iter().rev() {
                            let (x, z) = (wx - cx * 16, wz - cz * 16);
                            if !(0..16).contains(&x) || !(0..16).contains(&z) {
                                continue;
                            }
                            let (x, z) = (x as usize, z as usize);
                            let low = [
                                heights[z + 1][x],
                                heights[z + 1][x + 2],
                                heights[z][x + 1],
                                heights[z + 2][x + 1],
                            ]
                            .into_iter()
                            .min()
                            .unwrap();
                            if removable(reference.get(x, y, z), y, low) {
                                reference.set(x, y, z, blocks::AIR);
                            }
                        }
                    }
                    crate::ores::place(seed, &mut reference, cx, cz);
                    t.plant_trees(&mut reference, cx, cz, &plots, |x, z| {
                        t.surface_y(cx * 16 + x, cz * 16 + z)
                    });
                    let actual = t.generate(cx, cz);
                    for y in MIN_Y..MIN_Y + world::HEIGHT {
                        for z in 0..16 {
                            for x in 0..16 {
                                assert_eq!(
                                    actual.get(x, y, z),
                                    reference.get(x, y, z),
                                    "seed={seed}, chunk={cx},{cz}, block={x},{y},{z}"
                                );
                            }
                        }
                    }
                    actuals.push(((cx, cz), actual));
                }
            }
            for ((cx, cz), first) in actuals.into_iter().rev() {
                assert_eq!(first, t.generate(cx, cz));
            }
        }
    }

    #[test]
    fn passages_protect_water_ice_bedrock_floor_and_adjacent_water() {
        let e = Entrance {
            root: [15, 56, 0],
            centers: vec![[15.0, 56.0, 0.0], [16.0, 56.0, 0.0]],
            radius: 2.25,
        };
        let mut chunk = Chunk::empty(0, 0);
        for (y, state) in [
            (54, blocks::WATER),
            (55, blocks::ICE),
            (56, blocks::BEDROCK),
            (57, blocks::STONE),
            (58, blocks::GRASS_BLOCK),
        ] {
            chunk.set(15, y, 0, state);
        }
        let mut heights = [[80; 18]; 18];
        chunk.set(14, 55, 0, blocks::ICE);
        chunk.set(15, 55, 0, blocks::STONE);
        heights[1][17] = 50; // The water column is across the chunk border.
        carve(std::slice::from_ref(&e), &mut chunk, 0, 0, &heights);
        for (y, state) in [
            (54, blocks::WATER),
            (55, blocks::STONE),
            (56, blocks::BEDROCK),
            (57, blocks::AIR),
            (58, blocks::AIR),
        ] {
            assert_eq!(chunk.get(15, y, 0), state);
        }
        assert_eq!(chunk.get(14, 55, 0), blocks::ICE);
        assert!(!removable(blocks::STONE, 55, 50));
        for state in [
            blocks::WATER,
            blocks::ICE,
            blocks::BEDROCK,
            blocks::OAK_LOG,
            blocks::OAK_LEAVES,
        ] {
            assert!(!removable(state, 80, 80));
        }
        for y in MIN_Y..MIN_Y + 6 {
            assert!(!removable(blocks::STONE, y, 80));
        }
        assert!(!removable(
            blocks::STONE,
            crate::caves::CAVE_WATER_LEVEL,
            80
        ));
        assert!(removable(blocks::STONE, 80, 80));
    }
}
