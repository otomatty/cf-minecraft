//! Chunk generation.
//!
//! Terrain is original density-based terrain; Flat and DebugHills retain their
//! legacy output. Prepared generators own their noise tables, with no global state.

mod caves;
mod terrain;
mod trees;
pub use terrain::{terrain_fingerprint, TerrainGenerator, SEA_LEVEL};

use jmath::mix_stafford13;
use world::{biomes::BiomeId, blocks, Chunk, Section, MIN_Y};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Generator {
    Flat,
    DebugHills,
    Terrain,
}

impl Generator {
    pub fn from_id(id: u32) -> Self {
        match id {
            0 => Generator::Flat,
            1 => Generator::DebugHills,
            2 => Generator::Terrain,
            _ => Generator::DebugHills,
        }
    }
}

/// Highest terrain solid in the column; excludes sea-surface ice in Terrain.
pub fn surface_y(gen: Generator, seed: i64, x: i32, z: i32) -> i32 {
    match gen {
        // Classic Flat: bedrock, two dirt, one grass block, starting at the world bottom.
        Generator::Flat => MIN_Y + 3,
        Generator::DebugHills => hills_height(seed, x, z),
        Generator::Terrain => TerrainGenerator::new(seed).surface_y(x, z),
    }
}

pub fn generate(gen: Generator, seed: i64, cx: i32, cz: i32) -> Chunk {
    match gen {
        Generator::Flat => generate_flat(cx, cz),
        Generator::DebugHills => generate_hills(seed, cx, cz),
        Generator::Terrain => TerrainGenerator::new(seed).generate(cx, cz),
    }
}

/// Feet position on dry ground, searching square rings in a fixed order.
/// Legacy generators retain the original origin spawn.
pub fn spawn_point(gen: Generator, seed: i64) -> [i32; 3] {
    if gen == Generator::Terrain {
        TerrainGenerator::new(seed).spawn_point()
    } else {
        [0, surface_y(gen, seed, 0, 0) + 1, 0]
    }
}

fn generate_flat(cx: i32, cz: i32) -> Chunk {
    let mut chunk = Chunk::empty(cx, cz);
    for z in 0..16 {
        for x in 0..16 {
            chunk.set(x, MIN_Y, z, blocks::BEDROCK);
            chunk.set(x, MIN_Y + 1, z, blocks::DIRT);
            chunk.set(x, MIN_Y + 2, z, blocks::DIRT);
            chunk.set(x, MIN_Y + 3, z, blocks::GRASS_BLOCK);
        }
    }
    chunk
}

