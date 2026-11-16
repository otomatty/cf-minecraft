//! Original sloping entrance passages, owned by world-aligned plots.
use jmath::mix_stafford13;
use std::{collections::BTreeMap, rc::Rc};
use world::{blocks, BlockState, Chunk, MIN_Y};

use crate::{caves::ENTRANCE_THRESHOLD, TerrainGenerator, SEA_LEVEL};

const PLOT_SIZE: i32 = 32;
pub(crate) const MAX_ENTRANCE_REACH: i32 = 40;
const SALT: u64 = 0x6e31_a954_b807_2dda;
const CHANCE: f64 = 0.65;
const MAX_STEPS: i32 = 36;
const APRON_STEPS: i32 = 36;
const PROFILE_START: i32 = -APRON_STEPS - 3;
const FOOTPRINT_REACH: i32 = MAX_STEPS + 3;
const FOOTPRINT_ROWS: usize = (2 * FOOTPRINT_REACH + 1) as usize;
const _: () = assert!(APRON_STEPS <= MAX_STEPS);
const MIN_ENTRANCE_Y: i32 = crate::caves::CAVE_WATER_LEVEL + 1;
const _: () = assert!(MIN_ENTRANCE_Y >= MIN_Y + 6);
const _: () = assert!((MAX_STEPS + 3).pow(2) + 4 * 4 <= MAX_ENTRANCE_REACH.pow(2));

#[derive(Clone)]
pub(crate) struct Entrance {
    pub(crate) root: [i32; 3],
    centers: Vec<[f64; 3]>,
    radius: f64,
    direction: [i32; 2],
    slope: f64,
    floors: Vec<i32>,
    footprint: Option<[u16; FOOTPRINT_ROWS]>,
}

impl Entrance {
    fn floor_at(&self, x: i32, z: i32) -> i32 {
        let [dx, dz] = self.direction;
        let progress = (x - self.root[0]) * dx + (z - self.root[2]) * dz;
        if !self.floors.is_empty() {
            let index = (progress - PROFILE_START).clamp(0, self.floors.len() as i32 - 1) as usize;
            self.floors[index]
        } else if progress < 0 {
            self.root[1] - progress
        } else {
            self.root[1] - (self.slope * progress as f64).floor() as i32
        }
    }

    fn fit_floor(&mut self, mut surface: impl FnMut(i32, i32) -> i32) -> bool {
        let [dx, dz] = self.direction;
        let end = self.centers.len() as i32 - 1 + 3;
        let heights: Vec<_> = (PROFILE_START..=end)
            .map(|step| surface(self.root[0] + dx * step, self.root[2] + dz * step))
            .collect();
        let base: Vec<_> = (PROFILE_START..=end)
            .zip(&heights)
            .map(|(step, &top)| {
                self.floor_at(self.root[0] + dx * step, self.root[2] + dz * step)
                    .min(top)
            })
            .collect();
        // Use the shortest uphill apron that meets dry ground. Do not let a
        // distant valley behind the mouth lower an otherwise usable entrance.
        for apron in 0..=APRON_STEPS {
            let start = -apron - 3;
            let offset = (start - PROFILE_START) as usize;
            let mut floors = base[offset..].to_vec();
            for i in 1..floors.len() {
                floors[i] = floors[i].min(floors[i - 1] + 1);
            }
            for i in (0..floors.len() - 1).rev() {
                floors[i] = floors[i].min(floors[i + 1] + 1);
            }
            let landing = (-apron - 4).clamp(PROFILE_START, -5);
            if floors[0] != heights[offset]
                || heights[offset] <= SEA_LEVEL
                || heights[(landing - PROFILE_START) as usize] <= SEA_LEVEL
            {
                continue;
            }
            // Keep the common profile index origin while retaining only the
            // chosen apron in the horizontal footprint.
            self.floors = vec![floors[0]; offset];
            self.floors.extend(floors);
            let mut centers: Vec<_> = (-apron..0)
                .map(|step| {
                    [
                        (self.root[0] + dx * step) as f64,
                        self.floor_at(self.root[0] + dx * step, self.root[2] + dz * step) as f64,
                        (self.root[2] + dz * step) as f64,
                    ]
                })
                .collect();
            centers.append(&mut self.centers);
            self.centers = centers;
            // A lattice lookup replaces repeated sphere scans during overlap
            // tests and crown checks. Enumeration order stays unchanged.
            let mut footprint = [0u16; FOOTPRINT_ROWS];
            self.columns(|x, _, z| {
                let progress = (x - self.root[0]) * dx + (z - self.root[2]) * dz;
                let side = -(x - self.root[0]) * dz + (z - self.root[2]) * dx;
                debug_assert!((-FOOTPRINT_REACH..=FOOTPRINT_REACH).contains(&progress));
                debug_assert!((-4..=4).contains(&side));
                footprint[(progress + FOOTPRINT_REACH) as usize] |= 1u16 << (side + 4);
            });
            self.footprint = Some(footprint);
            return true;
        }
        false
    }

