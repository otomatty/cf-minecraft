use jmath::mix_stafford13;
use noise::Fbm;
use world::{blocks, Chunk, Fnv64, Section, MIN_Y};

pub const SEA_LEVEL: i32 = 56;
const CELL_XZ: i32 = 4;
const CELL_Y: i32 = 8;
const Y_POINTS: usize = 49;
const CONTINENT_GAIN: f64 = 3.0;
const LAND_OFFSET: f64 = 0.12;
const LAND_WIDTH: f64 = 0.45;
const RELIEF_GAIN: f64 = 3.0;
const RELIEF_OFFSET: f64 = 0.35;
const BASE_CENTER: f64 = 64.0;
const CONTINENT_HEIGHT: f64 = 85.0;
const RELIEF_HEIGHT: f64 = 110.0;
const DETAIL_HEIGHT: f64 = 8.0;
const SURFACE_DEPTH: i32 = 3;
const BEACH_HEIGHT: i32 = 2;
const FBM_LACUNARITY: f64 = 2.0;
const FBM_PERSISTENCE: f64 = 0.5;
const CONTINENT_OCTAVES: u8 = 3;
const LOCAL_OCTAVES: u8 = 2;
const CONTINENT_SCALE: f64 = 1100.0;
const RELIEF_SCALE: f64 = 470.0;
const DETAIL_SCALE: f64 = 95.0;
const DENSITY_XZ_SCALE: f64 = 38.0;
const DENSITY_Y_SCALE: f64 = 19.0;
const BASE_MIN: f64 = 20.0;
const BASE_LOW_KNEE: f64 = 50.0;
const BASE_HIGH_KNEE: f64 = 110.0;
const BASE_MAX: f64 = 180.0;
const DENSITY_MIN: f64 = 2.0;
const DENSITY_RELIEF: f64 = 36.0;
const CONTINENT_SALT: u64 = 0x8ab3_014d_5f22_c617;
const RELIEF_SALT: u64 = 0xd451_72c0_193b_8e65;
const DETAIL_SALT: u64 = 0x27f9_608a_b13d_4ce2;
const DENSITY_SALT: u64 = 0x635c_f81a_904e_2bd7;
const SPAWN_RADIUS: i32 = 512;
const SPAWN_STEP: i32 = 16;

/// Prepared seed-specific noise tables. Retain this value when generating many
/// chunks; all methods are pure and can share it across threads.
pub struct TerrainGenerator {
    continent: Fbm,
    relief: Fbm,
    detail: Fbm,
    density: Fbm,
}

fn lerp(t: f64, a: f64, b: f64) -> f64 {
    a + t * (b - a)
}
fn soft_height(raw: f64) -> f64 {
    if raw > BASE_HIGH_KNEE {
        let span = BASE_MAX - BASE_HIGH_KNEE;
        BASE_MAX - span * span / (raw - BASE_HIGH_KNEE + span)
    } else if raw < BASE_LOW_KNEE {
        let span = BASE_LOW_KNEE - BASE_MIN;
        BASE_MIN + span * span / (BASE_LOW_KNEE - raw + span)
    } else {
        raw
    }
}

