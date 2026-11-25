use jmath::mix_stafford13;
use noise::Fbm;
use world::{
    biomes::{self, Biome, BiomeId, TerrainKind, BIOMES},
    blocks, Chunk, Fnv64, Section, MIN_Y,
};

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
    pub(crate) seed: i64,
    pub(crate) caves: crate::caves::Caves,
    continent: Fbm,
    relief: Fbm,
    detail: Fbm,
    density: Fbm,
    temperature: Fbm,
    humidity: Fbm,
    warp: Fbm,
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
            seed,
            caves: crate::caves::Caves::new(seed),
            continent: field(CONTINENT_SALT, CONTINENT_OCTAVES),
            relief: field(RELIEF_SALT, LOCAL_OCTAVES),
            detail: field(DETAIL_SALT, LOCAL_OCTAVES),
            density: field(DENSITY_SALT, LOCAL_OCTAVES),
            temperature: field(0xa197_854b_32cd_601e, 2),
            humidity: field(0x732e_b190_4ac5_d86f, 3),
            warp: field(0xc931_467a_f208_5bed, 2),
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

    /// Geological surface height; unchanged by coatings and sea-surface ice.
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

    // A single sampler shares lattice points and heights across all candidates.
    // Optional chunk data is read before allocating or evaluating new samples.
    fn surface_sampler_with<'a>(
        &'a self,
        known_height: impl Fn(i32, i32) -> Option<i32> + 'a,
        known_line: impl Fn(i32, i32) -> Option<[f64; Y_POINTS]> + 'a,
    ) -> impl FnMut(i32, i32) -> i32 + 'a {
        let mut lines = std::collections::BTreeMap::new();
        let mut heights = std::collections::BTreeMap::new();
        move |x: i32, z: i32| {
            if let Some(top) = known_height(x, z) {
                return top;
            }
            if let Some(&top) = heights.get(&(x, z)) {
                return top;
            }
            let gx = x.div_euclid(CELL_XZ) * CELL_XZ;
            let gz = z.div_euclid(CELL_XZ) * CELL_XZ;
            let points = [
                (gx, gz),
                (gx + CELL_XZ, gz),
                (gx, gz + CELL_XZ),
                (gx + CELL_XZ, gz + CELL_XZ),
            ];
            for point in points {
                lines.entry(point).or_insert_with(|| {
                    known_line(point.0, point.1)
                        .unwrap_or_else(|| self.density_line(point.0, point.1))
                });
            }
            let top = Self::top(&Self::column(
                points.map(|point| &lines[&point]),
                (x - gx) as f64 / CELL_XZ as f64,
                (z - gz) as f64 / CELL_XZ as f64,
            ));
            heights.insert((x, z), top);
            top
        }
    }

    #[cfg(test)]
    pub(crate) fn surface_sampler(&self) -> impl FnMut(i32, i32) -> i32 + '_ {
        self.surface_sampler_with(|_, _| None, |_, _| None)
    }

    fn chunk_surface_sampler<'a>(
        &'a self,
        cx: i32,
        cz: i32,
        grid: &'a [[f64; Y_POINTS]; 49],
        heights: &'a [[i32; 18]; 18],
    ) -> impl FnMut(i32, i32) -> i32 + 'a {
        self.surface_sampler_with(
            move |x, z| {
                let (x, z) = (x - cx * 16, z - cz * 16);
                if (-1..=16).contains(&x) && (-1..=16).contains(&z) {
                    Some(heights[(z + 1) as usize][(x + 1) as usize])
                } else {
                    None
                }
            },
            move |x, z| {
                let (x, z) = (x - cx * 16, z - cz * 16);
                if (-4..=20).contains(&x) && (-4..=20).contains(&z) {
                    Some(grid[((z + 4) / 4 * 7 + (x + 4) / 4) as usize])
                } else {
                    None
                }
            },
        )
    }

    /// Piecewise linear, symmetric approximation of this fBm's cumulative distribution.
    /// Expands the common central values without turning the tails into hard plateaus.
    fn climate_map(v: f64) -> f64 {
        let knots = [
            (-1.0, 0.0),
            (-0.3, 0.005),
            (-0.2, 0.04),
            (-0.15, 0.1),
            (-0.1, 0.2),
            (-0.05, 0.34),
            (0.0, 0.5),
            (0.05, 0.66),
            (0.1, 0.8),
            (0.15, 0.9),
            (0.2, 0.96),
            (0.3, 0.995),
            (1.0, 1.0),
        ];
        for pair in knots.windows(2) {
            let [(a, va), (b, vb)] = [pair[0], pair[1]];
            if v <= b {
                return lerp(((v - a) / (b - a)).clamp(0.0, 1.0), va, vb);
            }
        }
        1.0
    }

    /// Gentler temperature mapping keeps intermediate climate belts broad.
    /// Humidity retains the more even distribution used by `climate_map`.
    fn temperature_map(v: f64) -> f64 {
        let knots = [
            (-1.0, 0.0),
            (-0.3, 0.04),
            (-0.15, 0.2),
            (0.0, 0.5),
            (0.15, 0.8),
            (0.3, 0.96),
            (1.0, 1.0),
        ];
        for pair in knots.windows(2) {
            let [(a, va), (b, vb)] = [pair[0], pair[1]];
            if v <= b {
                return lerp(((v - a) / (b - a)).clamp(0.0, 1.0), va, vb);
            }
        }
        1.0
    }

    fn climate_at(&self, x: i32, z: i32, top: i32) -> (f64, f64) {
        let (x, z) = (x as f64, z as f64);
        let wx = x + 18.0 * self.warp.sample2(x / 47.0, z / 47.0);
        let wz = z + 18.0 * self.warp.sample2((x + 791.0) / 47.0, (z - 313.0) / 47.0);
        let temperature =
            (Self::temperature_map(self.temperature.sample2(wx / 3000.0, wz / 3000.0))
                - (top - 80).max(0) as f64 * 0.002)
                .clamp(0.0, 1.0);
        let humidity = Self::climate_map(self.humidity.sample2(wx / 900.0, wz / 900.0));
        (temperature, humidity)
    }

    pub(crate) fn biome_for_height(&self, x: i32, z: i32, top: i32) -> BiomeId {
        let (temperature, humidity) = self.climate_at(x, z, top);
        let kind = if top < SEA_LEVEL {
            // Cold water can freeze all the way to shore.
            if top >= SEA_LEVEL - 7 && temperature >= 0.38 {
                TerrainKind::Shallows
            } else {
                TerrainKind::Sea
            }
        } else if top <= SEA_LEVEL + BEACH_HEIGHT {
            TerrainKind::Beach
        } else if top >= 122 {
            TerrainKind::Mountain
        } else {
            TerrainKind::Land
        };
        biomes::select(temperature, humidity, kind)
    }

    pub fn biome_at(&self, x: i32, z: i32) -> BiomeId {
        self.biome_for_height(x, z, self.surface_y(x, z))
    }

    /// Biomes at the centers of 4x4-block cells, in z-major order (j * 4 + i).
    /// Shares the chunk's 5x5 density lines across all sixteen samples.
    pub fn biome_cells(&self, cx: i32, cz: i32) -> [BiomeId; 16] {
        let grid = self.grid(cx, cz);
        std::array::from_fn(|index| {
            let (i, j) = (index % 4, index / 4);
            let corner = j * 5 + i;
            let line = Self::column(
                [
                    &grid[corner],
                    &grid[corner + 1],
                    &grid[corner + 5],
                    &grid[corner + 6],
                ],
                0.5,
                0.5,
            );
            self.biome_for_height(
                cx * 16 + i as i32 * 4 + 2,
                cz * 16 + j as i32 * 4 + 2,
                Self::top(&line),
            )
        })
    }

    pub(crate) fn coating(b: &Biome, top: i32, y: i32, steep: bool) -> world::BlockState {
        if top - y > i32::from(b.depth) {
            blocks::STONE
        } else if top < SEA_LEVEL {
            b.underwater
        } else if steep {
            b.slope
        } else if y == top {
            b.surface
        } else {
            b.subsurface
        }
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
        self.generate_features(cx, cz, true, true, true)
    }

    #[cfg(test)]
    pub(crate) fn generate_geology(&self, cx: i32, cz: i32) -> Chunk {
        self.generate_features(cx, cz, false, true, true)
    }

    pub(crate) fn generate_features(
        &self,
        cx: i32,
        cz: i32,
        trees: bool,
        caves: bool,
        ores: bool,
    ) -> Chunk {
        // A one-cell halo supplies exact neighbouring column heights for slopes.
        let grid: [[f64; Y_POINTS]; 49] = std::array::from_fn(|i| {
            self.density_line(
                cx * 16 + (i % 7) as i32 * 4 - 4,
                cz * 16 + (i / 7) as i32 * 4 - 4,
            )
        });
        let column = |x: i32, z: i32| {
            let i = ((z + 4).div_euclid(4) * 7 + (x + 4).div_euclid(4)) as usize;
            Self::column(
                [&grid[i], &grid[i + 1], &grid[i + 7], &grid[i + 8]],
                x.rem_euclid(4) as f64 / 4.0,
                z.rem_euclid(4) as f64 / 4.0,
            )
        };
        let heights: [[i32; 18]; 18] = std::array::from_fn(|z| {
            std::array::from_fn(|x| Self::top(&column(x as i32 - 1, z as i32 - 1)))
        });
        let mut chunk = Chunk::empty(cx, cz);
        // Positive lattice endpoints bound every interpolated density below them.
        // Leave room for the surface coating before filling uniform stone sections.
        let surface_depth = BIOMES.iter().map(|b| i32::from(b.depth)).max().unwrap_or(0);
        let lowest = grid
            .iter()
            .enumerate()
            // Halo columns do not bound densities inside this chunk.
            .filter(|(i, _)| (1..=5).contains(&(i % 7)) && (1..=5).contains(&(i / 7)))
            .map(|(_, line)| {
                line.iter().position(|&d| d <= 0.0).unwrap_or(Y_POINTS) as i32 * CELL_Y + MIN_Y
                    - CELL_Y
            })
            .min()
            .unwrap();
        let filled_to = ((lowest - surface_depth).div_euclid(16) * 16).max(MIN_Y + 16);
        for y in ((MIN_Y + 16)..filled_to).step_by(16) {
            chunk.sections[((y - MIN_Y) / 16) as usize] = Section::uniform(blocks::STONE);
        }
        for z in 0..16 {
            for x in 0..16 {
                let line = column(x as i32, z as i32);
                let top = heights[z + 1][x + 1];
                let b = &BIOMES
                    [self.biome_for_height(cx * 16 + x as i32, cz * 16 + z as i32, top) as usize];
                let steep = [
                    heights[z + 1][x],
                    heights[z + 1][x + 2],
                    heights[z][x + 1],
                    heights[z + 2][x + 1],
                ]
                .iter()
                .any(|&h| (h - top).abs() >= 3);
                chunk.set(x, MIN_Y, z, blocks::BEDROCK);
                for y in (MIN_Y + 1)..=top.max(SEA_LEVEL) {
                    if y >= MIN_Y + 16 && y < filled_to {
                        continue;
                    }
                    let state = if Self::solid(&line, y) {
                        Self::coating(b, top, y, steep)
                    } else if y <= SEA_LEVEL {
                        if y == SEA_LEVEL && b.freeze {
                            blocks::ICE
                        } else {
                            blocks::WATER
                        }
                    } else {
                        blocks::AIR
                    };
                    if state != blocks::AIR {
                        chunk.set(x, y, z, state);
                    }
                }
            }
        }
        let mut surface = self.chunk_surface_sampler(cx, cz, &grid, &heights);
        let entrances = if caves || trees {
            self.entrances_for_chunk_with_surface(
                cx,
                cz,
                crate::trees::TREE_ENTRANCE_HALO,
                &mut surface,
            )
        } else {
            Vec::new()
        };
        if caves {
            self.caves.carve(&mut chunk, cx, cz, &heights);
            crate::entrances::carve(&entrances, &mut chunk, cx, cz, &heights);
        }
        if ores {
            crate::ores::place(self.seed, &mut chunk, cx, cz);
        }
        if trees {
            self.plant_trees(&mut chunk, cx, cz, &entrances, |x, z| {
                surface(cx * 16 + x, cz * 16 + z)
            });
        }
        chunk
    }

    pub fn spawn_point(&self) -> [i32; 3] {
        let mut radius = SPAWN_RADIUS;
        loop {
            if let Some(point) = self.find_spawn(radius) {
                return point;
            }
            radius *= 2;
        }
    }

    fn find_spawn(&self, radius: i32) -> Option<[i32; 3]> {
        for r in (0..=radius).step_by(SPAWN_STEP as usize) {
            for z in (-r..=r).step_by(SPAWN_STEP as usize) {
                for x in (-r..=r).step_by(SPAWN_STEP as usize) {
                    if x != -r && x != r && z != -r && z != r {
                        continue;
                    }
                    let y = self.surface_y(x, z);
                    if y > SEA_LEVEL {
                        let chunk = self.generate(x.div_euclid(16), z.div_euclid(16));
                        let (lx, lz) = (x.rem_euclid(16) as usize, z.rem_euclid(16) as usize);
                        if blocks::info(chunk.get(lx, y, lz)).solid
                            && (1..=2).all(|dy| chunk.get(lx, y + dy, lz) == blocks::AIR)
                        {
                            return Some([x, y + 1, z]);
                        }
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
                for z in 0..16 {
                    for x in 0..16 {
                        hash.u16(terrain.biome_at(gx * spacing * 16 + x, gz * spacing * 16 + z));
                    }
                }
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

    fn terrain_column(t: &TerrainGenerator, x: i32, z: i32) -> [f64; Y_POINTS] {
        let (gx, gz) = (x.div_euclid(4) * 4, z.div_euclid(4) * 4);
        let c = [
            t.density_line(gx, gz),
            t.density_line(gx + 4, gz),
            t.density_line(gx, gz + 4),
            t.density_line(gx + 4, gz + 4),
        ];
        TerrainGenerator::column(
            c.each_ref(),
            x.rem_euclid(4) as f64 / 4.0,
            z.rem_euclid(4) as f64 / 4.0,
        )
    }

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
                            .find(|&y| {
                                let b = chunk.get(x, y, z);
                                blocks::info(b).solid
                                    && b != blocks::OAK_LOG
                                    && b != blocks::OAK_LEAVES
                            })
                            .unwrap();
                        let (wx, wz) = (cx * 16 + x as i32, cz * 16 + z as i32);
                        let neighbors = [(wx - 1, wz), (wx + 1, wz), (wx, wz - 1), (wx, wz + 1)]
                            .map(|(x, z)| terrain.surface_y(x, z));
                        let shape_top = terrain.surface_y(wx, wz);
                        let b = &BIOMES[terrain.biome_at(wx, wz) as usize];
                        assert_eq!(top, if b.freeze { SEA_LEVEL } else { shape_top });
                        if b.freeze {
                            assert_eq!(chunk.get(x, SEA_LEVEL, z), blocks::ICE);
                        }
                        let steep = [(wx - 1, wz), (wx + 1, wz), (wx, wz - 1), (wx, wz + 1)]
                            .iter()
                            .any(|&(nx, nz)| (terrain.surface_y(nx, nz) - shape_top).abs() >= 3);
                        assert_eq!(chunk.get(x, MIN_Y, z), blocks::BEDROCK);
                        for y in (MIN_Y + 1)..=SEA_LEVEL {
                            if let Some(state) =
                                terrain.caves.is_cave(wx, y, wz, shape_top, neighbors)
                            {
                                assert_eq!(chunk.get(x, y, z), state);
                            } else {
                                assert_ne!(chunk.get(x, y, z), blocks::AIR);
                            }
                        }
                        for depth in 0..=i32::from(b.depth) + 1 {
                            let y = shape_top - depth;
                            if TerrainGenerator::solid(&terrain_column(&terrain, wx, wz), y) {
                                let actual = chunk.get(x, y, z);
                                // Exposed stone can now carry minerals. The ore tests
                                // independently check the exact species and positions.
                                let material =
                                    if (blocks::COAL_ORE..=blocks::GOLD_ORE).contains(&actual) {
                                        blocks::STONE
                                    } else {
                                        actual
                                    };
                                assert_eq!(
                                    material,
                                    TerrainGenerator::coating(b, shape_top, y, steep)
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
                            .find(|&y| {
                                let b = c.get(x, y, z);
                                blocks::info(b).solid
                                    && b != blocks::OAK_LOG
                                    && b != blocks::OAK_LEAVES
                            })
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
    fn spawn_skips_a_dry_candidate_obstructed_by_a_tree() {
        for seed in 0..128 {
            let t = TerrainGenerator::new(seed);
            let top = t.surface_y(0, 0);
            if top <= SEA_LEVEL {
                continue;
            }
            let c = t.generate(0, 0);
            if (1..=2).any(|dy| c.get(0, top + dy, 0) != blocks::AIR) {
                assert_eq!(t.find_spawn(0), None);
                let [x, y, z] = t.spawn_point();
                assert_ne!((x, z), (0, 0));
                let c = t.generate(x.div_euclid(16), z.div_euclid(16));
                for dy in 0..2 {
                    assert_eq!(
                        c.get(x.rem_euclid(16) as usize, y + dy, z.rem_euclid(16) as usize),
                        blocks::AIR
                    );
                }
                return;
            }
        }
        panic!("samples must include an obstructed dry spawn candidate");
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
                        for y in 1..top - 3 - 1 {
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
    fn climate_mapping_spreads_central_fbm_values() {
        let mut bins = [[0usize; 10]; 2];
        for seed in [0, 2026, -71] {
            let t = TerrainGenerator::new(seed);
            for iz in -64..64 {
                for ix in -64..64 {
                    for (i, field) in [&t.temperature, &t.humidity].iter().enumerate() {
                        let raw = field.sample2(ix as f64 * 0.31, iz as f64 * 0.31);
                        let v = if i == 0 {
                            TerrainGenerator::temperature_map(raw)
                        } else {
                            TerrainGenerator::climate_map(raw)
                        };
                        bins[i][((v * 10.0) as usize).min(9)] += 1;
                    }
                }
            }
        }
        eprintln!("temperature/humidity histograms: {bins:?}");
        for count in bins[0] {
            // Temperature retains broad intermediate belts instead of requiring uniformity.
            assert!((500..11000).contains(&count));
        }
        for count in bins[1] {
            assert!((3500..6500).contains(&count));
        }
    }

    #[test]
    fn climate_coverage_and_ties() {
        for kind in [
            TerrainKind::Sea,
            TerrainKind::Shallows,
            TerrainKind::Beach,
            TerrainKind::Land,
            TerrainKind::Mountain,
        ] {
            for ti in 0..=100 {
                for hi in 0..=100 {
                    let (t, h) = (ti as f64 / 100.0, hi as f64 / 100.0);
                    let id = biomes::select(t, h, kind);
                    assert_eq!(BIOMES[id as usize].terrain, kind);
                    // Independent ordered scan also fixes how equal distances resolve.
                    let mut best = (f64::INFINITY, 0);
                    for (i, b) in BIOMES.iter().enumerate().filter(|(_, b)| b.terrain == kind) {
                        let d = (t - (b.temperature[0] + b.temperature[1]) / 2.0).powi(2)
                            + (h - (b.humidity[0] + b.humidity[1]) / 2.0).powi(2);
                        if d < best.0 {
                            best = (d, i);
                        }
                    }
                    assert_eq!(id as usize, best.1);
                }
            }
        }
        assert_eq!(biomes::select(0.385, 0.5, TerrainKind::Sea), 6);
        for gen in [Generator::Flat, Generator::DebugHills] {
            assert_eq!(crate::biome_at(gen, 2026, -17, 16), 0);
        }
    }

    #[test]
    fn biome_distribution_and_representative_surfaces() {
        let mut seen = vec![false; BIOMES.len()];
        for seed in [0, 2026, -71] {
            let t = TerrainGenerator::new(seed);
            let mut counts = vec![0usize; BIOMES.len()];
            let mut land = 0;
            for iz in -256..256 {
                for ix in -256..256 {
                    let (x, z) = (ix * 32, iz * 32);
                    let top = t.surface_y(x, z);
                    let id = t.biome_for_height(x, z, top) as usize;
                    let b = &BIOMES[id];
                    counts[id] += 1;
                    if b.terrain == TerrainKind::Land {
                        land += 1;
                    }
                    if seen[id] {
                        continue;
                    }
                    let steep = [(x - 1, z), (x + 1, z), (x, z - 1), (x, z + 1)]
                        .iter()
                        .any(|&(nx, nz)| (t.surface_y(nx, nz) - top).abs() >= 3);
                    if steep {
                        continue;
                    }
                    seen[id] = true;
                    let c = t.generate(x.div_euclid(16), z.div_euclid(16));
                    let (lx, lz) = (x.rem_euclid(16) as usize, z.rem_euclid(16) as usize);
                    assert_eq!(t.biome_at(x, z) as usize, id);
                    assert_eq!(crate::biome_at(Generator::Terrain, seed, x, z) as usize, id);
                    assert_eq!(
                        c.get(lx, top, lz),
                        if top < SEA_LEVEL {
                            b.underwater
                        } else {
                            b.surface
                        }
                    );
                    if b.name == "dry_sands" {
                        assert_eq!(c.get(lx, top - 1, lz), blocks::SANDSTONE);
                    }
                    if b.name == "quiet_snow" {
                        assert_eq!(c.get(lx, top, lz), blocks::SNOW_BLOCK);
                    }
                    if b.freeze {
                        assert_eq!(c.get(lx, SEA_LEVEL, lz), blocks::ICE);
                        assert_eq!(c.get(lx, SEA_LEVEL - 1, lz), blocks::WATER);
                    }
                    assert_eq!(c, t.generate(x.div_euclid(16), z.div_euclid(16)));
                }
            }
            eprintln!("biomes seed={seed}: {counts:?}");
            for (i, b) in BIOMES.iter().enumerate() {
                if b.terrain == TerrainKind::Land {
                    assert!(counts[i] * 10 < land * 7);
                }
            }
        }
        for (i, b) in BIOMES.iter().enumerate() {
            assert!(seen[i], "missing {}", b.name);
        }
    }

    #[test]
    fn ambient_temperature_changes_gradually() {
        for seed in [2026, 1, 777] {
            let t = TerrainGenerator::new(seed);
            let mut max_delta = 0.0f64;
            for z in (-8192..8192).step_by(128) {
                for x in (-8192..8192).step_by(128) {
                    let (temperature, _) = t.climate_at(x, z, 80);
                    for (nx, nz) in [(x + 16, z), (x, z + 16)] {
                        max_delta = max_delta.max((temperature - t.climate_at(nx, nz, 80).0).abs());
                    }
                    // Height cooling is still applied independently of ambient climate.
                    assert!(
                        (t.climate_at(x, z, 130).0 - (temperature - 0.1).max(0.0)).abs() < 1e-12
                    );
                }
            }
            eprintln!("ambient temperature seed={seed}: max 16-block delta={max_delta:.5}");
            assert!(max_delta < 0.05, "seed={seed}: {max_delta}");
        }
    }

    #[test]
    fn hot_and_cold_neighbours_are_rare() {
        for seed in [2026, 1, 777] {
            let t = TerrainGenerator::new(seed);
            let grid: Vec<_> = (-128..128)
                .flat_map(|iz| {
                    let t = &t;
                    (-128..128).map(move |ix| t.biome_at(ix * 16, iz * 16))
                })
                .collect();
            let (mut pairs, mut abrupt) = (0usize, 0usize);
            let mut contacts = std::collections::BTreeMap::new();
            let hot = |b: &Biome| matches!(b.name, "dry_sands" | "sun_steppe");
            let cold = |b: &Biome| matches!(b.name, "quiet_snow" | "silent_floe");
            let land = |b: &Biome| matches!(b.terrain, TerrainKind::Land | TerrainKind::Beach);
            for z in 0..256 {
                for x in 0..256 {
                    let a = &BIOMES[grid[z * 256 + x] as usize];
                    for (nx, nz) in [(x + 1, z), (x, z + 1)] {
                        if nx >= 256 || nz >= 256 {
                            continue;
                        }
                        let b = &BIOMES[grid[nz * 256 + nx] as usize];
                        // Include coasts to catch steppe/frozen-sea contacts as well.
                        if a.terrain == TerrainKind::Mountain
                            || b.terrain == TerrainKind::Mountain
                            || !(land(a) || land(b))
                        {
                            continue;
                        }
                        pairs += 1;
                        let opposite = (hot(a) && cold(b)) || (cold(a) && hot(b));
                        abrupt += usize::from(opposite);
                        if opposite {
                            let key = if hot(a) {
                                (a.name, b.name)
                            } else {
                                (b.name, a.name)
                            };
                            *contacts.entry(key).or_insert(0usize) += 1;
                        }
                    }
                }
            }
            eprintln!(
                "climate neighbours seed={seed}: {abrupt}/{pairs} ({:.4}%)",
                abrupt as f64 * 100.0 / pairs as f64
            );
            eprintln!("contacts: {contacts:?}");
            assert!(pairs > 10000);
            assert!(abrupt * 200 <= pairs, "seed={seed}: {abrupt}/{pairs}");
        }
    }

    #[test]
    fn border_columns_use_world_coordinates() {
        for seed in [0, 2026, -71] {
            let t = TerrainGenerator::new(seed);
            for (cx, cz) in [(-1, -1), (0, 0), (31, -32)] {
                for (dx, dz) in [(0, 0), (1, 0), (0, 1)] {
                    let (cx, cz) = (cx + dx, cz + dz);
                    let c = t.generate(cx, cz);
                    for i in 0..16 {
                        for (lx, lz) in [(0, i), (15, i), (i, 0), (i, 15)] {
                            let (x, z) = (cx * 16 + lx as i32, cz * 16 + lz as i32);
                            let top = t.surface_y(x, z);
                            let b = &BIOMES[t.biome_at(x, z) as usize];
                            let steep = [(x - 1, z), (x + 1, z), (x, z - 1), (x, z + 1)]
                                .iter()
                                .any(|&(nx, nz)| (t.surface_y(nx, nz) - top).abs() >= 3);
                            let expected = if top < SEA_LEVEL {
                                b.underwater
                            } else if steep {
                                b.slope
                            } else {
                                b.surface
                            };
                            assert_eq!(c.get(lx, top, lz), expected);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn heights_match_pre_biome_baseline() {
        // Captured by running the HEAD (pre-biome) generator on these probes.
        let mut hash = Fnv64::new();
        for seed in [0, 2026, -71] {
            let t = TerrainGenerator::new(seed);
            for z in (-2048..=2048).step_by(64) {
                for x in (-2048..=2048).step_by(64) {
                    hash.u16(t.surface_y(x, z) as u16);
                }
            }
        }
        assert_eq!(hash.finish(), 0xf3c5543374b0b4b8);
    }

    #[test]
    fn caves_match_coordinate_query_and_preserve_surface() {
        use crate::caves::CAVE_WATER_LEVEL;
        for seed in [2026, 0, -71] {
            let t = TerrainGenerator::new(seed);
            let (mut air, mut water) = (0, 0);
            let chunks = (-1..=1).flat_map(|z| (-1..=1).map(move |x| (x, z))).chain([
                (-13, 9),
                (-12, 9),
                (-13, 10),
                (-12, 10),
                (-20, -20),
                (20, 20),
            ]);
            for (cx, cz) in chunks {
                let before = t.generate_features(cx, cz, false, false, false);
                let after = t.generate_features(cx, cz, false, true, false);
                let entrances = t.entrances_for_chunk(cx, cz, 0);
                for z in 0..16 {
                    for x in 0..16 {
                        let (wx, wz) = (cx * 16 + x as i32, cz * 16 + z as i32);
                        let top = t.surface_y(wx, wz);
                        let neighbors = [(wx - 1, wz), (wx + 1, wz), (wx, wz - 1), (wx, wz + 1)]
                            .map(|(x, z)| t.surface_y(x, z));
                        for y in MIN_Y..320 {
                            let old = before.get(x, y, z);
                            let cave = t.caves.is_cave(wx, y, wz, top, neighbors);
                            let passage = entrances.iter().any(|e| e.contains(wx, y, wz))
                                && crate::entrances::removable(
                                    old,
                                    y,
                                    *neighbors.iter().min().unwrap(),
                                );
                            let expected = if passage {
                                blocks::AIR
                            } else if old != blocks::AIR && old != blocks::WATER {
                                cave.unwrap_or(old)
                            } else {
                                old
                            };
                            let support = y <= top
                                && expected == blocks::AIR
                                && entrances.iter().any(|e| e.supports(wx, y, wz));
                            let expected = if support { blocks::STONE } else { expected };
                            assert_eq!(
                                after.get(x, y, z),
                                expected,
                                "seed={seed} at {wx},{y},{wz}"
                            );
                            if y > top - 6 || y < MIN_Y + 6 {
                                assert_eq!(cave, None);
                                if !passage && !support {
                                    assert_eq!(after.get(x, y, z), old);
                                }
                            }
                            if let Some(state) = cave {
                                assert_eq!(
                                    state,
                                    if y <= CAVE_WATER_LEVEL {
                                        blocks::WATER
                                    } else {
                                        blocks::AIR
                                    }
                                );
                                if old != blocks::AIR && old != blocks::WATER {
                                    if state == blocks::WATER {
                                        water += 1;
                                    } else {
                                        air += 1;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            assert!(air > 0 && water > 0);
        }
    }

    #[test]
    fn entrances_open_the_surface_and_preserve_coasts_and_outer_regions() {
        let t = TerrainGenerator::new(2026);
        let mut openings = 0;
        for cz in -20..=20 {
            for cx in -20..=20 {
                // Broad, deterministic probes plus all columns around the closest entrance.
                if (!(-13..=-12).contains(&cx) || !(9..=10).contains(&cz))
                    && (cx % 4 != 0 || cz % 4 != 0)
                {
                    continue;
                }
                let before = t.generate_features(cx, cz, false, false, false);
                let after = t.generate_features(cx, cz, false, true, false);
                let entrances = t.entrances_for_chunk(cx, cz, 0);
                for z in 0..16 {
                    for x in 0..16 {
                        let (wx, wz) = (cx * 16 + x as i32, cz * 16 + z as i32);
                        let top = t.surface_y(wx, wz);
                        for y in top - 5..=top {
                            if !entrances.iter().any(|e| e.contains(wx, y, wz)) {
                                assert_eq!(before.get(x, y, z), after.get(x, y, z));
                            }
                        }
                        if after.get(x, top, z) == blocks::AIR {
                            openings += 1;
                            assert!(entrances.iter().any(|e| e.contains(wx, top, wz)));
                            assert_ne!(before.get(x, top, z), blocks::AIR);
                        }
                    }
                }
            }
        }
        assert!(openings > 0);
    }

    #[test]
    fn spawn_skips_surface_holes() {
        for seed in 0..10000 {
            let t = TerrainGenerator::new(seed);
            let top = t.surface_y(0, 0);
            if !t
                .entrances_for_chunk(0, 0, 0)
                .iter()
                .any(|e| e.contains(0, top, 0))
            {
                continue;
            }
            let c = t.generate(0, 0);
            if c.get(0, top, 0) != blocks::AIR {
                continue;
            }
            assert_eq!(t.find_spawn(0), None);
            let [x, y, z] = t.spawn_point();
            assert_ne!((x, z), (0, 0));
            let c = t.generate(x.div_euclid(16), z.div_euclid(16));
            let (lx, lz) = (x.rem_euclid(16) as usize, z.rem_euclid(16) as usize);
            assert_eq!(y, t.surface_y(x, z) + 1);
            assert!(blocks::info(c.get(lx, y - 1, lz)).solid);
            assert_eq!(c.get(lx, y, lz), blocks::AIR);
            assert_eq!(c.get(lx, y + 1, lz), blocks::AIR);
            return;
        }
        panic!("probes must include a seed with a surface hole at the first spawn candidate");
    }

    #[test]
    fn entrance_regions_cover_a_small_fraction_of_land() {
        for seed in [2026, 0, -71] {
            let t = TerrainGenerator::new(seed);
            let (mut land, mut region) = (0, 0);
            for z in (-4096..4096).step_by(32) {
                for x in (-4096..4096).step_by(32) {
                    let top = t.surface_y(x, z);
                    if top > SEA_LEVEL {
                        land += 1;
                        // Sample the region independently of the coastal exclusion.
                        region += usize::from(
                            t.caves.entrance_value(x, z) > crate::caves::ENTRANCE_THRESHOLD,
                        );
                    }
                }
            }
            let ratio = region as f64 / land as f64;
            eprintln!(
                "entrance region seed={seed}: {region}/{land} = {:.4}%",
                ratio * 100.0
            );
            assert!((0.10..=0.16).contains(&ratio));
        }
    }

    #[test]
    fn cave_air_never_touches_terrain_water() {
        for seed in [2026, 0, -71] {
            let t = TerrainGenerator::new(seed);
            let mut contacts = 0;
            for cz in -10..=10 {
                for cx in -10..=10 {
                    let chunk = t.generate_features(cx, cz, false, true, false);
                    let heights: [[i32; 18]; 18] = std::array::from_fn(|z| {
                        std::array::from_fn(|x| {
                            t.surface_y(cx * 16 + x as i32 - 1, cz * 16 + z as i32 - 1)
                        })
                    });
                    for z in 0..16 {
                        for x in 0..16 {
                            let top = heights[z + 1][x + 1];
                            let lowest = [
                                heights[z + 1][x],
                                heights[z + 1][x + 2],
                                heights[z][x + 1],
                                heights[z + 2][x + 1],
                            ]
                            .into_iter()
                            .min()
                            .unwrap();
                            for y in (crate::caves::CAVE_WATER_LEVEL + 1).max(lowest + 1)
                                ..=SEA_LEVEL.min(top)
                            {
                                contacts += usize::from(chunk.get(x, y, z) == blocks::AIR);
                            }
                        }
                    }
                }
            }
            eprintln!("terrain-water adjacent cave-air blocks seed={seed}: {contacts}");
            assert_eq!(contacts, 0);
        }
    }

    #[test]
    fn cave_volume_ratio() {
        for seed in [2026, 0, -71] {
            let t = TerrainGenerator::new(seed);
            let (mut carved, mut volume, mut pools) = (0u64, 0u64, 0usize);
            // 81 spaced chunks cover 1 km square, with every underground block counted.
            for cz in -4..=4 {
                for cx in -4..=4 {
                    let (cx, cz) = (cx * 8, cz * 8);
                    let before = t.generate_features(cx, cz, false, false, false);
                    let after = t.generate_features(cx, cz, false, true, false);
                    let entrances = t.entrances_for_chunk(cx, cz, 0);
                    for z in 0..16 {
                        for x in 0..16 {
                            let top = t.surface_y(cx * 16 + x as i32, cz * 16 + z as i32);
                            let level = crate::caves::CAVE_WATER_LEVEL;
                            pools += usize::from(
                                after.get(x, level, z) == blocks::WATER
                                    && after.get(x, level + 1, z) == blocks::AIR
                                    && before.get(x, level, z) == blocks::STONE
                                    && before.get(x, level + 1, z) == blocks::STONE,
                            );
                            for y in -56..=top - 6 {
                                volume += 1;
                                carved += u64::from(before.get(x, y, z) != after.get(x, y, z));
                            }
                            // Protected roof blocks are identical, including sea floors.
                            for y in top - 5..=top {
                                let (wx, wz) = (cx * 16 + x as i32, cz * 16 + z as i32);
                                if !entrances.iter().any(|e| e.contains(wx, y, wz)) {
                                    assert_eq!(before.get(x, y, z), after.get(x, y, z));
                                }
                            }
                        }
                    }
                }
            }
            let ratio = carved as f64 / volume as f64;
            eprintln!(
                "caves seed={seed}: {carved}/{volume} = {:.4}%",
                ratio * 100.0
            );
            assert!((0.04..=0.08).contains(&ratio));
            assert!(
                pools > 0,
                "seed={seed}: no groundwater pool in broad probes"
            );
        }
    }

    #[test]
    fn surface_metadata_baseline() {
        let mut h = Fnv64::new();
        for seed in [2026, 0, -71] {
            let t = TerrainGenerator::new(seed);
            for v in t.spawn_point() {
                h.u16(v as u16);
            }
            for cz in -2..=2 {
                for cx in -2..=2 {
                    for b in t.biome_cells(cx, cz) {
                        h.u16(b);
                    }
                    for z in 0..16 {
                        for x in 0..16 {
                            let (x, z) = (cx * 16 + x, cz * 16 + z);
                            h.u16(t.surface_y(x, z) as u16);
                            h.u16(t.biome_at(x, z));
                        }
                    }
                }
            }
        }
        // Captured before caves: surface_y, biome_at, biome_cells and spawn_point.
        assert_eq!(h.finish(), 13697186662624202043);
    }

    #[test]
    fn entrance_surface_sampler_matches_geological_queries() {
        for seed in [2026, 0, -71] {
            let t = TerrainGenerator::new(seed);
            for [dx, dz] in [[1, 0], [-1, 0], [0, 1], [0, -1]] {
                let mut sample = t.surface_sampler();
                for (x, z) in [(-17, 15), (16, -33)] {
                    for step in -39..=39 {
                        let (x, z) = (x + dx * step, z + dz * step);
                        assert_eq!(sample(x, z), t.surface_y(x, z));
                    }
                }
            }
        }
    }

    #[test]
    fn terrain_reference_fingerprint() {
        assert_eq!(terrain_fingerprint(2026), 0x7ec6cedb74055722);
    }
}