    fn covers(&self, x: i32, z: i32) -> bool {
        if let Some(footprint) = &self.footprint {
            let [dx, dz] = self.direction;
            let progress = (x - self.root[0]) * dx + (z - self.root[2]) * dz;
            let side = -(x - self.root[0]) * dz + (z - self.root[2]) * dx;
            return (-FOOTPRINT_REACH..=FOOTPRINT_REACH).contains(&progress)
                && (-4..=4).contains(&side)
                && footprint[(progress + FOOTPRINT_REACH) as usize] & (1u16 << (side + 4)) != 0;
        }
        self.centers.iter().any(|&[cx, _, cz]| {
            let dx = x as f64 - cx;
            let dz = z as f64 - cz;
            dx * dx + dz * dz <= self.radius * self.radius
        })
    }

    #[cfg(test)]
    pub(crate) fn supports(&self, x: i32, y: i32, z: i32) -> bool {
        y >= MIN_ENTRANCE_Y && y == self.floor_at(x, z) && self.covers(x, z)
    }

    fn bounds(&self) -> [i32; 4] {
        let end = self.centers.last().unwrap();
        let x = end[0].floor() as i32;
        let z = end[2].floor() as i32;
        let (sx, sz) = if self.floors.is_empty() {
            (
                self.root[0] - self.direction[0] * APRON_STEPS,
                self.root[2] - self.direction[1] * APRON_STEPS,
            )
        } else {
            (
                self.centers[0][0].floor() as i32,
                self.centers[0][2].floor() as i32,
            )
        };
        [sx.min(x) - 4, sx.max(x) + 4, sz.min(z) - 4, sz.max(z) + 4]
    }

    fn overlap_bounds(&self, other: &Self) -> Option<[i32; 4]> {
        overlap_bounds(self.bounds(), other.bounds())
    }

    fn conflicts(&self, other: &Self) -> bool {
        let Some([min_x, max_x, min_z, max_z]) = self.overlap_bounds(other) else {
            return false;
        };
        for z in min_z..=max_z {
            for x in min_x..=max_x {
                let delta = (self.floor_at(x, z) - other.floor_at(x, z)).abs();
                if (1..=4).contains(&delta) && self.covers(x, z) && other.covers(x, z) {
                    return true;
                }
            }
        }
        false
    }

    pub(crate) fn contains(&self, x: i32, y: i32, z: i32) -> bool {
        if (x - self.root[0]).abs() > 39 || (z - self.root[2]).abs() > 39 {
            return false;
        }
        let floor = self.floor_at(x, z);
        y > floor && y <= floor + 4 && self.covers(x, z)
    }

    // All overlapping cross sections use the same column floor. A later section
    // can never remove an earlier stair tread, including the mouth's first step.
    fn columns(&self, mut emit: impl FnMut(i32, i32, i32)) {
        for &[cx, _, cz] in &self.centers {
            let min_z = -((-(cz - self.radius)).floor());
            let min_x = -((-(cx - self.radius)).floor());
            for z in min_z as i32..=(cz + self.radius).floor() as i32 {
                for x in min_x as i32..=(cx + self.radius).floor() as i32 {
                    let dx = x as f64 - cx;
                    let dz = z as f64 - cz;
                    if dx * dx + dz * dz <= self.radius * self.radius {
                        debug_assert!(
                            (x - self.root[0]).pow(2) + (z - self.root[2]).pow(2)
                                <= MAX_ENTRANCE_REACH.pow(2)
                        );
                        emit(x, self.floor_at(x, z), z);
                    }
                }
            }
        }
    }