fn smooth(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

impl TerrainGenerator {
    pub fn new(seed: i64) -> Self {
        let field = |salt, octaves| {
            Fbm::new(
                mix_stafford13(seed as u64 ^ salt) as i64,
                octaves,
                FBM_LACUNARITY,
                FBM_PERSISTENCE,
            )
        };
        Self {
            continent: field(CONTINENT_SALT, CONTINENT_OCTAVES),
            relief: field(RELIEF_SALT, LOCAL_OCTAVES),
            detail: field(DETAIL_SALT, LOCAL_OCTAVES),
            density: field(DENSITY_SALT, LOCAL_OCTAVES),
        }
    }

    fn shape(&self, x: i32, z: i32) -> (f64, f64) {
        let (x, z) = (x as f64, z as f64);
        let continent = self
            .continent
            .sample2(x / CONTINENT_SCALE, z / CONTINENT_SCALE)
            * CONTINENT_GAIN;
        let land = smooth((continent + LAND_OFFSET) / LAND_WIDTH);
        let relief = smooth(
            self.relief.sample2(x / RELIEF_SCALE, z / RELIEF_SCALE) * RELIEF_GAIN + RELIEF_OFFSET,
        ) * land;
        let detail = self.detail.sample2(x / DETAIL_SCALE, z / DETAIL_SCALE);
        let base = soft_height(
            BASE_CENTER
                + continent * CONTINENT_HEIGHT
                + relief * relief * RELIEF_HEIGHT
                + detail * DETAIL_HEIGHT,
        );
        (base, DENSITY_MIN + DENSITY_RELIEF * relief * relief)
    }

    fn density_line(&self, x: i32, z: i32) -> [f64; Y_POINTS] {
        let (base, strength) = self.shape(x, z);
        std::array::from_fn(|i| {
            let y = MIN_Y + i as i32 * CELL_Y;
            base - y as f64
                + strength
                    * self.density.sample3(
                        x as f64 / DENSITY_XZ_SCALE,
                        y as f64 / DENSITY_Y_SCALE,
                        z as f64 / DENSITY_XZ_SCALE,
                    )
        })
    }

    fn column(corners: [&[f64; Y_POINTS]; 4], tx: f64, tz: f64) -> [f64; Y_POINTS] {
        std::array::from_fn(|i| {
            lerp(
                tz,
                lerp(tx, corners[0][i], corners[1][i]),
                lerp(tx, corners[2][i], corners[3][i]),
            )
        })
    }

    fn solid(line: &[f64; Y_POINTS], y: i32) -> bool {
        let offset = (y - MIN_Y) as usize;
        let i = offset / CELL_Y as usize;
        lerp(
            (offset % CELL_Y as usize) as f64 / CELL_Y as f64,
            line[i],
            line[i + 1],
        ) > 0.0
    }

    fn top(line: &[f64; Y_POINTS]) -> i32 {
        // The proven upper bound is BASE_MAX + DENSITY_MIN + DENSITY_RELIEF.
        (0..=(BASE_MAX + DENSITY_MIN + DENSITY_RELIEF) as i32)
            .rev()
            .find(|&y| Self::solid(line, y))
            .unwrap_or(MIN_Y)
    }

    pub fn surface_y(&self, x: i32, z: i32) -> i32 {
        let gx = x.div_euclid(CELL_XZ) * CELL_XZ;
        let gz = z.div_euclid(CELL_XZ) * CELL_XZ;
        let corners = [
            self.density_line(gx, gz),
            self.density_line(gx + CELL_XZ, gz),
            self.density_line(gx, gz + CELL_XZ),
            self.density_line(gx + CELL_XZ, gz + CELL_XZ),
        ];
        Self::top(&Self::column(
            corners.each_ref(),
            (x - gx) as f64 / CELL_XZ as f64,
            (z - gz) as f64 / CELL_XZ as f64,
        ))
    }

    fn grid(&self, cx: i32, cz: i32) -> [[f64; Y_POINTS]; 25] {
        std::array::from_fn(|i| {
            self.density_line(
                cx * 16 + (i % 5) as i32 * CELL_XZ,
                cz * 16 + (i / 5) as i32 * CELL_XZ,
            )
        })
    }

    pub fn generate(&self, cx: i32, cz: i32) -> Chunk {
        let grid = self.grid(cx, cz);
        let mut chunk = Chunk::empty(cx, cz);
        // Positive lattice endpoints bound every interpolated density below them.
        // Leave room for the surface coating before filling uniform stone sections.
        let lowest = grid
            .iter()
            .map(|line| {
                line.iter().position(|&d| d <= 0.0).unwrap_or(Y_POINTS) as i32 * CELL_Y + MIN_Y
                    - CELL_Y
            })
            .min()
            .unwrap();
        let filled_to = ((lowest - SURFACE_DEPTH).div_euclid(16) * 16).max(MIN_Y + 16);
        for y in ((MIN_Y + 16)..filled_to).step_by(16) {
            chunk.sections[((y - MIN_Y) / 16) as usize] = Section::uniform(blocks::STONE);
        }
        for z in 0..16 {
            for x in 0..16 {
                let i = (z / 4) * 5 + x / 4;
                let line = Self::column(
                    [&grid[i], &grid[i + 1], &grid[i + 5], &grid[i + 6]],
                    (x % 4) as f64 / 4.0,
                    (z % 4) as f64 / 4.0,
                );
                let top = Self::top(&line);
                chunk.set(x, MIN_Y, z, blocks::BEDROCK);
                for y in (MIN_Y + 1)..=top.max(SEA_LEVEL) {
                    if y >= MIN_Y + 16 && y < filled_to {
                        continue;
                    }
                    let state = if Self::solid(&line, y) {
                        if y >= top - SURFACE_DEPTH {
                            if top <= SEA_LEVEL + BEACH_HEIGHT {
                                blocks::SAND
                            } else if y == top {
                                blocks::GRASS_BLOCK
                            } else {
                                blocks::DIRT
                            }
                        } else {
                            blocks::STONE
                        }
                    } else if y <= SEA_LEVEL {
                        blocks::WATER
                    } else {
                        blocks::AIR
                    };
                    if state != blocks::AIR {
                        chunk.set(x, y, z, state);
                    }
                }
            }
        }
        chunk
    }

    pub fn spawn_point(&self) -> [i32; 3] {
        self.find_spawn(SPAWN_RADIUS)
            .unwrap_or([0, self.surface_y(0, 0).max(SEA_LEVEL) + 1, 0])
    }

    fn find_spawn(&self, radius: i32) -> Option<[i32; 3]> {
        for r in (0..=radius).step_by(SPAWN_STEP as usize) {
            for z in (-r..=r).step_by(SPAWN_STEP as usize) {
                for x in (-r..=r).step_by(SPAWN_STEP as usize) {
                    if x != -r && x != r && z != -r && z != r {
                        continue;
                    }
                    let y = self.surface_y(x, z);
                    // Highest solid implies both blocks above are air on dry land.
                    if y > SEA_LEVEL {
                        return Some([x, y + 1, z]);
                    }
                }
            }
        }
        None
    }
}

/// FNV-1a of central and widely spaced chunk block IDs; independent of palettes.
pub fn terrain_fingerprint(seed: i64) -> u64 {
    let terrain = TerrainGenerator::new(seed);
    let mut hash = Fnv64::new();
    // Central 5x5 plus 24 spaced probes include ocean floors and mountain caps.
    for spacing in [1, 32] {
        for gz in -2..=2 {
            for gx in -2..=2 {
                if spacing == 32 && gx == 0 && gz == 0 {
                    continue;
                }
                let chunk = terrain.generate(gx * spacing, gz * spacing);
                for y in MIN_Y..320 {
                    for z in 0..16 {
                        for x in 0..16 {
                            hash.u16(chunk.get(x, y, z));
                        }
                    }
                }
            }
        }
    }
    hash.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{generate, spawn_point, surface_y, Generator};

    fn chunk_hash(chunk: &Chunk) -> u64 {
        let mut hash = Fnv64::new();
        chunk.hash_into(&mut hash);
        hash.finish()
    }

    #[test]
    fn deterministic_chunks_and_seed_variation() {
        let a = TerrainGenerator::new(2026);
        assert_eq!(
            chunk_hash(&a.generate(-2, 1)),
            chunk_hash(&a.generate(-2, 1))
        );
        assert_ne!(
            chunk_hash(&a.generate(-2, 1)),
            chunk_hash(&TerrainGenerator::new(2027).generate(-2, 1))
        );
        assert_eq!(Generator::from_id(0), Generator::Flat);
        assert_eq!(Generator::from_id(1), Generator::DebugHills);
        assert_eq!(Generator::from_id(2), Generator::Terrain);
        for id in [3, 99, u32::MAX] {
            assert_eq!(Generator::from_id(id), Generator::DebugHills);
        }
        assert_eq!(a.generate(0, 0), generate(Generator::Terrain, 2026, 0, 0));
    }

    #[test]
    fn surfaces_water_bedrock_and_materials_match() {
        for seed in [0, 2026, -71] {
            let terrain = TerrainGenerator::new(seed);
            for (cx, cz) in [(0, 0), (-3, -1), (21, -33)] {
                let chunk = terrain.generate(cx, cz);
                for z in 0..16 {
                    for x in 0..16 {
                        let top = (MIN_Y..320)
                            .rev()
                            .find(|&y| blocks::info(chunk.get(x, y, z)).solid)
                            .unwrap();
                        assert_eq!(
                            top,
                            terrain.surface_y(cx * 16 + x as i32, cz * 16 + z as i32)
                        );
                        assert_eq!(chunk.get(x, MIN_Y, z), blocks::BEDROCK);
                        for y in (MIN_Y + 1)..=SEA_LEVEL {
                            assert_ne!(chunk.get(x, y, z), blocks::AIR);
                        }
                        for depth in 0..=3 {
                            let state = chunk.get(x, top - depth, z);
                            if blocks::info(state).solid {
                                assert_eq!(
                                    state,
                                    if top <= SEA_LEVEL + BEACH_HEIGHT {
                                        blocks::SAND
                                    } else if depth == 0 {
                                        blocks::GRASS_BLOCK
                                    } else {
                                        blocks::DIRT
                                    }
                                );
                            }
                        }
                    }
                }
                for section in &chunk.sections {
                    assert_eq!(
                        section.non_air as usize,
                        section.states.count(|s| s != blocks::AIR)
                    );
                }
                assert_eq!(
                    surface_y(Generator::Terrain, seed, cx * 16, cz * 16),
                    terrain.surface_y(cx * 16, cz * 16)
                );
            }
        }
    }

    #[test]
    fn world_aligned_lattice_and_border_slopes() {
        for seed in [2026, -71] {
            let terrain = TerrainGenerator::new(seed);
            let mut border_max = 0;
            let mut interior_max = 0;
            for cz in -2..=2 {
                for cx in -2..=2 {
                    let a = terrain.generate(cx, cz);
                    let east = terrain.generate(cx + 1, cz);
                    let south = terrain.generate(cx, cz + 1);
                    // Shared lattice planes are exactly identical, including negative coordinates.
                    for i in 0..=4 {
                        let grid = terrain.grid(cx, cz);
                        let east_grid = terrain.grid(cx + 1, cz);
                        let south_grid = terrain.grid(cx, cz + 1);
                        assert_eq!(grid[i as usize * 5 + 4], east_grid[i as usize * 5]);
                        assert_eq!(grid[20 + i as usize], south_grid[i as usize]);
                    }
                    let top = |c: &Chunk, x, z| {
                        (MIN_Y..320)
                            .rev()
                            .find(|&y| blocks::info(c.get(x, y, z)).solid)
                            .unwrap()
                    };
                    for i in 0..16 {
                        border_max = border_max.max((top(&a, 15, i) - top(&east, 0, i)).abs());
                        border_max = border_max.max((top(&a, i, 15) - top(&south, i, 0)).abs());
                        for j in 0..15 {
                            interior_max =
                                interior_max.max((top(&a, j, i) - top(&a, j + 1, i)).abs());
                            interior_max =
                                interior_max.max((top(&a, i, j) - top(&a, i, j + 1)).abs());
                        }
                    }
                }
            }
            assert!(
                border_max <= interior_max + 3,
                "border={border_max} interior={interior_max}"
            );
            assert!(border_max <= 16);
        }
    }

    #[test]
    fn broad_distribution_and_height_bounds() {
        for seed in [0, 2026, -71] {
            let terrain = TerrainGenerator::new(seed);
            let (mut sea, mut mountain, mut total) = (0, 0, 0);
            let (mut low, mut high) = (i32::MAX, i32::MIN);
            for z in (-2048..=2048).step_by(64) {
                for x in (-2048..=2048).step_by(64) {
                    let y = terrain.surface_y(x, z);
                    sea += i32::from(y < SEA_LEVEL);
                    mountain += i32::from(y > 140);
                    total += 1;
                    low = low.min(y);
                    high = high.max(y);
                }
            }
            let ratio = sea as f64 / total as f64;
            eprintln!("seed={seed}: ocean={ratio:.3} mountains={mountain} range={low}..{high}");
            assert!((0.15..0.65).contains(&ratio));
            assert!(mountain > 0);
            assert!(low >= 1 && high <= 218);
        }
    }

    #[test]
    fn spawn_is_dry_with_headroom_and_legacy_is_unchanged() {
        for seed in [0, 2026, -71, 42] {
            for gen in [Generator::Flat, Generator::DebugHills] {
                assert_eq!(
                    spawn_point(gen, seed),
                    [0, surface_y(gen, seed, 0, 0) + 1, 0]
                );
            }
            let terrain = TerrainGenerator::new(seed);
            let [x, y, z] = spawn_point(Generator::Terrain, seed);
            assert!(x.abs() <= SPAWN_RADIUS && z.abs() <= SPAWN_RADIUS);
            assert!(y > SEA_LEVEL + 1);
            let c = terrain.generate(x.div_euclid(16), z.div_euclid(16));
            let (x, z) = (x.rem_euclid(16) as usize, z.rem_euclid(16) as usize);
            assert!(blocks::info(c.get(x, y - 1, z)).solid);
            assert_eq!(c.get(x, y, z), blocks::AIR);
            assert_eq!(c.get(x, y + 1, z), blocks::AIR);
        }
        let ocean = (0..100)
            .map(TerrainGenerator::new)
            .find(|g| g.surface_y(0, 0) <= SEA_LEVEL)
            .unwrap();
        assert_eq!(ocean.find_spawn(0), None);
    }

    #[test]
    fn density_can_form_overhangs() {
        for seed in [2026, 0, -71] {
            let terrain = TerrainGenerator::new(seed);
            for z in (-2048..=2048).step_by(32) {
                for x in (-2048..=2048).step_by(32) {
                    let line = terrain.density_line(x, z);
                    let top = TerrainGenerator::top(&line);
                    if (1..top).any(|y| !TerrainGenerator::solid(&line, y)) {
                        let chunk = terrain.generate(x.div_euclid(16), z.div_euclid(16));
                        let (lx, lz) = (x.rem_euclid(16) as usize, z.rem_euclid(16) as usize);
                        for y in 1..top - SURFACE_DEPTH - 1 {
                            if !TerrainGenerator::solid(&line, y)
                                && TerrainGenerator::solid(&line, y + 1)
                            {
                                assert_eq!(chunk.get(lx, y + 1, lz), blocks::STONE);
                                return;
                            }
                        }
                    }
                }
            }
        }
        panic!("sampled mountains contained no overhangs");
    }

    #[test]
    fn height_histogram_has_no_cap_plateau() {
        let terrain = TerrainGenerator::new(2026);
        let mut bins = [0usize; 24];
        for iz in -256..256 {
            for ix in -256..256 {
                let y = terrain.surface_y(ix * 8, iz * 8);
                assert!((1..=218).contains(&y));
                bins[y as usize / 10] += 1;
            }
        }
        eprintln!("height histogram: {bins:?}");
        let highest = bins.iter().rposition(|&n| n > 0).unwrap();
        assert!(highest >= 14);
        assert!(bins[highest] <= 2 * bins[highest - 1]);
        // The upper mountain shoulder must taper too, rather than collect at a cap.
        assert!(bins[17] <= 2 * bins[16]);
        assert!(bins[18] <= 2 * bins[17]);
        assert!(bins[2] <= 2 * bins[3]);
        // Both joins have unit slope; neither side has a constant floor/ceiling.
        for knee in [BASE_LOW_KNEE, BASE_HIGH_KNEE] {
            assert!(
                (soft_height(knee + 0.001) - soft_height(knee - 0.001) - 0.002).abs() < 0.000001
            );
        }
        assert!(soft_height(-100.0) > soft_height(-200.0));
        assert!(soft_height(300.0) > soft_height(200.0));
    }

    #[test]
    fn terrain_reference_fingerprint() {
        assert_eq!(terrain_fingerprint(2026), 0x31bc3acc726368fc);
    }
}