/// Uniform value in [0, 1) for a lattice point.
fn lattice(seed: i64, x: i64, z: i64, salt: u64) -> f64 {
    let mut h = seed as u64 ^ salt;
    h = mix_stafford13(h ^ (x as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
    h = mix_stafford13(h ^ (z as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F));
    (h >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
}

/// Smoothed value noise in [0, 1). Only +, -, *, floor: exact on every host.
fn value_noise(seed: i64, x: f64, z: f64, salt: u64) -> f64 {
    let x0 = x.floor();
    let z0 = z.floor();
    let fx = x - x0;
    let fz = z - z0;
    let sx = fx * fx * (3.0 - 2.0 * fx);
    let sz = fz * fz * (3.0 - 2.0 * fz);
    let (ix, iz) = (x0 as i64, z0 as i64);
    let a = lattice(seed, ix, iz, salt);
    let b = lattice(seed, ix + 1, iz, salt);
    let c = lattice(seed, ix, iz + 1, salt);
    let d = lattice(seed, ix + 1, iz + 1, salt);
    let top = a + (b - a) * sx;
    let bottom = c + (d - c) * sx;
    top + (bottom - top) * sz
}

fn hills_height(seed: i64, x: i32, z: i32) -> i32 {
    let (fx, fz) = (x as f64, z as f64);
    let broad = value_noise(seed, fx / 96.0, fz / 96.0, 1) * 2.0 - 1.0;
    let medium = value_noise(seed, fx / 32.0, fz / 32.0, 2) * 2.0 - 1.0;
    let fine = value_noise(seed, fx / 12.0, fz / 12.0, 3) * 2.0 - 1.0;
    (66.0 + broad * 26.0 + medium * 9.0 + fine * 2.5).floor() as i32
}

fn generate_hills(seed: i64, cx: i32, cz: i32) -> Chunk {
    let mut heights = [[0i32; 16]; 16];
    let mut lowest = i32::MAX;
    for (z, row) in heights.iter_mut().enumerate() {
        for (x, h) in row.iter_mut().enumerate() {
            *h = hills_height(seed, cx * 16 + x as i32, cz * 16 + z as i32);
            lowest = lowest.min(*h);
        }
    }

    let mut chunk = Chunk::empty(cx, cz);
    // Sections that lie entirely inside the stone body need no per-block work.
    let stone_top = lowest - 4;
    let mut filled_below = MIN_Y;
    for (i, section) in chunk.sections.iter_mut().enumerate() {
        let base = MIN_Y + i as i32 * 16;
        if i > 0 && base + 15 <= stone_top {
            *section = Section::uniform(blocks::STONE);
            filled_below = base + 16;
        }
    }

    for (z, row) in heights.iter().enumerate() {
        for (x, &h) in row.iter().enumerate() {
            // Low ground gets sand, as a stand-in for beaches.
            let (top, under) = if h < 58 {
                (blocks::SAND, blocks::SAND)
            } else {
                (blocks::GRASS_BLOCK, blocks::DIRT)
            };
            chunk.set(x, MIN_Y, z, blocks::BEDROCK);
            for y in (MIN_Y + 1)..=h {
                if y >= MIN_Y + 16 && y < filled_below {
                    continue;
                }
                let state = if y == h {
                    top
                } else if y >= h - 3 {
                    under
                } else {
                    blocks::STONE
                };
                chunk.set(x, y, z, state);
            }
        }
    }
    chunk
}

/// Column biome; legacy generators retain the meadow default.
pub fn biome_at(gen: Generator, seed: i64, x: i32, z: i32) -> world::biomes::BiomeId {
    match gen {
        Generator::Terrain => TerrainGenerator::new(seed).biome_at(x, z),
        _ => 0,
    }
}

/// Chunk cell biomes in z-major order; legacy generators retain the meadow default.
/// Retain a `TerrainGenerator` and call its method to reuse seed-specific tables.
pub fn biome_cells(gen: Generator, seed: i64, cx: i32, cz: i32) -> [BiomeId; 16] {
    match gen {
        Generator::Terrain => TerrainGenerator::new(seed).biome_cells(cx, cz),
        _ => [0; 16],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cell_biomes_match_columns_across_land_sea_and_mountains() {
        let mut sea = false;
        let mut mountain = false;
        for seed in [0, 2026, -71] {
            let terrain = TerrainGenerator::new(seed);
            for cz in [-64, -32, -1, 0, 32, 64] {
                for cx in [-64, -32, -1, 0, 32, 64] {
                    let cells = terrain.biome_cells(cx, cz);
                    assert_eq!(cells, biome_cells(Generator::Terrain, seed, cx, cz));
                    for (index, id) in cells.into_iter().enumerate() {
                        let x = cx * 16 + (index % 4) as i32 * 4 + 2;
                        let z = cz * 16 + (index / 4) as i32 * 4 + 2;
                        assert_eq!(id, terrain.biome_at(x, z), "seed={seed}, x={x}, z={z}");
                        let kind = world::biomes::BIOMES[id as usize].terrain;
                        sea |= kind == world::biomes::TerrainKind::Sea;
                        mountain |= kind == world::biomes::TerrainKind::Mountain;
                    }
                    for gen in [Generator::Flat, Generator::DebugHills] {
                        assert_eq!(biome_cells(gen, seed, cx, cz), [0; 16]);
                    }
                }
            }
        }
        assert!(sea && mountain, "samples must cover sea and mountains");
    }

    #[test]
    fn classic_flat_layers() {
        let c = generate(Generator::Flat, 0, 5, -3);
        assert_eq!(c.get(7, -64, 7), blocks::BEDROCK);
        assert_eq!(c.get(7, -63, 7), blocks::DIRT);
        assert_eq!(c.get(7, -62, 7), blocks::DIRT);
        assert_eq!(c.get(7, -61, 7), blocks::GRASS_BLOCK);
        assert_eq!(c.get(7, -60, 7), blocks::AIR);
        assert_eq!(surface_y(Generator::Flat, 0, 0, 0), -61);
    }

    #[test]
    fn hills_are_deterministic_and_consistent_with_surface_y() {
        for &(cx, cz) in &[(0, 0), (-1, -1), (12, -40), (-300, 77)] {
            let a = generate(Generator::DebugHills, 1234, cx, cz);
            let b = generate(Generator::DebugHills, 1234, cx, cz);
            assert_eq!(a, b);
            for z in 0..16usize {
                for x in 0..16usize {
                    let h = surface_y(
                        Generator::DebugHills,
                        1234,
                        cx * 16 + x as i32,
                        cz * 16 + z as i32,
                    );
                    assert_ne!(a.get(x, h, z), blocks::AIR, "surface block at {x},{h},{z}");
                    assert_eq!(a.get(x, h + 1, z), blocks::AIR);
                    assert_eq!(a.get(x, -64, z), blocks::BEDROCK);
                    // No holes between bedrock and the surface.
                    for y in -63..h {
                        assert_ne!(
                            a.get(x, y, z),
                            blocks::AIR,
                            "hole at {x},{y},{z} in chunk {cx},{cz}"
                        );
                    }
                }
            }
        }
        assert_ne!(
            generate(Generator::DebugHills, 1, 0, 0),
            generate(Generator::DebugHills, 2, 0, 0)
        );
    }

    #[test]
    fn terrain_is_continuous_across_chunk_borders() {
        // Neighbouring columns on either side of a chunk border differ by a few blocks at most.
        for z in 0..64 {
            let a = surface_y(Generator::DebugHills, 99, 15, z);
            let b = surface_y(Generator::DebugHills, 99, 16, z);
            assert!((a - b).abs() <= 3, "cliff of {} at z={z}", (a - b).abs());
        }
    }

    #[test]
    fn section_counters_match_contents() {
        let c = generate(Generator::DebugHills, 7, 3, 3);
        for s in &c.sections {
            assert_eq!(s.non_air as usize, s.states.count(|v| v != blocks::AIR));
        }
    }
}