    fn blocks(&self, mut emit: impl FnMut(i32, i32, i32)) {
        self.columns(|x, floor, z| {
            for y in floor + 1..=floor + 4 {
                emit(x, y, z);
            }
        });
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

// Everything here is known before evaluating geological heights.
#[derive(Clone, Copy)]
struct EntranceSpec {
    x: i32,
    z: i32,
    direction: [i32; 2],
    slope: f64,
    radius: f64,
    steps: i32,
    sign: f64,
}

impl EntranceSpec {
    fn center(self, top: i32, step: i32) -> [f64; 3] {
        let [dx, dz] = self.direction;
        let phase = (step % 16) as f64 / 8.0;
        let side = self.sign * if phase <= 1.0 { phase } else { 2.0 - phase };
        [
            self.x as f64 + (dx * step) as f64 - dz as f64 * side,
            top as f64 - self.slope * step as f64,
            self.z as f64 + (dz * step) as f64 + dx as f64 * side,
        ]
    }

    fn bounds(self) -> [i32; 4] {
        let end = self.center(0, self.steps);
        let (x, z) = (end[0].floor() as i32, end[2].floor() as i32);
        let (sx, sz) = (
            self.x - self.direction[0] * APRON_STEPS,
            self.z - self.direction[1] * APRON_STEPS,
        );
        [sx.min(x) - 4, sx.max(x) + 4, sz.min(z) - 4, sz.max(z) + 4]
    }

    fn build(self, top: i32) -> Entrance {
        Entrance {
            root: [self.x, top, self.z],
            centers: (0..=self.steps)
                .map(|step| self.center(top, step))
                .collect(),
            radius: self.radius,
            direction: self.direction,
            slope: self.slope,
            floors: Vec::new(),
            footprint: None,
        }
    }
}

fn overlap_bounds(a: [i32; 4], b: [i32; 4]) -> Option<[i32; 4]> {
    let bounds = [
        a[0].max(b[0]),
        a[1].min(b[1]),
        a[2].max(b[2]),
        a[3].min(b[3]),
    ];
    (bounds[0] <= bounds[1] && bounds[2] <= bounds[3]).then_some(bounds)
}

struct CachedCandidate {
    spec: Option<EntranceSpec>,
    fitted: Option<Rc<Entrance>>,
    evaluated: bool,
}

// One query owns all state. Nothing is retained on the shared TerrainGenerator.
struct EntranceQuery<'a, S> {
    terrain: &'a TerrainGenerator,
    surface: S,
    candidates: BTreeMap<(i32, i32), CachedCandidate>,
}

impl<S: FnMut(i32, i32) -> i32> EntranceQuery<'_, S> {
    fn spec(&mut self, qx: i32, qz: i32) -> Option<EntranceSpec> {
        self.candidates
            .entry((qx, qz))
            .or_insert_with(|| CachedCandidate {
                spec: self.terrain.entrance_spec(qx, qz),
                fitted: None,
                evaluated: false,
            })
            .spec
    }

    fn fitted(&mut self, qx: i32, qz: i32) -> Option<Rc<Entrance>> {
        let spec = self.spec(qx, qz)?;
        if !self.candidates[&(qx, qz)].evaluated {
            let top = (self.surface)(spec.x, spec.z);
            let fitted = if top > SEA_LEVEL + 2 {
                let mut entrance = spec.build(top);
                entrance
                    .fit_floor(&mut self.surface)
                    .then(|| Rc::new(entrance))
            } else {
                None
            };
            let cached = self.candidates.get_mut(&(qx, qz)).unwrap();
            cached.fitted = fitted;
            cached.evaluated = true;
        }
        self.candidates[&(qx, qz)].fitted.clone()
    }

    fn entrance(&mut self, qx: i32, qz: i32) -> Option<Rc<Entrance>> {
        let candidate = self.fitted(qx, qz)?;
        for nz in qz - 3..=qz + 3 {
            for nx in qx - 3..=qx + 3 {
                if (nz, nx) >= (qz, qx) {
                    continue;
                }
                let Some(other) = self.spec(nx, nz) else {
                    continue;
                };
                // Exactly the former raw-candidate rectangle, without density_line.
                if overlap_bounds(candidate.bounds(), other.bounds()).is_none() {
                    continue;
                }
                if let Some(other) = self.fitted(nx, nz) {
                    if candidate.conflicts(&other) {
                        return None;
                    }
                }
            }
        }
        Some(candidate)
    }
}

