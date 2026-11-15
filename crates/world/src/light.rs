//! Deterministic, integer-only lighting of the loaded world. No I/O.
use std::collections::VecDeque;

use crate::{blocks, section_index, Chunk, Fnv64, World, HEIGHT, MIN_Y, SECTIONS};

type Pos = (i32, i32, i32);
const DIRS: [Pos; 6] = [
    (0, -1, 0),
    (0, 1, 0),
    (0, 0, -1),
    (0, 0, 1),
    (-1, 0, 0),
    (1, 0, 0),
];

/// Two block levels per byte, low nibble first in section index order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Nibbles {
    Uniform(u8),
    Packed(Box<[u8; 2048]>),
}
impl Default for Nibbles {
    fn default() -> Self {
        Self::Uniform(0)
    }
}
impl Nibbles {
    pub fn get(&self, i: usize) -> u8 {
        match self {
            Self::Uniform(v) => *v,
            Self::Packed(a) => (a[i / 2] >> ((i & 1) * 4)) & 15,
        }
    }
    fn set(&mut self, i: usize, value: u8) {
        debug_assert!(value <= 15);
        if self.get(i) == value {
            return;
        }
        if let Self::Uniform(v) = self {
            *self = Self::Packed(Box::new([*v * 17; 2048]));
        }
        if let Self::Packed(a) = self {
            let shift = (i & 1) * 4;
            a[i / 2] = (a[i / 2] & !(15 << shift)) | (value << shift);
        }
    }
    fn compact(&mut self) {
        if let Self::Packed(a) = self {
            let v = a[0] & 15;
            if a.iter().all(|b| *b == v * 17) {
                *self = Self::Uniform(v);
            }
        }
    }
    fn hash_into(&self, h: &mut Fnv64) {
        // Hash logical packed bytes, independently of allocation/history.
        for i in 0..2048 {
            h.u8(self.get(i * 2) | self.get(i * 2 + 1) << 4);
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LightSection {
    pub sky: Nibbles,
    pub block: Nibbles,
}
impl LightSection {
    pub(crate) fn hash_into(&self, h: &mut Fnv64) {
        self.sky.hash_into(h);
        self.block.hash_into(h);
    }
}

/// Allocated only for chunks in a lighting-enabled world.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChunkLighting {
    pub sections: [LightSection; SECTIONS],
    /// First Y above the highest block with nonzero opacity (z * 16 + x).
    pub heightmap: [i32; 256],
}
impl Default for ChunkLighting {
    fn default() -> Self {
        Self {
            sections: std::array::from_fn(|_| LightSection::default()),
            heightmap: [MIN_Y; 256],
        }
    }
}
impl ChunkLighting {
    pub(crate) fn hash_into(&self, h: &mut Fnv64) {
        for section in &self.sections {
            section.hash_into(h);
        }
        for height in self.heightmap {
            h.i32(height);
        }
    }
}

fn neighbor(p: Pos, d: Pos) -> Pos {
    (p.0 + d.0, p.1 + d.1, p.2 + d.2)
}
fn index(p: Pos) -> usize {
    (((p.1 - MIN_Y) & 15) * 256 + (p.2 & 15) * 16 + (p.0 & 15)) as usize
}

impl World {
    /// Opt-in mesh invalidation tracking; simulation worlds need no tracking.
    pub fn track_light_changes(&mut self) {
        self.light_changes = Some(Default::default());
    }
    pub fn take_light_changes(&mut self) -> impl Iterator<Item = (i32, usize, i32)> {
        self.light_changes
            .as_mut()
            .map(std::mem::take)
            .unwrap_or_default()
            .into_iter()
    }
    /// Store blocks immediately, leaving lighting to a client frame budget.
    pub fn insert_chunk_unlit(&mut self, mut chunk: Chunk) {
        self.remove_chunk(chunk.cx, chunk.cz);
        chunk.lighting = None;
        self.chunks.insert((chunk.cx, chunk.cz), chunk);
    }
    /// One indivisible unit of initial lighting work.
    pub fn light_chunk(&mut self, cx: i32, cz: i32) {
        if let Some(chunk) = self.chunks.remove(&(cx, cz)) {
            self.insert_chunk(chunk);
        }
    }

    /// Insert generated, received or decoded blocks and derive their lighting.
    pub fn insert_chunk(&mut self, mut chunk: Chunk) -> Option<Chunk> {
        let key = (chunk.cx, chunk.cz);
        if !self.lighting_enabled {
            chunk.lighting = None;
            return self.chunks.insert(key, chunk);
        }
        let old = self.remove_chunk(key.0, key.1);
        let mut lighting = Box::<ChunkLighting>::default();
        let mut block_queue = VecDeque::new();
        for z in 0..16 {
            for x in 0..16 {
                let mut height = MIN_Y;
                for section in (0..SECTIONS).rev() {
                    let top = MIN_Y + section as i32 * 16 + 15;
                    if let Some(state) = chunk.sections[section].states.uniform() {
                        if blocks::info(state).opacity == 0 {
                            continue;
                        }
                        height = top + 1;
                        break;
                    }
                    if let Some(y) = (top - 15..=top)
                        .rev()
                        .find(|&y| blocks::info(chunk.get(x, y, z)).opacity > 0)
                    {
                        height = y + 1;
                        break;
                    }
                }
                lighting.heightmap[z * 16 + x] = height;
            }
        }
        for s in 0..SECTIONS {
            let bottom = MIN_Y + s as i32 * 16;
            if lighting.heightmap.iter().all(|&h| h <= bottom) {
                lighting.sections[s].sky = Nibbles::Uniform(15);
            } else {
                for y in bottom..bottom + 16 {
                    for z in 0..16 {
                        for x in 0..16 {
                            if y >= lighting.heightmap[z * 16 + x] {
                                lighting.sections[s]
                                    .sky
                                    .set(crate::Section::index(x, (y & 15) as usize, z), 15);
                            }
                        }
                    }
                }
            }
            if chunk.sections[s]
                .states
                .uniform()
                .is_some_and(|state| blocks::info(state).emission == 0)
            {
                continue;
            }
            for y in bottom..bottom + 16 {
                for z in 0..16 {
                    for x in 0..16 {
                        let emission = blocks::info(chunk.get(x, y, z)).emission;
                        if emission > 0 {
                            lighting.sections[s]
                                .block
                                .set(crate::Section::index(x, (y & 15) as usize, z), emission);
                            block_queue.push_back((
                                key.0 * 16 + x as i32,
                                y,
                                key.1 * 16 + z as i32,
                            ));
                        }
                    }
                }
            }
        }
        chunk.lighting = Some(lighting);
        self.chunks.insert(key, chunk);
        let mut sky_queue = VecDeque::new();
        // Skip fully opaque and fully sunlit sections before looking for seeds.
        let chunk = &self.chunks[&key];
        let heights = &chunk.lighting.as_ref().unwrap().heightmap;
        let max_height = *heights.iter().max().unwrap();
        for section in 0..SECTIONS {
            let bottom = MIN_Y + section as i32 * 16;
            if bottom >= max_height
                || chunk.sections[section]
                    .states
                    .uniform()
                    .is_some_and(|state| blocks::info(state).opacity == 15)
            {
                continue;
            }
            for y in bottom..(bottom + 16).min(max_height) {
                for z in 0..16 {
                    for x in 0..16 {
                        if y >= heights[z * 16 + x]
                            || blocks::info(chunk.get(x, y, z)).opacity == 15
                        {
                            continue;
                        }
                        let p = (key.0 * 16 + x as i32, y, key.1 * 16 + z as i32);
                        for d in DIRS {
                            let n = neighbor(p, d);
                            if self.level(n, true) > 0 {
                                sky_queue.push_back(n);
                            }
                        }
                    }
                }
            }
        }
        // Unlit columns are closed boundaries too. Checking readiness once per
        // edge avoids scanning thousands of cells for each deferred neighbour.
        for d in [(-1, 0, 0), (1, 0, 0), (0, 0, -1), (0, 0, 1)] {
            if !self
                .chunks
                .get(&(key.0 + d.0, key.1 + d.2))
                .is_some_and(|c| c.lighting.is_some())
            {
                continue;
            }
            for y in MIN_Y..MIN_Y + HEIGHT {
                for a in 0..16 {
                    let x = if d.0 < 0 {
                        0
                    } else if d.0 > 0 {
                        15
                    } else {
                        a
                    };
                    let z = if d.2 < 0 {
                        0
                    } else if d.2 > 0 {
                        15
                    } else {
                        a
                    };
                    let p = (key.0 * 16 + x, y, key.1 * 16 + z);
                    let n = neighbor(p, d);
                    for (sky, queue) in [(true, &mut sky_queue), (false, &mut block_queue)] {
                        for (from, to) in [(p, n), (n, p)] {
                            let v = self.level(from, sky);
                            let target = self.level(to, sky);
                            if v > target && self.transmit(from, to, sky, v) > target {
                                queue.push_back(from);
                            }
                        }
                    }
                }
            }
        }
        self.spread(true, sky_queue);
        self.spread(false, block_queue);
        self.compact_chunk(key);
        if let Some(changes) = &mut self.light_changes {
            changes.extend((0..SECTIONS).map(|s| (key.0, s, key.1)));
        }
        old
    }

    /// Unloaded columns are closed boundaries, never implicit sources of light.
    pub fn remove_chunk(&mut self, cx: i32, cz: i32) -> Option<Chunk> {
        let removed = self.chunks.remove(&(cx, cz))?;
        let Some(lighting) = &removed.lighting else {
            return Some(removed);
        };
        for sky in [true, false] {
            let mut roots = Vec::new();
            for y in MIN_Y..MIN_Y + HEIGHT {
                for a in 0..16 {
                    for (p, d) in [
                        ((cx * 16, y, cz * 16 + a), (-1, 0, 0)),
                        ((cx * 16 + 15, y, cz * 16 + a), (1, 0, 0)),
                        ((cx * 16 + a, y, cz * 16), (0, 0, -1)),
                        ((cx * 16 + a, y, cz * 16 + 15), (0, 0, 1)),
                    ] {
                        let s = section_index(y).unwrap();
                        let light = &lighting.sections[s];
                        let v = if sky {
                            light.sky.get(index(p))
                        } else {
                            light.block.get(index(p))
                        };
                        let n = neighbor(p, d);
                        let adjacent = self.level(n, sky);
                        if adjacent > 0 && adjacent <= self.transmit(p, n, sky, v) {
                            roots.push((p, v));
                        }
                    }
                }
            }
            self.repair(sky, roots);
        }
        Some(removed)
    }

    pub fn sky_light(&self, x: i32, y: i32, z: i32) -> u8 {
        if !self.lighting_enabled {
            return 0;
        }
        if y >= MIN_Y + HEIGHT {
            return 15;
        }
        self.level((x, y, z), true)
    }
    pub fn block_light(&self, x: i32, y: i32, z: i32) -> u8 {
        self.level((x, y, z), false)
    }

    fn loaded(&self, p: Pos) -> bool {
        section_index(p.1).is_some()
            && self
                .chunks
                .get(&(p.0 >> 4, p.2 >> 4))
                .is_some_and(|c| c.lighting.is_some())
    }
    fn level(&self, p: Pos, sky: bool) -> u8 {
        let Some(s) = section_index(p.1) else {
            return 0;
        };
        let Some(c) = self.chunks.get(&(p.0 >> 4, p.2 >> 4)) else {
            return 0;
        };
        let Some(lighting) = &c.lighting else {
            return 0;
        };
        if sky {
            lighting.sections[s].sky.get(index(p))
        } else {
            lighting.sections[s].block.get(index(p))
        }
    }
    fn put(&mut self, p: Pos, sky: bool, v: u8) {
        let Some(s) = section_index(p.1) else {
            return;
        };
        if let Some(c) = self.chunks.get_mut(&(p.0 >> 4, p.2 >> 4)) {
            let Some(lighting) = c.lighting.as_mut() else {
                return;
            };
            let old = if sky {
                lighting.sections[s].sky.get(index(p))
            } else {
                lighting.sections[s].block.get(index(p))
            };
            if old != v {
                if let Some(changes) = &mut self.light_changes {
                    changes.insert((p.0 >> 4, s, p.2 >> 4));
                }
            }
            if sky {
                lighting.sections[s].sky.set(index(p), v);
            } else {
                lighting.sections[s].block.set(index(p), v);
            }
        }
    }
    fn base(&self, p: Pos, sky: bool) -> u8 {
        let Some(c) = self.chunks.get(&(p.0 >> 4, p.2 >> 4)) else {
            return 0;
        };
        if sky {
            if p.1
                >= c.lighting.as_ref().unwrap().heightmap[((p.2 & 15) * 16 + (p.0 & 15)) as usize]
            {
                15
            } else {
                0
            }
        } else {
            blocks::info(c.get((p.0 & 15) as usize, p.1, (p.2 & 15) as usize)).emission
        }
    }
    fn transmit(&self, from: Pos, to: Pos, sky: bool, value: u8) -> u8 {
        let Some(state) = self.get_block(to.0, to.1, to.2) else {
            return 0;
        };
        let opacity = blocks::info(state).opacity;
        if opacity == 15 {
            return 0;
        }
        let cost = if sky && value == 15 && to.1 < from.1 && opacity == 0 {
            0
        } else {
            opacity.max(1)
        };
        value.saturating_sub(cost)
    }
    fn spread(&mut self, sky: bool, mut queue: VecDeque<Pos>) {
        while let Some(p) = queue.pop_front() {
            let v = self.level(p, sky);
            for d in DIRS {
                let n = neighbor(p, d);
                if !self.loaded(n) {
                    continue;
                }
                let next = self.transmit(p, n, sky, v);
                if next > self.level(n, sky) {
                    self.put(n, sky, next);
                    queue.push_back(n);
                }
            }
        }
    }
    fn repair(&mut self, sky: bool, roots: Vec<(Pos, u8)>) {
        let mut remove: VecDeque<_> = roots.into();
        let mut add = VecDeque::new();
        for &(p, _) in &remove {
            self.put(p, sky, 0);
            add.push_back(p);
        }
        while let Some((p, old)) = remove.pop_front() {
            for d in DIRS {
                let n = neighbor(p, d);
                if !self.loaded(n) {
                    continue;
                }
                let v = self.level(n, sky);
                if v > 0 && v <= self.transmit(p, n, sky, old) {
                    self.put(n, sky, 0);
                    remove.push_back((n, v));
                }
                add.push_back(n);
            }
        }
        // Restore sources only after the entire dependent region is cleared.
        for &p in &add {
            if self.loaded(p) {
                self.put(p, sky, self.level(p, sky).max(self.base(p, sky)));
            }
        }
        self.spread(sky, add);
    }
    fn update_height(&mut self, x: i32, z: i32) {
        let c = self.chunks.get_mut(&(x >> 4, z >> 4)).unwrap();
        let height = (MIN_Y..MIN_Y + HEIGHT)
            .rev()
            .find(|&y| blocks::info(c.get((x & 15) as usize, y, (z & 15) as usize)).opacity > 0)
            .map_or(MIN_Y, |y| y + 1);
        c.lighting.as_mut().unwrap().heightmap[((z & 15) * 16 + (x & 15)) as usize] = height;
    }
    pub(crate) fn update_light(&mut self, x: i32, y: i32, z: i32) {
        self.update_height(x, z);
        for sky in [true, false] {
            self.repair(sky, vec![((x, y, z), self.level((x, y, z), sky))]);
        }
    }
    fn compact_chunk(&mut self, key: (i32, i32)) {
        for s in &mut self
            .chunks
            .get_mut(&key)
            .unwrap()
            .lighting
            .as_mut()
            .unwrap()
            .sections
        {
            s.sky.compact();
            s.block.compact();
        }
    }
    /// Enable lighting and rebuild it from blocks for every loaded chunk.
    pub fn rebuild_light(&mut self) {
        self.lighting_enabled = true;
        let chunks = std::mem::take(&mut self.chunks);
        for c in chunks.into_values() {
            self.insert_chunk(c);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn solid(cx: i32, cz: i32) -> Chunk {
        let mut c = Chunk::empty(cx, cz);
        c.sections = vec![crate::Section::uniform(blocks::STONE); SECTIONS];
        c
    }
    fn assert_rebuild(w: &World) {
        let mut rebuilt = World::with_lighting(true);
        // Reverse load order also checks that boundary propagation converges.
        for c in w.chunks.values().rev() {
            rebuilt.insert_chunk(c.clone());
        }
        for (&key, c) in &w.chunks {
            assert_eq!(
                c.lighting.as_ref().unwrap().heightmap,
                rebuilt.chunks[&key].lighting.as_ref().unwrap().heightmap
            );
            for y in MIN_Y..MIN_Y + HEIGHT {
                for z in 0..16 {
                    for x in 0..16 {
                        let p = (key.0 * 16 + x, y, key.1 * 16 + z);
                        for sky in [true, false] {
                            assert_eq!(w.level(p, sky), rebuilt.level(p, sky), "{p:?}, sky={sky}");
                        }
                    }
                }
            }
        }
        let mut a = Fnv64::new();
        let mut b = Fnv64::new();
        w.hash_into(&mut a);
        rebuilt.hash_into(&mut b);
        assert_eq!(a.finish(), b.finish());
    }
    #[test]
    fn glass_passes_direct_sun_and_leaves_and_water_filter_each_layer() {
        for material in [blocks::GLASS, blocks::OAK_LEAVES, blocks::WATER] {
            let mut c = solid(0, 0);
            for y in 0..MIN_Y + HEIGHT {
                c.set(8, y, 8, if y < 5 { material } else { blocks::AIR });
            }
            let mut w = World::with_lighting(true);
            w.insert_chunk(c);
            assert_eq!(w.sky_light(8, 5, 8), 15);
            for y in 0..5 {
                let expected = if material == blocks::GLASS {
                    15
                } else {
                    10 + y as u8
                };
                assert_eq!(w.sky_light(8, y, 8), expected, "material {material}, y {y}");
            }
            w.set_block(8, 3, 8, blocks::AIR);
            assert_eq!(
                w.sky_light(8, 0, 8),
                if material == blocks::GLASS { 15 } else { 10 }
            );
            assert_rebuild(&w);
        }
    }

    #[test]
    fn flat_surface_and_closed_underground() {
        let mut c = Chunk::empty(0, 0);
        for z in 0..16 {
            for x in 0..16 {
                for y in MIN_Y..=0 {
                    c.set(x, y, z, blocks::STONE);
                }
            }
        }
        let mut w = World::with_lighting(true);
        w.insert_chunk(c);
        assert_eq!(
            w.chunks[&(0, 0)].lighting.as_ref().unwrap().heightmap,
            [1; 256]
        );
        assert_eq!(w.sky_light(8, 1, 8), 15);
        assert_eq!(w.sky_light(8, 0, 8), 0);
        w.set_block(8, -10, 8, blocks::AIR);
        assert_eq!(w.sky_light(8, -10, 8), 0);
        assert_eq!(w.sky_light(8, 320, 8), 15);
        assert_eq!(w.sky_light(8, -65, 8), 0);
        assert_eq!(w.sky_light(16, 1, 8), 0);
    }
    #[test]
    fn roof_edges_and_ceiling_edits() {
        let mut c = Chunk::empty(0, 0);
        for z in 0..16 {
            for x in 3..=12 {
                c.set(x, 10, z, blocks::STONE);
            }
        }
        let mut w = World::with_lighting(true);
        w.insert_chunk(c);
        for x in 2..=7 {
            assert_eq!(w.sky_light(x, 9, 8), (17 - x) as u8);
        }
        assert_eq!(w.sky_light(7, 8, 8), 10); // side openings exist at this height too
        w.set_block(7, 10, 8, blocks::AIR);
        assert_eq!(w.sky_light(7, 9, 8), 15);
        assert_rebuild(&w);
        w.set_block(7, 10, 8, blocks::STONE);
        assert_eq!(w.sky_light(7, 9, 8), 10);
        assert_rebuild(&w);
    }
    #[test]
    fn diffuse_skylight_decays_down_a_closed_shaft() {
        let mut c = solid(0, 0);
        for y in 9..MIN_Y + HEIGHT {
            c.set(2, y, 8, blocks::AIR);
        }
        for x in 2..=7 {
            c.set(x, 9, 8, blocks::AIR);
        }
        for y in 0..=8 {
            c.set(7, y, 8, blocks::AIR);
        }
        let mut w = World::with_lighting(true);
        w.insert_chunk(c);
        assert_eq!(w.sky_light(2, 9, 8), 15);
        assert_eq!(w.sky_light(7, 9, 8), 10);
        assert_eq!(w.sky_light(7, 8, 8), 9);
        assert_eq!(w.sky_light(7, 0, 8), 1);
        w.set_block(4, 9, 8, blocks::STONE);
        assert_eq!(w.sky_light(7, 8, 8), 0);
        assert_rebuild(&w);
        w.set_block(4, 9, 8, blocks::AIR);
        assert_rebuild(&w);
    }

    #[test]
    fn tunnel_emission_and_edits() {
        let mut c = solid(0, 0);
        for x in 0..16 {
            c.set(x, 0, 8, blocks::AIR);
        }
        c.set(0, 0, 8, blocks::LAMP_BLOCK);
        let mut w = World::with_lighting(true);
        w.insert_chunk(c);
        for x in 0..16 {
            assert_eq!(w.block_light(x, 0, 8), (15 - x) as u8);
        }
        assert_eq!(w.block_light(0, 1, 8), 0);
        w.set_block(0, 0, 8, blocks::AIR);
        for x in 0..16 {
            assert_eq!(w.block_light(x, 0, 8), 0);
        }
        assert_rebuild(&w);
        w.set_block(0, 0, 8, blocks::LAMP_BLOCK);
        assert_rebuild(&w);
        w.set_block(5, 0, 8, blocks::STONE);
        assert_eq!(w.block_light(6, 0, 8), 0);
        assert_rebuild(&w);
        w.set_block(5, 0, 8, blocks::AIR);
        assert_eq!(w.block_light(6, 0, 8), 9);
        assert_rebuild(&w);
        // An alternate source must survive removal of the first one.
        w.set_block(12, 0, 8, blocks::LAMP_BLOCK);
        w.set_block(0, 0, 8, blocks::AIR);
        assert_eq!(w.block_light(1, 0, 8), 4);
        assert_rebuild(&w);
    }
    #[test]
    fn boundaries_late_load_replacement_and_unload() {
        let mut a = solid(-1, 0);
        let mut b = solid(0, 0);
        for x in 0..16 {
            a.set(x, 0, 8, blocks::AIR);
            b.set(x, 0, 8, blocks::AIR);
        }
        a.set(15, 0, 8, blocks::LAMP_BLOCK);
        let mut w = World::with_lighting(true);
        w.insert_chunk(b.clone());
        assert_eq!(w.block_light(0, 0, 8), 0);
        w.insert_chunk(a);
        assert_eq!(w.block_light(0, 0, 8), 14);
        assert_eq!(w.block_light(13, 0, 8), 1);
        assert_rebuild(&w);
        w.set_block(-1, 0, 8, blocks::AIR);
        assert_eq!(w.block_light(0, 0, 8), 0);
        assert_rebuild(&w);
        w.set_block(-1, 0, 8, blocks::LAMP_BLOCK);
        assert_eq!(w.block_light(0, 0, 8), 14);
        assert_rebuild(&w);
        w.remove_chunk(-1, 0);
        assert_eq!(w.block_light(0, 0, 8), 0);
        assert_rebuild(&w);
        b.set(0, 0, 8, blocks::LAMP_BLOCK);
        w.insert_chunk(b);
        assert_eq!(w.block_light(1, 0, 8), 14);
        assert_rebuild(&w);
        // Sunlight can arrive horizontally across a late-loaded boundary.
        let mut roof = Chunk::empty(0, 0);
        for z in 0..16 {
            for x in 0..16 {
                roof.set(x, 10, z, blocks::STONE);
            }
        }
        w.insert_chunk(roof);
        assert_eq!(w.sky_light(0, 9, 8), 0);
        w.insert_chunk(Chunk::empty(-1, 0));
        assert_eq!(w.sky_light(0, 9, 8), 14);
        assert_eq!(w.sky_light(13, 9, 8), 1);
        assert_rebuild(&w);
        w.remove_chunk(-1, 0);
        assert_eq!(w.sky_light(0, 9, 8), 0);
        assert_rebuild(&w);
    }
    #[test]
    fn fixed_seed_edits_match_rebuild_and_storage_is_unchanged() {
        let mut w = World::with_lighting(true);
        for cx in -1..=0 {
            let mut c = Chunk::empty(cx, 0);
            for z in 0..16 {
                for x in 0..16 {
                    c.set(x, 8, z, blocks::STONE);
                }
            }
            w.insert_chunk(c);
        }
        let mut rng = 0x12345678u32;
        for i in 0..120 {
            let mut next = || {
                rng ^= rng << 13;
                rng ^= rng >> 17;
                rng ^= rng << 5;
                rng
            };
            let x = (next() % 32) as i32 - 16;
            let y = (next() % 12) as i32;
            let z = (next() % 16) as i32;
            let state = [blocks::AIR, blocks::STONE, blocks::LAMP_BLOCK][next() as usize % 3];
            w.set_block(x, y, z, state);
            if i % 40 == 39 {
                assert_rebuild(&w);
            }
        }
        let mut restored = World::with_lighting(true);
        for c in w.chunks.values() {
            let bytes = c.to_bytes();
            let decoded = Chunk::read(c.cx, c.cz, &mut crate::io::Reader::new(&bytes)).unwrap();
            assert_eq!(bytes, decoded.to_bytes());
            restored.insert_chunk(decoded);
        }
        let mut a = Fnv64::new();
        let mut b = Fnv64::new();
        w.hash_into(&mut a);
        restored.hash_into(&mut b);
        assert_eq!(a.finish(), b.finish());
    }
    #[test]
    fn nibble_layout_and_canonical_hash() {
        let mut a = Nibbles::default();
        a.set(0, 3);
        a.set(1, 12);
        a.set(4095, 15);
        if let Nibbles::Packed(bytes) = &a {
            assert_eq!(bytes[0], 0xc3);
            assert_eq!(bytes[2047], 0xf0);
        } else {
            panic!("expected packed data");
        }
        a.set(0, 0);
        a.set(1, 0);
        a.set(4095, 0);
        let mut h1 = Fnv64::new();
        let mut h2 = Fnv64::new();
        a.hash_into(&mut h1);
        Nibbles::default().hash_into(&mut h2);
        assert_eq!(h1.finish(), h2.finish());
        a.compact();
        assert_eq!(a, Nibbles::Uniform(0));
        assert_eq!(blocks::info(blocks::AIR).opacity, 0);
        assert_eq!(blocks::info(blocks::LAMP_BLOCK).emission, 15);
        assert!(blocks::occludes(blocks::LAMP_BLOCK));
    }
    #[test]
    fn lighting_is_opt_in_and_disabling_releases_all_derived_data() {
        let mut c = Chunk::empty(0, 0);
        c.set(8, 0, 8, blocks::LAMP_BLOCK);
        assert!(c.lighting.is_none());
        let mut w = World::new();
        assert!(!w.lighting_enabled());
        w.insert_chunk(c);
        w.set_block(8, 0, 8, blocks::STONE);
        w.set_block(8, 0, 8, blocks::LAMP_BLOCK);
        assert!(w.chunks[&(0, 0)].lighting.is_none());
        assert_eq!(w.sky_light(8, 320, 8), 0);
        assert_eq!(w.block_light(8, 0, 8), 0);
        let mut unlit_hash = Fnv64::new();
        w.hash_into(&mut unlit_hash);
        let bytes = w.chunks[&(0, 0)].to_bytes();
        w.set_lighting_enabled(true);
        assert_eq!(w.block_light(9, 0, 8), 14);
        assert_rebuild(&w);
        let mut lit_hash = Fnv64::new();
        w.hash_into(&mut lit_hash);
        assert_ne!(unlit_hash.finish(), lit_hash.finish());
        assert_eq!(bytes, w.chunks[&(0, 0)].to_bytes());
        let lit_chunk = w.chunks[&(0, 0)].clone();
        w.set_lighting_enabled(false);
        assert!(w.chunks[&(0, 0)].lighting.is_none());
        let mut disabled_hash = Fnv64::new();
        w.hash_into(&mut disabled_hash);
        assert_eq!(unlit_hash.finish(), disabled_hash.finish());
        // An already-lit chunk must also release its arrays on unlit insertion.
        w.insert_chunk(lit_chunk);
        assert!(w.chunks[&(0, 0)].lighting.is_none());
        w.set_block(8, 0, 8, blocks::AIR);
        w.rebuild_light(); // explicitly enables and derives the latest blocks
        assert!(w.lighting_enabled());
        assert_eq!(w.block_light(9, 0, 8), 0);
        assert_rebuild(&w);
        w.set_lighting_enabled(false);
        assert!(w.remove_chunk(0, 0).unwrap().lighting.is_none());
    }

    #[test]
    fn lighting_timings() {
        let mut c = Chunk::empty(0, 0);
        for z in 0..16 {
            for x in 0..16 {
                for y in MIN_Y..=0 {
                    c.set(x, y, z, blocks::STONE);
                }
            }
        }
        let bytes = c.to_bytes();
        let unlit_chunk = c.clone();
        let mut w = World::with_lighting(true);
        let start = Instant::now();
        w.insert_chunk(c);
        let initial = start.elapsed();
        let start = Instant::now();
        w.set_block(8, 1, 8, blocks::LAMP_BLOCK);
        let edit = start.elapsed();
        let mut unlit = World::new();
        let start = Instant::now();
        unlit.insert_chunk(unlit_chunk);
        let disabled_initial = start.elapsed();
        let start = Instant::now();
        unlit.set_block(8, 1, 8, blocks::LAMP_BLOCK);
        let disabled_edit = start.elapsed();
        assert!(unlit.chunks[&(0, 0)].lighting.is_none());
        println!("lighting enabled: one flat chunk init={initial:?}, one lamp placement={edit:?}");
        println!("lighting disabled: init={disabled_initial:?}, lamp placement={disabled_edit:?}");
        assert_eq!(w.block_light(9, 1, 8), 14);
        assert_ne!(bytes, w.chunks[&(0, 0)].to_bytes());
    }
}