impl TerrainGenerator {
    fn entrance_spec(&self, qx: i32, qz: i32) -> Option<EntranceSpec> {
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
        let direction = [(1, 0), (0, 1), (-1, 0), (0, -1)][((shape >> 10) & 3) as usize];
        let slope = 0.75 + ((shape >> 12) % 3) as f64 * 0.025;
        let depth = 24 + ((shape >> 14) % 4) as i32;
        let radius = 1.75 + ((shape >> 16) % 3) as f64 * 0.25;
        let steps = -((-(depth as f64 / slope)).floor());
        Some(EntranceSpec {
            x,
            z,
            direction: [direction.0, direction.1],
            slope,
            radius,
            steps: (steps as i32).min(MAX_STEPS),
            sign: if shape & (1 << 20) == 0 { -1.0 } else { 1.0 },
        })
    }

    #[cfg(test)]
    pub(crate) fn entrance(&self, qx: i32, qz: i32) -> Option<Entrance> {
        let mut query = EntranceQuery {
            terrain: self,
            surface: self.surface_sampler(),
            candidates: BTreeMap::new(),
        };
        let result = query.entrance(qx, qz);
        drop(query);
        result.map(Rc::unwrap_or_clone)
    }

    #[cfg(test)]
    pub(crate) fn entrances_for_chunk(&self, cx: i32, cz: i32, halo: i32) -> Vec<Entrance> {
        self.entrances_for_chunk_with_surface(cx, cz, halo, self.surface_sampler())
    }

    pub(crate) fn entrances_for_chunk_with_surface(
        &self,
        cx: i32,
        cz: i32,
        halo: i32,
        surface: impl FnMut(i32, i32) -> i32,
    ) -> Vec<Entrance> {
        let reach = MAX_ENTRANCE_REACH + halo;
        let mut query = EntranceQuery {
            terrain: self,
            surface,
            candidates: BTreeMap::new(),
        };
        let mut result = Vec::new();
        // Root and crown halos both count: keep whole-tree decisions identical.
        let interest = [
            cx * 16 - 2 * halo,
            cx * 16 + 15 + 2 * halo,
            cz * 16 - 2 * halo,
            cz * 16 + 15 + 2 * halo,
        ];
        for qz in
            (cz * 16 - reach).div_euclid(PLOT_SIZE)..=(cz * 16 + 15 + reach).div_euclid(PLOT_SIZE)
        {
            for qx in (cx * 16 - reach).div_euclid(PLOT_SIZE)
                ..=(cx * 16 + 15 + reach).div_euclid(PLOT_SIZE)
            {
                let Some(spec) = query.spec(qx, qz) else {
                    continue;
                };
                if overlap_bounds(spec.bounds(), interest).is_none() {
                    continue;
                }
                if let Some(entrance) = query.entrance(qx, qz) {
                    result.push(entrance);
                }
            }
        }
        drop(query);
        result.into_iter().map(Rc::unwrap_or_clone).collect()
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
    // Repair missing treads only inside the geological terrain. Never build a
    // bridge or a raised apron in the air. Repair after every passage has carved.
    for entrance in entrances {
        entrance.columns(|x, floor, z| {
            let (x, z) = (x - cx * 16, z - cz * 16);
            if !(0..16).contains(&x) || !(0..16).contains(&z) {
                return;
            }
            let (x, z) = (x as usize, z as usize);
            if floor >= MIN_ENTRANCE_Y
                && floor <= heights[z + 1][x + 1]
                && chunk.get(x, floor, z) == blocks::AIR
            {
                chunk.set(x, floor, z, blocks::STONE);
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

    fn uncached_entrance(t: &TerrainGenerator, qx: i32, qz: i32) -> Option<Entrance> {
        let spec = t.entrance_spec(qx, qz)?;
        let top = t.surface_y(spec.x, spec.z);
        if top <= SEA_LEVEL + 2 {
            return None;
        }
        let mut candidate = spec.build(top);
        if !candidate.fit_floor(t.surface_sampler()) {
            return None;
        }
        for nz in qz - 3..=qz + 3 {
            for nx in qx - 3..=qx + 3 {
                if (nz, nx) >= (qz, qx) {
                    continue;
                }
                let Some(spec) = t.entrance_spec(nx, nz) else {
                    continue;
                };
                let top = t.surface_y(spec.x, spec.z);
                if top <= SEA_LEVEL + 2 {
                    continue;
                }
                let mut other = spec.build(top);
                if candidate.overlap_bounds(&other).is_none() {
                    continue;
                }
                if other.fit_floor(t.surface_sampler()) && candidate.conflicts(&other) {
                    return None;
                }
            }
        }
        Some(candidate)
    }

    #[test]
    fn cached_chunk_queries_match_uncached_reference_and_keep_generator_shareable() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<TerrainGenerator>();
        let mut compared = 0;
        for seed in [2026, 0, -71] {
            let t = TerrainGenerator::new(seed);
            for (cx, cz) in [(-12, 11), (-12, 12), (12, 1), (0, 0), (-1, -1)] {
                let halo = crate::trees::MAX_CROWN_RADIUS;
                let reach = MAX_ENTRANCE_REACH + halo;
                let mut expected = Vec::new();
                for qz in (cz * 16 - reach).div_euclid(PLOT_SIZE)
                    ..=(cz * 16 + 15 + reach).div_euclid(PLOT_SIZE)
                {
                    for qx in (cx * 16 - reach).div_euclid(PLOT_SIZE)
                        ..=(cx * 16 + 15 + reach).div_euclid(PLOT_SIZE)
                    {
                        if let Some(e) = uncached_entrance(&t, qx, qz) {
                            expected.push(e);
                        }
                    }
                }
                let actual = t.entrances_for_chunk(cx, cz, halo);
                let geometry = |entries: &[Entrance]| {
                    let mut air = BTreeSet::new();
                    let mut floors = BTreeSet::new();
                    for e in entries {
                        e.columns(|x, y, z| {
                            if (cx * 16 - 2 * halo..=cx * 16 + 15 + 2 * halo).contains(&x)
                                && (cz * 16 - 2 * halo..=cz * 16 + 15 + 2 * halo).contains(&z)
                            {
                                floors.insert([x, y, z]);
                                for y in y + 1..=y + 4 {
                                    air.insert([x, y, z]);
                                }
                            }
                        });
                    }
                    (air, floors)
                };
                let expected = geometry(&expected);
                compared += expected.0.len();
                assert_eq!(geometry(&actual), expected, "seed={seed}, chunk={cx},{cz}");
            }
        }
        assert!(compared > 100);
    }

    #[test]
    fn fitted_candidate_is_reused_without_more_height_queries() {
        use std::cell::Cell;
        let t = TerrainGenerator::new(2026);
        let calls = Cell::new(0);
        let mut surface = t.surface_sampler();
        let mut query = EntranceQuery {
            terrain: &t,
            candidates: BTreeMap::new(),
            surface: |x, z| {
                calls.set(calls.get() + 1);
                surface(x, z)
            },
        };
        let mut found = None;
        'plots: for qz in -13..=12 {
            for qx in -13..=12 {
                if let Some(e) = query.fitted(qx, qz) {
                    found = Some((qx, qz, e));
                    break 'plots;
                }
            }
        }
        let (qx, qz, first) = found.unwrap();
        let before = calls.get();
        let second = query.fitted(qx, qz).unwrap();
        assert!(Rc::ptr_eq(&first, &second));
        assert_eq!(calls.get(), before);
    }

    #[test]
    fn cached_footprints_match_direct_sphere_union() {
        for seed in [2026, 0, -71] {
            let t = TerrainGenerator::new(seed);
            let entries: Vec<_> = (-13..=12)
                .flat_map(|z| (-13..=12).map(move |x| (x, z)))
                .filter_map(|(x, z)| t.entrance(x, z))
                .take(5)
                .collect();
            assert!(!entries.is_empty());
            for e in entries {
                assert!(e.footprint.is_some());
                for z in e.root[2] - 41..=e.root[2] + 41 {
                    for x in e.root[0] - 41..=e.root[0] + 41 {
                        let expected = e.centers.iter().any(|&[cx, _, cz]| {
                            let dx = x as f64 - cx;
                            let dz = z as f64 - cz;
                            dx * dx + dz * dz <= e.radius * e.radius
                        });
                        assert_eq!(e.covers(x, z), expected, "root={:?}, point={x},{z}", e.root);
                    }
                }
            }
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
                    assert!(e.floor_at(x, z) <= top);
                    assert!(!e.contains(x, e.floor_at(x, z), z));
                    assert!(t.caves.entrance_value(x, z) > ENTRANCE_THRESHOLD);
                    assert!(e.centers.len() <= (MAX_STEPS + APRON_STEPS) as usize + 1);
                    let drop = top as f64 - e.centers.last().unwrap()[1];
                    assert!((24.0..28.0).contains(&drop));
                    let list: BTreeSet<_> = e.block_list().into_iter().collect();
                    for &[bx, by, bz] in &list {
                        assert!((bx - x).pow(2) + (bz - z).pow(2) <= MAX_ENTRANCE_REACH.pow(2));
                        assert!(e.contains(bx, by, bz));
                        assert!(by > e.floor_at(bx, bz));
                        assert!(
                            (e.floor_at(bx + e.direction[0], bz + e.direction[1])
                                - e.floor_at(bx, bz))
                            .abs()
                                <= 1
                        );
                        crossed += usize::from(
                            (bx.div_euclid(16), bz.div_euclid(16))
                                != (x.div_euclid(16), z.div_euclid(16)),
                        );
                    }
                    // Each sampled center has a vertical pair of air voxels for headroom.
                    for &[cx, _, cz] in &e.centers {
                        let (bx, by, bz) = (
                            round_ties_away(cx) as i32,
                            e.floor_at(round_ties_away(cx) as i32, round_ties_away(cz) as i32) + 1,
                            round_ties_away(cz) as i32,
                        );
                        assert!(list.contains(&[bx, by, bz]) && list.contains(&[bx, by + 1, bz]));
                    }
                }
            }
        }
        assert!(found > 20 && crossed > 100);
    }

    fn synthetic_entrance(direction: [i32; 2], radius: f64, sign: f64, slope: f64) -> Entrance {
        let [dx, dz] = direction;
        let root = [0, 100, 0];
        let centers = (0..=MAX_STEPS)
            .map(|step| {
                let phase = (step % 16) as f64 / 8.0;
                let side = sign * if phase <= 1.0 { phase } else { 2.0 - phase };
                [
                    (dx * step) as f64 - dz as f64 * side,
                    root[1] as f64 - slope * step as f64,
                    (dz * step) as f64 + dx as f64 * side,
                ]
            })
            .collect();
        Entrance {
            root,
            centers,
            radius,
            direction,
            slope,
            floors: Vec::new(),
            footprint: None,
        }
    }

    fn walk_back(
        e: &Entrance,
        state: impl Fn(i32, i32, i32) -> BlockState,
        surface: impl Fn(i32, i32) -> i32,
    ) -> u32 {
        use physics::{BlockWorld, Input, Player};
        let world = BlockWorld(|x, y, z| Some(state(x, y, z)));
        let mut floors = Vec::new();
        e.columns(|x, floor, z| {
            floors.push((
                floor,
                (x - e.root[0]) * e.direction[1] - (z - e.root[2]) * e.direction[0],
                x,
                z,
            ))
        });
        floors.sort_by_key(|&(floor, side, x, z)| (floor, side.abs(), x, z));
        let (_, _, bx, bz) = floors[0];
        let mut player = Player::new([
            bx as f64 + 0.5,
            (e.floor_at(bx, bz) + 1) as f64,
            bz as f64 + 0.5,
        ]);
        assert!(blocks::info(state(bx, e.floor_at(bx, bz), bz)).solid);
        assert!(
            player.is_clear(&world),
            "blocked start {:?}: {:?}",
            e.root,
            player.position
        );
        let [dx, dz] = e.direction;
        let yaw = match [dx, dz] {
            [1, 0] => 90.0,
            [-1, 0] => 270.0,
            [0, 1] => 180.0,
            [0, -1] => 0.0,
            _ => unreachable!(),
        };
        for tick in 0..2400 {
            // The straight centerline remains within both directions of the one-block sway.
            player.tick(
                Input {
                    forward: 1.0,
                    jump: true,
                    yaw,
                    ..Input::default()
                },
                &world,
            );
            let [x, y, z] = player.position;
            let progress =
                (x - e.root[0] as f64 - 0.5) * dx as f64 + (z - e.root[2] as f64 - 0.5) * dz as f64;
            if progress < -4.0
                && player.on_ground
                && y == (surface(x.floor() as i32, z.floor() as i32) + 1) as f64
                && !e.covers(x.floor() as i32, z.floor() as i32)
                && surface(x.floor() as i32, z.floor() as i32) > SEA_LEVEL
            {
                assert!(
                    blocks::info(state(x.floor() as i32, y as i32 - 1, z.floor() as i32)).solid
                );
                assert!(player.is_clear(&world));
                return tick;
            }
        }
        for step in 0..=2 {
            let x = player.position[0].floor() as i32 - e.direction[0] * step;
            let z = player.position[2].floor() as i32 - e.direction[1] * step;
            let y = player.position[1].floor() as i32;
            eprintln!(
                "blocked route ({x},{y},{z}), floor={}, states={:?}",
                e.floor_at(x, z),
                (y - 1..=y + 5).map(|y| state(x, y, z)).collect::<Vec<_>>()
            );
        }
        panic!(
            "cannot walk out root={:?}, dir={:?}, radius={}, slope={}, end={:?}",
            e.root, e.direction, e.radius, e.slope, player
        );
    }

    #[test]
    fn player_can_return_from_all_shapes_on_flat_and_sloping_ground() {
        for direction in [[1, 0], [-1, 0], [0, 1], [0, -1]] {
            for radius in [1.75, 2.0, 2.25] {
                for sign in [-1.0, 1.0] {
                    for slope in [0.75, 0.775, 0.8] {
                        for grade in [-1.0, -0.5, 0.0, 0.5, 1.0] {
                            let surface = |x: i32, z: i32| {
                                100 + (grade * (x * direction[0] + z * direction[1]) as f64).floor()
                                    as i32
                            };
                            let mut e = synthetic_entrance(direction, radius, sign, slope);
                            assert!(e.fit_floor(surface));
                            let cut: BTreeSet<_> = e.block_list().into_iter().collect();
                            let mut floors = BTreeSet::new();
                            e.columns(|x, y, z| {
                                floors.insert([x, y, z]);
                            });
                            walk_back(
                                &e,
                                |x, y, z| {
                                    if floors.contains(&[x, y, z]) && y <= surface(x, z) {
                                        blocks::STONE
                                    } else if cut.contains(&[x, y, z]) || y > surface(x, z) {
                                        blocks::AIR
                                    } else {
                                        blocks::STONE
                                    }
                                },
                                surface,
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn player_can_return_from_real_entrances_in_distance_order() {
        use std::collections::BTreeMap;
        for seed in [2026, 0, 1, -71] {
            let t = TerrainGenerator::new(seed);
            let mut entrances: Vec<_> = (-13..=12)
                .flat_map(|z| (-13..=12).map(move |x| (x, z)))
                .filter_map(|(x, z)| t.entrance(x, z))
                .collect();
            entrances.sort_by_key(|e| e.root[0] * e.root[0] + e.root[2] * e.root[2]);
            assert!(entrances.len() >= if seed == 2026 { 5 } else { 1 });
            for e in entrances {
                let mut chunks = BTreeMap::new();
                for z in (e.root[2] - 48).div_euclid(16)..=(e.root[2] + 48).div_euclid(16) {
                    for x in (e.root[0] - 48).div_euclid(16)..=(e.root[0] + 48).div_euclid(16) {
                        chunks.insert((x, z), t.generate(x, z));
                    }
                }
                walk_back(
                    &e,
                    |x, y, z| {
                        chunks
                            .get(&(x.div_euclid(16), z.div_euclid(16)))
                            .map(|c| c.get(x.rem_euclid(16) as usize, y, z.rem_euclid(16) as usize))
                            .unwrap_or(blocks::STONE)
                    },
                    |x, z| t.surface_y(x, z),
                );
            }
        }
    }

    #[test]
    fn floor_repairs_never_add_stone_above_synthetic_surfaces() {
        let mut repaired = 0;
        let mut skipped = 0;
        for direction in [[1, 0], [-1, 0], [0, 1], [0, -1]] {
            for radius in [1.75, 2.0, 2.25] {
                for bend in [-1.0, 1.0] {
                    for grade in [-1.0, 0.0, 1.0] {
                        // Deliberately retain the raw planned floor: both the rear
                        // apron and the downhill side can be above this surface.
                        let e = synthetic_entrance(direction, radius, bend, 0.775);
                        let surface = |x: i32, z: i32| {
                            100 + (grade * (x * direction[0] + z * direction[1]) as f64).floor()
                                as i32
                        };
                        let mut coords = BTreeSet::new();
                        e.columns(|x, _, z| {
                            coords.insert((x.div_euclid(16), z.div_euclid(16)));
                        });
                        for (cx, cz) in coords {
                            let heights: [[i32; 18]; 18] = std::array::from_fn(|z| {
                                std::array::from_fn(|x| {
                                    surface(cx * 16 + x as i32 - 1, cz * 16 + z as i32 - 1)
                                })
                            });
                            let mut chunk = Chunk::empty(cx, cz);
                            for z in 0..16 {
                                for x in 0..16 {
                                    chunk.set(x, heights[z + 1][x + 1], z, blocks::DIRT);
                                }
                            }
                            carve(std::slice::from_ref(&e), &mut chunk, cx, cz, &heights);
                            e.columns(|wx, floor, wz| {
                                let (x, z) = (wx - cx * 16, wz - cz * 16);
                                if !(0..16).contains(&x) || !(0..16).contains(&z) {
                                    return;
                                }
                                let (x, z) = (x as usize, z as usize);
                                let top = heights[z + 1][x + 1];
                                if floor > top {
                                    skipped += 1;
                                    assert_eq!(chunk.get(x, floor, z), blocks::AIR);
                                } else if floor < top && floor >= MIN_ENTRANCE_Y {
                                    repaired += 1;
                                    assert_eq!(chunk.get(x, floor, z), blocks::STONE);
                                }
                            });
                            for z in 0..16 {
                                for x in 0..16 {
                                    for y in heights[z + 1][x + 1] + 1..MIN_Y + world::HEIGHT {
                                        assert_eq!(chunk.get(x, y, z), blocks::AIR);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        assert!(repaired > 0 && skipped > 0);
    }

    #[test]
    fn floor_repairs_never_add_stone_above_real_surfaces() {
        let t = TerrainGenerator::new(2026);
        let mut entrances: Vec<_> = (-13..=12)
            .flat_map(|z| (-13..=12).map(move |x| (x, z)))
            .filter_map(|(x, z)| t.entrance(x, z))
            .collect();
        entrances.sort_by_key(|e| e.root[0] * e.root[0] + e.root[2] * e.root[2]);
        assert!(entrances.len() >= 5);
        let mut coords = BTreeSet::new();
        for e in entrances.iter().take(5) {
            e.columns(|x, _, z| {
                coords.insert((x.div_euclid(16), z.div_euclid(16)));
            });
        }
        for (cx, cz) in coords {
            let heights: [[i32; 18]; 18] = std::array::from_fn(|z| {
                std::array::from_fn(|x| t.surface_y(cx * 16 + x as i32 - 1, cz * 16 + z as i32 - 1))
            });
            let mut before = t.generate_features(cx, cz, false, false, false);
            t.caves.carve(&mut before, cx, cz, &heights);
            let mut after = before.clone();
            carve(
                &t.entrances_for_chunk(cx, cz, 0),
                &mut after,
                cx,
                cz,
                &heights,
            );
            for z in 0..16 {
                for x in 0..16 {
                    for y in heights[z + 1][x + 1] + 1..MIN_Y + world::HEIGHT {
                        assert_eq!(
                            after.get(x, y, z),
                            before.get(x, y, z),
                            "above geology at {},{y},{}",
                            cx * 16 + x as i32,
                            cz * 16 + z as i32
                        );
                    }
                }
            }
        }
        for z in [22, 23] {
            let chunk = t.generate(198i32.div_euclid(16), z / 16);
            let top = t.surface_y(198, z);
            for y in top + 1..=top + 3 {
                assert_eq!(chunk.get(198 % 16, y, (z % 16) as usize), blocks::AIR);
            }
        }
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
                    for e in &plots {
                        let columns: BTreeSet<_> =
                            e.block_list().into_iter().map(|[x, _, z]| (x, z)).collect();
                        for (wx, wz) in columns {
                            let (x, z) = (wx - cx * 16, wz - cz * 16);
                            let floor = e.floor_at(wx, wz);
                            if (0..16).contains(&x)
                                && (0..16).contains(&z)
                                && floor >= MIN_ENTRANCE_Y
                                && floor <= heights[z as usize + 1][x as usize + 1]
                                && reference.get(x as usize, floor, z as usize) == blocks::AIR
                            {
                                reference.set(x as usize, floor, z as usize, blocks::STONE);
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
            direction: [1, 0],
            slope: 0.75,
            floors: Vec::new(),
            footprint: None,
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
